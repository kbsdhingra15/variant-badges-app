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
const analyticsRoutes = require("./routes/analytics");
const billingRouter = require("./routes/billing");
const app = express();
// Body parser
app.use(express.json());
// Serve static files from public directory
app.use(express.static("public"));
// ← ADD CORS MIDDLEWARE HERE (before routes)
app.use((req, res, next) => {
  res.header("Access-Control-Allow-Origin", "*");
  res.header("Access-Control-Allow-Methods", "GET, POST, PUT, DELETE, OPTIONS");
  res.header("Access-Control-Allow-Headers", "Content-Type, Authorization");

  // Handle preflight
  if (req.method === "OPTIONS") {
    return res.status(200).end();
  }

  next();
});
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

    // AUTO-REGISTER ALL WEBHOOKS (including GDPR)
    const webhooks = [
      { topic: "app/uninstalled", path: "/webhooks/app/uninstalled" },
      {
        topic: "customers/data_request",
        path: "/webhooks/customers/data_request",
      },
      { topic: "customers/redact", path: "/webhooks/customers/redact" },
      { topic: "shop/redact", path: "/webhooks/shop/redact" },
    ];

    for (const webhook of webhooks) {
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
                topic: webhook.topic,
                address: `${
                  process.env.HOST ||
                  "https://variant-badges-app-production.up.railway.app"
                }${webhook.path}`,
                format: "json",
              },
            }),
          }
        );

        if (webhookResponse.ok) {
          console.log(`✅ Registered webhook: ${webhook.topic}`);
        } else {
          const error = await webhookResponse.json();
          console.log(`⚠️ Webhook ${webhook.topic} failed:`, error.errors);
        }
      } catch (webhookError) {
        console.error(`⚠️ Webhook ${webhook.topic} error:`, webhookError);
      }
    }
    // Show success page
    const shopSlug = shop.replace(".myshopify.com", "");
    res.send(`
  <!DOCTYPE html>
  <html>
    <head>
      <title>Installation Complete</title>
      <style>
        body {
          font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
          max-width: 500px;
          margin: 100px auto;
          text-align: center;
          padding: 40px;
          background: #f6f6f7;
        }
        .card {
          background: white;
          border-radius: 8px;
          padding: 40px;
          box-shadow: 0 2px 8px rgba(0,0,0,0.1);
        }
        h1 { color: #008060; margin-bottom: 16px; }
        p { color: #6d7175; line-height: 1.6; margin-bottom: 24px; }
        .button {
          display: inline-block;
          background: #008060;
          color: white;
          padding: 12px 24px;
          border-radius: 4px;
          text-decoration: none;
          font-weight: 500;
        }
        .button:hover { background: #006e52; }
      </style>
    </head>
    <body>
      <div class="card">
        <h1>✅ Installation Complete!</h1>
        <p>Variant Badges has been successfully installed.</p>
        <p>Click the button below to return to admin and then click "Variant Badges" in your apps sidebar to start assigning badges.</p>
        <a href="https://admin.shopify.com/store/${shopSlug}" class="button">
          Open Shopify Admin
        </a>
      </div>
    </body>
  </html>
`);
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
app.use("/api/analytics", analyticsRoutes);
app.use("/api/billing", billingRouter);
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

      // DELETE SETTINGS TOO
      await pool.query("DELETE FROM app_settings WHERE shop = $1", [shop]);
      console.log("✅ Settings deleted for:", shop);

      // DELETE BADGE ASSIGNMENTS TOO
      await pool.query("DELETE FROM badge_assignments WHERE shop = $1", [shop]);
      console.log("✅ Badge assignments deleted for:", shop);

      res.status(200).send("OK");
    } catch (error) {
      console.error("❌ Uninstall webhook error:", error);
      res.status(500).send("Error");
    }
  }
);
// GDPR Webhook: Customer data request
app.post(
  "/webhooks/customers/data_request",
  express.raw({ type: "application/json" }),
  async (req, res) => {
    try {
      const shop = req.get("X-Shopify-Shop-Domain");
      const body = JSON.parse(req.body.toString());

      console.log("📋 GDPR: Customer data request for:", shop);
      console.log("   Customer ID:", body.customer?.id);

      // We don't store any customer personal data
      res.status(200).json({
        message: "No customer data stored",
        data: {},
      });
    } catch (error) {
      console.error("❌ Customer data request error:", error);
      res.status(500).send("Error");
    }
  }
);

// GDPR Webhook: Customer redact (delete customer data)
app.post(
  "/webhooks/customers/redact",
  express.raw({ type: "application/json" }),
  async (req, res) => {
    try {
      const shop = req.get("X-Shopify-Shop-Domain");
      const body = JSON.parse(req.body.toString());

      console.log("🗑️ GDPR: Customer redact for:", shop);
      console.log("   Customer ID:", body.customer?.id);

      // We don't store customer data, nothing to delete
      res.status(200).send("OK");
    } catch (error) {
      console.error("❌ Customer redact error:", error);
      res.status(500).send("Error");
    }
  }
);

// GDPR Webhook: Shop redact (delete all shop data)
app.post(
  "/webhooks/shop/redact",
  express.raw({ type: "application/json" }),
  async (req, res) => {
    try {
      const shop = req.get("X-Shopify-Shop-Domain");

      console.log("🗑️ GDPR: Shop redact for:", shop);

      // Delete all shop data (same as uninstall)
      await pool.query("DELETE FROM shops WHERE shop = $1", [shop]);
      await pool.query("DELETE FROM app_settings WHERE shop = $1", [shop]);
      await pool.query("DELETE FROM badge_assignments WHERE shop = $1", [shop]);

      console.log("✅ All shop data deleted for:", shop);

      res.status(200).send("OK");
    } catch (error) {
      console.error("❌ Shop redact error:", error);
      res.status(500).send("Error");
    }
  }
);
// Privacy Policy page
app.get("/privacy-policy", (req, res) => {
  const fs = require("fs");
  const path = require("path");
  const htmlPath = path.join(__dirname, "views", "privacy-policy.html");
  const html = fs.readFileSync(htmlPath, "utf8");
  res.type("html").send(html);
});
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
