const { Pool } = require("pg");

async function createSessionsTable() {
  const pool = new Pool({
    connectionString: process.env.DATABASE_URL,
    ssl: { rejectUnauthorized: false },
  });

  try {
    console.log("Creating sessions table...");

    await pool.query(`
      CREATE TABLE IF NOT EXISTS sessions (
        shop VARCHAR(255) PRIMARY KEY,
        access_token TEXT NOT NULL,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      );
    `);

    console.log("✅ Sessions table created");

    await pool.query(`
      CREATE INDEX IF NOT EXISTS idx_sessions_shop ON sessions(shop);
    `);

    console.log("✅ Index created");

    await pool.end();
    process.exit(0);
  } catch (error) {
    console.error("❌ Migration failed:", error);
    process.exit(1);
  }
}

createSessionsTable();
