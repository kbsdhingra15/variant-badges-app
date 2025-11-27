const { Pool } = require("pg");

// Database connection pool
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl:
    process.env.NODE_ENV === "production"
      ? { rejectUnauthorized: false }
      : false,
});

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

    // App Settings table (which variant option chosen)
    await client.query(`
      CREATE TABLE IF NOT EXISTS app_settings (
        id SERIAL PRIMARY KEY,
        shop VARCHAR(255) UNIQUE NOT NULL,
        selected_option VARCHAR(100),
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      )
    `);

    // Badge Assignments table (which variants have which badges)
    await client.query(`
      CREATE TABLE IF NOT EXISTS badge_assignments (
        id SERIAL PRIMARY KEY,
        shop VARCHAR(255) NOT NULL,
        product_id VARCHAR(50) NOT NULL,
        variant_id VARCHAR(50) NOT NULL,
        badge_type VARCHAR(20) NOT NULL,
        option_value VARCHAR(100),
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        UNIQUE(shop, variant_id, badge_type)
      )
    `);

    // Create indexes for better query performance
    await client.query(`
      CREATE INDEX IF NOT EXISTS idx_badge_shop ON badge_assignments(shop)
    `);
    await client.query(`
      CREATE INDEX IF NOT EXISTS idx_badge_product ON badge_assignments(product_id)
    `);
    await client.query(`
      CREATE INDEX IF NOT EXISTS idx_badge_variant ON badge_assignments(variant_id)
    `);

    console.log(
      "✅ Database initialized (shops, app_settings, badge_assignments)"
    );
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
  } catch (error) {
    console.error("❌ Error saving shop session:", error);
    throw error;
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
      "SELECT selected_option FROM app_settings WHERE shop = $1",
      [shop]
    );

    if (result.rows.length === 0) {
      return { selectedOption: null };
    }

    return {
      selectedOption: result.rows[0].selected_option,
    };
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

// Badge management (SIMPLIFIED - option_value based)
async function getBadgeAssignments(shop) {
  const client = await pool.connect();
  try {
    const result = await client.query(
      `SELECT option_value, badge_type 
       FROM badge_assignments 
       WHERE shop = $1 
       ORDER BY option_value`,
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

async function saveBadgeAssignment(shop, optionValue, badgeType) {
  const client = await pool.connect();
  try {
    await client.query(
      `INSERT INTO badge_assignments (shop, option_value, badge_type, updated_at)
       VALUES ($1, $2, $3, NOW())
       ON CONFLICT (shop, option_value, badge_type)
       DO UPDATE SET updated_at = NOW()`,
      [shop, optionValue, badgeType]
    );
    console.log("✅ Badge assignment saved:", shop, optionValue, badgeType);
  } catch (error) {
    console.error("❌ Error saving badge assignment:", error);
    throw error;
  } finally {
    client.release();
  }
}

async function deleteBadgeAssignment(shop, optionValue, badgeType) {
  const client = await pool.connect();
  try {
    await client.query(
      `DELETE FROM badge_assignments 
       WHERE shop = $1 AND option_value = $2 AND badge_type = $3`,
      [shop, optionValue, badgeType]
    );
    console.log("✅ Badge assignment deleted:", shop, optionValue, badgeType);
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
};
