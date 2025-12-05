require("dotenv").config();
const { Pool } = require("pg");

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false },
});

async function addColumn() {
  try {
    console.log("🔧 Adding option_type column...");

    await pool.query(`
      ALTER TABLE badge_assignments 
      ADD COLUMN IF NOT EXISTS option_type VARCHAR(100)
    `);

    console.log("✅ Column added successfully!");
    process.exit(0);
  } catch (error) {
    console.error("❌ Error:", error.message);
    process.exit(1);
  }
}

addColumn();
