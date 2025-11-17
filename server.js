require('dotenv').config();
const express = require('express');
const { shopifyApi, LATEST_API_VERSION } = require('@shopify/shopify-api');
require('@shopify/shopify-api/adapters/node');
const { Pool } = require('pg');
const cookieParser = require('cookie-parser');
const cors = require('cors');

const app = express();
const PORT = process.env.PORT || 3000;

// Database setup
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.NODE_ENV === 'production' ? { rejectUnauthorized: false } : false
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
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      )
    `);
    console.log('Database initialized');
  } finally {
    client.release();
  }
}

initDB();

// Shopify API setup
const shopify = shopifyApi({
  apiKey: process.env.SHOPIFY_API_KEY,
  apiSecretKey: process.env.SHOPIFY_API_SECRET,
  scopes: process.env.SCOPES.split(','),
  hostName: process.env.HOST.replace(/https?:\/\//, ''),
  apiVersion: LATEST_API_VERSION,
  isEmbeddedApp: true,
});

app.use(cors());
app.use(express.json());
app.use(cookieParser());

// Health check
app.get('/health', (req, res) => {
  res.json({ status: 'ok', message: 'Variant Badges app is running' });
});

// OAuth begin
app.get('/auth', async (req, res) => {
  try {
    const { shop } = req.query;
    
    console.log('OAuth start requested for shop:', shop);
    
    if (!shop) {
      return res.status(400).send('Missing shop parameter');
    }
    
    console.log('Starting OAuth flow...');
    
    const sanitizedShop = shopify.utils.sanitizeShop(shop, true);
    console.log('Sanitized shop:', sanitizedShop);
    
    await shopify.auth.begin({
      shop: sanitizedShop,
      callbackPath: '/auth/callback',
      isOnline: false,
      rawRequest: req,
      rawResponse: res,
    });
    
    console.log('OAuth redirect sent by Shopify library');
  } catch (error) {
    console.error('OAuth start error:', error);
    if (!res.headersSent) {
      res.status(500).send('OAuth failed: ' + error.message);
    }
  }
});

// OAuth callback
app.get('/auth/callback', async (req, res) => {
  try {
    console.log('OAuth callback received');
    
    const callback = await shopify.auth.callback({
      rawRequest: req,
      rawResponse: res,
    });

    const { session } = callback;
    console.log('Session created for shop:', session.shop);
    console.log('Access token received:', session.accessToken ? 'Yes' : 'No');
    
    // Store session in database
    const client = await pool.connect();
    try {
      console.log('Attempting to save session for:', session.shop);
      console.log('Access token exists:', !!session.accessToken);
      console.log('Access token length:', session.accessToken?.length);
      
      const result = await client.query(
        'INSERT INTO shops (shop, access_token) VALUES ($1, $2) ON CONFLICT (shop) DO UPDATE SET access_token = $2 RETURNING *',
        [session.shop, session.accessToken]
      );
      console.log('Session saved successfully. Token starts with:', session.accessToken?.substring(0, 10));
    } finally {
      client.release();
    }

    // Redirect to app
    const host = req.query.host;
    console.log('Redirecting to app with shop:', session.shop);
    res.redirect(`/?shop=${session.shop}&host=${host}`);
  } catch (error) {
    console.error('Auth callback error:', error);
    res.status(500).send('Authentication failed: ' + error.message);
  }
});

// Get shop session from database
async function getShopSession(shop) {
  const client = await pool.connect();
  try {
    const result = await client.query('SELECT access_token FROM shops WHERE shop = $1', [shop]);
    if (result.rows.length === 0) return null;
    return {
      shop,
      accessToken: result.rows[0].access_token,
    };
  } finally {
    client.release();
  }
}

// API: Get products
app.get('/api/products', async (req, res) => {
  try {
    const { shop } = req.query;
    
    console.log('API request for shop:', shop);
    
    if (!shop) {
      return res.status(400).json({ error: 'Missing shop parameter' });
    }

    const session = await getShopSession(shop);
    console.log('Session found:', session ? 'Yes' : 'No');
    
    if (!session) {
      // Let's check what shops are in the database
      const client = await pool.connect();
      try {
        const result = await client.query('SELECT shop FROM shops');
        console.log('Shops in database:', result.rows);
      } finally {
        client.release();
      }
      return res.status(401).json({ error: 'Shop not authenticated', requestedShop: shop });
    }

    const restClient = new shopify.clients.Rest({ session });
    
    // Fetch products with variants
    const products = await restClient.get({
      path: 'products',
      query: { limit: 50 },
    });

    res.json({ products: products.body.products });
  } catch (error) {
    console.error('Error fetching products:', error);
    res.status(500).json({ error: 'Failed to fetch products', details: error.message });
  }
});

// Serve frontend
app.get('/', (req, res) => {
  const { shop, host } = req.query;
  
  if (!shop) {
    return res.send(`
      <!DOCTYPE html>
      <html>
        <head>
          <title>Variant Badges - Install</title>
          <style>
            body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; padding: 50px; text-align: center; }
            input { padding: 10px; width: 300px; font-size: 16px; }
            button { padding: 10px 30px; background: #5c6ac4; color: white; border: none; font-size: 16px; cursor: pointer; margin-left: 10px; }
          </style>
        </head>
        <body>
          <h1>Variant Badges App</h1>
          <p>Enter your Shopify store URL to install:</p>
          <form action="/auth" method="get">
            <input type="text" name="shop" placeholder="your-store.myshopify.com" required />
            <button type="submit">Install App</button>
          </form>
        </body>
      </html>
    `);
  }

  const htmlContent = `
    <!DOCTYPE html>
    <html>
      <head>
        <title>Variant Badges - Phase 1</title>
        <style>
          body { 
            font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; 
            padding: 20px; 
            background: #f4f6f8;
          }
          .container { max-width: 1200px; margin: 0 auto; }
          .header { background: white; padding: 30px; border-radius: 8px; margin-bottom: 20px; box-shadow: 0 1px 3px rgba(0,0,0,0.1); }
          .product-card { 
            background: white; 
            padding: 20px; 
            margin-bottom: 15px; 
            border-radius: 8px;
            box-shadow: 0 1px 3px rgba(0,0,0,0.1);
          }
          .product-title { font-size: 18px; font-weight: 600; margin-bottom: 15px; color: #202223; }
          .variant-row { 
            display: flex; 
            align-items: center; 
            padding: 10px; 
            border-bottom: 1px solid #e1e3e5;
            gap: 15px;
          }
          .variant-row:last-child { border-bottom: none; }
          .variant-image { width: 50px; height: 50px; object-fit: cover; border-radius: 4px; border: 1px solid #e1e3e5; }
          .variant-info { flex: 1; }
          .variant-option { color: #6d7175; font-size: 14px; }
          .loading { text-align: center; padding: 50px; }
          .success { color: #008060; background: #e3f5ef; padding: 15px; border-radius: 4px; margin-bottom: 20px; }
          .error { color: #d72c0d; background: #fef3f2; padding: 15px; border-radius: 4px; margin-bottom: 20px; }
        </style>
      </head>
      <body>
        <div class="container">
          <div class="header">
            <h1>Variant Badges - Phase 1 Test</h1>
            <p style="color: #6d7175;">✅ Successfully connected to your Shopify store!</p>
            <div class="success">
              <strong>Connection Test Successful!</strong><br>
              Below are the products from your dev store. We're reading variant data successfully.
            </div>
          </div>
          <div id="products">
            <div class="loading">Loading your products...</div>
          </div>
        </div>

        <script>
          const shop = '${shop}';

          fetch('/api/products?shop=' + encodeURIComponent(shop))
            .then(res => {
              if (!res.ok) {
                throw new Error('HTTP ' + res.status + ': ' + res.statusText);
              }
              return res.json();
            })
            .then(data => {
              const container = document.getElementById('products');
              
              if (!data.products || data.products.length === 0) {
                container.innerHTML = '<div class="product-card">No products found in your store. Add some products to test!</div>';
                return;
              }

              let html = '';
              data.products.forEach(product => {
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
                    html += '<div class="variant-option">SKU: ' + escapeHtml(variant.sku || 'N/A') + '</div>';
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
            })
            .catch(err => {
              console.error('Error:', err);
              document.getElementById('products').innerHTML = 
                '<div class="error"><strong>Error loading products:</strong><br>' + escapeHtml(err.message) + '<br><br>Check the browser console for more details.</div>';
            });
          
          function escapeHtml(text) {
            const div = document.createElement('div');
            div.textContent = text;
            return div.innerHTML;
          }
        </script>
      </body>
    </html>
  `;
  
  res.send(htmlContent);
});

// Debug endpoint: Clear shop session
app.get('/debug/clear-session', async (req, res) => {
  try {
    const { shop } = req.query;
    if (!shop) {
      return res.status(400).send('Missing shop parameter');
    }
    
    const client = await pool.connect();
    try {
      const result = await client.query('DELETE FROM shops WHERE shop = $1 RETURNING *', [shop]);
      console.log('Deleted session:', result.rows);
      res.json({ message: 'Session cleared', shop, deleted: result.rowCount > 0 });
    } finally {
      client.release();
    }
  } catch (error) {
    console.error('Error clearing session:', error);
    res.status(500).json({ error: error.message });
  }
});

app.listen(PORT, () => {
  console.log(`Variant Badges app running on port ${PORT}`);
  console.log(`Visit http://localhost:${PORT} to test locally`);
});
