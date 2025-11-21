require("dotenv").config();
const express = require("express");
const cookieParser = require("cookie-parser");
const fetch = require("node-fetch");

const app = express();
const PORT = process.env.PORT || 3000;

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

    const scopes = "read_products,write_products";
    const redirectUri = `${process.env.SHOPIFY_APP_URL}/auth/callback`;
    const nonce = require("crypto").randomBytes(16).toString("hex");

    const authUrl =
      `https://${shop}/admin/oauth/authorize?` +
      `client_id=${process.env.SHOPIFY_API_KEY}&` +
      `scope=${scopes}&` +
      `redirect_uri=${redirectUri}&` +
      `state=${nonce}`;

    console.log("   Redirecting to Shopify OAuth:", authUrl);
    res.redirect(authUrl);
  } catch (error) {
    console.error("❌ OAuth begin error:", error);
    res.status(500).send("OAuth initialization failed: " + error.message);
  }
});

// OAuth callback - after merchant approves
app.get("/auth/callback", async (req, res) => {
  try {
    const { shop, code } = req.query;
    console.log("🔐 OAuth callback received for shop:", shop);

    if (!shop || !code) {
      return res.status(400).send("Missing shop or code parameter");
    }

    // Exchange code for access token
    const tokenUrl = `https://${shop}/admin/oauth/access_token`;
    const tokenResponse = await fetch(tokenUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        client_id: process.env.SHOPIFY_API_KEY,
        client_secret: process.env.SHOPIFY_API_SECRET,
        code: code,
      }),
    });

    const tokenData = await tokenResponse.json();

    if (!tokenData.access_token) {
      throw new Error("Failed to get access token");
    }

    console.log("✅ OAuth successful!");
    console.log("   Shop:", shop);
    console.log(
      "   Access Token:",
      tokenData.access_token.substring(0, 20) + "..."
    );

    // Save to database
    await saveShopSession(shop, tokenData.access_token);

    console.log("✅ Token saved, waiting 1 second before redirect...");
    await new Promise((resolve) => setTimeout(resolve, 1000));

    // Redirect with fresh install flag
    const timestamp = Date.now();
    const redirectUrl = `https://${shop}/admin/apps/variant-badges?fresh=1&t=${timestamp}`;
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
app.use("/api", validateSessionToken, productsRouter);
app.use("/api", validateSessionToken, badgesRouter);
app.use("/api", validateSessionToken, settingsRouter);

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
