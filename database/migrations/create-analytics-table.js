const { Pool } = require("pg");
require("dotenv").config();

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl:
    process.env.NODE_ENV === "production"
      ? { rejectUnauthorized: false }
      : false,
});

async function createAnalyticsTable() {
  try {
    await pool.query(`
      CREATE TABLE IF NOT EXISTS badge_analytics (
        id SERIAL PRIMARY KEY,
        shop VARCHAR(255) NOT NULL,
        product_id BIGINT,
        variant_id BIGINT,
        badge_type VARCHAR(10),
        option_value VARCHAR(100),
        event_type VARCHAR(20),
        session_id VARCHAR(255),
        created_at TIMESTAMP DEFAULT NOW()
      );
      
      CREATE INDEX IF NOT EXISTS idx_badge_analytics_shop 
        ON badge_analytics(shop);
      CREATE INDEX IF NOT EXISTS idx_badge_analytics_event 
        ON badge_analytics(shop, event_type);
      CREATE INDEX IF NOT EXISTS idx_badge_analytics_date 
        ON badge_analytics(created_at);
    `);

    console.log("✅ Analytics table created successfully");
    await pool.end();
    process.exit(0);
  } catch (error) {
    console.error("❌ Error creating analytics table:", error);
    await pool.end();
    process.exit(1);
  }
}

createAnalyticsTable();
