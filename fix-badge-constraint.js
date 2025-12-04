require("dotenv").config();
const { Pool } = require("pg");

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false },
});

async function fixConstraint() {
  try {
    console.log("🔧 Adding unique constraint to badge_assignments...");

    // Add unique constraint on (shop, variant_id)
    await pool.query(`
      ALTER TABLE badge_assignments 
      ADD CONSTRAINT badge_assignments_shop_variant_unique 
      UNIQUE (shop, variant_id)
    `);

    console.log("✅ Constraint added successfully!");
    process.exit(0);
  } catch (error) {
    console.error("❌ Error:", error.message);

    // If constraint already exists, that's okay
    if (error.code === "42P07") {
      console.log("ℹ️ Constraint already exists, no changes needed");
      process.exit(0);
    }

    process.exit(1);
  }
}

fixConstraint();
