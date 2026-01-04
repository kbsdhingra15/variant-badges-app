const { getSubscription, countBadgedProducts } = require("../database/db");

// Middleware to check plan limits
async function checkPlanLimits(req, res, next) {
  try {
    const shop = req.shop;
    console.log("🔒 [PLAN LIMITS] Checking limits for:", shop);

    const subscription = await getSubscription(shop);
    console.log("🔒 [PLAN LIMITS] Subscription:", subscription?.plan_name);

    // Allow all actions for Pro users
    if (subscription && subscription.plan_name === "pro") {
      console.log("🔒 [PLAN LIMITS] Pro user - unlimited access");
      req.planLimits = {
        canAddBadges: true,
        maxProducts: Infinity,
        currentProducts: 0,
        plan: "pro",
      };
      return next();
    }

    // Allow all actions during trial
    if (
      subscription &&
      subscription.plan_name === "trial" &&
      subscription.trial_ends_at &&
      new Date(subscription.trial_ends_at) > new Date()
    ) {
      console.log("🔒 [PLAN LIMITS] Trial user - unlimited access");
      req.planLimits = {
        canAddBadges: true,
        maxProducts: Infinity,
        currentProducts: 0,
        plan: "trial",
        trialEndsAt: subscription.trial_ends_at,
      };
      return next();
    }

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
