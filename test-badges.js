require("dotenv").config();
const { Pool } = require("pg");

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false },
});

async function checkBadges() {
  const result = await pool.query(
    "SELECT * FROM badge_assignments WHERE shop = 'quickstart-c559582d.myshopify.com' ORDER BY updated_at DESC"
  );
  console.log("Badge assignments:", result.rows);
  process.exit(0);
}

checkBadges();
