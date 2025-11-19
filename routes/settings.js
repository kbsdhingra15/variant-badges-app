const express = require("express");
const router = express.Router();
const { getAppSettings, saveAppSettings } = require("../database/db");

// GET /api/settings - Get app settings for this shop
router.get("/settings", async (req, res) => {
  try {
    const { shop } = req.shopifySession;
    console.log("⚙️  Fetching settings for shop:", shop);

    const settings = await getAppSettings(shop);

    res.json({
      settings,
      message: "Settings retrieved successfully",
    });
  } catch (error) {
    console.error("❌ Error fetching settings:", error);
    res.status(500).json({
      error: "Internal server error",
      details: error.message,
    });
  }
});

// POST /api/settings - Save app settings
router.post("/settings", async (req, res) => {
  try {
    const { shop } = req.shopifySession;
    const { selectedOption } = req.body;

    console.log("⚙️  Saving settings for shop:", shop);
    console.log("   Selected option:", selectedOption);

    // Validate that selectedOption is provided
    if (!selectedOption) {
      return res.status(400).json({
        error: "Missing required field: selectedOption",
      });
    }

    // Valid option types: Color, Size, Material, Style, etc.
    // We're flexible here - merchant can choose any option name they want
    await saveAppSettings(shop, selectedOption);

    res.json({
      success: true,
      message: "Settings saved successfully",
      settings: {
        selectedOption,
      },
    });
  } catch (error) {
    console.error("❌ Error saving settings:", error);
    res.status(500).json({
      error: "Internal server error",
      details: error.message,
    });
  }
});

module.exports = router;
