const crypto = require("crypto");
const compression = require("compression");
const { pool } = require("./database/db");
require("dotenv").config();
const express = require("express");
const cors = require("cors");
const { shopifyApi } = require("@shopify/shopify-api");
require("@shopify/shopify-api/adapters/node");
const cookieParser = require("cookie-parser");
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
// Webhook handler for app uninstall

app.post(
  "/webhooks/app/uninstalled",
  express.raw({ type: "application/json" }),
  async (req, res) => {
    try {
      // --- HMAC validation ---
      const hmacHeader = req.get("X-Shopify-Hmac-Sha256");
      const body = req.body; // Buffer (express.raw)
      const secret = process.env.SHOPIFY_API_SECRET;

      // Compute HMAC
      const hash = crypto
        .createHmac("sha256", secret)
        .update(body, "utf8")
        .digest("base64");

      if (hash !== hmacHeader) {
        console.warn(
          "❌ Uninstall webhook failed HMAC for shop:",
          req.get("X-Shopify-Shop-Domain")
        );
        return res.status(401).send("Invalid HMAC");
      }

      // Parse JSON body (since using express.raw, need to parse here)
      const payload = JSON.parse(body.toString("utf8"));
      const shop = req.get("X-Shopify-Shop-Domain");
      if (!shop) {
        return res.status(400).send("Missing shop domain header");
      }

      console.log("🗑️ App uninstalled webhook received for:", shop);

      // Delete session from database
      await pool.query("DELETE FROM shops WHERE shop = $1", [shop]);
      console.log("✅ Session deleted for:", shop);

      // Delete settings
      await pool.query("DELETE FROM app_settings WHERE shop = $1", [shop]);
      console.log("✅ Settings deleted for:", shop);

      // Delete badge assignments
      await pool.query("DELETE FROM badge_assignments WHERE shop = $1", [shop]);
      console.log("✅ Badge assignments deleted for:", shop);

      // Update subscription status
      const subResult = await pool.query(
        `UPDATE subscriptions 
           SET status = $1, updated_at = NOW() 
           WHERE shop = $2
           RETURNING plan_name, status`,
        ["uninstalled", shop]
      );

      if (subResult.rowCount > 0) {
        console.log(
          "✅ Subscription marked as uninstalled:",
          subResult.rows[0]
        );
      } else {
        console.log("ℹ️  No subscription to update");
      }

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
      // --- HMAC validation ---
      const hmacHeader = req.get("X-Shopify-Hmac-Sha256");
      const body = req.body; // Buffer
      const secret = process.env.SHOPIFY_API_SECRET;

      const hash = crypto
        .createHmac("sha256", secret)
        .update(body, "utf8")
        .digest("base64");

      if (hash !== hmacHeader) {
        console.warn(
          "❌ Customer data request webhook failed HMAC for:",
          req.get("X-Shopify-Shop-Domain")
        );
        return res.status(401).send("Invalid HMAC");
      }

      const shop = req.get("X-Shopify-Shop-Domain");
      const payload = JSON.parse(body.toString("utf8"));

      console.log("📋 GDPR: Customer data request for:", shop);
      console.log("   Customer ID:", payload.customer?.id);

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
      // --- HMAC validation ---
      const hmacHeader = req.get("X-Shopify-Hmac-Sha256");
      const body = req.body; // Buffer
      const secret = process.env.SHOPIFY_API_SECRET;

      const hash = crypto
        .createHmac("sha256", secret)
        .update(body, "utf8")
        .digest("base64");

      if (hash !== hmacHeader) {
        console.warn(
          "❌ Customer redact webhook failed HMAC for:",
          req.get("X-Shopify-Shop-Domain")
        );
        return res.status(401).send("Invalid HMAC");
      }

      const shop = req.get("X-Shopify-Shop-Domain");
      const payload = JSON.parse(body.toString("utf8"));

      console.log("🗑️ GDPR: Customer redact for:", shop);
      console.log("   Customer ID:", payload.customer?.id);

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
      // --- HMAC validation ---
      const hmacHeader = req.get("X-Shopify-Hmac-Sha256");
      const body = req.body; // Buffer
      const secret = process.env.SHOPIFY_API_SECRET;

      const hash = crypto
        .createHmac("sha256", secret)
        .update(body, "utf8")
        .digest("base64");

      if (hash !== hmacHeader) {
        console.warn(
          "❌ Shop redact webhook failed HMAC for:",
          req.get("X-Shopify-Shop-Domain")
        );
        return res.status(401).send("Invalid HMAC");
      }

      const shop = req.get("X-Shopify-Shop-Domain");

      console.log("🗑️ GDPR: Shop redact for:", shop);

      // Delete all shop data (same as uninstall)
      await pool.query("DELETE FROM shops WHERE shop = $1", [shop]);
      await pool.query("DELETE FROM app_settings WHERE shop = $1", [shop]);
      await pool.query("DELETE FROM badge_assignments WHERE shop = $1", [shop]);

      // Also mark subscription as deleted
      await pool.query(
        "UPDATE subscriptions SET status = $1, updated_at = NOW() WHERE shop = $2",
        ["uninstalled", shop]
      );

      console.log("✅ All shop data deleted for:", shop);

      res.status(200).send("OK");
    } catch (error) {
      console.error("❌ Shop redact error:", error);
      res.status(500).send("Error");
    }
  }
);
app.use(express.json());
// Serve static files from public directory
app.use(cookieParser());
app.use(express.static("public"));
// ========== CORS CONFIGURATION (embedded app) ==========
const allowedOrigins = [
  "https://admin.shopify.com",
  "https://quickstart-c559582d.myshopify.com", // Your store
  "https://variant-badges-app-production.up.railway.app",
];

