-- ============================================================================
-- Supabase / PostgreSQL Schema for Role-Based Order Processing Bot
-- ============================================================================

-- Enable pgcrypto if needed
CREATE EXTENSION IF NOT EXISTS pgcrypto;

-- 1. Table: users
-- Stores registered employees and their assigned roles.
-- Roles are enforced via CHECK constraint and cannot be self-selected.
CREATE TABLE IF NOT EXISTS users (
    telegram_id BIGINT PRIMARY KEY,
    name TEXT NOT NULL,
    role TEXT NOT NULL CHECK (role IN ('manager', 'store', 'finance', 'sales')),
    created_at TIMESTAMPTZ DEFAULT NOW()
);

-- 2. Table: orders
-- Stores orders through the complete requisition -> fulfillment -> reconciliation lifecycle.
-- Media is stored natively as Telegram file_id strings without third-party buckets.
CREATE TABLE IF NOT EXISTS orders (
    id SERIAL PRIMARY KEY,
    sales_id BIGINT NOT NULL REFERENCES users(telegram_id) ON DELETE RESTRICT,
    client_name TEXT NOT NULL,
    item_details TEXT NOT NULL,
    total_amount NUMERIC NOT NULL CHECK (total_amount > 0),
    status TEXT NOT NULL DEFAULT 'pending_approval' 
        CHECK (status IN ('pending_approval', 'pending_dispatch', 'dispatched', 'pending_audit', 'completed', 'cancelled')),
    store_receipt_file_id TEXT,
    payment_slip_file_id TEXT,
    created_at TIMESTAMPTZ DEFAULT NOW(),
    updated_at TIMESTAMPTZ DEFAULT NOW()
);

-- Indexes for performance
CREATE INDEX IF NOT EXISTS idx_orders_sales_id ON orders(sales_id);
CREATE INDEX IF NOT EXISTS idx_orders_status ON orders(status);
CREATE INDEX IF NOT EXISTS idx_users_role ON users(role);

-- Trigger function to automatically maintain updated_at
CREATE OR REPLACE FUNCTION update_updated_at_column()
RETURNS TRIGGER AS $$
BEGIN
    NEW.updated_at = NOW();
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trigger_orders_updated_at ON orders;
CREATE TRIGGER trigger_orders_updated_at
BEFORE UPDATE ON orders
FOR EACH ROW
EXECUTE FUNCTION update_updated_at_column();

-- ============================================================================
-- Row Level Security (RLS) Configuration
-- ============================================================================
-- Note: When using SUPABASE_KEY with the 'service_role' secret, RLS is bypassed.
-- If using anon key, these policies allow the bot to query and mutate tables.
ALTER TABLE users ENABLE ROW LEVEL SECURITY;
ALTER TABLE orders ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "Bot full access to users" ON users;
CREATE POLICY "Bot full access to users" ON users FOR ALL USING (true) WITH CHECK (true);

DROP POLICY IF EXISTS "Bot full access to orders" ON orders;
CREATE POLICY "Bot full access to orders" ON orders FOR ALL USING (true) WITH CHECK (true);

-- ============================================================================
-- Sample Seed Data (Replace telegram_id with actual Telegram User IDs)
-- To obtain your Telegram ID, run /start with the bot or message @userinfobot
-- ============================================================================
/*
INSERT INTO users (telegram_id, name, role) VALUES
    (111111111, 'Dawit (Sales Rep)', 'sales'),
    (222222222, 'Abebe (Manager)', 'manager'),
    (333333333, 'Kebede (Storekeeper)', 'store'),
    (444444444, 'Almaz (Finance Analyst)', 'finance')
ON CONFLICT (telegram_id) DO NOTHING;
*/
