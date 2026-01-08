const { pool } = require("../db");

async function createSubscriptionsTable() {
  const query = `
    CREATE TABLE IF NOT EXISTS subscriptions (
      id SERIAL PRIMARY KEY,
      shop VARCHAR(255) NOT NULL UNIQUE,
      plan_name VARCHAR(50) NOT NULL DEFAULT 'free',
      status VARCHAR(50) NOT NULL DEFAULT 'active',
      charge_id VARCHAR(255),
      billing_on TIMESTAMP,
      trial_ends_at TIMESTAMP,
      cancelled_at TIMESTAMP,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    );

    CREATE INDEX idx_subscriptions_shop ON subscriptions(shop);
    CREATE INDEX idx_subscriptions_status ON subscriptions(status);
  `;

  try {
    await pool.query(query);
    console.log("✅ Subscriptions table created");
  } catch (error) {
    console.error("❌ Error creating subscriptions table:", error);
    throw error;
  }
}

module.exports = { createSubscriptionsTable };
