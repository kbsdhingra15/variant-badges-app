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
      return res
        .status(400)
        .json({ error: "Missing shop or productId parameter" });
    }

    // Get selected option type from settings
    const { getAppSettings } = require("../database/db");
    const settings = await getAppSettings(shop);
    const selectedOption = settings.selectedOption;

    if (!selectedOption) {
      // No option type selected, return empty
      res.header("Access-Control-Allow-Origin", "*");
      res.header("Access-Control-Allow-Methods", "GET");
      res.header("Cache-Control", "public, max-age=10");
      return res.json({ badges: {} });
    }

    const assignments = await getBadgeAssignments(shop);

    // Filter to only this product's variants AND matching selected option
    const badges = {};
    assignments
      .filter((row) => {
        // Must match product AND option type
        return row.product_id === productId && row.option_value; // Has option value stored
      })
      .forEach((row) => {
        badges[row.variant_id] = row.badge_type;
      });

    res.header("Access-Control-Allow-Origin", "*");
    res.header("Access-Control-Allow-Methods", "GET");
    res.header("Cache-Control", "public, max-age=10");

    console.log(
      `📦 Product badges served for ${shop}, product ${productId}, option ${selectedOption}: ${
        Object.keys(badges).length
      } badges`
    );

    res.json({ badges, selectedOption }); // Also return selected option type
  } catch (error) {
    console.error("❌ Error fetching product badges:", error);
    res.status(500).json({ error: "Failed to fetch badges" });
  }
});

module.exports = router;
