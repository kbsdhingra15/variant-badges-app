const { getSubscription, countBadgedProducts } = require("../database/db");

// Middleware to check plan limits
async function checkPlanLimits(req, res, next) {
  try {
    const shop = req.shop;
    const subscription = await getSubscription(shop);

    // Allow all actions for Pro users
    if (subscription && subscription.plan_name === "pro") {
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

    req.planLimits = {
      canAddBadges: currentProducts < maxProducts,
      maxProducts: maxProducts,
      currentProducts: currentProducts,
      plan: "free",
    };

    next();
  } catch (error) {
    console.error("Error checking plan limits:", error);
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
