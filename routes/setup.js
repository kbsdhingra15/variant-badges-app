const express = require("express");
const router = express.Router();
const { getShopSession } = require("../database/db");

// Check if theme extension is installed/enabled
router.get("/status", async (req, res) => {
  try {
    const shop = req.shop; // From middleware, not req.query

    console.log("🔍 Checking setup status for:", shop);

    // Get session from database (already have it in req.shopifySession, but keeping this for compatibility)
    const session = req.shopifySession || (await getShopSession(shop));
    if (!session || !session.accessToken) {
      return res.status(401).json({ error: "No session found" });
    }

    // Get active theme
    const themesResponse = await fetch(
      `https://${shop}/admin/api/2025-04/themes.json`,
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

    // Check multiple locations for our app block
    const assetKeys = [
      "templates/product.json",
      "sections/header-group.json",
      "sections/footer-group.json",
    ];

    let isEnabled = false;

    // We use a simple loop to check assets until we find a match
    for (const key of assetKeys) {
      try {
        const assetResponse = await fetch(
          `https://${shop}/admin/api/2025-01/themes/${activeTheme.id}/assets.json?asset[key]=${key}`,
          {
            headers: {
              "X-Shopify-Access-Token": session.accessToken,
            },
          }
        );

        if (assetResponse.ok) {
          const assetData = await assetResponse.json();
          if (assetData.asset && assetData.asset.value) {
            const content = assetData.asset.value;
            if (content.includes("variant-badges-display") || content.includes("variant_badges")) {
              console.log(`✅ Found app block in: ${key}`);
              isEnabled = true;
              break; // Found it!
            }
          }
        }
      } catch (err) {
        console.log(`⚠️ Skip check for ${key}:`, err.message);
      }
    }

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
    const shop = req.shop; // From middleware, not req.query

    console.log("🔗 Getting editor link for:", shop);

    // Get session from req.shopifySession (already have it from middleware)
    const session = req.shopifySession || (await getShopSession(shop));
    if (!session || !session.accessToken) {
      return res.status(401).json({ error: "No session found" });
    }

    // Get active theme
    const themesResponse = await fetch(
      `https://${shop}/admin/api/2025-04/themes.json`,
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

    console.log("✅ Editor link generated");

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
