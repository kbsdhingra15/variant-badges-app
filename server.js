require("dotenv").config();
const express = require("express");
const { shopifyApi } = require("@shopify/shopify-api");
require("@shopify/shopify-api/adapters/node");
const cookieParser = require("cookie-parser");
const cors = require("cors");
const fs = require("fs");
const path = require("path");

const { initDB, saveShopSession, getShopSession } = require("./database/db");
const { validateSessionToken } = require("./middleware/auth");
const productsRouter = require("./routes/products");
const badgesRouter = require("./routes/badges");
const settingsRouter = require("./routes/settings");

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
app.use(cookieParser());

app.get("/health", (req, res) => {
  res.json({
    status: "ok",
    message: "Variant Badges App is running",
    version: "2.0.1",
    api: "GraphQL",
    timestamp: new Date().toISOString(),
  });
});

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
    console.log("[OAuth] Callback");
    const callback = await shopify.auth.callback({
      rawRequest: req,
      rawResponse: res,
    });
    console.log("[SUCCESS] OAuth for:", callback.session.shop);
    await saveShopSession(callback.session.shop, callback.session.accessToken);
    console.log("[SUCCESS] Token saved");
    await new Promise((r) => setTimeout(r, 1000));
    const timestamp = Date.now();
    const redirectUrl = `https://${callback.session.shop}/admin/apps/variant-badges?fresh=1&t=${timestamp}`;
    console.log("[Redirect]", redirectUrl);
    res.redirect(redirectUrl);
  } catch (error) {
    console.error("[ERROR] OAuth callback:", error);
    res.status(500).send("OAuth failed");
  }
});

app.use("/api", validateSessionToken(shopify), productsRouter);
app.use("/api", validateSessionToken(shopify), badgesRouter);
app.use("/api", validateSessionToken(shopify), settingsRouter);

app.get("/app", async (req, res) => {
  try {
    const { shop } = req.query;
    if (!shop) return res.status(400).send("Missing shop");
    console.log("[App] Serving for:", shop);
    const session = await getShopSession(shop);
    if (!session) {
      console.log("[WARNING] Not authenticated");
      return res.redirect(`/auth?shop=${shop}`);
    }
    console.log("[SUCCESS] Serving app");
    const htmlPath = path.join(__dirname, "views", "app.html");
    let html = fs.readFileSync(htmlPath, "utf8");
    html = html.replace(/{{APP_HOST}}/g, process.env.HOST);
    html = html.replace(/{{SHOPIFY_API_KEY}}/g, process.env.SHOPIFY_API_KEY);
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
  console.log("Server started on port:", PORT);
  console.log("URL:", process.env.HOST);
});
