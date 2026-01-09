const { pool } = require("../db");

async function fixBadgeAssignmentsSchema() {
  const client = await pool.connect();
  try {
    console.log("🔧 Starting badge_assignments schema fix...");

    // Add missing columns
    await client.query(`
      ALTER TABLE badge_assignments 
      ADD COLUMN IF NOT EXISTS variant_id VARCHAR(255),
      ADD COLUMN IF NOT EXISTS product_id VARCHAR(255),
      ADD COLUMN IF NOT EXISTS option_type VARCHAR(50);
    `);

    console.log("✅ Added missing columns");

    // Update constraint to use variant_id instead of option_value
    await client.query(`
      ALTER TABLE badge_assignments 
      DROP CONSTRAINT IF EXISTS unique_shop_value_badge;
    `);

    await client.query(`
      ALTER TABLE badge_assignments 
      ADD CONSTRAINT unique_shop_variant UNIQUE(shop, variant_id);
    `);

    console.log("✅ Updated unique constraint");

    // Add index for product_id queries
    await client.query(`
      CREATE INDEX IF NOT EXISTS idx_badge_product 
      ON badge_assignments(shop, product_id);
    `);

    console.log("✅ Added product_id index");

    // Update CHECK constraint to include SALE
    await client.query(`
      ALTER TABLE badge_assignments 
      DROP CONSTRAINT IF EXISTS badge_assignments_badge_type_check;
    `);

    await client.query(`
      ALTER TABLE badge_assignments 
      ADD CONSTRAINT badge_assignments_badge_type_check 
      CHECK (badge_type IN ('HOT', 'NEW', 'SALE'));
    `);

    console.log("✅ Updated badge_type constraint to include SALE");

    console.log("🎉 Schema fix complete!");
  } catch (error) {
    console.error("❌ Migration error:", error);
    throw error;
  } finally {
    client.release();
  }
}

// Run migration
fixBadgeAssignmentsSchema()
  .then(() => {
    console.log("Migration successful");
    process.exit(0);
  })
  .catch((error) => {
    console.error("Migration failed:", error);
    process.exit(1);
  });
