const { Pool } = require("pg");
// Database connection pool
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl:
    process.env.NODE_ENV === "production"
      ? { rejectUnauthorized: false }
      : false,
});
// Auto-run migrations on startup
async function runMigrations() {
  try {
    // Create sessions table if it doesn't exist
    await pool.query(`
      CREATE TABLE IF NOT EXISTS sessions (
        shop VARCHAR(255) PRIMARY KEY,
        access_token TEXT NOT NULL,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      );
    `);

    await pool.query(`
      CREATE INDEX IF NOT EXISTS idx_sessions_shop ON sessions(shop);
    `);

    console.log("✅ Sessions table ready");
  } catch (error) {
    console.error("❌ Migration error:", error);
  }
}
// Call it immediately
runMigrations();
// Initialize database tables
// Initialize database tables
async function initDB() {
  const client = await pool.connect();
  try {
    // Shops table (OAuth sessions)
    await client.query(`
      CREATE TABLE IF NOT EXISTS shops (
        id SERIAL PRIMARY KEY,
        shop VARCHAR(255) UNIQUE NOT NULL,
        access_token TEXT NOT NULL,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      )
    `);

    // App Settings table
    await client.query(`
      CREATE TABLE IF NOT EXISTS app_settings (
        id SERIAL PRIMARY KEY,
        shop VARCHAR(255) UNIQUE NOT NULL,
        selected_option VARCHAR(100),
        badge_display_enabled BOOLEAN DEFAULT true,
        auto_sale_enabled BOOLEAN DEFAULT false,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      )
    `);

    // Badge Assignments table (UPDATED - includes variant_id, product_id, option_type)
    await client.query(`
  CREATE TABLE IF NOT EXISTS badge_assignments (
    id SERIAL PRIMARY KEY,
    shop VARCHAR(255) NOT NULL,
    variant_id VARCHAR(255) NOT NULL,
    product_id VARCHAR(255) NOT NULL,
    option_value VARCHAR(100) NOT NULL,
    option_type VARCHAR(50),
    badge_type VARCHAR(20) NOT NULL CHECK (badge_type IN ('HOT', 'NEW', 'SALE')),
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT unique_shop_variant UNIQUE(shop, variant_id)
  )
`);

    // Subscriptions table (NEW - for billing)
    await client.query(`
      CREATE TABLE IF NOT EXISTS subscriptions (
        id SERIAL PRIMARY KEY,
        shop VARCHAR(255) NOT NULL UNIQUE,
        plan_name VARCHAR(50) NOT NULL DEFAULT 'free',
        status VARCHAR(50) NOT NULL DEFAULT 'active',
        charge_id VARCHAR(255),
        billing_on TIMESTAMP,
        trial_ends_at TIMESTAMP,
        cancelled_at TIMESTAMP,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      )
    `);

    // Create indexes for better query performance
    await client.query(`
      CREATE INDEX IF NOT EXISTS idx_badge_shop ON badge_assignments(shop)
    `);
    await client.query(`
      CREATE INDEX IF NOT EXISTS idx_badge_value ON badge_assignments(option_value)
    `);
    await client.query(`
  CREATE INDEX IF NOT EXISTS idx_badge_product ON badge_assignments(shop, product_id)
`);
    await client.query(`
      CREATE INDEX IF NOT EXISTS idx_subscriptions_shop ON subscriptions(shop)
    `);
    await client.query(`
      CREATE INDEX IF NOT EXISTS idx_subscriptions_status ON subscriptions(status)
    `);

    console.log("✅ Database initialized");
  } catch (error) {
    console.error("❌ Database initialization error:", error);
    throw error;
  } finally {
    client.release();
  }
}

// Shop session management
async function saveShopSession(shop, accessToken) {
  const client = await pool.connect();
  try {
    await client.query(
      `INSERT INTO shops (shop, access_token, updated_at) 
       VALUES ($1, $2, NOW())
       ON CONFLICT (shop) 
       DO UPDATE SET access_token = $2, updated_at = NOW()`,
      [shop, accessToken]
    );
    console.log("✅ Shop session saved:", shop);
    return true;
  } catch (error) {
    console.error("❌ Error saving shop session:", error);
    return false;
  } finally {
    client.release();
  }
}

async function getShopSession(shop) {
  const client = await pool.connect();
  try {
    const result = await client.query(
      "SELECT shop, access_token FROM shops WHERE shop = $1",
      [shop]
    );

    if (result.rows.length === 0) {
      return null;
    }

    return {
      shop: result.rows[0].shop,
      accessToken: result.rows[0].access_token,
    };
  } catch (error) {
    console.error("❌ Error getting shop session:", error);
    throw error;
  } finally {
    client.release();
  }
}

