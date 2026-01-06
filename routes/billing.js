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

    // Create recurring application charge
    const charge = {
      recurring_application_charge: {
        name: planConfig.name,
        price: planConfig.price,
        return_url: `https://${process.env.HOST}/api/billing/activate?shop=${shop}`,
        trial_days: planConfig.trialDays,
        test: process.env.NODE_ENV !== "production", // Test mode in development
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
      }
    );

    const data = await response.json();

    if (data.errors) {
      console.error("Shopify billing error:", data.errors);
      return res.status(500).json({ error: "Failed to create charge" });
    }

    const chargeData = data.recurring_application_charge;

    // Save pending charge to database
    await saveSubscription(shop, {
      plan_name: plan,
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
    res.status(500).json({ error: "Failed to create charge" });
  }
});

// Activate charge after merchant approval
router.get("/activate", async (req, res) => {
  try {
    const { shop, charge_id } = req.query;

    if (!shop || !charge_id) {
      return res.redirect(
        `https://${shop}/admin/apps/${process.env.SHOPIFY_API_KEY}`
      );
    }

    // Get session for this shop
    const { getShopSession } = require("../database/db");
    const session = await getShopSession(shop);

    if (!session) {
      console.error("No session found for shop:", shop);
      return res.redirect(
        `https://${shop}/admin/apps/${process.env.SHOPIFY_API_KEY}`
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
      }
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
        }
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
          `https://${shop}/admin/apps/${process.env.SHOPIFY_API_KEY}?upgraded=true`
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
      `https://${req.query.shop}/admin/apps/${process.env.SHOPIFY_API_KEY}?error=activation_failed`
    );
  }
});

// Get current subscription status
router.get("/status", async (req, res) => {
  try {
    const shop = req.shop;
    const subscription = await getSubscription(shop);

    if (!subscription) {
      // Initialize trial if no subscription exists
      const { initializeTrial } = require("../database/db");
      const newSubscription = await initializeTrial(shop);
      return res.json(newSubscription);
    }

    // Check if trial has expired
    if (
      subscription.plan_name === "trial" &&
      subscription.trial_ends_at &&
      new Date(subscription.trial_ends_at) < new Date()
    ) {
      // Move to free plan
      const updated = await saveSubscription(shop, {
        plan_name: "free",
        status: "active",
        trial_ends_at: null,
      });
      return res.json(updated);
    }

    res.json(subscription);
  } catch (error) {
    console.error("Error getting billing status:", error);
    res.status(500).json({ error: "Failed to get billing status" });
  }
});

// Cancel subscription (downgrade to free)
// Cancel subscription (downgrade to free)
router.post("/cancel", async (req, res) => {
  try {
    const shop = req.shop;
    const { accessToken } = req.shopifySession;
    const subscription = await getSubscription(shop);

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
        }
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
        }
      );

      console.log(
        `🔻 Cancelled Pro subscription for ${shop}, expires: ${expiresOn}`
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

    res.json({
      success: true,
      plan: "pro", // Still Pro until expiry
      status: "cancelled",
      expiresOn: expiresOn,
    });
  } catch (error) {
    console.error("Error cancelling subscription:", error);
    res.status(500).json({ error: "Failed to cancel subscription" });
  }
});

module.exports = router;
