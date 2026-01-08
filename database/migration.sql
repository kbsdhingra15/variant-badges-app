-- ============================================
-- Migration: Simplify Badge System
-- ============================================

-- 1. Backup existing data
CREATE TABLE IF NOT EXISTS badge_assignments_backup AS 
SELECT * FROM badge_assignments;

-- 2. Drop old table and create new simplified structure
DROP TABLE IF EXISTS badge_assignments CASCADE;

CREATE TABLE badge_assignments (
  id SERIAL PRIMARY KEY,
  shop VARCHAR(255) NOT NULL,
  option_value VARCHAR(100) NOT NULL,
  badge_type VARCHAR(20) NOT NULL CHECK (badge_type IN ('HOT', 'NEW')),
  created_at TIMESTAMP DEFAULT NOW(),
  updated_at TIMESTAMP DEFAULT NOW(),
  CONSTRAINT unique_shop_value_badge UNIQUE(shop, option_value, badge_type)
);

CREATE INDEX idx_badge_shop ON badge_assignments(shop);
CREATE INDEX idx_badge_value ON badge_assignments(option_value);

-- 3. Update app_settings table with new columns
ALTER TABLE app_settings 
ADD COLUMN IF NOT EXISTS badge_display_enabled BOOLEAN DEFAULT true;

ALTER TABLE app_settings 
ADD COLUMN IF NOT EXISTS auto_sale_enabled BOOLEAN DEFAULT false;

-- Set defaults for existing shops
UPDATE app_settings 
SET badge_display_enabled = true, 
    auto_sale_enabled = false
WHERE badge_display_enabled IS NULL;

-- 4. Verify structure
SELECT 'Migration completed!' AS status;