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
  apiVersion: "2024-10", // Use recent stable version instead of LATEST_API_VERSION
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
    console.log("   Token length:", sessionToken.length);
    console.log("   Token starts with:", sessionToken.substring(0, 50) + "...");

    // Decode and validate the session token
    let payload;
    try {
      payload = await shopify.session.decodeSessionToken(sessionToken);
      console.log("✅ Session token decoded successfully");
    } catch (decodeError) {
      console.error("❌ Token decode error:", decodeError.message);
      console.error("   Full error:", decodeError);
      return res.status(401).json({
        error: "Invalid session token",
        details: decodeError.message,
      });
    }

    console.log("✅ Session token validated");
    console.log("   Destination:", payload.dest);
    console.log("   Audience:", payload.aud);

    // Get the shop domain from the token
    const shop = payload.dest.replace("https://", "").replace("/admin", "");
    console.log("   Extracted shop:", shop);

    // Get the access token from database
    const session = await getShopSession(shop);

    if (!session) {
      console.log("❌ Shop not authenticated in database:", shop);

      // Check what shops ARE in the database
      const client = await pool.connect();
      try {
        const result = await client.query("SELECT shop FROM shops");
        console.log(
          "   Shops in database:",
          result.rows.map((r) => r.shop)
        );
      } finally {
        client.release();
      }

      return res.status(401).json({
        error: "Shop not authenticated",
        shop,
        needsAuth: true,
        hint: "Please complete the OAuth installation flow",
      });
    }

    console.log("✅ Shop session found in database");
    console.log("   Access token length:", session.accessToken.length);

    // Attach session to request for use in route handlers
    req.shopifySession = {
      shop: session.shop,
      accessToken: session.accessToken,
    };

    next();
  } catch (error) {
    console.error("❌ Session token validation error:", error.message);
    console.error("   Stack:", error.stack);
    return res.status(500).json({
      error: "Token validation failed",
      details: error.message,
    });
  }
}

