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
    const shop = req.query.shop;
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
    const { shop, variantId, productId, badgeType, optionValue } = req.body;

    if (!shop || !variantId || !productId) {
      return res.status(400).json({ error: "Missing required fields" });
    }

    if (badgeType) {
      // Save or update badge
      await saveBadgeAssignment(
        shop,
        variantId,
        productId,
        badgeType,
        optionValue
      );
    } else {
      // Remove badge (badgeType is null/empty)
      await deleteBadgeAssignment(shop, variantId);
    }

    res.json({ success: true });
  } catch (error) {
    console.error("Error saving badge:", error);
    res.status(500).json({ error: "Failed to save badge" });
  }
});

// Delete badge assignment
router.delete("/", async (req, res) => {
  try {
    const { shop, variantId } = req.query;

    if (!shop || !variantId) {
      return res.status(400).json({ error: "Missing required fields" });
    }

    await deleteBadgeAssignment(shop, variantId);
    res.json({ success: true });
  } catch (error) {
    console.error("Error deleting badge:", error);
    res.status(500).json({ error: "Failed to delete badge" });
  }
});

    const assignments = await getBadgeAssignments(shop);

    // Format: { "variant_id": "badge_type" }
    const badges = {};
    assignments.forEach((row) => {
      badges[row.variant_id] = row.badge_type;
    });

    // Set CORS headers to allow storefront access
    res.header("Access-Control-Allow-Origin", "*");
    res.header("Access-Control-Allow-Methods", "GET");

    res.json({ badges });
  } catch (error) {
    console.error("Error fetching public badges:", error);
    res.status(500).json({ error: "Failed to fetch badges" });
  }
});

module.exports = router;
