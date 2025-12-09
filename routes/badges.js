const express = require("express");
const router = express.Router();
const {
  getBadgeAssignments,
  saveBadgeAssignment,
  deleteBadgeAssignment,
} = require("../database/db");

// Get all badge assignments for shop
router.get("/", async (req, res) => {
  try {
    const shop = req.shop; // From middleware, not req.query
    const assignments = await getBadgeAssignments(shop);

    // Format: { "variant_id": "badge_type" }
    const badges = {};
    assignments.forEach((row) => {
      badges[row.variant_id] = row.badge_type;
    });

    res.json({ badges });
  } catch (error) {
    console.error("Error fetching badge assignments:", error);
    res.status(500).json({ error: "Failed to fetch badges" });
  }
});

// Save badge assignment for a variant
router.post("/", async (req, res) => {
  try {
    const shop = req.shop; // From middleware, not req.body
    const { variantId, productId, badgeType, optionValue } = req.body;

    if (!variantId || !productId) {
      return res.status(400).json({ error: "Missing required fields" });
    }

    console.log(
      "💾 Saving badge for shop:",
      shop,
      "variant:",
      variantId,
      "badge:",
      badgeType
    );

    // Get current selected option type from settings
    const { getAppSettings } = require("../database/db");
    const settings = await getAppSettings(shop);
    const optionType = settings.selectedOption;

    if (badgeType) {
      await saveBadgeAssignment(
        shop,
        variantId,
        productId,
        badgeType,
        optionValue,
        optionType
      );
    } else {
      await deleteBadgeAssignment(shop, variantId);
    }

    console.log("✅ Badge saved successfully");
    res.json({ success: true });
  } catch (error) {
    console.error("Error saving badge:", error);
    res.status(500).json({ error: "Failed to save badge" });
  }
});

// Delete badge assignment
router.delete("/", async (req, res) => {
  try {
    const shop = req.shop; // From middleware, not req.query
    const { variantId } = req.query;

    if (!variantId) {
      return res.status(400).json({ error: "Missing required fields" });
    }

    console.log("🗑️ Deleting badge for shop:", shop, "variant:", variantId);

    await deleteBadgeAssignment(shop, variantId);

    console.log("✅ Badge deleted successfully");
    res.json({ success: true });
  } catch (error) {
    console.error("Error deleting badge:", error);
    res.status(500).json({ error: "Failed to delete badge" });
  }
});

module.exports = router;
