-- Migration: Multi-tenant security and RBAC for subscriptions
-- Date: 2026-04-03

-- 1. Create tenants table if not exists
CREATE TABLE IF NOT EXISTS tenants (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name TEXT NOT NULL,
  slug TEXT UNIQUE NOT NULL,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

-- 2. Create tenant_users mapping table if not exists
-- This maps users to tenants with specific roles
CREATE TABLE IF NOT EXISTS tenant_users (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  role TEXT NOT NULL CHECK (role IN ('admin', 'driver', 'user')),
  created_at TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE(tenant_id, user_id)
);

-- Add indexes for performance
CREATE INDEX IF NOT EXISTS idx_tenant_users_user_id ON tenant_users(user_id);
CREATE INDEX IF NOT EXISTS idx_tenant_users_tenant_id ON tenant_users(tenant_id);

-- 3. Helper function: get_my_tenant_id()
-- Returns the tenant_id for the currently authenticated user
CREATE OR REPLACE FUNCTION get_my_tenant_id()
RETURNS uuid AS $$
  SELECT tenant_id FROM tenant_users WHERE user_id = auth.uid() LIMIT 1;
$$ LANGUAGE sql STABLE SECURITY DEFINER;

-- 4. Helper function: is_tenant_admin()
-- Checks if the current user is an admin for their tenant
CREATE OR REPLACE FUNCTION is_tenant_admin()
RETURNS boolean AS $$
  SELECT EXISTS (
    SELECT 1 FROM tenant_users 
    WHERE user_id = auth.uid() AND role = 'admin'
  );
$$ LANGUAGE sql STABLE SECURITY DEFINER;

-- 5. Update subscriptions table RLS policies
-- First, drop existing policies to avoid conflicts
DROP POLICY IF EXISTS "Users can view own subscriptions" ON subscriptions;
DROP POLICY IF EXISTS "Admins can view tenant subscriptions" ON subscriptions;
DROP POLICY IF EXISTS "Service role full access" ON subscriptions;

-- Enable RLS (already enabled, but making sure)
ALTER TABLE subscriptions ENABLE ROW LEVEL SECURITY;

-- Policy: Users can SELECT their own subscription
CREATE POLICY "Users can view own subscriptions"
  ON subscriptions FOR SELECT
  USING (auth.uid() = user_id);

-- Policy: Tenant admins can SELECT all subscriptions in their tenant
CREATE POLICY "Admins can view tenant subscriptions"
  ON subscriptions FOR SELECT
  USING (
    is_tenant_admin() AND tenant_id = get_my_tenant_id()
  );

-- Policy: INSERT/UPDATE/DELETE restricted to service_role or tenant admins
-- Note: service_role bypasses RLS by default in Supabase, but we can be explicit
-- We allow tenant admins to manage subscriptions if needed, 
-- though usually the Node backend handles this.
CREATE POLICY "Admins can manage tenant subscriptions"
  ON subscriptions FOR ALL
  USING (
    is_tenant_admin() AND tenant_id = get_my_tenant_id()
  )
  WITH CHECK (
    is_tenant_admin() AND tenant_id = get_my_tenant_id()
  );

-- 6. Ensure indexes exist on subscriptions for tenant_id and user_id
CREATE INDEX IF NOT EXISTS idx_subscriptions_user_id_v2 ON subscriptions(user_id);
CREATE INDEX IF NOT EXISTS idx_subscriptions_tenant_id_v2 ON subscriptions(tenant_id);

-- 7. RLS for tenants and tenant_users
ALTER TABLE tenants ENABLE ROW LEVEL SECURITY;
ALTER TABLE tenant_users ENABLE ROW LEVEL SECURITY;

-- Tenants: Users can see the tenant they belong to
CREATE POLICY "Users can view their own tenant"
  ON tenants FOR SELECT
  USING (
    id = get_my_tenant_id()
  );

-- Tenant Users: Users can see their own mapping
CREATE POLICY "Users can view own tenant mapping"
  ON tenant_users FOR SELECT
  USING (
    auth.uid() = user_id
  );

-- Tenant Users: Admins can see all mappings in their tenant
CREATE POLICY "Admins can view all tenant mappings"
  ON tenant_users FOR SELECT
  USING (
    is_tenant_admin() AND tenant_id = get_my_tenant_id()
  );

-- 8. Explanation of each policy:
-- "Users can view own subscriptions": Allows any authenticated user to see their own record.
-- "Admins can view tenant subscriptions": Allows users with 'admin' role in tenant_users to see all records for their tenant.
-- "Admins can manage tenant subscriptions": Allows tenant admins to perform write operations within their tenant.
-- "Users can view their own tenant": Restricts tenant visibility to members only.
-- "Users can view own tenant mapping": Allows users to see which tenant they are assigned to.
-- "Admins can view all tenant mappings": Allows tenant admins to see all members of their tenant.
-- service_role: Bypasses RLS automatically, used by the Node backend for secure operations.
