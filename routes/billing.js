const express = require("express");
const router = express.Router();
const {
  getSubscription,
  saveSubscription,
  countBadgedProducts,
} = require("../database/db");

// Shopify billing configuration
const PLANS = {
  pro: {
    name: "Pro Plan",
    price: 4.99,
    trialDays: 0, // No trial for upgrades (already had trial on Free)
    features: ["Unlimited products", "Priority support"],
  },
};

// Create a billing charge
router.post("/create-charge", async (req, res) => {
  try {
    const shop = req.shop;
    const { accessToken } = req.shopifySession;
    const { plan } = req.body;

    if (!PLANS[plan]) {
      return res.status(400).json({ error: "Invalid plan" });
    }

    const planConfig = PLANS[plan];

    // ========== AUTO-DETECT TEST MODE ==========
    // Check if this is a development/partner store
    const shopInfoResponse = await fetch(
      `https://${shop}/admin/api/2024-10/shop.json`,
      {
        headers: {
          "X-Shopify-Access-Token": accessToken,
        },
      },
    );

    // ✅ CHECK 1: Shop info response
    if (!shopInfoResponse.ok) {
      console.error(
        "Shop info fetch failed:",
        shopInfoResponse.status,
        shopInfoResponse.statusText,
      );
      return res
        .status(500)
        .json({ error: "Failed to fetch shop information" });
    }

    const shopInfo = await shopInfoResponse.json();
    const isDevelopmentStore =
      shopInfo.shop.plan_name === "partner_test" ||
      shopInfo.shop.plan_name === "affiliate" ||
      shopInfo.shop.plan_name === "staff_business";

    console.log(`💳 Creating charge for ${shop}`);
    console.log(`   Plan: ${shopInfo.shop.plan_name}`);
    console.log(`   Test mode: ${isDevelopmentStore}`);
    // ========== END AUTO-DETECT ==========

    // Create recurring application charge
    const charge = {
      recurring_application_charge: {
        name: planConfig.name,
        price: planConfig.price,
        return_url: `https://${process.env.HOST}/api/billing/activate?shop=${shop}&charge_id={charge_id}`,
        trial_days: planConfig.trialDays,
        test: isDevelopmentStore, // ✅ Auto-detect based on store type!
      },
    };
    const response = await fetch(
      `https://${shop}/admin/api/2024-10/recurring_application_charges.json`,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-Shopify-Access-Token": accessToken,
        },
        body: JSON.stringify(charge),
      },
    );
    // ✅ CHECK 2: Billing charge response (CRITICAL - this is where your error is!)
    if (!response.ok) {
      const errorText = await response.text();
      console.error("Billing API error:", response.status, response.statusText);
      console.error("Error body:", errorText);
      return res.status(500).json({
        error: "Failed to create charge",
        details: `Shopify returned ${response.status}: ${errorText.substring(0, 200)}`,
      });
    }

    const data = await response.json();

    if (data.errors) {
      console.error("Shopify billing error:", data.errors);
      return res.status(500).json({
        error: "Failed to create charge",
        details: JSON.stringify(data.errors),
      });
    }

    const chargeData = data.recurring_application_charge;

    // Save pending charge to database
    await saveSubscription(shop, {
      plan_name: "free",
      status: "pending",
      charge_id: chargeData.id.toString(),
    });

    console.log(`💳 Created billing charge for ${shop}: ${chargeData.id}`);

    // Return confirmation URL for merchant to approve
    res.json({
      confirmationUrl: chargeData.confirmation_url,
      chargeId: chargeData.id,
    });
  } catch (error) {
    console.error("Error creating charge:", error);
    res
      .status(500)
      .json({ error: "Failed to create charge", details: error.message });
  }
});

// Activate charge after merchant approval
router.get("/activate", async (req, res) => {
  try {
    const { shop, charge_id } = req.query;

    if (!shop || !charge_id) {
      return res.redirect(
        `https://${shop}/admin/apps/${process.env.SHOPIFY_API_KEY}`,
      );
    }

    // Get session for this shop
    const { getShopSession } = require("../database/db");
    const session = await getShopSession(shop);

    if (!session) {
      console.error("No session found for shop:", shop);
      return res.redirect(
        `https://${shop}/admin/apps/${process.env.SHOPIFY_API_KEY}`,
      );
    }

    const accessToken = session.accessToken;

    // Get charge details from Shopify
    const response = await fetch(
      `https://${shop}/admin/api/2024-10/recurring_application_charges/${charge_id}.json`,
      {
        method: "GET",
        headers: {
          "X-Shopify-Access-Token": accessToken,
        },
      },
    );

    const data = await response.json();
    const charge = data.recurring_application_charge;

    if (charge.status === "accepted") {
      // Activate the charge
      const activateResponse = await fetch(
        `https://${shop}/admin/api/2024-10/recurring_application_charges/${charge_id}/activate.json`,
        {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "X-Shopify-Access-Token": accessToken,
          },
          body: JSON.stringify({
            recurring_application_charge: {
              id: charge_id,
            },
          }),
        },
      );

      const activateData = await activateResponse.json();

      if (activateData.recurring_application_charge) {
        // Update subscription in database
        await saveSubscription(shop, {
          plan_name: "pro",
          status: "active",
          charge_id: charge_id.toString(),
          billing_on: activateData.recurring_application_charge.billing_on,
          trial_ends_at: null,
          cancelled_at: null,
        });

        console.log(`✅ Activated Pro plan for ${shop}`);

        // Redirect back to app with success message
        return res.redirect(
          `https://${shop}/admin/apps/${process.env.SHOPIFY_API_KEY}?upgraded=true`,
        );
      }
    } else if (charge.status === "declined") {
      console.log(`❌ Charge declined by ${shop}`);

      // Reset to free plan
      await saveSubscription(shop, {
        plan_name: "free",
        status: "active",
        charge_id: null,
      });
    }

    // Redirect back to app
    res.redirect(`https://${shop}/admin/apps/${process.env.SHOPIFY_API_KEY}`);
  } catch (error) {
    console.error("Error activating charge:", error);
    res.redirect(
      `https://${req.query.shop}/admin/apps/${process.env.SHOPIFY_API_KEY}?error=activation_failed`,
    );
  }
});

