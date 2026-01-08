const { Pool } = require("pg");
const fs = require("fs");
const path = require("path");

const DATABASE_URL =
  "postgresql://postgres:SkhgjsJgWlKDEtFHvAwZBVUhYPXKsMZP@centerbeam.proxy.rlwy.net:35696/railway";

const pool = new Pool({
  connectionString: DATABASE_URL,
  ssl: {
    rejectUnauthorized: false,
  },
});

async function runMigration() {
  const client = await pool.connect();
  try {
    console.log("Connected to database...");

    const sql = fs.readFileSync(path.join(__dirname, "migration.sql"), "utf8");

    console.log("Running migration...");
    await client.query(sql);

    console.log("✅ Migration completed successfully!");
  } catch (err) {
    console.error("❌ Migration failed:", err);
  } finally {
    client.release();
    await pool.end();
  }
}

runMigration();
