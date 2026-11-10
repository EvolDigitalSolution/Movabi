-- Candidate test-schema migration (reviewed, additive).
--
-- Source: supabase/migrations/20260403000002_multi_tenant_security.sql (the
-- authoritative tenants DDL). The reviewed deployed snapshot does not contain
-- public.tenants because that snapshot came from a divergent clone, not from an
-- ordered replay of the migration chain. This file adds ONLY the missing table
-- required by application code and fixtures; it does not replay the migration.
CREATE TABLE IF NOT EXISTS public.tenants (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name text NOT NULL,
  slug text UNIQUE NOT NULL,
  created_at timestamptz DEFAULT now()
);