// Get current subscription status
router.get("/status", async (req, res) => {
  try {
    const shop = req.shop;
    const subscription = await getSubscription(shop);

    if (!subscription) {
      // ========== NO TRIAL - Initialize Free plan directly ==========
      console.log(
        "💳 No subscription found - initializing Free plan for:",
        shop,
      );
      const newSubscription = await saveSubscription(shop, {
        plan_name: "free",
        status: "active",
      });
      return res.json(newSubscription);
      // ========== END ==========
    }

    // ========== REMOVED: Trial expiry check (no trial anymore!) ==========
    // No need to check trial_ends_at since we don't have trials

    res.json(subscription);
  } catch (error) {
    console.error("Error getting billing status:", error);
    res.status(500).json({ error: "Failed to get billing status" });
  }
});

// Cancel subscription (downgrade to free)
router.post("/cancel", async (req, res) => {
  try {
    const shop = req.shop;
    const { accessToken } = req.shopifySession;
    const subscription = await getSubscription(shop);
    // ========== ADD THIS BLOCK HERE ==========
    // Handle cancelling a pending upgrade
    if (subscription && subscription.status === "pending") {
      console.log("🔄 Cancelling pending upgrade for:", shop);

      // Delete the pending charge from Shopify if it exists
      if (subscription.charge_id) {
        try {
          await fetch(
            `https://${shop}/admin/api/2024-10/recurring_application_charges/${subscription.charge_id}.json`,
            {
              method: "DELETE",
              headers: {
                "X-Shopify-Access-Token": accessToken,
              },
            },
          );
        } catch (err) {
          console.log("⚠️ Could not delete pending charge (may not exist)");
        }
      }

      // Reset to Free plan
      await saveSubscription(shop, {
        plan_name: "free",
        status: "active",
        charge_id: null,
        billing_on: null,
        cancelled_at: null,
      });

      return res.json({
        success: true,
        message: "Pending upgrade cancelled - returned to Free plan",
        plan: "free",
        status: "active",
      });
    }
    // ========== END NEW CODE ==========
    let expiresOn = null;

    if (
      subscription &&
      subscription.charge_id &&
      subscription.plan_name === "pro"
    ) {
      // Get charge details from Shopify to know when it expires
      const chargeResponse = await fetch(
        `https://${shop}/admin/api/2024-10/recurring_application_charges/${subscription.charge_id}.json`,
        {
          method: "GET",
          headers: {
            "X-Shopify-Access-Token": accessToken,
          },
        },
      );

      const chargeData = await chargeResponse.json();
      expiresOn = chargeData.recurring_application_charge?.billing_on;

      // Cancel the recurring charge in Shopify
      await fetch(
        `https://${shop}/admin/api/2024-10/recurring_application_charges/${subscription.charge_id}.json`,
        {
          method: "DELETE",
          headers: {
            "X-Shopify-Access-Token": accessToken,
          },
        },
      );

      console.log(
        `🔻 Cancelled Pro subscription for ${shop}, expires: ${expiresOn}`,
      );
    }

    // Mark as cancelled but keep billing_on date
    await saveSubscription(shop, {
      plan_name: "pro", // Keep Pro until expiry
      status: "cancelled", // Mark as cancelled
      charge_id: subscription.charge_id,
      billing_on: expiresOn, // When it actually expires
      cancelled_at: new Date(),
    });

    // ========== CHECK HOW MANY PRODUCTS WILL BE AFFECTED ==========
    const { countBadgedProducts } = require("../database/db");
    const currentProducts = await countBadgedProducts(shop);
    const willLoseAccess = currentProducts > 5 ? currentProducts - 5 : 0;

    console.log(`📊 User has ${currentProducts} products with badges`);
    console.log(
      `⚠️ Will lose access to ${willLoseAccess} products after grace period`,
    );
    // ========== END CHECK ==========

    res.json({
      success: true,
      plan: "pro", // Still Pro until expiry
      status: "cancelled",
      expiresOn: expiresOn,
      warning: {
        currentProducts: currentProducts,
        freeLimit: 5,
        productsToLose: willLoseAccess,
      },
    });
  } catch (error) {
    console.error("Error cancelling subscription:", error);
    res.status(500).json({ error: "Failed to cancel subscription" });
  }
});

module.exports = router;
