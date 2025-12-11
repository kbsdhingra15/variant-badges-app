const { pool } = require("./database/db");
require("dotenv").config();
const express = require("express");
const { shopifyApi } = require("@shopify/shopify-api");
require("@shopify/shopify-api/adapters/node");
const cookieParser = require("cookie-parser");
const cors = require("cors");
const fs = require("fs");
const path = require("path");
const jwt = require("jsonwebtoken");
const db = require("./database/db");

const { initDB, saveShopSession, getShopSession } = require("./database/db");
const productsRouter = require("./routes/products");
const badgesRouter = require("./routes/badges");
const settingsRouter = require("./routes/settings");
const publicRouter = require("./routes/public");
const authRouter = require("./routes/auth");
const setupRouter = require("./routes/setup");

const app = express();
const PORT = process.env.PORT || 3000;

initDB().catch((error) => {
  console.error("[ERROR] Failed to initialize database:", error);
  process.exit(1);
});

const shopify = shopifyApi({
  apiKey: process.env.SHOPIFY_API_KEY,
  apiSecretKey: process.env.SHOPIFY_API_SECRET,
  scopes: process.env.SCOPES.split(","),
  hostName: process.env.HOST.replace(/https?:\/\//, ""),
  apiVersion: "2024-10",
  isEmbeddedApp: true,
  isCustomStoreApp: false,
});

app.use(
  cors({
    origin: ["https://admin.shopify.com", process.env.SHOP_URL].filter(Boolean),
    credentials: true,
    methods: ["GET", "POST", "PUT", "DELETE", "OPTIONS"],
    allowedHeaders: ["Content-Type", "Authorization"],
  })
);

app.use(express.json());

// CORS headers for embedded app
app.use((req, res, next) => {
  const origin = req.headers.origin;
  if (origin) {
    res.header("Access-Control-Allow-Origin", origin);
    res.header("Access-Control-Allow-Credentials", "true");
  }
  res.header("Access-Control-Allow-Methods", "GET, POST, PUT, DELETE, OPTIONS");
  res.header("Access-Control-Allow-Headers", "Content-Type, Authorization");
  if (req.method === "OPTIONS") {
    return res.sendStatus(200);
  }
  next();
});

app.use(cookieParser());

app.get("/health", (req, res) => {
  res.json({
    status: "ok",
    message: "Variant Badges App is running",
    version: "2.3.0",
    api: "GraphQL",
    auth: "JWT Secure",
    timestamp: new Date().toISOString(),
  });
});

// Debug endpoint to check database session
app.get("/debug/session", async (req, res) => {
  try {
    const { shop } = req.query;
    if (!shop) return res.status(400).json({ error: "Missing shop" });

    const session = await getShopSession(shop);

    res.json({
      shop,
      hasSession: !!session,
      hasAccessToken: !!(session && session.accessToken),
      tokenPreview:
        session && session.accessToken
          ? session.accessToken.substring(0, 20) + "..."
          : null,
      sessionData: session
        ? {
            shop: session.shop,
            hasToken: !!session.accessToken,
          }
        : null,
    });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Test if token actually works with Shopify API
app.get("/debug/test-token", async (req, res) => {
  try {
    const { shop } = req.query;
    if (!shop) return res.status(400).json({ error: "Missing shop" });

    const session = await getShopSession(shop);
    if (!session || !session.accessToken) {
      return res.status(401).json({ error: "No session found" });
    }

    console.log("[DEBUG] Testing token for:", shop);
    console.log(
      "[DEBUG] Token preview:",
      session.accessToken.substring(0, 20) + "..."
    );

    // Try to make a simple API call to Shopify
    const client = new shopify.clients.Graphql({
      session: {
        shop: shop,
        accessToken: session.accessToken,
      },
    });

    const response = await client.query({
      data: `{
        shop {
          name
          email
        }
      }`,
    });

    console.log("[DEBUG] API call successful!");

    res.json({
      success: true,
      shopName: response.body.data.shop.name,
      shopEmail: response.body.data.shop.email,
      message: "✅ Token is valid and working with Shopify API!",
    });
  } catch (error) {
    console.error("[DEBUG] API call failed:", error.message);
    res.status(500).json({
      success: false,
      error: error.message,
      details: error.response ? error.response.errors : null,
    });
  }
});

// Clear invalid session (for debugging)
app.get("/debug/clear-session", async (req, res) => {
  try {
    const { shop } = req.query;
    if (!shop) return res.status(400).json({ error: "Missing shop" });

    // Delete session directly from database
    const { db } = require("./database/db");
    const result = await db.query(
      "DELETE FROM sessions WHERE shop = $1 RETURNING *",
      [shop]
    );

    console.log("[DEBUG] Cleared session for:", shop);
    console.log("[DEBUG] Deleted rows:", result.rowCount);

    res.json({
      success: true,
      deletedRows: result.rowCount,
      message: "Session cleared. Now reinstall the app at: /auth?shop=" + shop,
    });
  } catch (error) {
    console.error("[DEBUG] Failed to clear session:", error);
    res.status(500).json({ error: error.message });
  }
});

// ============================================
// JWT TOKEN GENERATION & VALIDATION
// ============================================

/**
 * Generate a secure JWT session token for a shop
 * This token proves the request is authenticated and authorized
 */
function generateSessionToken(shop) {
  const payload = {
    shop: shop,
    iss: process.env.SHOPIFY_API_KEY,
    iat: Math.floor(Date.now() / 1000),
  };

  return jwt.sign(payload, process.env.SHOPIFY_API_SECRET, {
    expiresIn: "8h", // Token valid for 8 hours
    audience: shop,
  });
}

/**
 * Secure authentication middleware using JWT tokens
 * Validates token signature and checks shop session exists
 */
async function authenticateRequest(req, res, next) {
  try {
    // Extract token from Authorization header
    const authHeader = req.headers.authorization;
    if (!authHeader || !authHeader.startsWith("Bearer ")) {
      console.log("❌ No valid Authorization header");
      return res.status(401).json({ error: "Authentication required" });
    }

    const token = authHeader.replace("Bearer ", "");

    // Verify JWT signature and decode
    let decoded;
    try {
      decoded = jwt.verify(token, process.env.SHOPIFY_API_SECRET);
    } catch (error) {
      console.log("❌ Invalid token signature:", error.message);
      return res.status(401).json({ error: "Invalid session token" });
    }

    const shop = decoded.shop;

    // Verify shop has active session in database
    const session = await getShopSession(shop);
    if (!session || !session.accessToken) {
      console.log("❌ No valid session for shop:", shop);
      return res.status(401).json({ error: "Shop session expired" });
    }

    // Format session to match what Shopify SDK routes expect
    const formattedSession = {
      shop: shop,
      accessToken: session.accessToken,
      state: "online",
      isOnline: false,
      scope: process.env.SCOPES,
    };

    // Attach shop and session to request for route handlers
    req.shop = shop;
    req.shopifySession = formattedSession; // Formatted for Shopify SDK
    req.shopSession = session; // Raw session from database

    console.log("✅ Authenticated request for:", shop);
    console.log(
      "   Token preview:",
      session.accessToken.substring(0, 20) + "..."
    );
    next();
  } catch (error) {
    console.error("❌ Authentication error:", error);
    res.status(500).json({ error: "Authentication failed" });
  }
}

// ============================================
// OAUTH FLOW
// ============================================

app.get("/auth", async (req, res) => {
  try {
    const { shop } = req.query;
    console.log("[OAuth] Start for:", shop);
    if (!shop) return res.status(400).send("Missing shop");
    const sanitizedShop = shopify.utils.sanitizeShop(shop, true);
    await shopify.auth.begin({
      shop: sanitizedShop,
      callbackPath: "/auth/callback",
      isOnline: false,
      rawRequest: req,
      rawResponse: res,
    });
  } catch (error) {
    console.error("[ERROR] OAuth:", error);
    res.status(500).send("OAuth failed: " + error.message);
  }
});
app.get("/auth/callback", async (req, res) => {
  try {
    const { shop, code } = req.query;

    if (!shop || !code) {
      return res.status(400).send("Missing shop or code");
    }

    console.log("✅ OAuth callback received for:", shop);

    // Exchange code for access token
    const tokenResponse = await fetch(
      `https://${shop}/admin/oauth/access_token`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          client_id: process.env.SHOPIFY_API_KEY,
          client_secret: process.env.SHOPIFY_API_SECRET,
          code: code,
        }),
      }
    );

    if (!tokenResponse.ok) {
      console.error("❌ Token exchange failed:", await tokenResponse.text());
      return res.status(500).send("OAuth token exchange failed");
    }

    const tokenData = await tokenResponse.json();
    const accessToken = tokenData.access_token;

    console.log("✅ Access token received");

    // CRITICAL: Verify token works before saving
    const testResponse = await fetch(
      `https://${shop}/admin/api/2024-10/shop.json`,
      {
        headers: {
          "X-Shopify-Access-Token": accessToken,
        },
      }
    );

    if (!testResponse.ok) {
      console.error("❌ Token verification failed:", testResponse.status);
      return res.status(500).send("Token is invalid");
    }

    console.log("✅ Token verified successfully");

    // Delete old session if exists
    await pool.query("DELETE FROM shops WHERE shop = $1", [shop]);
    console.log("✅ Deleted old session (if existed)");

    // Save new session
    const saved = await db.saveShopSession(shop, accessToken);

    if (!saved) {
      console.error("❌ Failed to save session to database");
      return res.status(500).send("Database save failed");
    }

    console.log("✅ Session saved successfully");

    // Verify it was saved
    const retrieved = await db.getShopSession(shop);
    if (!retrieved) {
      console.error("❌ Session not found after save");
      return res.status(500).send("Session verification failed");
    }

    console.log("✅ Session verified in database");

    // AUTO-REGISTER UNINSTALL WEBHOOK
    try {
      const webhookResponse = await fetch(
        `https://${shop}/admin/api/2024-10/webhooks.json`,
        {
          method: "POST",
          headers: {
            "X-Shopify-Access-Token": accessToken,
            "Content-Type": "application/json",
          },
          body: JSON.stringify({
            webhook: {
              topic: "app/uninstalled",
              address: `${
                process.env.HOST ||
                "https://variant-badges-app-production.up.railway.app"
              }/webhooks/app/uninstalled`,
              format: "json",
            },
          }),
        }
      );

      if (webhookResponse.ok) {
        console.log("✅ Uninstall webhook registered");
      } else {
        const webhookError = await webhookResponse.json();
        console.log(
          "⚠️ Webhook registration failed (might already exist):",
          webhookError
        );
      }
    } catch (webhookError) {
      console.error("⚠️ Webhook registration error:", webhookError);
      // Don't fail OAuth if webhook fails
    }

    // Redirect to embedded app
    const redirectUrl = `https://variant-badges-app-production.up.railway.app/app?shop=${shop}`;
    res.redirect(redirectUrl);
  } catch (error) {
    console.error("❌ OAuth callback error:", error);
    res.status(500).send("OAuth failed: " + error.message);
  }
});

// ============================================
// SESSION TOKEN ENDPOINT
// ============================================

/**
 * Generate a session token for the frontend
 * This endpoint is called once when the app loads
 * The token is then used for all subsequent API calls
 */
app.get("/auth/token", async (req, res) => {
  try {
    const { shop } = req.query;

    if (!shop) {
      return res.status(400).json({ error: "Missing shop parameter" });
    }

    // Verify shop has valid session
    const session = await getShopSession(shop);
    if (!session || !session.accessToken) {
      console.log("❌ No session for shop:", shop);
      return res.status(401).json({
        error: "Not authenticated",
        redirect: `/auth?shop=${shop}`,
      });
    }

    // Generate JWT token
    const token = generateSessionToken(shop);

    console.log("✅ Generated session token for:", shop);

    res.json({
      token,
      shop,
      expiresIn: 28800, // 8 hours in seconds
    });
  } catch (error) {
    console.error("❌ Token generation failed:", error);
    res.status(500).json({ error: "Failed to generate token" });
  }
});

// ============================================
// TOKEN GENERATION ROUTE (for routes/auth.js)
// ============================================
app.use("/auth", authRouter);

// Public API routes (no authentication required)
app.use("/api/public", publicRouter);

// Protected endpoints (require JWT authentication)
app.use("/api/products", authenticateRequest, productsRouter);
app.use("/api/badges", authenticateRequest, badgesRouter);
app.use("/api/settings", authenticateRequest, settingsRouter);
app.use("/api/setup", authenticateRequest, setupRouter);

// ============================================
// APP PAGE
// ============================================

app.get("/app", async (req, res) => {
  try {
    const { shop } = req.query;
    if (!shop) return res.status(400).send("Missing shop");
    console.log("[App] Serving for:", shop);

    // Prevent caching
    res.setHeader(
      "Cache-Control",
      "no-store, no-cache, must-revalidate, private"
    );
    res.setHeader("Pragma", "no-cache");
    res.setHeader("Expires", "0");

    const htmlPath = path.join(__dirname, "views", "app.html");
    let html = fs.readFileSync(htmlPath, "utf8");

    // Replace template variables
    html = html.replace(/{{APP_HOST}}/g, process.env.HOST);
    html = html.replace(/{{SHOPIFY_API_KEY}}/g, process.env.SHOPIFY_API_KEY);
    html = html.replace(/{{SHOP}}/g, shop);

    res.type("html").send(html);
  } catch (error) {
    console.error("[ERROR] App page:", error);
    res.status(500).send("Failed to load");
  }
});

app.get("/", (req, res) => {
  const { shop, host } = req.query;
  if (shop && host) return res.redirect(`/app?shop=${shop}&host=${host}`);
  res.redirect("/install");
});

app.get("/install", (req, res) => {
  res.send(`
    <!DOCTYPE html>
    <html>
      <head><title>Install Variant Badges</title></head>
      <body>
        <h1>Variant Badges</h1>
        <form action="/auth">
          <input name="shop" placeholder="store.myshopify.com" required>
          <button>Install</button>
        </form>
      </body>
    </html>
  `);
});

// Webhook handler for app uninstall
app.post(
  "/webhooks/app/uninstalled",
  express.raw({ type: "application/json" }),
  async (req, res) => {
    try {
      const shop = req.get("X-Shopify-Shop-Domain");
      console.log("🗑️ App uninstalled webhook received for:", shop);

      // Delete session from database
      await pool.query("DELETE FROM shops WHERE shop = $1", [shop]);
      console.log("✅ Session deleted for:", shop);

      res.status(200).send("OK");
    } catch (error) {
      console.error("❌ Uninstall webhook error:", error);
      res.status(500).send("Error");
    }
  }
);

app.listen(PORT, () => {
  console.log("");
  console.log("🚀 Variant Badges App Server Started");
  console.log("==================================");
  console.log(`📍 Port: ${PORT}`);
  console.log(`🌐 URL: ${process.env.HOST || "http://localhost:" + PORT}`);
  console.log(`🔐 Auth: JWT Secure (App Store Ready)`);
  console.log(`✨ Navigation: Clean horizontal tabs`);
  console.log("");
});