// Settings management
async function getAppSettings(shop) {
  const client = await pool.connect();
  try {
    const result = await client.query(
      "SELECT selected_option, badge_display_enabled, auto_sale_enabled FROM app_settings WHERE shop = $1",
      [shop]
    );
    console.log("🔍 getAppSettings DEBUG:");
    console.log("   Shop:", shop);
    console.log("   Rows found:", result.rows.length);
    console.log("   Raw row:", result.rows[0]);

    if (result.rows.length === 0) {
      return {
        selectedOption: null,
        badgeDisplayEnabled: true,
        autoSaleEnabled: false,
      };
    }

    const returnValue = {
      selectedOption: result.rows[0].selected_option,
      badgeDisplayEnabled: result.rows[0].badge_display_enabled,
      autoSaleEnabled: result.rows[0].auto_sale_enabled,
    };
    console.log("   ✅ Returning:", returnValue);
    return returnValue;
  } catch (error) {
    console.error("❌ Error getting app settings:", error);
    throw error;
  } finally {
    client.release();
  }
}

async function saveAppSettings(shop, settings) {
  const client = await pool.connect();
  try {
    const { selected_option, badge_display_enabled, auto_sale_enabled } =
      settings;

    await client.query(
      `INSERT INTO app_settings (shop, selected_option, badge_display_enabled, auto_sale_enabled, updated_at) 
       VALUES ($1, $2, $3, $4, NOW())
       ON CONFLICT (shop) 
       DO UPDATE SET 
         selected_option = COALESCE($2, app_settings.selected_option),
         badge_display_enabled = COALESCE($3, app_settings.badge_display_enabled),
         auto_sale_enabled = COALESCE($4, app_settings.auto_sale_enabled),
         updated_at = NOW()`,
      [shop, selected_option, badge_display_enabled, auto_sale_enabled]
    );
    console.log("✅ App settings saved:", shop);
  } catch (error) {
    console.error("❌ Error saving app settings:", error);
    throw error;
  } finally {
    client.release();
  }
}

// Badge management (VARIANT-LEVEL)
async function getBadgeAssignments(shop) {
  const client = await pool.connect();
  try {
    const result = await client.query(
      `SELECT variant_id, product_id, badge_type, option_value 
       FROM badge_assignments 
       WHERE shop = $1 
       ORDER BY product_id, option_value`,
      [shop]
    );
    return result.rows;
  } catch (error) {
    console.error("❌ Error getting badge assignments:", error);
    throw error;
  } finally {
    client.release();
  }
}

async function saveBadgeAssignment(
  shop,
  variantId,
  productId,
  badgeType,
  optionValue,
  optionType
) {
  const client = await pool.connect();
  try {
    await client.query(
      `INSERT INTO badge_assignments (shop, variant_id, product_id, badge_type, option_value, option_type, updated_at)
       VALUES ($1, $2, $3, $4, $5, $6, NOW())
       ON CONFLICT (shop, variant_id)
       DO UPDATE SET 
         badge_type = $4,
         option_value = $5,
         option_type = $6,
         updated_at = NOW()`,
      [shop, variantId, productId, badgeType, optionValue, optionType]
    );
    console.log(
      "✅ Badge assignment saved:",
      shop,
      variantId,
      badgeType,
      optionType
    );
  } catch (error) {
    console.error("❌ Error saving badge assignment:", error);
    throw error;
  } finally {
    client.release();
  }
}

async function deleteBadgeAssignment(shop, variantId) {
  const client = await pool.connect();
  try {
    await client.query(
      `DELETE FROM badge_assignments 
       WHERE shop = $1 AND variant_id = $2`,
      [shop, variantId]
    );
    console.log("✅ Badge assignment deleted:", shop, variantId);
  } catch (error) {
    console.error("❌ Error deleting badge assignment:", error);
    throw error;
  } finally {
    client.release();
  }
}

async function getBadgesForPublicAPI(shop) {
  const client = await pool.connect();
  try {
    const result = await client.query(
      "SELECT option_value, badge_type FROM badge_assignments WHERE shop = $1",
      [shop]
    );

    // Convert to format: { "Red": ["HOT"], "Blue": ["NEW", "HOT"] }
    const badges = {};
    result.rows.forEach((row) => {
      if (!badges[row.option_value]) {
        badges[row.option_value] = [];
      }
      badges[row.option_value].push(row.badge_type);
    });

    return badges;
  } catch (error) {
    console.error("❌ Error getting public badges:", error);
    throw error;
  } finally {
    client.release();
  }
}

// Badge Assignment Functions
// ===========================

async function getBadgeAssignments(shop) {
  const query = `
    SELECT * FROM badge_assignments 
    WHERE shop = $1
    ORDER BY created_at DESC
  `;
  const result = await pool.query(query, [shop]);
  return result.rows;
}

async function deleteBadgeAssignment(shop, variantId) {
  const query = `DELETE FROM badge_assignments WHERE shop = $1 AND variant_id = $2`;
  await pool.query(query, [shop, variantId]);
}

