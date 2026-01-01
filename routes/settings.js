const express = require("express");
const router = express.Router();
const { getAppSettings, saveAppSettings, pool } = require("../database/db");

// Get settings for shop
router.get("/", async (req, res) => {
  try {
    const shop = req.shop; // From middleware, not req.query

    console.log("🔍 Getting settings for:", shop);

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
    const shop = req.shop; // From middleware, not req.body
    const { selectedOption, badgeDisplayEnabled, autoSaleEnabled, enabled } =
      req.body;

    console.log("💾 Saving settings for:", shop);
    console.log("   Settings:", {
      selectedOption,
      badgeDisplayEnabled,
      autoSaleEnabled,
      enabled,
    });

    // Get current settings to check if option changed
    const currentSettings = await getAppSettings(shop);
    const oldOption = currentSettings?.selectedOption;
    let badgesDeleted = false;
    let deletedCount = 0;

    // If option type changed, delete all badge assignments
    if (oldOption && oldOption !== selectedOption) {
      const result = await pool.query(
        "DELETE FROM badge_assignments WHERE shop = $1",
        [shop]
      );
      badgesDeleted = true;
      deletedCount = result.rowCount;
      console.log(
        `🗑️ Deleted ${deletedCount} badges due to option change: ${oldOption} → ${selectedOption}`
      );
    }

    await saveAppSettings(shop, {
      selected_option: selectedOption,
      badge_display_enabled:
        badgeDisplayEnabled !== undefined ? badgeDisplayEnabled : enabled, // Support both field names
      auto_sale_enabled: autoSaleEnabled,
    });

    console.log("✅ Settings saved successfully");

    res.json({
      success: true,
      badgesDeleted,
      deletedCount,
    });
  } catch (error) {
    console.error("Error saving settings:", error);
    res.status(500).json({ error: "Failed to save settings" });
  }
});

module.exports = router;