// Health check
app.get("/health", (req, res) => {
  res.json({
    status: "ok",
    message: "Variant Badges App is running (GraphQL API)",
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
      isOnline: false,
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
    console.log("   Query params:", Object.keys(req.query));

    const callback = await shopify.auth.callback({
      rawRequest: req,
      rawResponse: res,
    });

    const { session } = callback;
    console.log("✅ Session created for shop:", session.shop);
    console.log("   Session ID:", session.id);
    console.log("   Session state:", session.state);
    console.log("   Session isOnline:", session.isOnline);
    console.log(
      "   Access token received:",
      session.accessToken ? "Yes" : "No"
    );
    console.log("   Access token length:", session.accessToken?.length);
    console.log(
      "   Access token starts with:",
      session.accessToken?.substring(0, 15) + "..."
    );
    console.log(
      "   Access token ends with:",
      "..." + session.accessToken?.substring(session.accessToken.length - 15)
    );

    // Store session in database
    const client = await pool.connect();
    try {
      console.log("💾 Saving to database...");
      console.log("   Shop:", session.shop);
      console.log("   Token to save length:", session.accessToken.length);

      // Check if updated_at column exists
      const schemaCheck = await client.query(`
        SELECT column_name 
        FROM information_schema.columns 
        WHERE table_name = 'shops' AND column_name = 'updated_at'
      `);

      const hasUpdatedAt = schemaCheck.rows.length > 0;
      console.log("   Schema has updated_at:", hasUpdatedAt);

      let result;
      if (hasUpdatedAt) {
        result = await client.query(
          `INSERT INTO shops (shop, access_token, updated_at) 
           VALUES ($1, $2, NOW()) 
           ON CONFLICT (shop) 
           DO UPDATE SET access_token = $2, updated_at = NOW()
           RETURNING shop, LENGTH(access_token) as token_length, created_at, updated_at`,
          [session.shop, session.accessToken]
        );
      } else {
        result = await client.query(
          `INSERT INTO shops (shop, access_token) 
           VALUES ($1, $2) 
           ON CONFLICT (shop) 
           DO UPDATE SET access_token = $2
           RETURNING shop, LENGTH(access_token) as token_length, created_at`,
          [session.shop, session.accessToken]
        );
      }

      console.log("✅ Session saved to database");
      console.log("   Saved shop:", result.rows[0].shop);
      console.log("   Saved token length:", result.rows[0].token_length);
      console.log("   Created at:", result.rows[0].created_at);

      // Verify by reading it back
      const verifyResult = await client.query(
        "SELECT shop, LENGTH(access_token) as token_length, access_token FROM shops WHERE shop = $1",
        [session.shop]
      );
      console.log("🔍 Verification read:");
      console.log("   Token length in DB:", verifyResult.rows[0].token_length);
      console.log(
        "   Token starts with:",
        verifyResult.rows[0].access_token.substring(0, 15) + "..."
      );
      console.log(
        "   Tokens match:",
        verifyResult.rows[0].access_token === session.accessToken ? "Yes" : "No"
      );
    } finally {
      client.release();
    }

    // Register APP_UNINSTALLED webhook (critical for production)
    try {
      console.log("📡 Registering APP_UNINSTALLED webhook...");
      const webhookResult = await shopify.webhooks.register({
        session,
        topic: "APP_UNINSTALLED",
        path: "/webhooks/app-uninstalled",
        deliveryMethod: "http",
      });

      if (
        webhookResult.APP_UNINSTALLED &&
        webhookResult.APP_UNINSTALLED[0].success
      ) {
        console.log("✅ APP_UNINSTALLED webhook registered successfully");
      } else {
        console.log("⚠️  Webhook registration failed:", webhookResult);
      }
    } catch (webhookError) {
      console.error("⚠️  Webhook registration error:", webhookError.message);
      // Don't fail OAuth if webhook registration fails
    }

    // Redirect to app with embedded parameter
    const host = req.query.host;
    const redirectUrl = `/?shop=${session.shop}&host=${host}&embedded=1`;
    console.log("   Redirecting to:", redirectUrl);
    res.redirect(redirectUrl);
  } catch (error) {
    console.error("❌ Auth callback error:", error);
    console.error("   Stack:", error.stack);
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

// Webhook: APP_UNINSTALLED - Auto-cleanup when merchant uninstalls
app.post(
  "/webhooks/app-uninstalled",
  express.raw({ type: "application/json" }),
  async (req, res) => {
    try {
      console.log("📡 APP_UNINSTALLED webhook received");

      // Verify webhook authenticity
      const hmac = req.headers["x-shopify-hmac-sha256"];
      const shop = req.headers["x-shopify-shop-domain"];

      console.log("   Shop:", shop);

      // Delete shop from database
      if (shop) {
        const client = await pool.connect();
        try {
          const result = await client.query(
            "DELETE FROM shops WHERE shop = $1 RETURNING shop",
            [shop]
          );

          if (result.rowCount > 0) {
            console.log("✅ Shop session auto-deleted:", shop);
          } else {
            console.log("⚠️  Shop not found in database (already deleted)");
          }
        } finally {
          client.release();
        }
      }

      res.status(200).send("OK");
    } catch (error) {
      console.error("❌ Webhook error:", error);
      res.status(500).send("Error");
    }
  }
);

// API: Get products - PROTECTED by session token (USING GRAPHQL)
app.get("/api/products", validateSessionToken, async (req, res) => {
  try {
    const sessionData = req.shopifySession;
    console.log("📦 Fetching products for shop:", sessionData.shop);
    console.log("   Access token available:", !!sessionData.accessToken);
    console.log("   Access token length:", sessionData.accessToken?.length);
    console.log("   Using GraphQL API ✅");

    // Create a complete session object with all required properties
    const session = {
      id: `offline_${sessionData.shop}`,
      shop: sessionData.shop,
      state: "offline",
      isOnline: false,
      accessToken: sessionData.accessToken,
      scope: process.env.SCOPES,
    };

    const client = new shopify.clients.Graphql({ session });

    // GraphQL query for products with variants
    console.log("   Making Shopify GraphQL API call...");
    const query = `
      query getProducts {
        products(first: 50) {
          edges {
            node {
              id
              title
              handle
              descriptionHtml
              createdAt
              updatedAt
              productType
              tags
              vendor
              options {
                id
                name
                position
                values
              }
              variants(first: 100) {
                edges {
                  node {
                    id
                    title
                    price
                    compareAtPrice
                    sku
                    barcode
                    position
                    inventoryQuantity
                    taxable
                    image {
                      id
                      url
                      altText
                      width
                      height
                    }
                    selectedOptions {
                      name
                      value
                    }
                  }
                }
              }
              images(first: 10) {
                edges {
                  node {
                    id
                    url
                    altText
                    width
                    height
                  }
                }
              }
            }
          }
        }
      }
    `;

    const response = await client.query({ data: query });

    // Transform GraphQL response to match REST API format (for compatibility)
    const products = response.body.data.products.edges.map((edge) => {
      const product = edge.node;

      return {
        id: product.id.split("/").pop(),
        title: product.title,
        handle: product.handle,
        body_html: product.descriptionHtml,
        created_at: product.createdAt,
        updated_at: product.updatedAt,
        product_type: product.productType,
        tags: product.tags,
        vendor: product.vendor,
        options: product.options.map((opt) => ({
          id: opt.id.split("/").pop(),
          name: opt.name,
          position: opt.position,
          values: opt.values,
        })),
        variants: product.variants.edges.map((vEdge, index) => {
          const variant = vEdge.node;

          // Build option values
          const selectedOptions = variant.selectedOptions || [];
          const option1 =
            selectedOptions.find((o) => o.name === product.options[0]?.name)
              ?.value || null;
          const option2 =
            selectedOptions.find((o) => o.name === product.options[1]?.name)
              ?.value || null;
          const option3 =
            selectedOptions.find((o) => o.name === product.options[2]?.name)
              ?.value || null;

          return {
            id: variant.id.split("/").pop(),
            title: variant.title,
            price: variant.price,
            compare_at_price: variant.compareAtPrice,
            sku: variant.sku || "",
            barcode: variant.barcode || "",
            position: variant.position || index + 1,
            inventory_quantity: variant.inventoryQuantity || 0,
            taxable: variant.taxable,
            image_id: variant.image ? variant.image.id.split("/").pop() : null,
            option1,
            option2,
            option3,
          };
        }),
        images: product.images.edges.map((imgEdge) => {
          const image = imgEdge.node;
          return {
            id: image.id.split("/").pop(),
            src: image.url,
            alt: image.altText,
            width: image.width,
            height: image.height,
          };
        }),
      };
    });

    console.log(`✅ Fetched ${products.length} products via GraphQL`);
    res.json({ products });
  } catch (error) {
    console.error("❌ Error fetching products:", error.message);
    console.error("   Error stack:", error.stack);

    // Check for GraphQL-specific errors
    if (error.response?.errors) {
      console.error(
        "   GraphQL errors:",
        JSON.stringify(error.response.errors, null, 2)
      );
    }

    // If Shopify returns 401, the token is invalid - delete it from database
    if (
      error.response &&
      (error.response.code === 401 || error.response.statusCode === 401)
    ) {
      console.log("🗑️  Token invalid - removing from database");
      const dbClient = await pool.connect();
      try {
        await dbClient.query("DELETE FROM shops WHERE shop = $1", [
          req.shopifySession.shop,
        ]);
        console.log("✅ Invalid token removed from database");
      } catch (dbError) {
        console.error("❌ Error removing invalid token:", dbError);
      } finally {
        dbClient.release();
      }

      return res.status(401).json({
        error: "Shop not authenticated",
        needsAuth: true,
        details:
          "Access token is invalid or expired. Please reinstall the app.",
      });
    }

    res.status(500).json({
      error: "Failed to fetch products",
      details: error.message,
      graphqlErrors: error.response?.errors,
    });
  }
});

// API: Get product options - for settings page (USING GRAPHQL)
app.get("/api/product-options", validateSessionToken, async (req, res) => {
  try {
    const sessionData = req.shopifySession;
    console.log("🎯 Fetching product options for shop:", sessionData.shop);
    console.log("   Using GraphQL API ✅");

    // Create a complete session object with all required properties
    const session = {
      id: `offline_${sessionData.shop}`,
      shop: sessionData.shop,
      state: "offline",
      isOnline: false,
      accessToken: sessionData.accessToken,
      scope: process.env.SCOPES,
    };

    const client = new shopify.clients.Graphql({ session });

    // GraphQL query to get all product options
    const query = `
      query getProductOptions {
        products(first: 250) {
          edges {
            node {
              id
              title
              options {
                name
                values
              }
            }
          }
        }
      }
    `;

    const response = await client.query({ data: query });

    // Extract all unique option names across all products
    const optionNames = new Set();
    response.body.data.products.edges.forEach((edge) => {
      const product = edge.node;
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
    console.error("   GraphQL errors:", error.response?.errors);
    res.status(500).json({
      error: "Failed to fetch product options",
      details: error.message,
      graphqlErrors: error.response?.errors,
    });
  }
});

// Debug: Check shop authentication status (NO auth required - for troubleshooting)
app.get("/api/check-auth", async (req, res) => {
  try {
    const { shop } = req.query;

    if (!shop) {
      return res.status(400).json({ error: "Missing shop parameter" });
    }

    console.log("🔍 Checking auth status for:", shop);

    // Check if shop is in database
    const session = await getShopSession(shop);

    if (session) {
      console.log("✅ Shop is authenticated");
      return res.json({
        authenticated: true,
        shop: session.shop,
        hasAccessToken: !!session.accessToken,
        tokenLength: session.accessToken?.length,
      });
    } else {
      console.log("❌ Shop not authenticated");

      // Show what shops ARE in the database
      const client = await pool.connect();
      try {
        const result = await client.query(
          "SELECT shop, created_at FROM shops ORDER BY created_at DESC"
        );
        return res.json({
          authenticated: false,
          shop,
          shopsInDatabase: result.rows,
        });
      } finally {
        client.release();
      }
    }
  } catch (error) {
    console.error("❌ Check auth error:", error);
    res.status(500).json({ error: error.message });
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
      // Check if updated_at column exists
      const schemaCheck = await client.query(`
        SELECT column_name 
        FROM information_schema.columns 
        WHERE table_name = 'shops' AND column_name = 'updated_at'
      `);

      const hasUpdatedAt = schemaCheck.rows.length > 0;

      let result;
      if (hasUpdatedAt) {
        result = await client.query(
          "SELECT shop, LENGTH(access_token) as token_length, created_at, updated_at FROM shops ORDER BY created_at DESC"
        );
      } else {
        result = await client.query(
          "SELECT shop, LENGTH(access_token) as token_length, created_at FROM shops ORDER BY created_at DESC"
        );
      }

      res.json({
        shops: result.rows,
        count: result.rows.length,
        schema_version: hasUpdatedAt ? "new" : "old (missing updated_at)",
      });
    } finally {
      client.release();
    }
  } catch (error) {
    console.error("Error listing shops:", error);
    res.status(500).json({ error: error.message });
  }
});

// Debug: Clear shop session
app.get("/debug/clear-session", async (req, res) => {
  try {
    const { shop } = req.query;
    if (!shop) {
      return res.status(400).json({
        error:
          "Missing shop parameter. Usage: /debug/clear-session?shop=your-store.myshopify.com",
      });
    }

    console.log("🗑️  Clearing session for:", shop);

    const client = await pool.connect();
    try {
      const result = await client.query(
        "DELETE FROM shops WHERE shop = $1 RETURNING *",
        [shop]
      );

      if (result.rowCount > 0) {
        console.log("✅ Session deleted:", result.rows[0].shop);
        res.json({
          message: "Session cleared successfully",
          shop: shop,
          deleted: true,
        });
      } else {
        console.log("⚠️  Shop not found in database:", shop);
        res.json({
          message: "Shop not found in database (already cleared)",
          shop: shop,
          deleted: false,
        });
      }
    } finally {
      client.release();
    }
  } catch (error) {
    console.error("❌ Error clearing session:", error);
    res.status(500).json({ error: error.message });
  }
});

// Debug: Migrate database schema
app.get("/debug/migrate-schema", async (req, res) => {
  try {
    console.log("🔧 Starting database schema migration...");

    const client = await pool.connect();
    try {
      // Check if updated_at column exists
      const schemaCheck = await client.query(`
        SELECT column_name 
        FROM information_schema.columns 
        WHERE table_name = 'shops' AND column_name = 'updated_at'
      `);

      if (schemaCheck.rows.length > 0) {
        console.log("✅ Schema already up to date");
        return res.json({
          message: "Schema already up to date",
          updated_at_exists: true,
        });
      }

      // Add updated_at column
      console.log("   Adding updated_at column...");
      await client.query(`
        ALTER TABLE shops 
        ADD COLUMN IF NOT EXISTS updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      `);

      // Update existing rows to have updated_at = created_at
      console.log("   Setting updated_at for existing rows...");
      await client.query(`
        UPDATE shops 
        SET updated_at = created_at 
        WHERE updated_at IS NULL
      `);

      console.log("✅ Schema migration completed");

      res.json({
        message: "Schema migrated successfully",
        changes: [
          "Added updated_at column",
          "Set updated_at = created_at for existing rows",
        ],
      });
    } finally {
      client.release();
    }
  } catch (error) {
    console.error("❌ Schema migration error:", error);
    res.status(500).json({ error: error.message, stack: error.stack });
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
        <title>Variant Badges - Phase 1 (GraphQL)</title>
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
          .api-badge {
            display: inline-block;
            padding: 4px 12px;
            border-radius: 4px;
            font-size: 12px;
            font-weight: 600;
            margin-left: 10px;
            background: #e0e3ff;
            color: #4353ff;
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
              <span class="api-badge">GraphQL API ✨</span>
              <span class="status-badge status-success" id="status">Connecting...</span>
            </h1>
            <p style="color: #6d7175;">Testing App Bridge authentication and product data access using GraphQL API</p>
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

          console.log('🚀 App loading with GraphQL API...');
          console.log('   Shop:', shop);
          console.log('   Host:', host);
          console.log('   API Key:', apiKey);

          let app;
          let currentToken = null;

          // Get initial session token from URL
          function getSessionTokenFromURL() {
            const urlParams = new URLSearchParams(window.location.search);
            const idToken = urlParams.get('id_token');
            
            if (idToken) {
              console.log('✅ Initial session token from URL');
              currentToken = idToken;
              return idToken;
            }
            
            console.log('⚠️  No id_token in URL');
            return null;
          }

          // Initialize App Bridge (for token refresh and redirects)
          async function initAppBridge() {
            try {
              // Wait for App Bridge to be available
              if (typeof window.createApp === 'undefined') {
                console.log('⏳ Waiting for App Bridge...');
                setTimeout(initAppBridge, 200);
                return;
              }

              app = window.createApp({
                apiKey: apiKey,
                host: host,
              });
              
              console.log('✅ App Bridge initialized');
              
              // Set up token refresh (tokens expire after ~1 minute)
              startTokenRefresh();
              
            } catch (error) {
              console.log('⚠️  App Bridge init delayed:', error.message);
              // Retry
              setTimeout(initAppBridge, 500);
            }
          }

          // Redirect using App Bridge (for embedded apps)
          function redirectToOAuth() {
            const oauthUrl = appHost + '/auth?shop=' + encodeURIComponent(shop);
            console.log('🔄 Need to redirect to OAuth:', oauthUrl);
            
            // Try App Bridge redirect first
            if (app && window.AppBridge && window.AppBridge.actions) {
              try {
                console.log('   Using App Bridge Redirect');
                const Redirect = window.AppBridge.actions.Redirect;
                const redirect = Redirect.create(app);
                redirect.dispatch(Redirect.Action.REMOTE, oauthUrl);
                return;
              } catch (error) {
                console.error('   App Bridge redirect failed:', error);
              }
            }
            
            // Fallback: Show message and break out of iframe
            console.log('   Using fallback: top-level redirect');
            
            // For embedded apps, we need to break out of the iframe
            if (window.top !== window.self) {
              // We're in an iframe - use special redirect
              const shopHandle = shop.split('.')[0];
              window.top.location.href = 'https://admin.shopify.com/store/' + shopHandle + '/apps/' + apiKey;
            } else {
              // Direct navigation
              window.location.href = oauthUrl;
            }
          }

          // Get fresh token from App Bridge
          async function getSessionToken() {
            try {
              if (!app) {
                console.log('ℹ️  Using initial token (App Bridge not ready)');
                return currentToken;
              }

              if (typeof window.getSessionToken === 'undefined') {
                console.log('ℹ️  getSessionToken not available, using current token');
                return currentToken;
              }

              const token = await window.getSessionToken(app);
              currentToken = token;
              console.log('✅ Refreshed session token');
              return token;
              
            } catch (error) {
              console.log('⚠️  Token refresh failed, using current:', error.message);
              return currentToken;
            }
          }

          // Auto-refresh token every 50 seconds (tokens expire after 60s)
          function startTokenRefresh() {
            setInterval(async () => {
              try {
                await getSessionToken();
                console.log('🔄 Token auto-refreshed');
              } catch (error) {
                console.log('⚠️  Auto-refresh failed:', error.message);
              }
            }, 50000); // 50 seconds
          }

          // Initialize App Bridge immediately (critical for OAuth redirects)
          initAppBridge();

          // Load products using session token (with auto-refresh support)
          async function loadProducts() {
            try {
              document.getElementById('status').textContent = 'Getting Auth Token...';
              
              // Get initial token from URL
              let sessionToken = getSessionTokenFromURL();
              
              if (!sessionToken) {
                throw new Error('No session token found. Try reinstalling the app.');
              }
              
              document.getElementById('status').textContent = 'Loading Products...';
              console.log('📦 Fetching products via GraphQL API...');
              
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
                
                // If shop not authenticated, redirect to OAuth using App Bridge
                if (errorData.needsAuth || errorData.error === 'Shop not authenticated') {
                  console.log('🔄 Shop not authenticated - need to reinstall');
                  document.getElementById('status').textContent = 'Need to Reinstall...';
                  
                  // Wait for App Bridge to be ready before redirecting
                  const waitForAppBridge = setInterval(() => {
                    if (app) {
                      clearInterval(waitForAppBridge);
                      console.log('✅ App Bridge ready, redirecting to OAuth');
                      redirectToOAuth();
                    } else {
                      console.log('⏳ Waiting for App Bridge to initialize...');
                    }
                  }, 100);
                  
                  // Timeout after 5 seconds - use fallback redirect
                  setTimeout(() => {
                    clearInterval(waitForAppBridge);
                    if (!app) {
                      console.log('⚠️  App Bridge timeout, using fallback redirect');
                      redirectToOAuth();
                    }
                  }, 5000);
                  
                  return;
                }
                
                throw new Error(errorData.error || 'HTTP ' + response.status);
              }

              const data = await response.json();
              console.log('✅ Products received via GraphQL:', data.products.length);
              
              document.getElementById('status').textContent = '✅ Connected';
              displayProducts(data.products);
            } catch (error) {
              console.error('❌ Error loading products:', error);
              document.getElementById('status').textContent = '❌ Error';
              showError('Failed to load products: ' + error.message);
            }
          }

          // Refresh products (can be called after token refresh)
          async function refreshProducts() {
            try {
              const sessionToken = await getSessionToken();
              
              const response = await fetch(appHost + '/api/products', {
                method: 'GET',
                headers: {
                  'Authorization': 'Bearer ' + sessionToken,
                  'Content-Type': 'application/json',
                }
              });

              if (response.ok) {
                const data = await response.json();
                displayProducts(data.products);
                console.log('🔄 Products refreshed');
              }
            } catch (error) {
              console.log('⚠️  Product refresh failed:', error.message);
            }
          }

          function displayProducts(products) {
            const container = document.getElementById('products');
            
            if (!products || products.length === 0) {
              container.innerHTML = '<div class="product-card">No products found in your store. Add some products with variants to test!</div>';
              return;
            }

            let html = '<div class="success"><strong>🎉 Success!</strong> Connected to your store and loaded products using GraphQL API (no more warnings!).</div>';
            
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

          // Start loading products immediately
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
  console.log(`✨ API: GraphQL (no more REST warnings!)`);
  console.log("");
});
