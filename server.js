require("dotenv").config();
const express = require("express");
const { shopifyApi, LATEST_API_VERSION } = require("@shopify/shopify-api");
require("@shopify/shopify-api/adapters/node");
const { Pool } = require("pg");
const cookieParser = require("cookie-parser");
const cors = require("cors");

const app = express();
const PORT = process.env.PORT || 3000;

// Database setup
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl:
    process.env.NODE_ENV === "production"
      ? { rejectUnauthorized: false }
      : false,
});

// Initialize database
async function initDB() {
  const client = await pool.connect();
  try {
    await client.query(`
      CREATE TABLE IF NOT EXISTS shops (
        id SERIAL PRIMARY KEY,
        shop VARCHAR(255) UNIQUE NOT NULL,
        access_token TEXT NOT NULL,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      )
    `);
    console.log("✅ Database initialized");
  } catch (error) {
    console.error("❌ Database initialization error:", error);
  } finally {
    client.release();
  }
}

initDB();

// Shopify API setup - EMBEDDED APP
const shopify = shopifyApi({
  apiKey: process.env.SHOPIFY_API_KEY,
  apiSecretKey: process.env.SHOPIFY_API_SECRET,
  scopes: process.env.SCOPES.split(","),
  hostName: process.env.HOST.replace(/https?:\/\//, ""),
  apiVersion: LATEST_API_VERSION,
  isEmbeddedApp: true, // ✅ Changed to true for App Bridge
  isCustomStoreApp: false,
});

// CORS configuration
app.use(
  cors({
    origin: [
      "https://admin.shopify.com",
      process.env.SHOP_URL, // Add your specific shop URL from .env if needed
    ].filter(Boolean),
    credentials: true,
    methods: ["GET", "POST", "PUT", "DELETE", "OPTIONS"],
    allowedHeaders: ["Content-Type", "Authorization"],
  })
);

app.use(express.json());
app.use(cookieParser());

// Middleware to validate session token from App Bridge
async function validateSessionToken(req, res, next) {
  try {
    const authHeader = req.headers.authorization;

    if (!authHeader || !authHeader.startsWith("Bearer ")) {
      console.log("❌ No Authorization header found");
      return res.status(401).json({ error: "Missing authorization header" });
    }

    const sessionToken = authHeader.replace("Bearer ", "");
    console.log("🔐 Validating session token...");

    // Decode and validate the session token
    const payload = await shopify.session.decodeSessionToken(sessionToken);

    console.log("✅ Session token validated");
    console.log(
      "   Shop:",
      payload.dest.replace("https://", "").replace("/admin", "")
    );

    // Get the shop domain from the token
    const shop = payload.dest.replace("https://", "").replace("/admin", "");

    // Get the access token from database
    const session = await getShopSession(shop);

    if (!session) {
      console.log("❌ Shop not authenticated in database:", shop);
      return res.status(401).json({
        error: "Shop not authenticated",
        shop,
        needsAuth: true,
      });
    }

    // Attach session to request for use in route handlers
    req.shopifySession = {
      shop: session.shop,
      accessToken: session.accessToken,
    };

    next();
  } catch (error) {
    console.error("❌ Session token validation error:", error.message);
    return res.status(401).json({
      error: "Invalid session token",
      details: error.message,
    });
  }
}

// Health check
app.get("/health", (req, res) => {
  res.json({
    status: "ok",
    message: "Variant Badges App is running",
    timestamp: new Date().toISOString(),
  });
});

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
      isOnline: false, // Offline token for persistent access
      rawRequest: req,
      rawResponse: res,
    });

    console.log("✅ OAuth redirect sent");
  } catch (error) {
    console.error("❌ OAuth start error:", error);
    if (!res.headersSent) {
      res.status(500).send("OAuth failed: " + error.message);
    }
  }
});

// OAuth callback - completes installation
app.get("/auth/callback", async (req, res) => {
  try {
    console.log("🔐 OAuth callback received");

    const callback = await shopify.auth.callback({
      rawRequest: req,
      rawResponse: res,
    });

    const { session } = callback;
    console.log("✅ Session created for shop:", session.shop);

    // Store session in database
    const client = await pool.connect();
    try {
      await client.query(
        `INSERT INTO shops (shop, access_token, updated_at) 
         VALUES ($1, $2, NOW()) 
         ON CONFLICT (shop) 
         DO UPDATE SET access_token = $2, updated_at = NOW()`,
        [session.shop, session.accessToken]
      );
      console.log("✅ Session saved to database");
    } finally {
      client.release();
    }

    // Redirect to app with embedded parameter
    const host = req.query.host;
    const redirectUrl = `/?shop=${session.shop}&host=${host}&embedded=1`;
    console.log("   Redirecting to:", redirectUrl);
    res.redirect(redirectUrl);
  } catch (error) {
    console.error("❌ Auth callback error:", error);
    res.status(500).send("Authentication failed: " + error.message);
  }
});

