require("dotenv").config();
const { Pool } = require("pg");

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: {
    rejectUnauthorized: false,
  },
});

async function migrateBadgesTable() {
  try {
    console.log("🔄 Migrating badge tables...");

    await pool.query("DROP TABLE IF EXISTS badge_assignments CASCADE");
    await pool.query(
      "ALTER TABLE badge_assignments_backup RENAME TO badge_assignments"
    );

    console.log("✅ Migration complete!");
    console.log("   - Dropped old badge_assignments table");
    console.log("   - Renamed badge_assignments_backup → badge_assignments");

    process.exit(0);
  } catch (error) {
    console.error("❌ Migration failed:", error);
    process.exit(1);
  }
}

migrateBadgesTable();
