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
    res.header("Cache-Control", "public, max-age=10");

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

// Get badges for specific product (SCALABLE - filters by selected option)
router.get("/badges/product/:productId", async (req, res) => {
  try {
    const { shop } = req.query;
    const { productId } = req.params;

    if (!shop || !productId) {
      return res.status(400).json({ error: "Missing parameters" });
    }

    // Get selected option type
    const { getAppSettings } = require("../database/db");
    const settings = await getAppSettings(shop);
    const selectedOption = settings.selectedOption;

    if (!selectedOption) {
      res.header("Access-Control-Allow-Origin", "*");
      res.header("Cache-Control", "public, max-age=10");
      return res.json({ badges: {}, selectedOption: null });
    }

    const assignments = await getBadgeAssignments(shop);

    // Filter: only badges for THIS product AND THIS option type
    const badges = {};
    assignments
      .filter(
        (row) =>
          row.product_id === productId && row.option_type === selectedOption // ← KEY FILTER
      )
      .forEach((row) => {
        badges[row.variant_id] = row.badge_type;
      });

    res.header("Access-Control-Allow-Origin", "*");
    res.header("Cache-Control", "public, max-age=10");

    console.log(
      `📦 Badges for product ${productId}, option "${selectedOption}": ${
        Object.keys(badges).length
      }`
    );

    res.json({ badges, selectedOption });
  } catch (error) {
    console.error("Error fetching badges:", error);
    res.status(500).json({ error: "Failed to fetch badges" });
  }
});

module.exports = router;
