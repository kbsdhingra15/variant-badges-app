require("dotenv").config();
const express = require("express");
const { shopifyApi } = require("@shopify/shopify-api");
require("@shopify/shopify-api/adapters/node");
const cookieParser = require("cookie-parser");
const cors = require("cors");
const fs = require("fs");
const path = require("path");

// Import database functions
const { initDB, saveShopSession, getShopSession } = require("./database/db");

// Import middleware
const { validateSessionToken } = require("./middleware/auth");

// Import routes
const productsRouter = require("./routes/products");
const badgesRouter = require("./routes/badges");
const settingsRouter = require("./routes/settings");

const app = express();
const PORT = process.env.PORT || 3000;

// Initialize database on startup
initDB().catch((error) => {
  console.error("❌ Failed to initialize database:", error);
  process.exit(1);
});

// Shopify API setup - EMBEDDED APP
const shopify = shopifyApi({
  apiKey: process.env.SHOPIFY_API_KEY,
  apiSecretKey: process.env.SHOPIFY_API_SECRET,
  scopes: process.env.SCOPES.split(","),
  hostName: process.env.HOST.replace(/https?:\/\//, ""),
  apiVersion: "2024-10",
  isEmbeddedApp: true,
  isCustomStoreApp: false,
});

// CORS configuration
app.use(
  cors({
    origin: ["https://admin.shopify.com", process.env.SHOP_URL].filter(Boolean),
    credentials: true,
    methods: ["GET", "POST", "PUT", "DELETE", "OPTIONS"],
    allowedHeaders: ["Content-Type", "Authorization"],
  })
);

app.use(express.json());
app.use(cookieParser());

// Health check
app.get("/health", (req, res) => {
  res.json({
    status: "ok",
    message: "Variant Badges App is running",
    version: "2.0.0 (Modular)",
    api: "GraphQL",
    timestamp: new Date().toISOString(),
  });
});

// OAuth Routes
// ============

// OAuth begin - for initial installation
app.get("/auth", async (req, res) => {
  try {
    const { shop } = req.query;
    console.log("🔐 OAuth start requested for shop:", shop);

    if (!shop) {
      return res.status(400).send("Missing shop parameter");
    }

    const sanitizedShop = shopify.utils.sanitizeShop(shop, true);
    console.log("   Sanitized shop:", sanitizedShop);

    await shopify.auth.begin({
      shop: sanitizedShop,
      callbackPath: "/auth/callback",
      isOnline: false,
      rawRequest: req,
      rawResponse: res,
    });
  } catch (error) {
    console.error("❌ OAuth begin error:", error);
    res.status(500).send("OAuth initialization failed: " + error.message);
  }
});

// OAuth callback - after merchant approves
app.get("/auth/callback", async (req, res) => {
  try {
    console.log("🔐 OAuth callback received");
    console.log("   Query params:", Object.keys(req.query));

    const callback = await shopify.auth.callback({
      rawRequest: req,
      rawResponse: res,
    });

    console.log("✅ OAuth successful!");
    console.log("   Shop:", callback.session.shop);
    console.log(
      "   Access Token:",
      callback.session.accessToken.substring(0, 20) + "..."
    );

    // Save to database
    await saveShopSession(callback.session.shop, callback.session.accessToken);

    // Small delay to ensure database write is fully propagated
    await new Promise((resolve) => setTimeout(resolve, 5000));

    // Redirect to the app (embedded in Shopify admin)
    const redirectUrl = `https://${callback.session.shop}/admin/apps/variant-badges`;
    console.log("🔄 Redirecting to:", redirectUrl);
    res.redirect(redirectUrl);
  } catch (error) {
    console.error("❌ OAuth callback error:", error);
    res.status(500).send("OAuth failed: " + error.message);
  }
});

// API Routes (with authentication)
// ================================

// Mount API routers with authentication middleware
app.use("/api", validateSessionToken(shopify), productsRouter);
app.use("/api", validateSessionToken(shopify), badgesRouter);
app.use("/api", validateSessionToken(shopify), settingsRouter);

// Debug endpoint to check authentication status
app.get("/api/check-auth", async (req, res) => {
  try {
    const { shop } = req.query;

    if (!shop) {
      return res.status(400).json({ error: "Missing shop parameter" });
    }

    console.log("🔍 Checking auth status for:", shop);
    const session = await getShopSession(shop);

    if (session) {
      console.log("✅ Shop is authenticated");
      return res.json({
        authenticated: true,
        shop: session.shop,
        hasAccessToken: !!session.accessToken,
      });
    } else {
      console.log("❌ Shop not authenticated");
      return res.json({
        authenticated: false,
        shop,
      });
    }
  } catch (error) {
    console.error("❌ Error checking auth:", error);
    res.status(500).json({ error: error.message });
  }
});

// Frontend Routes
// ==============

// Main app page (embedded in Shopify admin)
app.get("/app", async (req, res) => {
  try {
    const { shop, host } = req.query;

    if (!shop) {
      return res.status(400).send("Missing shop parameter");
    }

    console.log("🎨 Serving app page for:", shop);

    // Check if shop is authenticated (OAuth completed)
    const session = await getShopSession(shop);

    if (!session) {
      console.log("⚠️  Shop not authenticated, redirecting to OAuth...");
      return res.redirect(`/auth?shop=${shop}`);
    }

    console.log("✅ Shop is authenticated, serving app page");

    // Read the HTML template
    const htmlPath = path.join(__dirname, "views", "app.html");
    let html = fs.readFileSync(htmlPath, "utf8");

    // Replace placeholders
    html = html.replace(/{{APP_HOST}}/g, process.env.HOST);
    html = html.replace(/{{SHOPIFY_API_KEY}}/g, process.env.SHOPIFY_API_KEY);

    res.send(html);
  } catch (error) {
    console.error("❌ Error serving app page:", error);
    res.status(500).send("Failed to load app");
  }
});

// Install page (for new installations)
app.get("/install", (req, res) => {
  res.send(`
    <!DOCTYPE html>
    <html>
      <head>
        <title>Install Variant Badges</title>
        <style>
          body { 
            font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; 
            padding: 50px; 
            text-align: center;
            background: #f4f6f8;
          }
          .container {
            max-width: 500px;
            margin: 0 auto;
            background: white;
            padding: 40px;
            border-radius: 8px;
            box-shadow: 0 2px 4px rgba(0,0,0,0.1);
          }
          h1 { color: #202223; margin-bottom: 10px; }
          p { color: #6d7175; margin-bottom: 30px; }
          input { 
            padding: 12px; 
            width: 100%; 
            font-size: 16px; 
            border: 1px solid #c9cccf;
            border-radius: 4px;
            box-sizing: border-box;
          }
          button { 
            padding: 12px 30px; 
            background: #008060; 
            color: white; 
            border: none; 
            font-size: 16px; 
            cursor: pointer; 
            margin-top: 15px;
            border-radius: 4px;
            width: 100%;
            font-weight: 600;
          }
          button:hover { background: #006e52; }
        </style>
      </head>
      <body>
        <div class="container">
          <h1>🎨 Variant Badges</h1>
          <p>Add HOT, NEW, and SALE badges to your product variants</p>
          <form action="/auth" method="get">
            <input type="text" name="shop" placeholder="your-store.myshopify.com" required />
            <button type="submit">Install App</button>
          </form>
        </div>
      </body>
    </html>
  `);
});

// Root route - smart redirect
app.get("/", (req, res) => {
  const { shop, host } = req.query;

  // If accessed from Shopify admin (has shop/host params), go to app
  if (shop && host) {
    return res.redirect(`/app?shop=${shop}&host=${host}`);
  }

  // Otherwise, show install page
  res.redirect("/install");
});

// Start server
app.listen(PORT, () => {
  console.log("");
  console.log("━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━");
  console.log("🚀 Variant Badges App Server Started");
  console.log("━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━");
  console.log(`📍 Port: ${PORT}`);
  console.log(`🌐 URL: ${process.env.HOST || "http://localhost:" + PORT}`);
  console.log(`🔐 Embedded: true (App Bridge)`);
  console.log(`✨ API: GraphQL`);
  console.log(`📦 Architecture: Modular v2.0`);
  console.log("━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━");
  console.log("");
  console.log("Routes:");
  console.log("  GET  /                - Install page");
  console.log("  GET  /auth            - OAuth start");
  console.log("  GET  /auth/callback   - OAuth callback");
  console.log("  GET  /app             - Main app page");
  console.log("  GET  /health          - Health check");
  console.log("");
  console.log("API Routes (authenticated):");
  console.log("  GET  /api/products    - Get products (GraphQL)");
  console.log("  GET  /api/settings    - Get app settings");
  console.log("  POST /api/settings    - Save app settings");
  console.log("  GET  /api/badges      - Get badge assignments");
  console.log("  POST /api/badges      - Assign badge");
  console.log("  POST /api/badges/bulk - Bulk assign badges");
  console.log("  DEL  /api/badges/:id  - Remove badge");
  console.log("");
});
