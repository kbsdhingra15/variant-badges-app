require("dotenv").config();
const { Pool } = require("pg");

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false },
});

async function checkSettings() {
  const result = await pool.query(
    "SELECT * FROM app_settings WHERE shop = 'quickstart-c559582d.myshopify.com'"
  );
  console.log("Database row:", result.rows);
  process.exit(0);
}

checkSettings();
