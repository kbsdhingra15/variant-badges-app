const {
  getSubscription,
  countBadgedProducts,
  saveSubscription,
} = require("../database/db"); // ADD saveSubscription

// Middleware to check plan limits
async function checkPlanLimits(req, res, next) {
  try {
    const shop = req.shop;
    console.log("🔒 [PLAN LIMITS] Checking limits for:", shop);

    const subscription = await getSubscription(shop);
    console.log(
      "🔒 [PLAN LIMITS] Subscription:",
      subscription?.plan_name,
      subscription?.status
    );

    // Check if Pro but cancelled - still allow if before billing_on date
    if (subscription && subscription.plan_name === "pro") {
      if (subscription.status === "cancelled" && subscription.billing_on) {
        // Check if still in grace period
        if (new Date(subscription.billing_on) > new Date()) {
          console.log("🔒 [PLAN LIMITS] Cancelled Pro - still in grace period");
          req.planLimits = {
            canAddBadges: true,
            maxProducts: Infinity,
            currentProducts: 0,
            plan: "pro",
            status: "cancelled",
            expiresOn: subscription.billing_on,
          };
          return next();
        } else {
          // Grace period expired - downgrade to free
          console.log(
            "🔒 [PLAN LIMITS] Cancelled Pro - grace period expired, downgrading"
          );
          await saveSubscription(shop, {
            plan_name: "free",
            status: "active",
            charge_id: null,
            billing_on: null,
          });
          // Continue to free plan logic below
        }
      } else if (subscription.status === "active") {
        // Active Pro
        console.log("🔒 [PLAN LIMITS] Active Pro - unlimited access");
        req.planLimits = {
          canAddBadges: true,
          maxProducts: Infinity,
          currentProducts: 0,
          plan: "pro",
        };
        return next();
      }
    }

    // REMOVE THE DUPLICATE PRO CHECK HERE (lines 47-56)

    // Free plan - check limits
    const currentProducts = await countBadgedProducts(shop);
    const maxProducts = 5;

    console.log(
      `🔒 [PLAN LIMITS] Free plan - ${currentProducts}/${maxProducts} products used`
    );

    req.planLimits = {
      canAddBadges: currentProducts < maxProducts,
      maxProducts: maxProducts,
      currentProducts: currentProducts,
      plan: "free",
    };

    next();
  } catch (error) {
    console.error("🔒 [PLAN LIMITS] Error checking plan limits:", error);
    // On error, allow action (fail open)
    req.planLimits = {
      canAddBadges: true,
      maxProducts: Infinity,
      currentProducts: 0,
      plan: "unknown",
    };
    next();
  }
}

module.exports = { checkPlanLimits };
