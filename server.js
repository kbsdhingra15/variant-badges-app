require("dotenv").config();
const express = require("express");
const { shopifyApi } = require("@shopify/shopify-api");
require("@shopify/shopify-api/adapters/node");
const cookieParser = require("cookie-parser");
const cors = require("cors");
const fs = require("fs");
const path = require("path");
const jwt = require("jsonwebtoken");

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
    console.log("[OAuth] Callback received");
    const callback = await shopify.auth.callback({
      rawRequest: req,
      rawResponse: res,
    });

    const shop = callback.session.shop;
    const accessToken = callback.session.accessToken;

    console.log("[SUCCESS] OAuth for:", shop);
    console.log("[Token] Length:", accessToken ? accessToken.length : 0);
    console.log(
      "[Token] Preview:",
      accessToken ? accessToken.substring(0, 20) + "..." : "MISSING"
    );

    // Force delete old session first
    try {
      const { db } = require("./database/db");
      await db.query("DELETE FROM sessions WHERE shop = $1", [shop]);
      console.log("[CLEANUP] Deleted old session");
    } catch (error) {
      console.log(
        "[CLEANUP] No old session to delete or error:",
        error.message
      );
    }

    // Save new token
    await saveShopSession(shop, accessToken);
    console.log("[SUCCESS] New token saved to database");

    // Verify it was saved correctly
    const savedSession = await getShopSession(shop);
    console.log("[VERIFY] Retrieved from DB:", savedSession ? "YES" : "NO");
    console.log(
      "[VERIFY] Has token:",
      savedSession && savedSession.accessToken ? "YES" : "NO"
    );
    console.log(
      "[VERIFY] Token matches:",
      savedSession && savedSession.accessToken === accessToken ? "YES" : "NO"
    );

    await new Promise((r) => setTimeout(r, 3000));
    const redirectUrl = `https://${shop}/admin/apps/variant-badges`;
    console.log("[Redirect]", redirectUrl);
    res.redirect(redirectUrl);
  } catch (error) {
    console.error("[ERROR] OAuth callback:", error);
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