// Add dynamic origins from env if present
if (process.env.SHOP_URL) allowedOrigins.push(process.env.SHOP_URL);

app.use(
  cors({
    origin: (origin, callback) => {
      // Allow requests with no origin (mobile apps, Postman, etc.)
      if (!origin) return callback(null, true);

      // Allow all *.myshopify.com domains (merchant stores)
      if (origin.endsWith(".myshopify.com")) {
        return callback(null, true);
      }
      // Allow all *.shopifypreview.com domains (preview mode)
      if (origin.endsWith(".shopifypreview.com")) {
        return callback(null, true);
      }
      // Allow specific origins
      if (allowedOrigins.includes(origin)) {
        return callback(null, true);
      }

      // Block everything else
      callback(new Error("Not allowed by CORS"));
    },
    credentials: true,
    methods: ["GET", "POST", "PUT", "DELETE", "OPTIONS"],
    allowedHeaders: ["Content-Type", "Authorization", "X-Requested-With"],
  })
);
// ========== END CORS ==========
app.use(compression());
// ========== SECURITY HEADERS ==========
app.use((req, res, next) => {
  // Prevent clickjacking - only allow embedding in Shopify Admin
  res.setHeader("X-Frame-Options", "ALLOW-FROM https://admin.shopify.com");

  // Content Security Policy - allow embedding only from Shopify
  res.setHeader(
    "Content-Security-Policy",
    "frame-ancestors https://admin.shopify.com https://*.myshopify.com"
  );

  // Prevent MIME type sniffing
  res.setHeader("X-Content-Type-Options", "nosniff");

  // Enable XSS protection
  res.setHeader("X-XSS-Protection", "1; mode=block");

  // Prevent browsers from sending referrer info to other sites
  res.setHeader("Referrer-Policy", "strict-origin-when-cross-origin");

  next();
});
// ========== END SECURITY HEADERS ==========
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
// TEMPORARY: Manually delete session to force fresh OAuth
app.get("/admin/delete-session", async (req, res) => {
  const shop = "quickstart-c559582d.myshopify.com";

  try {
    console.log("🗑️ Manually deleting session for:", shop);
    await db.deleteShopSession(shop);
    console.log("✅ Session deleted successfully");

    res.json({
      success: true,
      message: "Session deleted. Now visit the auth URL to reinstall.",
      authUrl: `https://variant-badges-app-production.up.railway.app/auth?shop=${shop}`,
    });
  } catch (error) {
    console.error("❌ Error deleting session:", error);
    res.status(500).json({
      success: false,
      error: error.message,
    });
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
      console.log(
        `❌ No valid Authorization header - ${req.method} ${req.originalUrl}`
      ); // ← CHANGED THIS LINE
      return res.status(401).json({ error: "Authentication required" });
    }

    const token = authHeader.replace("Bearer ", "");

    // Verify JWT signature and decode
    let decoded;
    try {
      decoded = jwt.verify(token, process.env.SHOPIFY_API_SECRET);
    } catch (error) {
      console.log(
        `❌ Invalid token signature: ${error.message} - ${req.method} ${req.originalUrl}`
      ); // ← CHANGED THIS LINE
      return res.status(401).json({ error: "Invalid session token" });
    }

    const shop = decoded.shop;

    // Verify shop has active session in database
    const session = await getShopSession(shop);
    if (!session || !session.accessToken) {
      console.log(
        `❌ No valid session for shop: ${shop} - ${req.method} ${req.originalUrl}`
      ); // ← CHANGED THIS LINE
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
    console.log("🔄 Starting webhook registration...");

    // Regular webhook via GraphQL
    const regularWebhook = {
      topic: "APP_UNINSTALLED",
      path: "/webhooks/app/uninstalled",
    };

    // GDPR mandatory webhooks via REST
    const gdprWebhooks = [
      {
        topic: "customers/data_request",
        path: "/webhooks/customers/data_request",
      },
      { topic: "customers/redact", path: "/webhooks/customers/redact" },
      { topic: "shop/redact", path: "/webhooks/shop/redact" },
    ];

    // Register APP_UNINSTALLED via GraphQL
    try {
      const webhookUrl = `https://variant-badges-app-production.up.railway.app${regularWebhook.path}`;
      console.log(`🔄 Registering: ${regularWebhook.topic} (GraphQL)`);

      const mutation = `
    mutation {
      webhookSubscriptionCreate(
        topic: ${regularWebhook.topic}
        webhookSubscription: {
          callbackUrl: "${webhookUrl}"
          format: JSON
        }
      ) {
        webhookSubscription {
          id
        }
        userErrors {
          message
        }
      }
    }
  `;

      const graphqlResponse = await fetch(
        `https://${shop}/admin/api/2024-10/graphql.json`,
        {
          method: "POST",
          headers: {
            "X-Shopify-Access-Token": accessToken,
            "Content-Type": "application/json",
          },
          body: JSON.stringify({ query: mutation }),
        }
      );

      const result = await graphqlResponse.json();
      if (result.data?.webhookSubscriptionCreate?.webhookSubscription) {
        console.log(`✅ Registered webhook: ${regularWebhook.topic}`);
      }
    } catch (error) {
      console.error(`❌ Error registering APP_UNINSTALLED:`, error.message);
    }

    // Register GDPR webhooks via REST API
    console.log(`📋 Registering ${gdprWebhooks.length} GDPR webhooks via REST`);

    for (const webhook of gdprWebhooks) {
      try {
        const webhookUrl = `https://variant-badges-app-production.up.railway.app${webhook.path}`;

        console.log(`🔄 Registering: ${webhook.topic}`);
        console.log(`   URL: ${webhookUrl}`);

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
                address: webhookUrl,
                format: "json",
              },
            }),
          }
        );

        const responseData = await webhookResponse.json();
        console.log(`   Response status: ${webhookResponse.status}`);

        if (webhookResponse.ok && responseData.webhook) {
          console.log(
            `✅ Registered webhook: ${webhook.topic} (ID: ${responseData.webhook.id})`
          );
        } else {
          console.log(`⚠️ Webhook ${webhook.topic} response:`, responseData);
        }
      } catch (error) {
        console.error(`❌ Error registering ${webhook.topic}:`, error.message);
      }
    }

    console.log("✅ Webhook registration complete"); //TEMP DELETE
    // ========== INITIALIZE FREE PLAN (NO TRIAL) ==========
    // Initialize Free plan subscription on install
    try {
      const { getSubscription, saveSubscription } = require("./database/db");
      const existingSub = await getSubscription(shop);

      if (!existingSub) {
        // First install - create Free plan
        console.log("💳 First install - initializing Free plan for:", shop);
        await saveSubscription(shop, {
          plan_name: "free",
          status: "active",
        });
        console.log("✅ Free plan initialized");
      } else if (
        existingSub.status === "uninstalled" ||
        existingSub.status === "cancelled"
      ) {
        // ========== FIX: Reset to Free on reinstall ==========
        console.log("🔄 Reinstall detected - resetting to Free plan");
        console.log(
          "   Previous state:",
          existingSub.plan_name,
          existingSub.status
        );

        await saveSubscription(shop, {
          plan_name: "free",
          status: "active",
          charge_id: null,
          billing_on: null,
          cancelled_at: null,
        });
        console.log("✅ Reset to Free plan");
        // ========== END FIX ==========
      } else {
        console.log("💳 Active subscription exists - keeping it");
      }
    } catch (billingError) {
      console.error("⚠️  Failed to initialize subscription:", billingError);
      // Don't fail OAuth if subscription init fails
    }
    // ========== END INITIALIZATION ==========

    /* OLD CODE TO SHOW SUCCESS PAGE REDIRECT ON INSTALL TEMP // Show success page
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
`); OLD CODE TO RESTORE FOR SUCCES PAGE */

    // ✅ Redirect to embedded app (not separate page) NEW CODE TEST
    console.log("🔄 Redirecting to embedded app...");
    const appUrl = `https://${shop}/admin/apps/${process.env.SHOPIFY_API_KEY}`;
    res.redirect(appUrl); // NEW CODE ENDS HERE
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
app.use("/api/analytics", analyticsRoutes);
// Protected endpoints (require JWT authentication)
app.use("/api/products", authenticateRequest, productsRouter);
app.use("/api/badges", authenticateRequest, badgesRouter);
app.use("/api/settings", authenticateRequest, settingsRouter);
app.use("/api/setup", authenticateRequest, setupRouter);
// Billing routes - activate is public, rest requires auth
// ========== PUBLIC BILLING CALLBACK (no auth) ==========
app.get("/api/billing/activate", async (req, res) => {
  try {
    let { shop, charge_id } = req.query;

    if (Array.isArray(charge_id)) {
      console.log("⚠️ charge_id came as array:", charge_id);
      charge_id = charge_id.find(
        (id) => id !== "{charge_id}" && !id.includes("{")
      );
      console.log("✅ Using charge_id:", charge_id);
    }

    if (!shop || !charge_id) {
      console.log("❌ Missing shop or charge_id");
      return res.redirect(
        `https://${shop}/admin/apps/${process.env.SHOPIFY_API_KEY}`
      );
    }

    console.log("💳 Activating charge:", charge_id, "for shop:", shop);

    const { getShopSession, saveSubscription } = require("./database/db");
    const session = await getShopSession(shop);

    if (!session) {
      console.error("❌ No session found for shop:", shop);
      return res.redirect(
        `https://${shop}/admin/apps/${process.env.SHOPIFY_API_KEY}`
      );
    }

    console.log("✅ Session found for shop:", shop);
    const accessToken = session.accessToken;

    // Get charge details from Shopify
    console.log("📞 Fetching charge details from Shopify...");
    const response = await fetch(
      `https://${shop}/admin/api/2024-10/recurring_application_charges/${charge_id}.json`,
      {
        method: "GET",
        headers: {
          "X-Shopify-Access-Token": accessToken,
        },
      }
    );

    console.log("📊 Charge fetch response status:", response.status);
    const data = await response.json();
    console.log("📊 Charge data:", JSON.stringify(data, null, 2));

    const charge = data.recurring_application_charge;
    console.log("📊 Charge status:", charge?.status);

    if (charge.status === "accepted" || charge.status === "active") {
      console.log("✅ Charge accepted - activating...");

      // Activate the charge
      const activateResponse = await fetch(
        `https://${shop}/admin/api/2024-10/recurring_application_charges/${charge_id}/activate.json`,
        {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "X-Shopify-Access-Token": accessToken,
          },
          body: JSON.stringify({
            recurring_application_charge: {
              id: charge_id,
            },
          }),
        }
      );

      console.log("📊 Activate response status:", activateResponse.status);
      const activateData = await activateResponse.json();
      console.log("📊 Activate data:", JSON.stringify(activateData, null, 2));

      if (activateData.recurring_application_charge) {
        console.log("💾 Saving Pro subscription to database...");

        await saveSubscription(shop, {
          plan_name: "pro",
          status: "active",
          charge_id: charge_id.toString(),
          billing_on: activateData.recurring_application_charge.billing_on,
          trial_ends_at: null,
          cancelled_at: null,
        });

        console.log(`✅ Activated Pro plan for ${shop}`);

        return res.redirect(
          `https://${shop}/admin/apps/${process.env.SHOPIFY_API_KEY}?upgraded=true`
        );
      } else {
        console.log("❌ No recurring_application_charge in activate response");
      }
    } else if (charge.status === "declined") {
      console.log(`❌ Charge declined by ${shop}`);

      await saveSubscription(shop, {
        plan_name: "free",
        status: "active",
        charge_id: null,
      });
    } else {
      console.log(`⚠️ Unexpected charge status: ${charge.status}`);
    }

    console.log("🔄 Redirecting back to app...");
    res.redirect(`https://${shop}/admin/apps/${process.env.SHOPIFY_API_KEY}`);
  } catch (error) {
    console.error("❌ Error activating charge:", error);
    res.redirect(
      `https://${req.query.shop}/admin/apps/${process.env.SHOPIFY_API_KEY}?error=activation_failed`
    );
  }
});
// ========== END PUBLIC CALLBACK ==========

// Now register other billing routes (protected)
app.use("/api/billing", authenticateRequest, billingRouter);

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
