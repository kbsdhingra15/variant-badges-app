const express = require("express");
const router = express.Router();
const { pool } = require("../database/db");

// Public endpoint - called from storefront
router.post("/track", async (req, res) => {
  try {
    const {
      shop,
      product_id,
      variant_id,
      badge_type,
      option_value,
      event_type,
      session_id,
    } = req.body;

    // Basic validation
    if (!shop || !event_type) {
      return res.status(400).json({ error: "Missing required fields" });
    }

    // Silent insert (don't block if fails)
    await pool
      .query(
        `INSERT INTO badge_analytics 
       (shop, product_id, variant_id, badge_type, option_value, event_type, session_id)
       VALUES ($1, $2, $3, $4, $5, $6, $7)`,
        [
          shop,
          product_id,
          variant_id,
          badge_type,
          option_value,
          event_type,
          session_id,
        ]
      )
      .catch((err) => {
        console.error("Analytics insert error:", err);
      });

    res.json({ success: true });
  } catch (error) {
    console.error("Analytics error:", error);
    res.json({ success: true }); // Always return success
  }
});

module.exports = router;