// Get shop session from database
async function getShopSession(shop) {
  const client = await pool.connect();
  try {
    const result = await client.query(
      "SELECT shop, access_token FROM shops WHERE shop = $1",
      [shop]
    );
    if (result.rows.length === 0) {
      console.log("⚠️  Shop not found in database:", shop);
      return null;
    }
    return {
      shop: result.rows[0].shop,
      accessToken: result.rows[0].access_token,
    };
  } finally {
    client.release();
  }
}

// 🆕 API: Get products - PROTECTED by session token
app.get("/api/products", validateSessionToken, async (req, res) => {
  try {
    const session = req.shopifySession;
    console.log("📦 Fetching products for shop:", session.shop);

    const client = new shopify.clients.Rest({ session });

    // Fetch products with variants
    const response = await client.get({
      path: "products",
      query: { limit: 50 },
    });

    console.log(`✅ Fetched ${response.body.products.length} products`);
    res.json({ products: response.body.products });
  } catch (error) {
    console.error("❌ Error fetching products:", error);
    res.status(500).json({
      error: "Failed to fetch products",
      details: error.message,
    });
  }
});

// 🆕 API: Get product options - for settings page
app.get("/api/product-options", validateSessionToken, async (req, res) => {
  try {
    const session = req.shopifySession;
    console.log("🎯 Fetching product options for shop:", session.shop);

    const client = new shopify.clients.Rest({ session });

    const response = await client.get({
      path: "products",
      query: { limit: 250, fields: "id,title,options" },
    });

    // Extract all unique option names across all products
    const optionNames = new Set();
    response.body.products.forEach((product) => {
      if (product.options) {
        product.options.forEach((option) => {
          optionNames.add(option.name);
        });
      }
    });

    const options = Array.from(optionNames).sort();
    console.log(`✅ Found ${options.length} unique option types:`, options);

    res.json({ options });
  } catch (error) {
    console.error("❌ Error fetching product options:", error);
    res.status(500).json({
      error: "Failed to fetch product options",
      details: error.message,
    });
  }
});

// Debug: Check shop authentication status
app.get("/api/auth-status", validateSessionToken, (req, res) => {
  res.json({
    authenticated: true,
    shop: req.shopifySession.shop,
  });
});

// Debug: List all shops in database
app.get("/debug/shops", async (req, res) => {
  try {
    const client = await pool.connect();
    try {
      const result = await client.query(
        "SELECT shop, created_at, updated_at FROM shops ORDER BY updated_at DESC"
      );
      res.json({
        shops: result.rows,
        count: result.rows.length,
      });
    } finally {
      client.release();
    }
  } catch (error) {
    console.error("Error listing shops:", error);
    res.status(500).json({ error: error.message });
  }
});

