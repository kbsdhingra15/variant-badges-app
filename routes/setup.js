const express = require("express");
const router = express.Router();
const { getShopSession } = require("../database/db");

// Check if theme extension is installed/enabled
router.get("/status", async (req, res) => {
  try {
    const { shop } = req.query;

    // Get session from database
    const session = await getShopSession(shop);
    if (!session || !session.accessToken) {
      return res.status(401).json({ error: "No session found" });
    }

    // Get active theme
    const themesResponse = await fetch(
      `https://${shop}/admin/api/2024-10/themes.json`,
      {
        headers: {
          "X-Shopify-Access-Token": session.accessToken,
        },
      }
    );

    if (!themesResponse.ok) {
      const errorText = await themesResponse.text();
      console.error("Themes API error:", themesResponse.status, errorText);
      return res.status(500).json({ error: "Failed to fetch themes" });
    }

    const themesData = await themesResponse.json();

    if (!themesData.themes || themesData.themes.length === 0) {
      return res.json({ enabled: false, theme: null });
    }

    const activeTheme = themesData.themes.find((t) => t.role === "main");

    if (!activeTheme) {
      return res.json({ enabled: false, theme: null });
    }

    // Check product template for our app block
    const assetResponse = await fetch(
      `https://${shop}/admin/api/2024-10/themes/${activeTheme.id}/assets.json?asset[key]=templates/product.json`,
      {
        headers: {
          "X-Shopify-Access-Token": session.accessToken,
        },
      }
    );

    if (!assetResponse.ok) {
      console.error("Asset API error:", assetResponse.status);
      return res.json({
        enabled: false,
        theme: activeTheme.name,
        themeId: activeTheme.id,
      });
    }

    const assetData = await assetResponse.json();

    if (!assetData.asset) {
      return res.json({
        enabled: false,
        theme: activeTheme.name,
        themeId: activeTheme.id,
      });
    }

    // Check if our block exists in the template
    const templateContent = assetData.asset.value;
    const isEnabled =
      templateContent.includes("variant-badges-display") ||
      templateContent.includes("variant_badges");

    console.log(
      `✅ Setup check for ${shop}: ${isEnabled ? "ENABLED" : "NOT ENABLED"}`
    );

    res.json({
      enabled: isEnabled,
      theme: activeTheme.name,
      themeId: activeTheme.id,
      themeRole: activeTheme.role,
    });
  } catch (error) {
    console.error("Error checking setup status:", error);
    res.status(500).json({ error: error.message });
  }
});

// Get deep link to theme editor
router.get("/editor-link", async (req, res) => {
  try {
    const { shop } = req.query;

    // Get session from database
    const session = await getShopSession(shop);
    if (!session || !session.accessToken) {
      return res.status(401).json({ error: "No session found" });
    }

    // Get active theme
    const themesResponse = await fetch(
      `https://${shop}/admin/api/2024-10/themes.json`,
      {
        headers: {
          "X-Shopify-Access-Token": session.accessToken,
        },
      }
    );

    if (!themesResponse.ok) {
      return res.status(500).json({ error: "Failed to fetch themes" });
    }

    const themesData = await themesResponse.json();
    const activeTheme = themesData.themes?.find((t) => t.role === "main");

    if (!activeTheme) {
      return res.status(404).json({ error: "No active theme found" });
    }

    // Build deep link to theme editor
    const editorUrl = `https://${shop}/admin/themes/${activeTheme.id}/editor?context=apps`;

    res.json({
      editorUrl,
      themeName: activeTheme.name,
      themeId: activeTheme.id,
    });
  } catch (error) {
    console.error("Error getting editor link:", error);
    res.status(500).json({ error: error.message });
  }
});

module.exports = router;
