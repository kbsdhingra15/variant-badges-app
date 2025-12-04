const express = require("express");
const router = express.Router();
const { getBadgeAssignments } = require("../database/db");

// Public badge endpoint for storefront (no authentication required)
router.get("/badges", async (req, res) => {
  try {
    const shop = req.query.shop;

    if (!shop) {
      return res.status(400).json({ error: "Missing shop parameter" });
    }

    const assignments = await getBadgeAssignments(shop);

    // Format: { "variant_id": "badge_type" }
    const badges = {};
    assignments.forEach((row) => {
      badges[row.variant_id] = row.badge_type;
    });

    // CORS headers for storefront access
    res.header("Access-Control-Allow-Origin", "*");
    res.header("Access-Control-Allow-Methods", "GET");
    res.header("Cache-Control", "public, max-age=300"); // Cache for 5 minutes

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

module.exports = router;
