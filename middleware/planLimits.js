const {
  getSubscription,
  countBadgedProducts,
  saveSubscription,
} = require("../database/db");

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

    // ========== HANDLE PENDING UPGRADE ==========
    // If user clicked "Upgrade to Pro" but hasn't approved yet
    if (subscription && subscription.status === "pending") {
      console.log("⏳ [PLAN LIMITS] Upgrade pending - enforcing Free limits");
      const currentProducts = await countBadgedProducts(shop);
      req.planLimits = {
        canAddBadges: currentProducts < 5,
        maxProducts: 5,
        currentProducts: currentProducts,
        plan: "free",
        pendingUpgrade: true,
      };
      return next();
    }
    // ========== END PENDING HANDLING ==========

    // ========== HANDLE PRO PLAN ==========
    if (subscription && subscription.plan_name === "pro") {
      // Check if Pro is cancelled (grace period)
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
          // Grace period expired - downgrade to Free
          console.log(
            "🔒 [PLAN LIMITS] Cancelled Pro - grace period expired, downgrading to Free"
          );

          // ========== CLEAN UP BADGES (keep first 5 products) ==========
          const { cleanupBadgesForFreePlan } = require("../database/db");
          const cleanupResult = await cleanupBadgesForFreePlan(shop);

          if (cleanupResult.cleaned) {
            console.log(`🧹 [PLAN LIMITS] Cleaned up badges:`);
            console.log(`   - Kept: ${cleanupResult.keptProducts} products`);
            console.log(
              `   - Removed: ${cleanupResult.removedProducts} products`
            );
          }
          // ========== END CLEANUP ==========

          await saveSubscription(shop, {
            plan_name: "free",
            status: "active",
            charge_id: null,
            billing_on: null,
            cancelled_at: null,
          });
          // Fall through to Free plan logic below
        }
      } else if (subscription.status === "active") {
        // Active Pro - unlimited access
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
    // ========== END PRO HANDLING ==========

    // ========== FREE PLAN - CHECK LIMITS ==========
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
    // ========== END FREE PLAN ==========
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