// Serve frontend
app.get("/", (req, res) => {
  const { shop, host } = req.query;

  // Installation page (no shop parameter)
  if (!shop) {
    return res.send(`
      <!DOCTYPE html>
      <html>
        <head>
          <title>Variant Badges - Install</title>
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
  }

  // Main app page (embedded in Shopify admin)
  const htmlContent = `
    <!DOCTYPE html>
    <html>
      <head>
        <title>Variant Badges - Phase 1</title>
        <script src="https://cdn.shopify.com/shopifycloud/app-bridge.js"></script>
        <style>
          body { 
            font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; 
            padding: 20px; 
            background: #f4f6f8;
            margin: 0;
          }
          .container { max-width: 1200px; margin: 0 auto; }
          .header { 
            background: white; 
            padding: 30px; 
            border-radius: 8px; 
            margin-bottom: 20px; 
            box-shadow: 0 1px 3px rgba(0,0,0,0.1); 
          }
          .status-badge {
            display: inline-block;
            padding: 4px 12px;
            border-radius: 4px;
            font-size: 14px;
            font-weight: 600;
            margin-left: 10px;
          }
          .status-success {
            background: #e3f5ef;
            color: #008060;
          }
          .product-card { 
            background: white; 
            padding: 20px; 
            margin-bottom: 15px; 
            border-radius: 8px;
            box-shadow: 0 1px 3px rgba(0,0,0,0.1);
          }
          .product-title { 
            font-size: 18px; 
            font-weight: 600; 
            margin-bottom: 15px; 
            color: #202223; 
          }
          .variant-row { 
            display: flex; 
            align-items: center; 
            padding: 10px; 
            border-bottom: 1px solid #e1e3e5;
            gap: 15px;
          }
          .variant-row:last-child { border-bottom: none; }
          .variant-image { 
            width: 50px; 
            height: 50px; 
            object-fit: cover; 
            border-radius: 4px; 
            border: 1px solid #e1e3e5; 
          }
          .variant-info { flex: 1; }
          .variant-option { color: #6d7175; font-size: 14px; }
          .loading { 
            text-align: center; 
            padding: 50px; 
            color: #6d7175;
          }
          .success { 
            color: #008060; 
            background: #e3f5ef; 
            padding: 15px; 
            border-radius: 4px; 
            margin-bottom: 20px; 
          }
          .error { 
            color: #d72c0d; 
            background: #fef3f2; 
            padding: 15px; 
            border-radius: 4px; 
            margin-bottom: 20px; 
          }
        </style>
      </head>
      <body>
        <div class="container">
          <div class="header">
            <h1>
              🎨 Variant Badges - Phase 1 Test
              <span class="status-badge status-success" id="status">Connecting...</span>
            </h1>
            <p style="color: #6d7175;">Testing App Bridge authentication and product data access</p>
          </div>
          <div id="products">
            <div class="loading">🔄 Initializing App Bridge...</div>
          </div>
        </div>

        <script>
          const shop = '${shop}';
          const host = '${host}';
          const apiKey = '${process.env.SHOPIFY_API_KEY}';
          const appHost = '${process.env.HOST}';

          console.log('🚀 App loading...');
          console.log('   Shop:', shop);
          console.log('   Host:', host);
          console.log('   API Key:', apiKey);

          // Initialize App Bridge
          let app;
          try {
            app = window.createApp({
              apiKey: apiKey,
              host: host,
            });
            console.log('✅ App Bridge initialized');
          } catch (error) {
            console.error('❌ App Bridge initialization failed:', error);
            showError('Failed to initialize App Bridge: ' + error.message);
          }

          // Get session token from App Bridge
          async function getSessionToken() {
            try {
              console.log('🔐 Getting session token from App Bridge...');
              const token = await window.getSessionToken(app);
              console.log('✅ Session token received');
              return token;
            } catch (error) {
              console.error('❌ Failed to get session token:', error);
              throw error;
            }
          }

          // Load products using session token
          async function loadProducts() {
            try {
              document.getElementById('status').textContent = 'Getting Auth Token...';
              const sessionToken = await getSessionToken();
              
              document.getElementById('status').textContent = 'Loading Products...';
              console.log('📦 Fetching products...');
              
              const url = appHost + '/api/products';
              console.log('   URL:', url);
              
              const response = await fetch(url, {
                method: 'GET',
                headers: {
                  'Authorization': 'Bearer ' + sessionToken,
                  'Content-Type': 'application/json',
                }
              });

              console.log('   Response status:', response.status);

              if (!response.ok) {
                const errorData = await response.json();
                throw new Error(errorData.error || 'HTTP ' + response.status);
              }

              const data = await response.json();
              console.log('✅ Products received:', data.products.length);
              
              document.getElementById('status').textContent = '✅ Connected';
              displayProducts(data.products);
            } catch (error) {
              console.error('❌ Error loading products:', error);
              document.getElementById('status').textContent = '❌ Error';
              showError('Failed to load products: ' + error.message);
            }
          }

          function displayProducts(products) {
            const container = document.getElementById('products');
            
            if (!products || products.length === 0) {
              container.innerHTML = '<div class="product-card">No products found in your store. Add some products with variants to test!</div>';
              return;
            }

            let html = '<div class="success"><strong>🎉 Success!</strong> Connected to your store and loaded products with App Bridge authentication.</div>';
            
            products.forEach(product => {
              html += '<div class="product-card">';
              html += '<div class="product-title">' + escapeHtml(product.title) + '</div>';
              
              if (product.variants && product.variants.length > 0) {
                product.variants.forEach(variant => {
                  html += '<div class="variant-row">';
                  
                  const image = variant.image_id ? 
                    (product.images && product.images.find(img => img.id === variant.image_id)) : 
                    (product.images && product.images[0]);
                  
                  if (image && image.src) {
                    html += '<img class="variant-image" src="' + escapeHtml(image.src) + '" />';
                  } else {
                    html += '<div class="variant-image" style="background:#e1e3e5"></div>';
                  }
                  
                  html += '<div class="variant-info">';
                  html += '<div><strong>' + escapeHtml(variant.title) + '</strong></div>';
                  html += '<div class="variant-option">Price: $' + escapeHtml(variant.price) + '</div>';
                  
                  if (variant.option1) html += '<div class="variant-option">Option 1: ' + escapeHtml(variant.option1) + '</div>';
                  if (variant.option2) html += '<div class="variant-option">Option 2: ' + escapeHtml(variant.option2) + '</div>';
                  if (variant.option3) html += '<div class="variant-option">Option 3: ' + escapeHtml(variant.option3) + '</div>';
                  
                  html += '</div>';
                  html += '</div>';
                });
              }
              
              html += '</div>';
            });
            
            container.innerHTML = html;
          }

          function showError(message) {
            document.getElementById('products').innerHTML = 
              '<div class="error"><strong>❌ Error:</strong><br>' + escapeHtml(message) + '</div>';
          }
          
          function escapeHtml(text) {
            if (!text) return '';
            const div = document.createElement('div');
            div.textContent = text.toString();
            return div.innerHTML;
          }

          // Start loading products
          loadProducts();
        </script>
      </body>
    </html>
  `;

  res.send(htmlContent);
});

app.listen(PORT, () => {
  console.log("");
  console.log("🚀 Variant Badges App Server Started");
  console.log("==================================");
  console.log(`📍 Port: ${PORT}`);
  console.log(`🌐 URL: ${process.env.HOST || "http://localhost:" + PORT}`);
  console.log(`🔐 Embedded: true (App Bridge)`);
  console.log("");
});
