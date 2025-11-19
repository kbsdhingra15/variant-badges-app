const express = require("express");
const router = express.Router();
const {
  getBadgeAssignments,
  saveBadgeAssignment,
  deleteBadgeAssignment,
} = require("../database/db");

// GET /api/badges - Get all badge assignments for this shop
router.get("/badges", async (req, res) => {
  try {
    const { shop } = req.shopifySession;
    console.log("🏷️  Fetching badge assignments for shop:", shop);

    const badges = await getBadgeAssignments(shop);

    res.json({
      badges,
      count: badges.length,
      message: "Badge assignments retrieved successfully",
    });
  } catch (error) {
    console.error("❌ Error fetching badges:", error);
    res.status(500).json({
      error: "Internal server error",
      details: error.message,
    });
  }
});

// POST /api/badges - Assign a badge to a variant
router.post("/badges", async (req, res) => {
  try {
    const { shop } = req.shopifySession;
    const { productId, variantId, badgeType, optionValue } = req.body;

    console.log("🏷️  Assigning badge for shop:", shop);
    console.log("   Product:", productId);
    console.log("   Variant:", variantId);
    console.log("   Badge Type:", badgeType);
    console.log("   Option Value:", optionValue);

    // Validate required fields
    if (!productId || !variantId || !badgeType) {
      return res.status(400).json({
        error: "Missing required fields: productId, variantId, badgeType",
      });
    }

    // Validate badge type
    const validBadgeTypes = ["HOT", "NEW", "SALE"];
    if (!validBadgeTypes.includes(badgeType)) {
      return res.status(400).json({
        error: `Invalid badge type. Must be one of: ${validBadgeTypes.join(", ")}`,
      });
    }

    await saveBadgeAssignment(shop, productId, variantId, badgeType, optionValue);

    res.json({
      success: true,
      message: "Badge assigned successfully",
      badge: {
        productId,
        variantId,
        badgeType,
        optionValue,
      },
    });
  } catch (error) {
    console.error("❌ Error assigning badge:", error);
    res.status(500).json({
      error: "Internal server error",
      details: error.message,
    });
  }
});

// DELETE /api/badges/:variantId/:badgeType - Remove a badge from a variant
router.delete("/badges/:variantId/:badgeType", async (req, res) => {
  try {
    const { shop } = req.shopifySession;
    const { variantId, badgeType } = req.params;

    console.log("🏷️  Removing badge for shop:", shop);
    console.log("   Variant:", variantId);
    console.log("   Badge Type:", badgeType);

    await deleteBadgeAssignment(shop, variantId, badgeType);

    res.json({
      success: true,
      message: "Badge removed successfully",
    });
  } catch (error) {
    console.error("❌ Error removing badge:", error);
    res.status(500).json({
      error: "Internal server error",
      details: error.message,
    });
  }
});

// POST /api/badges/bulk - Assign badges to multiple variants at once
router.post("/badges/bulk", async (req, res) => {
  try {
    const { shop } = req.shopifySession;
    const { assignments } = req.body;

    console.log("🏷️  Bulk assigning badges for shop:", shop);
    console.log("   Number of assignments:", assignments?.length || 0);

    // Validate request
    if (!assignments || !Array.isArray(assignments)) {
      return res.status(400).json({
        error: "Missing or invalid 'assignments' array",
      });
    }

    // Process each assignment
    const results = [];
    for (const assignment of assignments) {
      const { productId, variantId, badgeType, optionValue } = assignment;

      try {
        await saveBadgeAssignment(shop, productId, variantId, badgeType, optionValue);
        results.push({
          variantId,
          badgeType,
          success: true,
        });
      } catch (error) {
        console.error(`❌ Failed to assign badge to variant ${variantId}:`, error);
        results.push({
          variantId,
          badgeType,
          success: false,
          error: error.message,
        });
      }
    }

    const successCount = results.filter((r) => r.success).length;
    const failureCount = results.filter((r) => !r.success).length;

    res.json({
      success: failureCount === 0,
      message: `Assigned ${successCount} badges, ${failureCount} failed`,
      results,
    });
  } catch (error) {
    console.error("❌ Error in bulk badge assignment:", error);
    res.status(500).json({
      error: "Internal server error",
      details: error.message,
    });
  }
});

module.exports = router;