async function getBadgesForPublicAPI(shop) {
  const query = `
    SELECT variant_id, badge_type, option_value 
    FROM badge_assignments 
    WHERE shop = $1 AND badge_type IS NOT NULL
  `;
  const result = await pool.query(query, [shop]);
  return result.rows;
}

// Get subscription for shop
async function getSubscription(shop) {
  try {
    const result = await pool.query(
      "SELECT * FROM subscriptions WHERE shop = $1",
      [shop]
    );
    return result.rows[0] || null;
  } catch (error) {
    console.error("Error getting subscription:", error);
    return null;
  }
}

// Create or update subscription
async function saveSubscription(shop, data) {
  const {
    plan_name = "free",
    status = "active",
    charge_id = null,
    billing_on = null,
    trial_ends_at = null,
    cancelled_at = null,
  } = data;

  try {
    const result = await pool.query(
      `INSERT INTO subscriptions 
       (shop, plan_name, status, charge_id, billing_on, trial_ends_at, cancelled_at, updated_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, CURRENT_TIMESTAMP)
       ON CONFLICT (shop) 
       DO UPDATE SET 
         plan_name = EXCLUDED.plan_name,
         status = EXCLUDED.status,
         charge_id = EXCLUDED.charge_id,
         billing_on = EXCLUDED.billing_on,
         trial_ends_at = EXCLUDED.trial_ends_at,
         cancelled_at = EXCLUDED.cancelled_at,
         updated_at = CURRENT_TIMESTAMP
       RETURNING *`,
      [
        shop,
        plan_name,
        status,
        charge_id,
        billing_on,
        trial_ends_at,
        cancelled_at,
      ]
    );
    return result.rows[0];
  } catch (error) {
    console.error("Error saving subscription:", error);
    throw error;
  }
}

/*// Initialize trial for new shop
async function initializeTrial(shop) {
  const trialEndsAt = new Date();
  trialEndsAt.setDate(trialEndsAt.getDate() + 14); // 14-day trial

  return saveSubscription(shop, {
    plan_name: "trial",
    status: "active",
    trial_ends_at: trialEndsAt,
  });
}   */

// Count products with badges for a shop
async function countBadgedProducts(shop) {
  try {
    const result = await pool.query(
      "SELECT COUNT(DISTINCT product_id) as count FROM badge_assignments WHERE shop = $1",
      [shop]
    );
    return parseInt(result.rows[0]?.count || 0);
  } catch (error) {
    console.error("Error counting badged products:", error);
    return 0;
  }
}
// Clean up badges when downgrading to Free plan
// Keeps badges on first 5 products, removes rest
async function cleanupBadgesForFreePlan(shop) {
  try {
    console.log("🧹 [CLEANUP] Starting badge cleanup for:", shop);

    // Get all badge assignments for this shop
    const result = await pool.query(
      `SELECT DISTINCT product_id FROM badge_assignments 
       WHERE shop = $1 
       ORDER BY product_id`,
      [shop]
    );

    const productIds = result.rows.map((row) => row.product_id);
    const totalProducts = productIds.length;

    console.log(`📊 [CLEANUP] Found ${totalProducts} products with badges`);

    if (totalProducts <= 5) {
      console.log("✅ [CLEANUP] 5 or fewer products - no cleanup needed");
      return {
        cleaned: false,
        totalProducts: totalProducts,
        keptProducts: totalProducts,
        removedProducts: 0,
      };
    }

    // Keep first 5, remove rest
    const keepProducts = productIds.slice(0, 5);
    const removeProducts = productIds.slice(5);

    console.log(`✅ [CLEANUP] Keeping badges on products:`, keepProducts);
    console.log(`🗑️ [CLEANUP] Removing badges from products:`, removeProducts);

    // Delete badges for products beyond the first 5
    const deleteResult = await pool.query(
      `DELETE FROM badge_assignments 
       WHERE shop = $1 AND product_id = ANY($2::text[])
       RETURNING product_id`,
      [shop, removeProducts]
    );

    console.log(
      `✅ [CLEANUP] Removed ${deleteResult.rowCount} badge assignments`
    );

    return {
      cleaned: true,
      totalProducts: totalProducts,
      keptProducts: keepProducts.length,
      removedProducts: removeProducts.length,
      keptProductIds: keepProducts,
      removedProductIds: removeProducts,
    };
  } catch (error) {
    console.error("❌ [CLEANUP] Error cleaning badges:", error);
    throw error;
  }
}
module.exports = {
  pool,
  initDB,
  saveShopSession,
  getShopSession,
  getAppSettings,
  saveAppSettings,
  getBadgeAssignments,
  saveBadgeAssignment,
  deleteBadgeAssignment,
  getBadgesForPublicAPI, // ADD THIS LINE
  getSubscription,
  saveSubscription,
  //initializeTrial,
  countBadgedProducts,
  cleanupBadgesForFreePlan,
};
