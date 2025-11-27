const express = require("express");
const router = express.Router();
const {
  getBadgeAssignments,
  saveBadgeAssignment,
  deleteBadgeAssignment,
  getBadgesForPublicAPI,
} = require("../database/db");

// Get all badge assignments for shop
router.get("/", async (req, res) => {
  try {
    const shop = req.query.shop;
    const badges = await getBadgeAssignments(shop);
    res.json({ badges });
  } catch (error) {
    console.error("Error fetching badges:", error);
    res.status(500).json({ error: "Failed to fetch badges" });
  }
});

// Save badge assignment (option_value based)
router.post("/", async (req, res) => {
  try {
    const { shop, optionValue, badgeType } = req.body;

    if (!shop || !optionValue || !badgeType) {
      return res.status(400).json({ error: "Missing required fields" });
    }

    if (!["HOT", "NEW"].includes(badgeType)) {
      return res.status(400).json({ error: "Invalid badge type" });
    }

    const badge = await saveBadgeAssignment(shop, optionValue, badgeType);
    res.json({ success: true, badge });
  } catch (error) {
    console.error("Error saving badge:", error);
    res.status(500).json({ error: "Failed to save badge" });
  }
});

// Delete badge assignment
router.delete("/:optionValue/:badgeType", async (req, res) => {
  try {
    const shop = req.query.shop;
    const { optionValue, badgeType } = req.params;

    await deleteBadgeAssignment(
      shop,
      decodeURIComponent(optionValue),
      badgeType
    );
    res.json({ success: true });
  } catch (error) {
    console.error("Error deleting badge:", error);
    res.status(500).json({ error: "Failed to delete badge" });
  }
});

// Public API endpoint (no auth) - for storefront
router.get("/public/:shop", async (req, res) => {
  try {
    const shop = req.params.shop;
    const badges = await getBadgesForPublicAPI(shop);

    res.json({ badges });
  } catch (error) {
    console.error("Error fetching public badges:", error);
    res.status(500).json({ error: "Failed to fetch badges" });
  }
});

module.exports = router;
