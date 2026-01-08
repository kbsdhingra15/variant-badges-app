const { Pool } = require("pg");
require("dotenv").config();

const pool = new Pool({
  connectionString:
    "postgresql://postgres:SkhgjsJgWlKDEtFHvAwZBVUhYPXKsMZP@centerbeam.proxy.rlwy.net:35696/railway",
  ssl: { rejectUnauthorized: false },
});

async function checkAnalytics() {
  try {
    const result = await pool.query(`
      SELECT 
        event_type,
        badge_type,
        COUNT(*) as count
      FROM badge_analytics
      GROUP BY event_type, badge_type
      ORDER BY event_type, badge_type
    `);

    console.log("\n📊 Analytics Summary:");
    console.table(result.rows);

    const recent = await pool.query(`
      SELECT 
        id,
        shop,
        event_type,
        badge_type,
        option_value,
        created_at
      FROM badge_analytics 
      ORDER BY created_at DESC 
      LIMIT 10
    `);

    console.log("\n🕐 Recent Events:");
    console.table(recent.rows);

    const total = await pool.query("SELECT COUNT(*) FROM badge_analytics");
    console.log(`\n✅ Total events tracked: ${total.rows[0].count}`);

    await pool.end();
    process.exit(0);
  } catch (error) {
    console.error("❌ Error:", error.message);
    await pool.end();
    process.exit(1);
  }
}

checkAnalytics();
