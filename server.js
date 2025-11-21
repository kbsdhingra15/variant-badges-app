require("dotenv").config();
const express = require("express");
const cookieParser = require("cookie-parser");
const { shopifyApp } = require("@shopify/shopify-app-express");
const {
  PostgreSQLSessionStorage,
} = require("@shopify/shopify-app-session-storage-postgresql");

const app = express();
const PORT = process.env.PORT || 3000;

// Shopify App configuration
const shopify = shopifyApp({
  api: {
    apiKey: process.env.SHOPIFY_API_KEY,
    apiSecretKey: process.env.SHOPIFY_API_SECRET,
    scopes: process.env.SHOPIFY_SCOPES?.split(",") || [
      "read_products",
      "write_products",
    ],
    hostName: process.env.SHOPIFY_APP_URL?.replace(/https?:\/\//, "") || "",
    apiVersion: "2024-10",
  },
  auth: {
    path: "/auth",
    callbackPath: "/auth/callback",
  },
  webhooks: {
    path: "/webhooks",
  },
  sessionStorage: new PostgreSQLSessionStorage(process.env.DATABASE_URL),
});

// Import database functions
const { initDB, saveShopSession, getShopSession } = require("./database/db");

// Import middleware
const { validateSessionToken } = require("./middleware/auth");

// Import routes
const productsRouter = require("./routes/products");
const badgesRouter = require("./routes/badges");
const settingsRouter = require("./routes/settings");

// Middleware
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

    console.log("✅ Token saved, waiting 1 second before redirect...");
    await new Promise((resolve) => setTimeout(resolve, 1000));

    // Redirect with fresh install flag
    const timestamp = Date.now();
    const redirectUrl = `https://${callback.session.shop}/admin/apps/variant-badges?fresh=1&t=${timestamp}`;
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

// App Page Route
// ==============

app.get("/app", async (req, res) => {
  try {
    const { shop } = req.query;
    console.log("🎨 Serving app page for:", shop);

    if (!shop) {
      return res.status(400).send("Missing shop parameter");
    }

    // Check if shop is authenticated (OAuth completed)
    const session = await getShopSession(shop);

    if (!session) {
      console.log("⚠️  Shop not authenticated, redirecting to OAuth...");
      return res.redirect(`/auth?shop=${shop}`);
    }

    console.log("✅ Shop is authenticated, serving app page");

    // Read the HTML template
    const fs = require("fs");
    const path = require("path");
    const htmlPath = path.join(__dirname, "views", "app.html");
    let html = fs.readFileSync(htmlPath, "utf-8");

    // Replace placeholders with actual values
    html = html.replace("{{SHOPIFY_API_KEY}}", process.env.SHOPIFY_API_KEY);
    html = html.replace("{{APP_HOST}}", process.env.SHOPIFY_APP_URL);

    res.send(html);
  } catch (error) {
    console.error("❌ Error serving app page:", error);
    res.status(500).send("Error loading app: " + error.message);
  }
});

// Root route - Installation page
app.get("/", (req, res) => {
  res.send(`
    <!DOCTYPE html>
    <html>
      <head>
        <title>Variant Badges - Install</title>
        <style>
          body {
            font-family: Arial, sans-serif;
            max-width: 600px;
            margin: 100px auto;
            text-align: center;
          }
          input {
            padding: 10px;
            width: 300px;
            font-size: 16px;
          }
          button {
            padding: 10px 30px;
            font-size: 16px;
            background: #008060;
            color: white;
            border: none;
            cursor: pointer;
          }
          .container {
            background: #f4f6f8;
            padding: 40px;
            border-radius: 8px;
          }
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

// Initialize and start server
// ===========================

initDB()
  .then(() => {
    app.listen(PORT, () => {
      console.log("");
      console.log("╔════════════════════════════════════════════════════╗");
      console.log("║                                                    ║");
      console.log("║       🎨 VARIANT BADGES APP - RUNNING ✅           ║");
      console.log("║                                                    ║");
      console.log("╚════════════════════════════════════════════════════╝");
      console.log("");
      console.log(`🚀 Server: http://localhost:${PORT}`);
      console.log(`📦 Architecture: Modular v2.0`);
      console.log("━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━");
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
      console.log("  GET  /api/badges      - Get badge assignments");
      console.log("  POST /api/badges      - Assign badge to variant");
      console.log("  DELETE /api/badges    - Remove badge");
      console.log("  GET  /api/settings    - Get app settings");
      console.log("  POST /api/settings    - Save app settings");
      console.log("");
      console.log("━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━");
    });
  })
  .catch((error) => {
    console.error("❌ Failed to start server:", error);
    process.exit(1);
  });
