const express = require("express");
const router = express.Router();
const { getAppSettings, saveAppSettings } = require("../database/db");

// Get settings for shop
router.get("/", async (req, res) => {
  try {
    const shop = req.query.shop;
    const settings = await getAppSettings(shop);

    res.json({
      selectedOption: settings.selectedOption || "",
      badgeDisplayEnabled: settings.badgeDisplayEnabled !== false,
      autoSaleEnabled: settings.autoSaleEnabled || false,
    });
  } catch (error) {
    console.error("Error fetching settings:", error);
    res.status(500).json({ error: "Failed to fetch settings" });
  }
});

// Save settings
router.post("/", async (req, res) => {
  try {
    const { shop, selectedOption, badgeDisplayEnabled, autoSaleEnabled } =
      req.body;

    await saveAppSettings(shop, {
      selected_option: selectedOption,
      badge_display_enabled: badgeDisplayEnabled,
      auto_sale_enabled: autoSaleEnabled,
    });

    res.json({ success: true });
  } catch (error) {
    console.error("Error saving settings:", error);
    res.status(500).json({ error: "Failed to save settings" });
  }
});

module.exports = router;
