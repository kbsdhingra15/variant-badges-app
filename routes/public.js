const express = require("express");
const router = express.Router();
const { getBadgeAssignments } = require("../database/db");

// Get all badges for shop (existing route - keep for backward compatibility)
router.get("/badges", async (req, res) => {
  try {
    const shop = req.query.shop;

    if (!shop) {
      return res.status(400).json({ error: "Missing shop parameter" });
    }

    const assignments = await getBadgeAssignments(shop);

    const badges = {};
    assignments.forEach((row) => {
      badges[row.variant_id] = row.badge_type;
    });

    res.header("Access-Control-Allow-Origin", "*");
    res.header("Access-Control-Allow-Methods", "GET");
    res.header("Cache-Control", "public, max-age=300");

    console.log(
      `📦 Public badges served for ${shop}: ${
        Object.keys(badges).length
      } assignments`
    );

    res.json({ badges });
  } catch (error) {
    console.error("❌ Error fetching public badges:", error);
    res.status(500).json({ error: "Failed to fetch badges" });
  }
});

// Get badges for specific product (SCALABLE - use this!)
router.get("/badges/product/:productId", async (req, res) => {
  try {
    const { shop } = req.query;
    const { productId } = req.params;

    if (!shop || !productId) {
      return res
        .status(400)
        .json({ error: "Missing shop or productId parameter" });
    }

    const assignments = await getBadgeAssignments(shop);

    // Filter to only this product's variants
    const badges = {};
    assignments
      .filter((row) => row.product_id === productId)
      .forEach((row) => {
        badges[row.variant_id] = row.badge_type;
      });

    res.header("Access-Control-Allow-Origin", "*");
    res.header("Access-Control-Allow-Methods", "GET");
    res.header("Cache-Control", "public, max-age=600"); // 10 minutes

    console.log(
      `📦 Product badges served for ${shop}, product ${productId}: ${
        Object.keys(badges).length
      } badges`
    );

    res.json({ badges });
  } catch (error) {
    console.error("❌ Error fetching product badges:", error);
    res.status(500).json({ error: "Failed to fetch badges" });
  }
});

module.exports = router;
