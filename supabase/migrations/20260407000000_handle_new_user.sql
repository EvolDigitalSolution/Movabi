-- Migration: Handle new user creation and profile bootstrapping
-- Date: 2026-04-07

-- 1. Ensure a default tenant exists
INSERT INTO public.tenants (id, name, slug)
VALUES ('d0e8e8e8-e8e8-e8e8-e8e8-d0e8e8e8e8e8', 'Movabi Global', 'movabi-global')
ON CONFLICT (slug) DO NOTHING;

-- 2. Create a function to handle new user signups
CREATE OR REPLACE FUNCTION public.handle_new_user()
RETURNS trigger AS $$
DECLARE
  v_tenant_id UUID;
  v_full_name TEXT;
  v_first_name TEXT;
  v_last_name TEXT;
BEGIN
  -- Get the default tenant ID
  SELECT id INTO v_tenant_id FROM public.tenants WHERE slug = 'movabi-global' LIMIT 1;
  
  -- Extract names from metadata
  v_full_name := COALESCE(new.raw_user_meta_data->>'full_name', 'User');
  v_first_name := split_part(v_full_name, ' ', 1);
  v_last_name := substring(v_full_name from position(' ' in v_full_name) + 1);
  
  IF v_last_name = '' THEN
    v_last_name := 'User';
  END IF;

  -- Insert into profiles
  INSERT INTO public.profiles (
    id, 
    email, 
    first_name, 
    last_name, 
    role, 
    tenant_id,
    pricing_plan, 
    commission_rate, 
    currency_code, 
    country_code,
    subscription_status
  )
  VALUES (
    new.id,
    new.email,
    v_first_name,
    v_last_name,
    COALESCE(new.raw_user_meta_data->>'role', 'customer'),
    v_tenant_id,
    'starter',
    15.00,
    'GBP',
    'GB',
    'inactive'
  );

  -- Also insert into tenant_users to satisfy RLS and multi-tenant logic
  INSERT INTO public.tenant_users (tenant_id, user_id, role)
  VALUES (
    v_tenant_id,
    new.id,
    COALESCE(new.raw_user_meta_data->>'role', 'user')
  );

  RETURN new;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

-- 3. Trigger the function every time a user is created
DROP TRIGGER IF EXISTS on_auth_user_created ON auth.users;
CREATE TRIGGER on_auth_user_created
  AFTER INSERT ON auth.users
  FOR EACH ROW EXECUTE FUNCTION public.handle_new_user();
