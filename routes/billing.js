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
      `https://${shop}/admin/api/2025-04/shop.json`,
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

    // ========== GRAPHQL BILLING (STANDALONE APP COMPATIBLE) ==========
    console.log("💳 [GraphQL] Creating billing charge for:", shop);
    console.log("   Plan:", planConfig.name, "@", planConfig.price);
    console.log("   Test mode:", isDevelopmentStore);

    // GraphQL mutation for creating recurring charge
    const mutation = `
      mutation CreateAppSubscription($name: String!, $returnUrl: URL!, $test: Boolean, $trialDays: Int, $lineItems: [AppSubscriptionLineItemInput!]!) {
        appSubscriptionCreate(
          name: $name
          returnUrl: $returnUrl
          test: $test
          trialDays: $trialDays
          lineItems: $lineItems
        ) {
          appSubscription {
            id
            name
            test
            status
          }
          confirmationUrl
          userErrors {
            field
            message
          }
        }
      }
    `;

    const variables = {
      name: planConfig.name,
      returnUrl: `${process.env.HOST}/api/billing/activate?shop=${shop}`,
      test: isDevelopmentStore,
      trialDays: planConfig.trialDays,
      lineItems: [
        {
          plan: {
            appRecurringPricingDetails: {
              price: { amount: planConfig.price, currencyCode: "USD" },
              interval: "EVERY_30_DAYS",
            },
          },
        },
      ],
    };

    console.log("📤 [GraphQL] Sending mutation with variables:", JSON.stringify(variables, null, 2));

    const response = await fetch(
      `https://${shop}/admin/api/2025-04/graphql.json`,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-Shopify-Access-Token": accessToken,
        },
        body: JSON.stringify({ query: mutation, variables }),
      }
    );

    if (!response.ok) {
      const errorText = await response.text();
      console.error("❌ [GraphQL] Billing API error:", response.status, response.statusText);
      console.error("   Error body:", errorText || "(empty)");
      return res.status(500).json({
        error: "Failed to create charge via GraphQL",
        details: `Shopify returned ${response.status}: ${errorText.substring(0, 200)}`,
      });
    }

    const data = await response.json();
    console.log("📥 [GraphQL] Response:", JSON.stringify(data, null, 2));

    if (data.errors) {
      console.error("❌ [GraphQL] GraphQL errors:", data.errors);
      return res.status(500).json({
        error: "GraphQL errors",
        details: JSON.stringify(data.errors),
      });
    }

    if (data.data?.appSubscriptionCreate?.userErrors?.length > 0) {
      console.error("❌ [GraphQL] User errors:", data.data.appSubscriptionCreate.userErrors);
      return res.status(500).json({
        error: "Failed to create subscription",
        details: JSON.stringify(data.data.appSubscriptionCreate.userErrors),
      });
    }

    const subscription = data.data?.appSubscriptionCreate?.appSubscription;
    const confirmationUrl = data.data?.appSubscriptionCreate?.confirmationUrl;

    if (!subscription || !confirmationUrl) {
      console.error("❌ [GraphQL] Missing subscription or confirmation URL");
      return res.status(500).json({
        error: "Invalid response from Shopify",
        details: "No subscription or confirmation URL returned",
      });
    }
    // ========== END GRAPHQL BILLING ==========

    // Extract subscription ID from GraphQL response (format: gid://shopify/AppSubscription/12345)
    const subscriptionId = subscription.id.split('/').pop();

    // Save pending charge to database
    await saveSubscription(shop, {
      plan_name: "free", //Still keep as free until activated
      status: "pending",
      charge_id: subscriptionId,
    });

    console.log(`💳 [GraphQL] Created billing subscription for ${shop}: ${subscriptionId}`);

    // Return confirmation URL for merchant to approve
    res.json({
      confirmationUrl: confirmationUrl,
      chargeId: subscriptionId,
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

    // ========== GRAPHQL ACTIVATION CHECK ==========
    console.log(`💳 [GraphQL] Verifying activation for ${shop}, ID: ${charge_id}`);

    const query = `
      query GetSubscription($id: ID!) {
        node(id: $id) {
          ... on AppSubscription {
            id
            name
            status
            currentPeriodEnd
          }
        }
      }
    `;

    const variables = {
      id: `gid://shopify/AppSubscription/${charge_id}`
    };

    const response = await fetch(
      `https://${shop}/admin/api/2025-04/graphql.json`,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-Shopify-Access-Token": accessToken,
        },
        body: JSON.stringify({ query, variables }),
      }
    );

    if (!response.ok) {
      console.error("❌ [GraphQL] Activation check failed:", response.status);
      return res.redirect(`https://${shop}/admin/apps/${process.env.SHOPIFY_API_KEY}?error=check_failed`);
    }

    const data = await response.json();
    const subscription = data.data?.node;

    if (subscription && subscription.status === "ACTIVE") {
      // Update subscription in database
      await saveSubscription(shop, {
        plan_name: "pro",
        status: "active",
        charge_id: charge_id.toString(),
        billing_on: subscription.currentPeriodEnd, // currentPeriodEnd is the mapping for billing_on in GraphQL
        trial_ends_at: null,
        cancelled_at: null,
      });

      console.log(`✅ Activated Pro plan for ${shop}`);

      // Redirect back to app with success message
      return res.redirect(
        `https://${shop}/admin/apps/${process.env.SHOPIFY_API_KEY}?upgraded=true`,
      );
    } else {
      console.log(`❌ Subscription not active. Status: ${subscription?.status || 'NOT_FOUND'}`);
      
      // If declined or expired, reset to free
      if (subscription?.status === "DECLINED" || subscription?.status === "EXPIRED") {
        await saveSubscription(shop, {
          plan_name: "free",
          status: "active",
          charge_id: null,
        });
      }
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

    // ========== FIX: Check for expired grace period ==========
    if (subscription.plan_name === "pro" && subscription.status === "cancelled" && subscription.billing_on) {
      const now = new Date();
      const billingOn = new Date(subscription.billing_on);
      
      if (now > billingOn) {
        console.log("💳 [STATUS] Pro (Cancelled) expired - downgrading to Free:", shop);
        
        subscription = await saveSubscription(shop, {
          plan_name: "free",
          status: "active",
          charge_id: null,
          billing_on: null,
          cancelled_at: null,
        });
      }
    }
    // ========== END FIX ==========

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
            `https://${shop}/admin/api/2025-04/recurring_application_charges/${subscription.charge_id}.json`,
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
        `https://${shop}/admin/api/2025-04/recurring_application_charges/${subscription.charge_id}.json`,
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
        `https://${shop}/admin/api/2025-04/recurring_application_charges/${subscription.charge_id}.json`,
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
