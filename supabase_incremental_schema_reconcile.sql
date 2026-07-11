-- ==============================================================================
-- MIGRATION: Supabase Incremental Schema Reconcile
-- DESCRIPTION: Reconciles existing production database with codebase expectations.
--              Idempotent, non-destructive, and backward-compatible.
-- DATE: 2026-04-15
-- ==============================================================================

-- PART 1 — Extensions
CREATE EXTENSION IF NOT EXISTS "uuid-ossp";
CREATE EXTENSION IF NOT EXISTS "pgcrypto";

-- PART 1B — Storage Buckets & Policies
INSERT INTO storage.buckets (id, name, public)
VALUES
    ('profiles', 'profiles', TRUE),
    ('driver-docs', 'driver-docs', FALSE)
ON CONFLICT (id) DO UPDATE
SET public = EXCLUDED.public;

DO $$
BEGIN
    IF EXISTS (SELECT 1 FROM information_schema.tables WHERE table_schema = 'storage' AND table_name = 'objects') THEN
        DROP POLICY IF EXISTS profiles_avatar_public_read ON storage.objects;
        DROP POLICY IF EXISTS profiles_avatar_owner_insert ON storage.objects;
        DROP POLICY IF EXISTS profiles_avatar_owner_update ON storage.objects;
        DROP POLICY IF EXISTS profiles_avatar_owner_delete ON storage.objects;
        DROP POLICY IF EXISTS driver_docs_owner_access ON storage.objects;

        IF NOT EXISTS (
            SELECT 1 FROM pg_policies
            WHERE schemaname = 'storage'
              AND tablename = 'objects'
              AND policyname = 'profiles_avatar_public_read'
        ) THEN
            CREATE POLICY profiles_avatar_public_read
            ON storage.objects
            FOR SELECT
            USING (bucket_id = 'profiles');
        END IF;

        IF NOT EXISTS (
            SELECT 1 FROM pg_policies
            WHERE schemaname = 'storage'
              AND tablename = 'objects'
              AND policyname = 'profiles_avatar_owner_insert'
        ) THEN
            CREATE POLICY profiles_avatar_owner_insert
            ON storage.objects
            FOR INSERT
            WITH CHECK (
                bucket_id = 'profiles'
                AND name LIKE ('avatars/' || auth.uid()::TEXT || '/%')
            );
        END IF;

        IF NOT EXISTS (
            SELECT 1 FROM pg_policies
            WHERE schemaname = 'storage'
              AND tablename = 'objects'
              AND policyname = 'profiles_avatar_owner_update'
        ) THEN
            CREATE POLICY profiles_avatar_owner_update
            ON storage.objects
            FOR UPDATE
            USING (
                bucket_id = 'profiles'
                AND name LIKE ('avatars/' || auth.uid()::TEXT || '/%')
            )
            WITH CHECK (
                bucket_id = 'profiles'
                AND name LIKE ('avatars/' || auth.uid()::TEXT || '/%')
            );
        END IF;

        IF NOT EXISTS (
            SELECT 1 FROM pg_policies
            WHERE schemaname = 'storage'
              AND tablename = 'objects'
              AND policyname = 'profiles_avatar_owner_delete'
        ) THEN
            CREATE POLICY profiles_avatar_owner_delete
            ON storage.objects
            FOR DELETE
            USING (
                bucket_id = 'profiles'
                AND name LIKE ('avatars/' || auth.uid()::TEXT || '/%')
            );
        END IF;

        IF NOT EXISTS (
            SELECT 1 FROM pg_policies
            WHERE schemaname = 'storage'
              AND tablename = 'objects'
              AND policyname = 'driver_docs_owner_access'
        ) THEN
            CREATE POLICY driver_docs_owner_access
            ON storage.objects
            FOR ALL
            USING (
                bucket_id = 'driver-docs'
                AND name LIKE ('documents/' || auth.uid()::TEXT || '/%')
            )
            WITH CHECK (
                bucket_id = 'driver-docs'
                AND name LIKE ('documents/' || auth.uid()::TEXT || '/%')
            );
        END IF;
    END IF;
END $$;

-- PART 2 — Service Types
CREATE TABLE IF NOT EXISTS service_types (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    slug TEXT UNIQUE NOT NULL,
    name TEXT NOT NULL,
    base_price NUMERIC DEFAULT 0,
    price_per_km NUMERIC DEFAULT 0,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

INSERT INTO service_types (slug, name)
VALUES 
    ('ride', 'Ride'),
    ('errand', 'Errand'),
    ('van-moving', 'Van Moving'),
    ('delivery', 'Package Delivery')
ON CONFLICT (slug) DO NOTHING;

-- PART 3 — Cities (Fixing missing is_active error)
CREATE TABLE IF NOT EXISTS cities (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    name TEXT NOT NULL,
    lat NUMERIC,
    lng NUMERIC,
    radius_km NUMERIC DEFAULT 50,
    is_active BOOLEAN DEFAULT TRUE,
    base_surge_multiplier NUMERIC DEFAULT 1.0,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

DO $$
BEGIN
    IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'cities' AND column_name = 'is_active') THEN
        ALTER TABLE cities ADD COLUMN is_active BOOLEAN DEFAULT TRUE;
    END IF;
    
    IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'cities' AND column_name = 'radius_km') THEN
        ALTER TABLE cities ADD COLUMN radius_km NUMERIC DEFAULT 50;
    END IF;

    IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'cities' AND column_name = 'base_surge_multiplier') THEN
        ALTER TABLE cities ADD COLUMN base_surge_multiplier NUMERIC DEFAULT 1.0;
    END IF;
END $$;



-- PART 4 — Pricing Rules & Fixed Fare Bands
CREATE TABLE IF NOT EXISTS pricing_rules (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    service_type_id UUID REFERENCES service_types(id),
    currency_code TEXT NOT NULL DEFAULT 'GBP',
    country_code TEXT NOT NULL DEFAULT 'GB',
    base_fare NUMERIC DEFAULT 0,
    per_km_rate NUMERIC DEFAULT 0,
    minimum_fare NUMERIC DEFAULT 0,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
    UNIQUE(service_type_id, currency_code, country_code)
);

CREATE TABLE IF NOT EXISTS fixed_fare_bands (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    service_type_id UUID REFERENCES service_types(id),
    currency_code TEXT NOT NULL DEFAULT 'GBP',
    country_code TEXT NOT NULL DEFAULT 'GB',
    min_distance_km NUMERIC NOT NULL,
    max_distance_km NUMERIC NOT NULL,
    flat_rate NUMERIC NOT NULL,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

-- PART 5 — Profiles Hardening
DO $$
BEGIN
    IF EXISTS (SELECT 1 FROM information_schema.tables WHERE table_name = 'profiles') THEN
        IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'profiles' AND column_name = 'completion_rate') THEN
            ALTER TABLE profiles ADD COLUMN completion_rate NUMERIC DEFAULT 1.0;
        END IF;
        
        IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'profiles' AND column_name = 'cancellation_rate') THEN
            ALTER TABLE profiles ADD COLUMN cancellation_rate NUMERIC DEFAULT 0.0;
        END IF;

        IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'profiles' AND column_name = 'lat') THEN
            ALTER TABLE profiles ADD COLUMN lat NUMERIC;
        END IF;

        IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'profiles' AND column_name = 'lng') THEN
            ALTER TABLE profiles ADD COLUMN lng NUMERIC;
        END IF;

        IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'profiles' AND column_name = 'account_status') THEN
            ALTER TABLE profiles ADD COLUMN account_status TEXT DEFAULT 'active';
        END IF;

        IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'profiles' AND column_name = 'account_closure_requested_at') THEN
            ALTER TABLE profiles ADD COLUMN account_closure_requested_at TIMESTAMPTZ;
        END IF;

        IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'profiles' AND column_name = 'account_closure_reason') THEN
            ALTER TABLE profiles ADD COLUMN account_closure_reason TEXT;
        END IF;

        ALTER TABLE profiles
            ADD COLUMN IF NOT EXISTS closure_requested_at TIMESTAMPTZ,
            ADD COLUMN IF NOT EXISTS closed_at TIMESTAMPTZ,
            ADD COLUMN IF NOT EXISTS closure_reason TEXT,
            ADD COLUMN IF NOT EXISTS closure_notes TEXT,
            ADD COLUMN IF NOT EXISTS reinstated_at TIMESTAMPTZ,
            ADD COLUMN IF NOT EXISTS reinstated_by UUID,
            ADD COLUMN IF NOT EXISTS reinstatement_notes TEXT;

        IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'profiles' AND column_name = 'tenant_id') THEN
            ALTER TABLE profiles ADD COLUMN tenant_id UUID;
        END IF;

        IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'profiles' AND column_name = 'phone') THEN
            ALTER TABLE profiles ADD COLUMN phone TEXT;
        END IF;

        IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'profiles' AND column_name = 'avatar_url') THEN
            ALTER TABLE profiles ADD COLUMN avatar_url TEXT;
        END IF;

        IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'profiles' AND column_name = 'stripe_account_id') THEN
            ALTER TABLE profiles ADD COLUMN stripe_account_id TEXT;
        END IF;

        IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'profiles' AND column_name = 'stripe_connect_status') THEN
            ALTER TABLE profiles ADD COLUMN stripe_connect_status TEXT DEFAULT 'not_started';
        END IF;

        IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'profiles' AND column_name = 'charges_enabled') THEN
            ALTER TABLE profiles ADD COLUMN charges_enabled BOOLEAN DEFAULT FALSE;
        END IF;

        IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'profiles' AND column_name = 'payouts_enabled') THEN
            ALTER TABLE profiles ADD COLUMN payouts_enabled BOOLEAN DEFAULT FALSE;
        END IF;

        IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'profiles' AND column_name = 'movabi_pay_card_preference') THEN
            ALTER TABLE profiles ADD COLUMN movabi_pay_card_preference TEXT DEFAULT 'virtual';
        END IF;

        IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'profiles' AND column_name = 'movabi_pay_physical_card_status') THEN
            ALTER TABLE profiles ADD COLUMN movabi_pay_physical_card_status TEXT DEFAULT 'not_requested';
        END IF;

        IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'profiles' AND column_name = 'movabi_pay_physical_card_received_at') THEN
            ALTER TABLE profiles ADD COLUMN movabi_pay_physical_card_received_at TIMESTAMPTZ;
        END IF;

        ALTER TABLE profiles
            ADD COLUMN IF NOT EXISTS compliance_status TEXT DEFAULT 'draft',
            ADD COLUMN IF NOT EXISTS accepted_terms_at TIMESTAMPTZ,
            ADD COLUMN IF NOT EXISTS accepted_privacy_at TIMESTAMPTZ,
            ADD COLUMN IF NOT EXISTS accepted_driver_agreement_at TIMESTAMPTZ,
            ADD COLUMN IF NOT EXISTS date_of_birth DATE,
            ADD COLUMN IF NOT EXISTS current_address TEXT,
            ADD COLUMN IF NOT EXISTS address_line1 TEXT,
            ADD COLUMN IF NOT EXISTS home_address TEXT,
            ADD COLUMN IF NOT EXISTS email_verified BOOLEAN DEFAULT FALSE,
            ADD COLUMN IF NOT EXISTS email_confirmed_at TIMESTAMPTZ,
            ADD COLUMN IF NOT EXISTS phone_verified BOOLEAN DEFAULT FALSE,
            ADD COLUMN IF NOT EXISTS phone_verified_at TIMESTAMPTZ,
            ADD COLUMN IF NOT EXISTS phone_verification_supported BOOLEAN DEFAULT FALSE,
            ADD COLUMN IF NOT EXISTS profile_photo_status TEXT DEFAULT 'missing',
            ADD COLUMN IF NOT EXISTS live_selfie_url TEXT,
            ADD COLUMN IF NOT EXISTS live_selfie_status TEXT DEFAULT 'missing',
            ADD COLUMN IF NOT EXISTS driver_license_status TEXT DEFAULT 'missing',
            ADD COLUMN IF NOT EXISTS driver_license_expiry DATE,
            ADD COLUMN IF NOT EXISTS insurance_status TEXT DEFAULT 'missing',
            ADD COLUMN IF NOT EXISTS insurance_expiry DATE,
            ADD COLUMN IF NOT EXISTS right_to_work_url TEXT,
            ADD COLUMN IF NOT EXISTS right_to_work_share_code TEXT,
            ADD COLUMN IF NOT EXISTS right_to_work_status TEXT DEFAULT 'missing',
            ADD COLUMN IF NOT EXISTS private_hire_driver_license_url TEXT,
            ADD COLUMN IF NOT EXISTS private_hire_driver_license_status TEXT DEFAULT 'missing',
            ADD COLUMN IF NOT EXISTS private_hire_vehicle_license_url TEXT,
            ADD COLUMN IF NOT EXISTS private_hire_vehicle_license_status TEXT DEFAULT 'missing',
            ADD COLUMN IF NOT EXISTS private_hire_insurance_url TEXT,
            ADD COLUMN IF NOT EXISTS private_hire_insurance_status TEXT DEFAULT 'missing',
            ADD COLUMN IF NOT EXISTS council_name TEXT,
            ADD COLUMN IF NOT EXISTS council_license_authority TEXT,
            ADD COLUMN IF NOT EXISTS council_license_number TEXT,
            ADD COLUMN IF NOT EXISTS council_license_expiry DATE,
            ADD COLUMN IF NOT EXISTS taxi_badge_number TEXT,
            ADD COLUMN IF NOT EXISTS taxi_license_expiry DATE,
            ADD COLUMN IF NOT EXISTS vehicle_license_url TEXT,
            ADD COLUMN IF NOT EXISTS vehicle_license_status TEXT DEFAULT 'missing',
            ADD COLUMN IF NOT EXISTS vehicle_license_expiry DATE,
            ADD COLUMN IF NOT EXISTS mot_url TEXT,
            ADD COLUMN IF NOT EXISTS mot_status TEXT DEFAULT 'missing',
            ADD COLUMN IF NOT EXISTS mot_expiry DATE,
            ADD COLUMN IF NOT EXISTS background_check_status TEXT DEFAULT 'missing',
            ADD COLUMN IF NOT EXISTS operator_compliance_status TEXT DEFAULT 'missing',
            ADD COLUMN IF NOT EXISTS courier_insurance_url TEXT,
            ADD COLUMN IF NOT EXISTS courier_insurance_status TEXT DEFAULT 'missing',
            ADD COLUMN IF NOT EXISTS courier_insurance_expiry DATE,
            ADD COLUMN IF NOT EXISTS goods_in_transit_insurance_url TEXT,
            ADD COLUMN IF NOT EXISTS goods_in_transit_insurance_status TEXT DEFAULT 'missing',
            ADD COLUMN IF NOT EXISTS goods_in_transit_insurance_expiry DATE,
            ADD COLUMN IF NOT EXISTS public_liability_insurance_url TEXT,
            ADD COLUMN IF NOT EXISTS public_liability_insurance_status TEXT DEFAULT 'missing',
            ADD COLUMN IF NOT EXISTS public_liability_insurance_expiry DATE,
            ADD COLUMN IF NOT EXISTS moving_insurance_url TEXT,
            ADD COLUMN IF NOT EXISTS moving_insurance_status TEXT DEFAULT 'missing',
            ADD COLUMN IF NOT EXISTS moving_insurance_expiry DATE,
            ADD COLUMN IF NOT EXISTS helper_labour_declaration BOOLEAN DEFAULT FALSE,
            ADD COLUMN IF NOT EXISTS driver_review_status TEXT,
            ADD COLUMN IF NOT EXISTS driver_review_notes TEXT,
            ADD COLUMN IF NOT EXISTS driver_review_blockers JSONB,
            ADD COLUMN IF NOT EXISTS driver_review_sent_at TIMESTAMPTZ,
            ADD COLUMN IF NOT EXISTS driver_review_sent_by UUID,
            ADD COLUMN IF NOT EXISTS driver_review_history JSONB;

        IF EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema = 'public' AND table_name = 'profiles' AND column_name = 'council_license_authority') THEN
            UPDATE public.profiles
            SET council_name = COALESCE(NULLIF(TRIM(council_name), ''), NULLIF(TRIM(council_license_authority), ''))
            WHERE NULLIF(TRIM(COALESCE(council_name, '')), '') IS NULL
              AND NULLIF(TRIM(COALESCE(council_license_authority, '')), '') IS NOT NULL;
        END IF;

        IF EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema = 'public' AND table_name = 'profiles' AND column_name = 'council_license_expiry') THEN
            UPDATE public.profiles
            SET taxi_license_expiry = COALESCE(taxi_license_expiry, council_license_expiry)
            WHERE taxi_license_expiry IS NULL
              AND council_license_expiry IS NOT NULL;
        END IF;

        IF EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema = 'public' AND table_name = 'profiles' AND column_name = 'vehicle_license_url') THEN
            UPDATE public.profiles
            SET private_hire_vehicle_license_url = COALESCE(NULLIF(TRIM(private_hire_vehicle_license_url), ''), NULLIF(TRIM(vehicle_license_url), ''))
            WHERE NULLIF(TRIM(COALESCE(private_hire_vehicle_license_url, '')), '') IS NULL
              AND NULLIF(TRIM(COALESCE(vehicle_license_url, '')), '') IS NOT NULL;
        END IF;
    END IF;
END $$;

-- PART 6 — Wallets & Transactions
-- PART 5B - Driver Vehicle Capability Hardening
DO $$
BEGIN
    IF EXISTS (SELECT 1 FROM information_schema.tables WHERE table_schema = 'public' AND table_name = 'vehicles') THEN
        IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema = 'public' AND table_name = 'vehicles' AND column_name = 'type') THEN
            ALTER TABLE public.vehicles ADD COLUMN type TEXT DEFAULT 'car';
        END IF;

        IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema = 'public' AND table_name = 'vehicles' AND column_name = 'capacity') THEN
            ALTER TABLE public.vehicles ADD COLUMN capacity TEXT DEFAULT 'standard';
        END IF;

        IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema = 'public' AND table_name = 'vehicles' AND column_name = 'service_eligibility') THEN
            ALTER TABLE public.vehicles ADD COLUMN service_eligibility JSONB;
        END IF;

        IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema = 'public' AND table_name = 'vehicles' AND column_name = 'color') THEN
            ALTER TABLE public.vehicles ADD COLUMN color TEXT;
        END IF;

        IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema = 'public' AND table_name = 'vehicles' AND column_name = 'is_verified') THEN
            ALTER TABLE public.vehicles ADD COLUMN is_verified BOOLEAN DEFAULT FALSE;
        END IF;

        IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema = 'public' AND table_name = 'vehicles' AND column_name = 'driver_id') THEN
            ALTER TABLE public.vehicles ADD COLUMN driver_id UUID;
        END IF;

        IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema = 'public' AND table_name = 'vehicles' AND column_name = 'created_at') THEN
            ALTER TABLE public.vehicles ADD COLUMN created_at TIMESTAMPTZ DEFAULT NOW();
        END IF;

        UPDATE public.vehicles
        SET type = COALESCE(NULLIF(type, ''), 'car'),
            capacity = COALESCE(NULLIF(capacity, ''), CASE WHEN type = 'van' THEN 'small_van' ELSE 'standard' END),
            is_verified = COALESCE(is_verified, FALSE),
            driver_id = COALESCE(driver_id, user_id),
            created_at = COALESCE(created_at, NOW())
        WHERE type IS NULL
           OR type = ''
           OR capacity IS NULL
           OR capacity = ''
           OR is_verified IS NULL
           OR driver_id IS NULL
           OR created_at IS NULL;
    END IF;
END $$;

CREATE TABLE IF NOT EXISTS wallets (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id UUID UNIQUE NOT NULL,
    balance NUMERIC DEFAULT 0,
    available_balance NUMERIC DEFAULT 0,
    reserved_balance NUMERIC DEFAULT 0,
    currency_code TEXT DEFAULT 'GBP',
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
    updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

DO $$
BEGIN
    IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'wallets' AND column_name = 'reserved_balance') THEN
        ALTER TABLE wallets ADD COLUMN reserved_balance NUMERIC DEFAULT 0;
    END IF;
END $$;

CREATE TABLE IF NOT EXISTS wallet_transactions (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id UUID NOT NULL,
    amount NUMERIC NOT NULL,
    type TEXT NOT NULL, -- 'credit', 'debit', 'refund'
    status TEXT DEFAULT 'completed',
    payment_intent_id TEXT UNIQUE,
    description TEXT,
    metadata JSONB,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

-- PART 7 — Jobs & Service Details
CREATE TABLE IF NOT EXISTS jobs (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id UUID,
    customer_id UUID NOT NULL,
    driver_id UUID,
    service_type_id UUID REFERENCES service_types(id),
    status TEXT DEFAULT 'requested',
    pickup_address TEXT,
    pickup_lat NUMERIC,
    pickup_lng NUMERIC,
    dropoff_address TEXT,
    dropoff_lat NUMERIC,
    dropoff_lng NUMERIC,
    total_price NUMERIC DEFAULT 0,
    payment_status TEXT DEFAULT 'pending',
    payment_intent_id TEXT,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
    updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

DO $$
BEGIN
        IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema = 'public' AND table_name = 'jobs' AND column_name = 'tenant_id') THEN
            ALTER TABLE public.jobs ADD COLUMN tenant_id UUID;
        END IF;

        IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema = 'public' AND table_name = 'jobs' AND column_name = 'estimated_distance') THEN
            ALTER TABLE public.jobs ADD COLUMN estimated_distance NUMERIC DEFAULT 0;
        END IF;

        IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema = 'public' AND table_name = 'jobs' AND column_name = 'estimated_distance_km') THEN
            ALTER TABLE public.jobs ADD COLUMN estimated_distance_km NUMERIC DEFAULT 0;
        END IF;

        IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema = 'public' AND table_name = 'jobs' AND column_name = 'distance_km') THEN
            ALTER TABLE public.jobs ADD COLUMN distance_km NUMERIC DEFAULT 0;
        END IF;

        IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema = 'public' AND table_name = 'jobs' AND column_name = 'distance_meters') THEN
            ALTER TABLE public.jobs ADD COLUMN distance_meters NUMERIC DEFAULT 0;
        END IF;

        IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema = 'public' AND table_name = 'jobs' AND column_name = 'duration_seconds') THEN
            ALTER TABLE public.jobs ADD COLUMN duration_seconds INTEGER;
        END IF;

        IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema = 'public' AND table_name = 'jobs' AND column_name = 'dispatch_started_at') THEN
            ALTER TABLE public.jobs ADD COLUMN dispatch_started_at TIMESTAMPTZ;
        END IF;

        IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema = 'public' AND table_name = 'jobs' AND column_name = 'driver_search_expires_at') THEN
            ALTER TABLE public.jobs ADD COLUMN driver_search_expires_at TIMESTAMPTZ;
        END IF;

        IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema = 'public' AND table_name = 'jobs' AND column_name = 'dispatch_attempts') THEN
            ALTER TABLE public.jobs ADD COLUMN dispatch_attempts INTEGER DEFAULT 0;
        END IF;

        IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema = 'public' AND table_name = 'jobs' AND column_name = 'no_driver_reason') THEN
            ALTER TABLE public.jobs ADD COLUMN no_driver_reason TEXT;
        END IF;

        IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema = 'public' AND table_name = 'jobs' AND column_name = 'accepted_driver_id') THEN
            ALTER TABLE public.jobs ADD COLUMN accepted_driver_id UUID;
        END IF;

        IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema = 'public' AND table_name = 'jobs' AND column_name = 'accepted_at') THEN
            ALTER TABLE public.jobs ADD COLUMN accepted_at TIMESTAMPTZ;
        END IF;
END $$;

-- PART 7B - Errand Detail Hardening
DO $$
BEGIN
    IF EXISTS (SELECT 1 FROM information_schema.tables WHERE table_schema = 'public' AND table_name = 'errand_details') THEN
        IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema = 'public' AND table_name = 'errand_details' AND column_name = 'actual_spending') THEN
            ALTER TABLE public.errand_details ADD COLUMN actual_spending NUMERIC DEFAULT 0;
        END IF;

        IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema = 'public' AND table_name = 'errand_details' AND column_name = 'spending_notes') THEN
            ALTER TABLE public.errand_details ADD COLUMN spending_notes TEXT;
        END IF;

        IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema = 'public' AND table_name = 'errand_details' AND column_name = 'receipt_url') THEN
            ALTER TABLE public.errand_details ADD COLUMN receipt_url TEXT;
        END IF;

        IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema = 'public' AND table_name = 'errand_details' AND column_name = 'updated_at') THEN
            ALTER TABLE public.errand_details ADD COLUMN updated_at TIMESTAMPTZ DEFAULT NOW();
        END IF;
    END IF;
END $$;

DO $$
BEGIN
    IF EXISTS (SELECT 1 FROM information_schema.tables WHERE table_schema = 'public' AND table_name = 'errand_details') THEN
        ALTER TABLE public.errand_details ENABLE ROW LEVEL SECURITY;
        DROP POLICY IF EXISTS "Job participants can read errand details" ON public.errand_details;
        DROP POLICY IF EXISTS "Assigned drivers can update errand spend details" ON public.errand_details;

        IF NOT EXISTS (
            SELECT 1 FROM pg_policies
            WHERE schemaname = 'public'
              AND tablename = 'errand_details'
              AND policyname = 'Job participants can read errand details'
        ) THEN
            CREATE POLICY "Job participants can read errand details"
            ON public.errand_details
            FOR SELECT
            TO authenticated
            USING (
                EXISTS (
                    SELECT 1
                    FROM public.jobs j
                    WHERE j.id = errand_details.job_id
                      AND (j.customer_id = auth.uid() OR j.driver_id = auth.uid() OR j.accepted_driver_id = auth.uid())
                )
            );
        END IF;

        IF NOT EXISTS (
            SELECT 1 FROM pg_policies
            WHERE schemaname = 'public'
              AND tablename = 'errand_details'
              AND policyname = 'Assigned drivers can update errand spend details'
        ) THEN
            CREATE POLICY "Assigned drivers can update errand spend details"
            ON public.errand_details
            FOR UPDATE
            TO authenticated
            USING (
                EXISTS (
                    SELECT 1
                    FROM public.jobs j
                    WHERE j.id = errand_details.job_id
                      AND (j.driver_id = auth.uid() OR j.accepted_driver_id = auth.uid())
                      AND j.status NOT IN ('completed', 'cancelled')
                )
            )
            WITH CHECK (
                EXISTS (
                    SELECT 1
                    FROM public.jobs j
                    WHERE j.id = errand_details.job_id
                      AND (j.driver_id = auth.uid() OR j.accepted_driver_id = auth.uid())
                      AND j.status NOT IN ('completed', 'cancelled')
                )
            );
        END IF;

        GRANT SELECT, UPDATE ON public.errand_details TO authenticated;
    END IF;

    IF EXISTS (SELECT 1 FROM information_schema.tables WHERE table_schema = 'public' AND table_name = 'errand_funding') THEN
        ALTER TABLE public.errand_funding ENABLE ROW LEVEL SECURITY;
        DROP POLICY IF EXISTS "Job participants can read errand funding" ON public.errand_funding;

        IF NOT EXISTS (
            SELECT 1 FROM pg_policies
            WHERE schemaname = 'public'
              AND tablename = 'errand_funding'
              AND policyname = 'Job participants can read errand funding'
        ) THEN
            CREATE POLICY "Job participants can read errand funding"
            ON public.errand_funding
            FOR SELECT
            TO authenticated
            USING (
                EXISTS (
                    SELECT 1
                    FROM public.jobs j
                    WHERE j.id = errand_funding.job_id
                      AND (j.customer_id = auth.uid() OR j.driver_id = auth.uid() OR j.accepted_driver_id = auth.uid())
                )
            );
        END IF;

        GRANT SELECT ON public.errand_funding TO authenticated;
    END IF;
END $$;

DO $$
BEGIN
    ALTER TABLE public.jobs DROP CONSTRAINT IF EXISTS jobs_status_check;

    ALTER TABLE public.jobs
        ADD CONSTRAINT jobs_status_check
        CHECK (status IN (
            'requested',
            'pending',
            'pending_payment',
            'payment_authorized',
            'pending_fare_confirmation',
            'negotiating',
            'fare_agreed',
            'searching',
            'broadcasting',
            'waiting',
            'accepted',
            'assigned',
            'arrived',
            'heading_to_pickup',
            'driver_en_route',
            'driver_arrived',
            'picked_up',
            'in_progress',
            'arrived_at_store',
            'shopping_in_progress',
            'collected',
            'en_route_to_customer',
            'delivered',
            'completed',
            'settled',
            'cancelled',
            'expired',
            'no_driver_found',
            'requires_review',
            'failed'
        ));
END $$;

CREATE TABLE IF NOT EXISTS job_service_details (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    job_id UUID NOT NULL REFERENCES jobs(id) ON DELETE CASCADE,
    service_type_slug TEXT,
    passenger_count INTEGER,
    items_list JSONB,
    estimated_budget NUMERIC,
    move_size TEXT,
    helper_count INTEGER,
    has_elevator BOOLEAN,
    notes TEXT,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

-- PART 8 — Driver Earnings & Payouts
CREATE TABLE IF NOT EXISTS job_queue (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    job_id UUID NOT NULL REFERENCES jobs(id) ON DELETE CASCADE,
    tenant_id UUID,
    city_id UUID,
    status TEXT NOT NULL DEFAULT 'waiting',
    expires_at TIMESTAMPTZ NOT NULL DEFAULT NOW() + INTERVAL '5 minutes',
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    CONSTRAINT job_queue_job_id_key UNIQUE (job_id)
);

DO $$
BEGIN
    IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema = 'public' AND table_name = 'job_queue' AND column_name = 'tenant_id') THEN
        ALTER TABLE public.job_queue ADD COLUMN tenant_id UUID;
    END IF;

    IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema = 'public' AND table_name = 'job_queue' AND column_name = 'city_id') THEN
        ALTER TABLE public.job_queue ADD COLUMN city_id UUID;
    END IF;

    IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema = 'public' AND table_name = 'job_queue' AND column_name = 'updated_at') THEN
        ALTER TABLE public.job_queue ADD COLUMN updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW();
    END IF;

    ALTER TABLE public.job_queue DROP CONSTRAINT IF EXISTS job_queue_status_check;
    ALTER TABLE public.job_queue
        ADD CONSTRAINT job_queue_status_check
        CHECK (status IN ('waiting', 'broadcasting', 'assigned', 'expired', 'ignored'));
END $$;

DELETE FROM job_queue a
USING job_queue b
WHERE a.job_id = b.job_id
  AND (
    a.created_at < b.created_at
    OR (a.created_at = b.created_at AND a.id::text < b.id::text)
  );

CREATE UNIQUE INDEX IF NOT EXISTS idx_job_queue_job_id_unique ON job_queue(job_id);
CREATE INDEX IF NOT EXISTS idx_job_queue_status_expires ON job_queue(status, expires_at);

CREATE TABLE IF NOT EXISTS dispatch_logs (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    job_id UUID NOT NULL REFERENCES jobs(id) ON DELETE CASCADE,
    driver_id UUID,
    accepted BOOLEAN DEFAULT FALSE,
    distance NUMERIC,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_dispatch_logs_job_driver ON dispatch_logs(job_id, driver_id);

CREATE TABLE IF NOT EXISTS payout_batches (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    total_amount NUMERIC DEFAULT 0,
    status TEXT DEFAULT 'processing',
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
    processed_at TIMESTAMP WITH TIME ZONE
);

CREATE TABLE IF NOT EXISTS driver_earnings (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    driver_id UUID NOT NULL,
    booking_id UUID REFERENCES jobs(id),
    gross_amount NUMERIC NOT NULL,
    platform_fee NUMERIC DEFAULT 0,
    net_amount NUMERIC NOT NULL,
    status TEXT DEFAULT 'pending', -- 'pending', 'payable', 'paid'
    payout_batch_id UUID REFERENCES payout_batches(id),
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
    paid_out_at TIMESTAMP WITH TIME ZONE
);

-- PART 9 — Audit & Events
CREATE TABLE IF NOT EXISTS audit_logs (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id UUID,
    action TEXT NOT NULL,
    entity_type TEXT,
    entity_id UUID,
    metadata JSONB,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS public.system_configs (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    key TEXT NOT NULL UNIQUE,
    value JSONB NOT NULL DEFAULT '{}'::jsonb,
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

INSERT INTO public.system_configs (key, value, updated_at)
VALUES (
    'app_version_config',
    jsonb_build_object(
        'current_web_version', '1.0.0',
        'minimum_web_version', '1.0.0',
        'current_android_version', '1.0.0',
        'minimum_android_version', '1.0.0',
        'current_ios_version', '1.0.0',
        'minimum_ios_version', '1.0.0',
        'update_required', false,
        'update_severity', 'optional',
        'update_title', 'Movabi update available',
        'update_message', 'A new version of Movabi is available.',
        'release_notes', '',
        'android_update_url', '',
        'ios_update_url', '',
        'web_reload_required', false,
        'admin_set_by', null,
        'updated_at', NOW()
    ),
    NOW()
)
ON CONFLICT (key) DO NOTHING;

CREATE TABLE IF NOT EXISTS stripe_events (
    id TEXT PRIMARY KEY, -- Use Stripe's event ID
    type TEXT,
    status TEXT DEFAULT 'received',
    error_message TEXT,
    processed_at TIMESTAMP WITH TIME ZONE,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

-- PART 10 — Errand Funding
CREATE TABLE IF NOT EXISTS ratings (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    job_id UUID REFERENCES jobs(id) ON DELETE CASCADE,
    booking_id UUID REFERENCES jobs(id) ON DELETE CASCADE,
    customer_id UUID,
    driver_id UUID,
    score INTEGER,
    comment TEXT,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

DO $$
BEGIN
    IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema = 'public' AND table_name = 'ratings' AND column_name = 'job_id') THEN
        ALTER TABLE public.ratings ADD COLUMN job_id UUID REFERENCES public.jobs(id) ON DELETE CASCADE;
    END IF;

    IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema = 'public' AND table_name = 'ratings' AND column_name = 'booking_id') THEN
        ALTER TABLE public.ratings ADD COLUMN booking_id UUID REFERENCES public.jobs(id) ON DELETE CASCADE;
    END IF;

    IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema = 'public' AND table_name = 'ratings' AND column_name = 'customer_id') THEN
        ALTER TABLE public.ratings ADD COLUMN customer_id UUID;
    END IF;

    IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema = 'public' AND table_name = 'ratings' AND column_name = 'driver_id') THEN
        ALTER TABLE public.ratings ADD COLUMN driver_id UUID;
    END IF;

    IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema = 'public' AND table_name = 'ratings' AND column_name = 'score') THEN
        ALTER TABLE public.ratings ADD COLUMN score INTEGER;
    END IF;

    IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema = 'public' AND table_name = 'ratings' AND column_name = 'comment') THEN
        ALTER TABLE public.ratings ADD COLUMN comment TEXT;
    END IF;

    IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema = 'public' AND table_name = 'ratings' AND column_name = 'created_at') THEN
        ALTER TABLE public.ratings ADD COLUMN created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW();
    END IF;
END $$;

CREATE UNIQUE INDEX IF NOT EXISTS idx_ratings_job_customer
ON public.ratings(job_id, customer_id)
WHERE job_id IS NOT NULL AND customer_id IS NOT NULL;

CREATE UNIQUE INDEX IF NOT EXISTS idx_ratings_booking_customer
ON public.ratings(booking_id, customer_id)
WHERE booking_id IS NOT NULL AND customer_id IS NOT NULL;

DO $$
BEGIN
    IF EXISTS (SELECT 1 FROM information_schema.tables WHERE table_schema = 'public' AND table_name = 'profiles') THEN
        IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema = 'public' AND table_name = 'profiles' AND column_name = 'rating') THEN
            ALTER TABLE public.profiles ADD COLUMN rating NUMERIC DEFAULT 0;
        END IF;

        IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema = 'public' AND table_name = 'profiles' AND column_name = 'driver_rating') THEN
            ALTER TABLE public.profiles ADD COLUMN driver_rating NUMERIC DEFAULT 0;
        END IF;

        IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema = 'public' AND table_name = 'profiles' AND column_name = 'review_count') THEN
            ALTER TABLE public.profiles ADD COLUMN review_count INTEGER DEFAULT 0;
        END IF;
    END IF;
END $$;

UPDATE public.profiles p
SET rating = r.average_score,
    driver_rating = r.average_score,
    review_count = r.rating_count
FROM (
    SELECT driver_id,
           ROUND(AVG(score)::NUMERIC, 1) AS average_score,
           COUNT(*)::INTEGER AS rating_count
    FROM public.ratings
    WHERE driver_id IS NOT NULL
      AND score BETWEEN 1 AND 5
    GROUP BY driver_id
) r
WHERE p.id = r.driver_id;

CREATE TABLE IF NOT EXISTS errand_funding (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    job_id UUID UNIQUE NOT NULL REFERENCES jobs(id) ON DELETE CASCADE,
    customer_id UUID NOT NULL,
    amount_reserved NUMERIC DEFAULT 0,
    status TEXT DEFAULT 'pending', -- 'pending', 'reserved', 'approved', 'settled', 'cancelled'
    over_budget_status TEXT DEFAULT 'none', -- 'none', 'requested', 'approved', 'rejected'
    over_budget_amount NUMERIC DEFAULT 0,
    metadata JSONB,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
    updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

DO $$
BEGIN
    IF EXISTS (SELECT 1 FROM pg_publication WHERE pubname = 'supabase_realtime') THEN
        BEGIN
            ALTER PUBLICATION supabase_realtime ADD TABLE public.errand_funding;
        EXCEPTION
            WHEN duplicate_object THEN NULL;
            WHEN undefined_table THEN NULL;
        END;

        IF EXISTS (SELECT 1 FROM information_schema.tables WHERE table_schema = 'public' AND table_name = 'errand_details') THEN
            BEGIN
                ALTER PUBLICATION supabase_realtime ADD TABLE public.errand_details;
            EXCEPTION
                WHEN duplicate_object THEN NULL;
                WHEN undefined_table THEN NULL;
            END;
        END IF;
    END IF;
END $$;

DO $$
BEGIN
    IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema = 'public' AND table_name = 'errand_funding' AND column_name = 'requested_over_budget_amount') THEN
        ALTER TABLE public.errand_funding ADD COLUMN requested_over_budget_amount NUMERIC DEFAULT 0;
    END IF;

    IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema = 'public' AND table_name = 'errand_funding' AND column_name = 'over_budget_reason') THEN
        ALTER TABLE public.errand_funding ADD COLUMN over_budget_reason TEXT;
    END IF;
END $$;

CREATE OR REPLACE FUNCTION public.enforce_errand_spending_budget()
RETURNS TRIGGER AS $$
DECLARE
    v_approved_extra NUMERIC := 0;
    v_approved_budget NUMERIC := 0;
BEGIN
    IF NEW.actual_spending IS NULL OR NEW.actual_spending IS NOT DISTINCT FROM OLD.actual_spending THEN
        RETURN NEW;
    END IF;

    IF NEW.actual_spending < 0 THEN
        RAISE EXCEPTION 'Item spending cannot be negative';
    END IF;

    SELECT CASE
        WHEN over_budget_status = 'approved'
        THEN COALESCE(requested_over_budget_amount, over_budget_amount, 0)
        ELSE 0
    END
    INTO v_approved_extra
    FROM public.errand_funding
    WHERE job_id = NEW.job_id;

    v_approved_budget := ROUND(
        (COALESCE(NEW.estimated_budget, 0) + COALESCE(v_approved_extra, 0))::NUMERIC,
        2
    );

    IF ROUND(NEW.actual_spending::NUMERIC, 2) > v_approved_budget THEN
        RAISE EXCEPTION 'Item spending exceeds approved budget. Maximum: %', v_approved_budget;
    END IF;

    NEW.actual_spending := ROUND(NEW.actual_spending::NUMERIC, 2);
    RETURN NEW;
END;
$$ LANGUAGE plpgsql SET search_path = public;

DROP TRIGGER IF EXISTS trg_enforce_errand_spending_budget ON public.errand_details;
CREATE TRIGGER trg_enforce_errand_spending_budget
BEFORE UPDATE OF actual_spending ON public.errand_details
FOR EACH ROW
EXECUTE FUNCTION public.enforce_errand_spending_budget();

CREATE TABLE IF NOT EXISTS public.notifications (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id UUID NOT NULL REFERENCES public.profiles(id) ON DELETE CASCADE,
    title TEXT NOT NULL,
    body TEXT NOT NULL,
    type TEXT NOT NULL DEFAULT 'system',
    route TEXT,
    metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
    data JSONB NOT NULL DEFAULT '{}'::jsonb,
    is_read BOOLEAN NOT NULL DEFAULT FALSE,
    read_at TIMESTAMPTZ,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

DO $$
BEGIN
    IF EXISTS (SELECT 1 FROM information_schema.tables WHERE table_schema = 'public' AND table_name = 'notifications') THEN
        ALTER TABLE public.notifications
            ADD COLUMN IF NOT EXISTS route TEXT,
            ADD COLUMN IF NOT EXISTS metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
            ADD COLUMN IF NOT EXISTS data JSONB NOT NULL DEFAULT '{}'::jsonb,
            ADD COLUMN IF NOT EXISTS is_read BOOLEAN NOT NULL DEFAULT FALSE,
            ADD COLUMN IF NOT EXISTS read_at TIMESTAMPTZ;
    END IF;
END $$;

CREATE INDEX IF NOT EXISTS idx_notifications_user_created
ON public.notifications(user_id, created_at DESC);

CREATE OR REPLACE FUNCTION public.notify_admins_account_closure_requested()
RETURNS TRIGGER AS $$
DECLARE
    v_display_name TEXT;
    v_route TEXT;
BEGIN
    IF NEW.account_status = 'closure_requested'
       AND COALESCE(OLD.account_status, 'active') <> 'closure_requested' THEN
        v_display_name := COALESCE(
            NULLIF(to_jsonb(NEW)->>'full_name', ''),
            NULLIF(to_jsonb(NEW)->>'email', ''),
            NULLIF(to_jsonb(NEW)->>'phone', ''),
            NEW.id::TEXT
        );

        v_route := CASE
            WHEN COALESCE(to_jsonb(NEW)->>'role', '') = 'driver' THEN '/admin/drivers'
            ELSE '/admin/users'
        END;

        INSERT INTO public.notifications (
            user_id,
            title,
            body,
            type,
            route,
            metadata,
            data
        )
        SELECT
            admin_profile.id,
            'Account closure requested',
            v_display_name || ' requested account closure',
            'account_closure_requested',
            v_route,
            jsonb_build_object(
                'profile_id', NEW.id,
                'role', to_jsonb(NEW)->>'role',
                'account_status', NEW.account_status
            ),
            jsonb_build_object(
                'profile_id', NEW.id,
                'role', to_jsonb(NEW)->>'role',
                'account_status', NEW.account_status
            )
        FROM public.profiles admin_profile
        WHERE admin_profile.role = 'admin';
    END IF;

    RETURN NEW;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public;

DROP TRIGGER IF EXISTS trg_notify_admins_account_closure_requested ON public.profiles;
CREATE TRIGGER trg_notify_admins_account_closure_requested
AFTER UPDATE OF account_status ON public.profiles
FOR EACH ROW
EXECUTE FUNCTION public.notify_admins_account_closure_requested();

ALTER TABLE public.notifications ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "Users read own notifications" ON public.notifications;
CREATE POLICY "Users read own notifications"
ON public.notifications
FOR SELECT
TO authenticated
USING (auth.uid() = user_id);

DROP POLICY IF EXISTS "Users update own notification read state" ON public.notifications;
CREATE POLICY "Users update own notification read state"
ON public.notifications
FOR UPDATE
TO authenticated
USING (auth.uid() = user_id)
WITH CHECK (auth.uid() = user_id);

DROP POLICY IF EXISTS "Users create own notifications" ON public.notifications;
CREATE POLICY "Users create own notifications"
ON public.notifications
FOR INSERT
TO authenticated
WITH CHECK (auth.uid() = user_id);

GRANT SELECT, INSERT, UPDATE ON public.notifications TO authenticated;

CREATE TABLE IF NOT EXISTS public.device_push_tokens (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id UUID NOT NULL REFERENCES public.profiles(id) ON DELETE CASCADE,
    token TEXT NOT NULL UNIQUE,
    provider TEXT NOT NULL DEFAULT 'capacitor',
    subscription_id TEXT,
    external_id TEXT,
    platform TEXT NOT NULL CHECK (platform IN ('ios', 'android', 'web')),
    enabled BOOLEAN NOT NULL DEFAULT TRUE,
    last_seen_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

DO $$
BEGIN
    IF EXISTS (SELECT 1 FROM information_schema.tables WHERE table_schema = 'public' AND table_name = 'device_push_tokens') THEN
        ALTER TABLE public.device_push_tokens
            ADD COLUMN IF NOT EXISTS provider TEXT NOT NULL DEFAULT 'capacitor',
            ADD COLUMN IF NOT EXISTS subscription_id TEXT,
            ADD COLUMN IF NOT EXISTS external_id TEXT,
            ADD COLUMN IF NOT EXISTS last_seen_at TIMESTAMPTZ NOT NULL DEFAULT NOW();
    END IF;
END $$;

CREATE INDEX IF NOT EXISTS idx_device_push_tokens_user_enabled
ON public.device_push_tokens(user_id, enabled);

CREATE UNIQUE INDEX IF NOT EXISTS idx_device_push_tokens_user_provider_subscription
ON public.device_push_tokens(user_id, provider, subscription_id)
WHERE subscription_id IS NOT NULL;

ALTER TABLE public.device_push_tokens ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "Users manage their push tokens" ON public.device_push_tokens;
CREATE POLICY "Users manage their push tokens"
ON public.device_push_tokens
FOR ALL
TO authenticated
USING (auth.uid() = user_id)
WITH CHECK (auth.uid() = user_id);

GRANT SELECT, INSERT, UPDATE, DELETE ON public.device_push_tokens TO authenticated;

CREATE TABLE IF NOT EXISTS public.driver_issuing_cardholders (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    driver_id UUID NOT NULL UNIQUE REFERENCES public.profiles(id) ON DELETE CASCADE,
    tenant_id UUID,
    stripe_cardholder_id TEXT NOT NULL UNIQUE,
    status TEXT NOT NULL DEFAULT 'active',
    metadata JSONB DEFAULT '{}'::jsonb,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS public.driver_issuing_cards (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    driver_id UUID NOT NULL REFERENCES public.profiles(id) ON DELETE CASCADE,
    tenant_id UUID,
    stripe_cardholder_id TEXT NOT NULL,
    stripe_card_id TEXT NOT NULL UNIQUE,
    card_type TEXT NOT NULL DEFAULT 'physical',
    currency_code TEXT NOT NULL DEFAULT 'GBP',
    last4 TEXT,
    status TEXT NOT NULL DEFAULT 'active',
    metadata JSONB DEFAULT '{}'::jsonb,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS public.job_issuing_spend_controls (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    job_id UUID NOT NULL UNIQUE REFERENCES public.jobs(id) ON DELETE CASCADE,
    driver_id UUID NOT NULL REFERENCES public.profiles(id) ON DELETE CASCADE,
    customer_id UUID NOT NULL REFERENCES public.profiles(id) ON DELETE CASCADE,
    tenant_id UUID,
    stripe_card_id TEXT NOT NULL,
    amount_limit NUMERIC NOT NULL DEFAULT 0,
    amount_authorized NUMERIC NOT NULL DEFAULT 0,
    amount_captured NUMERIC NOT NULL DEFAULT 0,
    currency_code TEXT NOT NULL DEFAULT 'GBP',
    status TEXT NOT NULL DEFAULT 'pending',
    metadata JSONB DEFAULT '{}'::jsonb,
    activated_at TIMESTAMPTZ,
    deactivated_at TIMESTAMPTZ,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS public.job_issuing_authorizations (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    stripe_authorization_id TEXT NOT NULL UNIQUE,
    job_id UUID REFERENCES public.jobs(id) ON DELETE SET NULL,
    driver_id UUID REFERENCES public.profiles(id) ON DELETE SET NULL,
    stripe_card_id TEXT,
    amount NUMERIC NOT NULL DEFAULT 0,
    currency_code TEXT NOT NULL DEFAULT 'GBP',
    approved BOOLEAN NOT NULL DEFAULT FALSE,
    merchant_name TEXT,
    merchant_category TEXT,
    status TEXT,
    raw_event JSONB DEFAULT '{}'::jsonb,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS public.job_issuing_transactions (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    stripe_transaction_id TEXT NOT NULL UNIQUE,
    stripe_authorization_id TEXT,
    job_id UUID REFERENCES public.jobs(id) ON DELETE SET NULL,
    driver_id UUID REFERENCES public.profiles(id) ON DELETE SET NULL,
    stripe_card_id TEXT,
    amount NUMERIC NOT NULL DEFAULT 0,
    currency_code TEXT NOT NULL DEFAULT 'GBP',
    merchant_name TEXT,
    status TEXT,
    raw_event JSONB DEFAULT '{}'::jsonb,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_driver_issuing_cards_driver
ON public.driver_issuing_cards(driver_id, status);

CREATE INDEX IF NOT EXISTS idx_job_issuing_spend_controls_driver
ON public.job_issuing_spend_controls(driver_id, status);

CREATE INDEX IF NOT EXISTS idx_job_issuing_spend_controls_card
ON public.job_issuing_spend_controls(stripe_card_id, status);

CREATE INDEX IF NOT EXISTS idx_job_issuing_authorizations_job
ON public.job_issuing_authorizations(job_id, created_at);

CREATE INDEX IF NOT EXISTS idx_job_issuing_transactions_job
ON public.job_issuing_transactions(job_id, created_at);

UPDATE public.driver_issuing_cards
SET card_type = 'virtual',
    updated_at = NOW()
WHERE card_type IS DISTINCT FROM 'virtual';

DO $$
BEGIN
    IF EXISTS (SELECT 1 FROM pg_publication WHERE pubname = 'supabase_realtime') THEN
        BEGIN
            ALTER PUBLICATION supabase_realtime ADD TABLE public.job_issuing_spend_controls;
        EXCEPTION
            WHEN duplicate_object THEN NULL;
            WHEN undefined_table THEN NULL;
        END;

        BEGIN
            ALTER PUBLICATION supabase_realtime ADD TABLE public.job_issuing_authorizations;
        EXCEPTION
            WHEN duplicate_object THEN NULL;
            WHEN undefined_table THEN NULL;
        END;

        BEGIN
            ALTER PUBLICATION supabase_realtime ADD TABLE public.job_issuing_transactions;
        EXCEPTION
            WHEN duplicate_object THEN NULL;
            WHEN undefined_table THEN NULL;
        END;
    END IF;
END $$;

ALTER TABLE public.driver_issuing_cardholders ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.driver_issuing_cards ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.job_issuing_spend_controls ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.job_issuing_authorizations ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.job_issuing_transactions ENABLE ROW LEVEL SECURITY;

DO $$
BEGIN
    DROP POLICY IF EXISTS "Drivers can read their issuing cards" ON public.driver_issuing_cards;
    DROP POLICY IF EXISTS "Drivers can read their issuing cardholder" ON public.driver_issuing_cardholders;
    DROP POLICY IF EXISTS "Job participants can read issuing spend controls" ON public.job_issuing_spend_controls;
    DROP POLICY IF EXISTS "Job participants can read issuing authorizations" ON public.job_issuing_authorizations;
    DROP POLICY IF EXISTS "Job participants can read issuing transactions" ON public.job_issuing_transactions;

    IF NOT EXISTS (
        SELECT 1 FROM pg_policies
        WHERE schemaname = 'public'
          AND tablename = 'driver_issuing_cards'
          AND policyname = 'Drivers can read their issuing cards'
    ) THEN
        CREATE POLICY "Drivers can read their issuing cards"
        ON public.driver_issuing_cards
        FOR SELECT
        USING (driver_id = auth.uid());
    END IF;

    IF NOT EXISTS (
        SELECT 1 FROM pg_policies
        WHERE schemaname = 'public'
          AND tablename = 'driver_issuing_cardholders'
          AND policyname = 'Drivers can read their issuing cardholder'
    ) THEN
        CREATE POLICY "Drivers can read their issuing cardholder"
        ON public.driver_issuing_cardholders
        FOR SELECT
        USING (driver_id = auth.uid());
    END IF;

    IF NOT EXISTS (
        SELECT 1 FROM pg_policies
        WHERE schemaname = 'public'
          AND tablename = 'job_issuing_spend_controls'
          AND policyname = 'Job participants can read issuing spend controls'
    ) THEN
        CREATE POLICY "Job participants can read issuing spend controls"
        ON public.job_issuing_spend_controls
        FOR SELECT
        USING (
            customer_id = auth.uid()
            OR driver_id = auth.uid()
            OR EXISTS (SELECT 1 FROM public.profiles WHERE profiles.id = auth.uid() AND profiles.role = 'admin')
        );
    END IF;

    IF NOT EXISTS (
        SELECT 1 FROM pg_policies
        WHERE schemaname = 'public'
          AND tablename = 'job_issuing_authorizations'
          AND policyname = 'Job participants can read issuing authorizations'
    ) THEN
        CREATE POLICY "Job participants can read issuing authorizations"
        ON public.job_issuing_authorizations
        FOR SELECT
        USING (
            EXISTS (
                SELECT 1
                FROM public.jobs
                WHERE jobs.id = job_issuing_authorizations.job_id
                  AND (jobs.customer_id = auth.uid() OR jobs.driver_id = auth.uid())
            )
            OR EXISTS (SELECT 1 FROM public.profiles WHERE profiles.id = auth.uid() AND profiles.role = 'admin')
        );
    END IF;

    IF NOT EXISTS (
        SELECT 1 FROM pg_policies
        WHERE schemaname = 'public'
          AND tablename = 'job_issuing_transactions'
          AND policyname = 'Job participants can read issuing transactions'
    ) THEN
        CREATE POLICY "Job participants can read issuing transactions"
        ON public.job_issuing_transactions
        FOR SELECT
        USING (
            EXISTS (
                SELECT 1
                FROM public.jobs
                WHERE jobs.id = job_issuing_transactions.job_id
                  AND (jobs.customer_id = auth.uid() OR jobs.driver_id = auth.uid())
            )
            OR EXISTS (SELECT 1 FROM public.profiles WHERE profiles.id = auth.uid() AND profiles.role = 'admin')
        );
    END IF;
END $$;

GRANT SELECT ON public.driver_issuing_cardholders TO authenticated;
GRANT SELECT ON public.driver_issuing_cards TO authenticated;
GRANT SELECT ON public.job_issuing_spend_controls TO authenticated;
GRANT SELECT ON public.job_issuing_authorizations TO authenticated;
GRANT SELECT ON public.job_issuing_transactions TO authenticated;

CREATE TABLE IF NOT EXISTS job_messages (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id UUID,
    job_id UUID NOT NULL REFERENCES jobs(id) ON DELETE CASCADE,
    sender_id UUID NOT NULL,
    receiver_id UUID NOT NULL,
    message TEXT NOT NULL,
    message_type TEXT NOT NULL DEFAULT 'text',
    read_at TIMESTAMPTZ,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

DO $$
BEGIN
    IF EXISTS (SELECT 1 FROM pg_publication WHERE pubname = 'supabase_realtime') THEN
        BEGIN
            ALTER PUBLICATION supabase_realtime ADD TABLE public.job_messages;
        EXCEPTION
            WHEN duplicate_object THEN NULL;
            WHEN undefined_table THEN NULL;
        END;
    END IF;
END $$;

CREATE INDEX IF NOT EXISTS idx_job_messages_job_created
ON public.job_messages(job_id, created_at);

ALTER TABLE public.job_messages ENABLE ROW LEVEL SECURITY;

DO $$
BEGIN
    DROP POLICY IF EXISTS "Job participants can read messages" ON public.job_messages;
    DROP POLICY IF EXISTS "Job participants can insert messages" ON public.job_messages;

    IF NOT EXISTS (
        SELECT 1 FROM pg_policies
        WHERE schemaname = 'public'
          AND tablename = 'job_messages'
          AND policyname = 'Job participants can read messages'
    ) THEN
        CREATE POLICY "Job participants can read messages"
        ON public.job_messages
        FOR SELECT
        USING (
            auth.uid() IN (sender_id, receiver_id)
            OR EXISTS (
                SELECT 1
                FROM public.jobs j
                WHERE j.id = job_messages.job_id
                  AND auth.uid() IN (j.customer_id, j.driver_id)
            )
        );
    END IF;

    IF NOT EXISTS (
        SELECT 1 FROM pg_policies
        WHERE schemaname = 'public'
          AND tablename = 'job_messages'
          AND policyname = 'Job participants can insert messages'
    ) THEN
        CREATE POLICY "Job participants can insert messages"
        ON public.job_messages
        FOR INSERT
        WITH CHECK (
            auth.uid() = sender_id
            AND EXISTS (
                SELECT 1
                FROM public.jobs j
                WHERE j.id = job_messages.job_id
                  AND auth.uid() IN (j.customer_id, j.driver_id)
                  AND receiver_id IN (j.customer_id, j.driver_id)
            )
        );
    END IF;
END $$;

-- PART 11 — RPC Functions (Idempotent)

-- Finalize Wallet Top-up
CREATE OR REPLACE FUNCTION finalize_wallet_topup(
  p_user_id UUID,
  p_amount NUMERIC,
  p_payment_intent_id TEXT,
  p_description TEXT DEFAULT 'Wallet top-up'
)
RETURNS BOOLEAN AS $$
DECLARE
  already_exists BOOLEAN;
  v_wallet_id UUID;
  v_tx_type_col TEXT;
  v_has_wallet_id BOOLEAN;
  v_has_stripe_payment_intent_id BOOLEAN;
  v_amount NUMERIC := ROUND(COALESCE(p_amount, 0)::NUMERIC, 2);
BEGIN
  IF v_amount <= 0 THEN
    RAISE EXCEPTION 'Wallet top-up amount must be greater than zero';
  END IF;

  SELECT CASE
    WHEN EXISTS (
      SELECT 1 FROM information_schema.columns
      WHERE table_schema = 'public'
        AND table_name = 'wallet_transactions'
        AND column_name = 'transaction_type'
    ) THEN 'transaction_type'
    ELSE 'type'
  END INTO v_tx_type_col;

  SELECT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public'
      AND table_name = 'wallet_transactions'
      AND column_name = 'wallet_id'
  ) INTO v_has_wallet_id;

  SELECT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public'
      AND table_name = 'wallet_transactions'
      AND column_name = 'stripe_payment_intent_id'
  ) INTO v_has_stripe_payment_intent_id;

  IF v_has_stripe_payment_intent_id THEN
    EXECUTE
      'SELECT EXISTS (
         SELECT 1
         FROM wallet_transactions
         WHERE payment_intent_id = $1 OR stripe_payment_intent_id = $1
       )'
    INTO already_exists
    USING p_payment_intent_id;
  ELSE
    SELECT EXISTS (
      SELECT 1 FROM wallet_transactions WHERE payment_intent_id = p_payment_intent_id
    ) INTO already_exists;
  END IF;

  IF already_exists THEN
    RETURN FALSE;
  END IF;

  INSERT INTO wallets (user_id, balance, available_balance)
  VALUES (p_user_id, v_amount, v_amount)
  ON CONFLICT (user_id) DO UPDATE
  SET balance = COALESCE(wallets.balance, 0) + v_amount,
      available_balance = COALESCE(wallets.available_balance, 0) + v_amount,
      updated_at = NOW();

  SELECT id
  INTO v_wallet_id
  FROM wallets
  WHERE user_id = p_user_id;

  IF v_has_wallet_id AND v_has_stripe_payment_intent_id THEN
    EXECUTE format(
      'INSERT INTO wallet_transactions (wallet_id, user_id, amount, %I, payment_intent_id, stripe_payment_intent_id, description)
       VALUES ($1, $2, $3, $4, $5, $6, $7)',
      v_tx_type_col
    )
    USING v_wallet_id, p_user_id, v_amount, 'topup', p_payment_intent_id, p_payment_intent_id, p_description;
  ELSIF v_has_wallet_id THEN
    EXECUTE format(
      'INSERT INTO wallet_transactions (wallet_id, user_id, amount, %I, payment_intent_id, description)
       VALUES ($1, $2, $3, $4, $5, $6)',
      v_tx_type_col
    )
    USING v_wallet_id, p_user_id, v_amount, 'topup', p_payment_intent_id, p_description;
  ELSIF v_has_stripe_payment_intent_id THEN
    EXECUTE format(
      'INSERT INTO wallet_transactions (user_id, amount, %I, payment_intent_id, stripe_payment_intent_id, description)
       VALUES ($1, $2, $3, $4, $5, $6)',
      v_tx_type_col
    )
    USING p_user_id, v_amount, 'topup', p_payment_intent_id, p_payment_intent_id, p_description;
  ELSE
    EXECUTE format(
      'INSERT INTO wallet_transactions (user_id, amount, %I, payment_intent_id, description)
       VALUES ($1, $2, $3, $4, $5)',
      v_tx_type_col
    )
    USING p_user_id, v_amount, 'topup', p_payment_intent_id, p_description;
  END IF;

  RETURN TRUE;
END;
$$ LANGUAGE plpgsql;

-- Errand Funding RPCs
DROP FUNCTION IF EXISTS reserve_errand_funds(UUID, UUID, NUMERIC, NUMERIC);

CREATE OR REPLACE FUNCTION reserve_errand_funds(
  p_job_id UUID,
  p_customer_id UUID,
  p_item_budget NUMERIC,
  p_service_estimate NUMERIC
)
RETURNS BOOLEAN AS $$
DECLARE
  v_total_needed NUMERIC := ROUND((COALESCE(p_item_budget, 0) + COALESCE(p_service_estimate, 0))::NUMERIC, 2);
  v_available NUMERIC;
  v_wallet_id UUID;
  v_existing_reserved NUMERIC := 0;
  v_delta NUMERIC;
  v_job RECORD;
BEGIN
  IF v_total_needed <= 0 THEN
    RAISE EXCEPTION 'Errand reservation amount must be greater than zero';
  END IF;

  SELECT *
  INTO v_job
  FROM jobs
  WHERE id = p_job_id
    AND customer_id = p_customer_id
  FOR UPDATE;

  IF v_job IS NULL THEN
    RAISE EXCEPTION 'Job not found for errand reservation';
  END IF;

  IF v_job.status IN ('cancelled', 'completed') THEN
    RAISE EXCEPTION 'Errand reservation is not available for this job status';
  END IF;

  INSERT INTO wallets (user_id, currency_code)
  VALUES (p_customer_id, COALESCE(v_job.currency_code, 'GBP'))
  ON CONFLICT (user_id) DO NOTHING;

  SELECT id, COALESCE(available_balance, 0)
  INTO v_wallet_id, v_available
  FROM wallets
  WHERE user_id = p_customer_id
  FOR UPDATE;

  SELECT COALESCE(amount_reserved, 0)
  INTO v_existing_reserved
  FROM errand_funding
  WHERE job_id = p_job_id
  FOR UPDATE;

  v_delta := ROUND((v_total_needed - COALESCE(v_existing_reserved, 0))::NUMERIC, 2);

  IF v_delta > 0 AND v_available < v_delta THEN
    RAISE EXCEPTION 'Insufficient funds. Required: %, Available: %', v_total_needed, v_available;
  END IF;

  -- Reserve in wallet
  UPDATE wallets
  SET available_balance = COALESCE(available_balance, 0) - v_delta,
      reserved_balance = COALESCE(reserved_balance, 0) + v_delta,
      updated_at = NOW()
  WHERE id = v_wallet_id;

  -- Record in errand_funding
  INSERT INTO errand_funding (job_id, customer_id, amount_reserved, status)
  VALUES (p_job_id, p_customer_id, v_total_needed, 'reserved')
  ON CONFLICT (job_id) DO UPDATE
  SET amount_reserved = v_total_needed,
      status = 'reserved',
      updated_at = NOW();

  UPDATE jobs
  SET payment_status = 'wallet_funded',
      payment_method = 'wallet',
      updated_at = NOW()
  WHERE id = p_job_id;

  RETURN TRUE;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public SET row_security = off;

ALTER FUNCTION reserve_errand_funds(UUID, UUID, NUMERIC, NUMERIC) OWNER TO postgres;
ALTER FUNCTION reserve_errand_funds(UUID, UUID, NUMERIC, NUMERIC) SET row_security = off;
GRANT EXECUTE ON FUNCTION reserve_errand_funds(UUID, UUID, NUMERIC, NUMERIC) TO authenticated;

DROP FUNCTION IF EXISTS public.request_errand_over_budget(UUID, NUMERIC, TEXT);
CREATE OR REPLACE FUNCTION public.request_errand_over_budget(
  p_job_id UUID,
  p_amount NUMERIC,
  p_reason TEXT DEFAULT NULL
)
RETURNS BOOLEAN AS $$
DECLARE
  v_amount NUMERIC := ROUND(COALESCE(p_amount, 0)::NUMERIC, 2);
BEGIN
  IF v_amount <= 0 THEN
    RAISE EXCEPTION 'Extra budget amount must be greater than zero';
  END IF;

  UPDATE public.errand_funding
  SET over_budget_status = 'requested',
      over_budget_amount = v_amount,
      requested_over_budget_amount = v_amount,
      over_budget_reason = p_reason,
      status = CASE WHEN status = 'settled' THEN status ELSE 'over_budget_requested' END,
      updated_at = NOW()
  WHERE job_id = p_job_id
    AND status <> 'settled';

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Errand funding not found or already settled';
  END IF;

  RETURN TRUE;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public SET row_security = off;

ALTER FUNCTION public.request_errand_over_budget(UUID, NUMERIC, TEXT) OWNER TO postgres;
ALTER FUNCTION public.request_errand_over_budget(UUID, NUMERIC, TEXT) SET search_path = public;
ALTER FUNCTION public.request_errand_over_budget(UUID, NUMERIC, TEXT) SET row_security = off;
GRANT EXECUTE ON FUNCTION public.request_errand_over_budget(UUID, NUMERIC, TEXT) TO authenticated;

DROP FUNCTION IF EXISTS public.approve_errand_over_budget(UUID);
CREATE OR REPLACE FUNCTION public.approve_errand_over_budget(p_job_id UUID)
RETURNS BOOLEAN AS $$
DECLARE
  v_customer_id UUID;
  v_wallet_id UUID;
  v_available NUMERIC;
  v_extra_amount NUMERIC;
BEGIN
  SELECT customer_id,
         ROUND(COALESCE(requested_over_budget_amount, over_budget_amount, 0)::NUMERIC, 2)
  INTO v_customer_id, v_extra_amount
  FROM public.errand_funding
  WHERE job_id = p_job_id
    AND over_budget_status = 'requested'
  FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'No pending extra budget request was found';
  END IF;

  IF v_extra_amount <= 0 THEN
    RAISE EXCEPTION 'Extra budget amount must be greater than zero';
  END IF;

  SELECT id, COALESCE(available_balance, 0)
  INTO v_wallet_id, v_available
  FROM public.wallets
  WHERE user_id = v_customer_id
  FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Customer wallet not found';
  END IF;

  IF v_available < v_extra_amount THEN
    RAISE EXCEPTION 'Insufficient wallet balance for extra budget. Required: %, Available: %', v_extra_amount, v_available;
  END IF;

  UPDATE public.wallets
  SET available_balance = COALESCE(available_balance, 0) - v_extra_amount,
      reserved_balance = COALESCE(reserved_balance, 0) + v_extra_amount,
      updated_at = NOW()
  WHERE id = v_wallet_id;

  UPDATE public.errand_funding
  SET over_budget_status = 'approved',
      status = 'reserved',
      amount_reserved = COALESCE(amount_reserved, 0) + v_extra_amount,
      updated_at = NOW()
  WHERE job_id = p_job_id;

  RETURN TRUE;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public SET row_security = off;

ALTER FUNCTION public.approve_errand_over_budget(UUID) OWNER TO postgres;
ALTER FUNCTION public.approve_errand_over_budget(UUID) SET search_path = public;
ALTER FUNCTION public.approve_errand_over_budget(UUID) SET row_security = off;
GRANT EXECUTE ON FUNCTION public.approve_errand_over_budget(UUID) TO authenticated;

DROP FUNCTION IF EXISTS public.reject_errand_over_budget(UUID);
CREATE OR REPLACE FUNCTION public.reject_errand_over_budget(p_job_id UUID)
RETURNS BOOLEAN AS $$
BEGIN
  UPDATE public.errand_funding
  SET over_budget_status = 'rejected',
      status = CASE WHEN status = 'over_budget_requested' THEN 'reserved' ELSE status END,
      updated_at = NOW()
  WHERE job_id = p_job_id
    AND over_budget_status = 'requested';

  IF NOT FOUND THEN
    RAISE EXCEPTION 'No pending extra budget request was found';
  END IF;

  RETURN TRUE;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public SET row_security = off;

ALTER FUNCTION public.reject_errand_over_budget(UUID) OWNER TO postgres;
ALTER FUNCTION public.reject_errand_over_budget(UUID) SET search_path = public;
ALTER FUNCTION public.reject_errand_over_budget(UUID) SET row_security = off;
GRANT EXECUTE ON FUNCTION public.reject_errand_over_budget(UUID) TO authenticated;

DROP FUNCTION IF EXISTS public.send_job_message(UUID, UUID, TEXT, TEXT);
CREATE OR REPLACE FUNCTION public.send_job_message(
  p_job_id UUID,
  p_receiver_id UUID,
  p_message TEXT,
  p_message_type TEXT DEFAULT 'text'
)
RETURNS job_messages AS $$
DECLARE
  v_sender_id UUID := auth.uid();
  v_job RECORD;
  v_message job_messages;
BEGIN
  IF v_sender_id IS NULL THEN
    RAISE EXCEPTION 'Not authenticated';
  END IF;

  IF NULLIF(TRIM(COALESCE(p_message, '')), '') IS NULL THEN
    RAISE EXCEPTION 'Message cannot be empty';
  END IF;

  SELECT *
  INTO v_job
  FROM jobs
  WHERE id = p_job_id
    AND v_sender_id IN (customer_id, driver_id)
    AND p_receiver_id IN (customer_id, driver_id);

  IF v_job IS NULL THEN
    RAISE EXCEPTION 'You can only message participants on this job';
  END IF;

  INSERT INTO job_messages (
    tenant_id,
    job_id,
    sender_id,
    receiver_id,
    message,
    message_type
  )
  VALUES (
    NULLIF(to_jsonb(v_job)->>'tenant_id', '')::UUID,
    p_job_id,
    v_sender_id,
    p_receiver_id,
    TRIM(p_message),
    COALESCE(NULLIF(p_message_type, ''), 'text')
  )
  RETURNING * INTO v_message;

  RETURN v_message;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public SET row_security = off;

ALTER FUNCTION public.send_job_message(UUID, UUID, TEXT, TEXT) OWNER TO postgres;
ALTER FUNCTION public.send_job_message(UUID, UUID, TEXT, TEXT) SET search_path = public;
ALTER FUNCTION public.send_job_message(UUID, UUID, TEXT, TEXT) SET row_security = off;
GRANT EXECUTE ON FUNCTION public.send_job_message(UUID, UUID, TEXT, TEXT) TO authenticated;

-- Wallet-first Job Payment RPC
CREATE OR REPLACE FUNCTION pay_job_from_wallet(
  p_job_id UUID,
  p_customer_id UUID,
  p_amount NUMERIC,
  p_currency_code TEXT DEFAULT 'GBP',
  p_tenant_id UUID DEFAULT NULL
)
RETURNS JSONB AS $$
DECLARE
  v_available NUMERIC;
  v_wallet_id UUID;
  v_job RECORD;
  v_amount NUMERIC := ROUND(COALESCE(p_amount, 0)::NUMERIC, 2);
  v_tx_type_col TEXT;
  v_has_wallet_id BOOLEAN;
BEGIN
  IF v_amount <= 0 THEN
    RAISE EXCEPTION 'Wallet payment amount must be greater than zero';
  END IF;

  SELECT *
  INTO v_job
  FROM jobs
  WHERE id = p_job_id
    AND customer_id = p_customer_id
  FOR UPDATE;

  IF v_job IS NULL THEN
    RAISE EXCEPTION 'Job not found for wallet payment';
  END IF;

  IF v_job.status IN ('cancelled', 'completed') THEN
    RAISE EXCEPTION 'Wallet payment is not available for this job status';
  END IF;

  INSERT INTO wallets (user_id, currency_code)
  VALUES (p_customer_id, COALESCE(p_currency_code, 'GBP'))
  ON CONFLICT (user_id) DO NOTHING;

  SELECT id, available_balance
  INTO v_wallet_id, v_available
  FROM wallets
  WHERE user_id = p_customer_id
  FOR UPDATE;

  IF v_available IS NULL OR v_available < v_amount THEN
    RAISE EXCEPTION 'Insufficient wallet balance. Required: %, Available: %', v_amount, COALESCE(v_available, 0);
  END IF;

  UPDATE wallets
  SET available_balance = available_balance - v_amount,
      reserved_balance = COALESCE(reserved_balance, 0) + v_amount,
      updated_at = NOW()
  WHERE id = v_wallet_id;

  SELECT CASE
    WHEN EXISTS (
      SELECT 1 FROM information_schema.columns
      WHERE table_schema = 'public'
        AND table_name = 'wallet_transactions'
        AND column_name = 'transaction_type'
    ) THEN 'transaction_type'
    ELSE 'type'
  END INTO v_tx_type_col;

  SELECT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public'
      AND table_name = 'wallet_transactions'
      AND column_name = 'wallet_id'
  ) INTO v_has_wallet_id;

  IF v_has_wallet_id THEN
    EXECUTE format(
      'INSERT INTO wallet_transactions (wallet_id, user_id, job_id, amount, %I, description, metadata)
       VALUES ($1, $2, $3, $4, $5, $6, $7)',
      v_tx_type_col
    )
    USING
      v_wallet_id,
      p_customer_id,
      p_job_id,
      v_amount,
      'reservation',
      'Job payment reserved from wallet',
      jsonb_build_object(
        'currency_code', COALESCE(p_currency_code, 'GBP'),
        'tenant_id', p_tenant_id,
        'payment_method', 'wallet'
      );
  ELSE
    EXECUTE format(
      'INSERT INTO wallet_transactions (user_id, job_id, amount, %I, description, metadata)
       VALUES ($1, $2, $3, $4, $5, $6)',
      v_tx_type_col
    )
    USING
      p_customer_id,
      p_job_id,
      v_amount,
      'reservation',
      'Job payment reserved from wallet',
      jsonb_build_object(
        'currency_code', COALESCE(p_currency_code, 'GBP'),
        'tenant_id', p_tenant_id,
        'payment_method', 'wallet'
      );
  END IF;

  UPDATE jobs
  SET payment_status = 'wallet_funded',
      payment_method = 'wallet',
      payment_intent_id = NULL,
      total_price = v_amount,
      price = COALESCE(price, v_amount),
      confirmed_at = NOW(),
      updated_at = NOW()
  WHERE id = p_job_id;

  RETURN jsonb_build_object(
    'job_id', p_job_id,
    'amount', v_amount,
    'payment_method', 'wallet'
  );
END;
$$ LANGUAGE plpgsql;

-- Release a wallet reservation when no driver is found or the customer cancels before completion.
CREATE OR REPLACE FUNCTION release_job_wallet_reservation(
  p_job_id UUID,
  p_reason TEXT DEFAULT 'Wallet reservation released'
)
RETURNS JSONB AS $$
DECLARE
  v_job RECORD;
  v_wallet_id UUID;
  v_tx_type_col TEXT;
  v_has_wallet_id BOOLEAN;
  v_tx_reserved NUMERIC := 0;
  v_errand_reserved NUMERIC := 0;
  v_release_amount NUMERIC := 0;
BEGIN
  SELECT *
  INTO v_job
  FROM jobs
  WHERE id = p_job_id
  FOR UPDATE;

  IF v_job IS NULL THEN
    RAISE EXCEPTION 'Job not found for wallet release';
  END IF;

  IF v_job.payment_status NOT IN ('wallet_funded', 'paid') AND COALESCE(v_job.payment_method, '') <> 'wallet' THEN
    RETURN jsonb_build_object('released', false, 'reason', 'Job is not wallet-funded');
  END IF;

  SELECT id
  INTO v_wallet_id
  FROM wallets
  WHERE user_id = v_job.customer_id
  FOR UPDATE;

  IF v_wallet_id IS NULL THEN
    RETURN jsonb_build_object('released', false, 'reason', 'Wallet not found');
  END IF;

  SELECT CASE
    WHEN EXISTS (
      SELECT 1 FROM information_schema.columns
      WHERE table_schema = 'public'
        AND table_name = 'wallet_transactions'
        AND column_name = 'transaction_type'
    ) THEN 'transaction_type'
    ELSE 'type'
  END INTO v_tx_type_col;

  SELECT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public'
      AND table_name = 'wallet_transactions'
      AND column_name = 'wallet_id'
  ) INTO v_has_wallet_id;

  EXECUTE format(
    'SELECT COALESCE(SUM(CASE
       WHEN %I = ''reservation'' THEN amount
       WHEN %I = ''release'' THEN -amount
       ELSE 0
     END), 0)
     FROM wallet_transactions
     WHERE job_id = $1 AND user_id = $2',
    v_tx_type_col,
    v_tx_type_col
  )
  INTO v_tx_reserved
  USING p_job_id, v_job.customer_id;

  SELECT COALESCE(amount_reserved, 0)
  INTO v_errand_reserved
  FROM errand_funding
  WHERE job_id = p_job_id
    AND status IN ('reserved', 'approved', 'over_budget_requested')
  LIMIT 1;

  v_release_amount := GREATEST(COALESCE(v_tx_reserved, 0), COALESCE(v_errand_reserved, 0));

  IF v_release_amount <= 0 THEN
    UPDATE jobs
    SET payment_status = 'cancelled',
        updated_at = NOW()
    WHERE id = p_job_id;

    RETURN jsonb_build_object('released', false, 'reason', 'No active wallet reservation');
  END IF;

  UPDATE wallets
  SET available_balance = COALESCE(available_balance, 0) + v_release_amount,
      reserved_balance = GREATEST(COALESCE(reserved_balance, 0) - v_release_amount, 0),
      updated_at = NOW()
  WHERE id = v_wallet_id;

  IF v_has_wallet_id THEN
    EXECUTE format(
      'INSERT INTO wallet_transactions (wallet_id, user_id, job_id, amount, %I, description, metadata)
       VALUES ($1, $2, $3, $4, $5, $6, $7)',
      v_tx_type_col
    )
    USING
      v_wallet_id,
      v_job.customer_id,
      p_job_id,
      v_release_amount,
      'release',
      p_reason,
      jsonb_build_object('payment_method', 'wallet', 'released_from_status', v_job.status);
  ELSE
    EXECUTE format(
      'INSERT INTO wallet_transactions (user_id, job_id, amount, %I, description, metadata)
       VALUES ($1, $2, $3, $4, $5, $6)',
      v_tx_type_col
    )
    USING
      v_job.customer_id,
      p_job_id,
      v_release_amount,
      'release',
      p_reason,
      jsonb_build_object('payment_method', 'wallet', 'released_from_status', v_job.status);
  END IF;

  UPDATE errand_funding
  SET status = 'cancelled',
      metadata = COALESCE(metadata, '{}'::jsonb) || jsonb_build_object(
        'released_amount', v_release_amount,
        'release_reason', p_reason
      ),
      updated_at = NOW()
  WHERE job_id = p_job_id
    AND status IN ('reserved', 'approved', 'over_budget_requested');

  UPDATE jobs
  SET payment_status = 'cancelled',
      payment_intent_id = NULL,
      updated_at = NOW()
  WHERE id = p_job_id;

  RETURN jsonb_build_object(
    'released', true,
    'job_id', p_job_id,
    'amount', v_release_amount,
    'reason', p_reason
  );
END;
$$ LANGUAGE plpgsql;

DO $$
DECLARE
  v_job RECORD;
BEGIN
  FOR v_job IN
    SELECT id
    FROM public.jobs
    WHERE status = 'searching'
      AND driver_id IS NULL
      AND driver_search_expires_at IS NULL
      AND created_at < NOW() - INTERVAL '5 minutes'
      AND (
        payment_status = 'wallet_funded'
        OR COALESCE(payment_method, '') = 'wallet'
      )
  LOOP
    UPDATE public.jobs
    SET status = 'no_driver_found',
        no_driver_reason = 'No available driver after search window',
        updated_at = NOW()
    WHERE id = v_job.id
      AND status = 'searching'
      AND driver_id IS NULL;

    PERFORM release_job_wallet_reservation(
      v_job.id,
      'Auto release for stale searching wallet request'
    );
  END LOOP;
END $$;

-- Driver Vehicle Compatibility
CREATE OR REPLACE FUNCTION driver_vehicle_can_accept_job(
  p_job_id UUID,
  p_driver_id UUID
)
RETURNS BOOLEAN AS $$
DECLARE
  v_required TEXT;
  v_service_slug TEXT;
  v_metadata JSONB;
  v_vehicle RECORD;
  v_vehicle_text TEXT;
BEGIN
  SELECT
    COALESCE(st.slug::TEXT, st.name::TEXT, j.metadata->>'service_slug', ''),
    COALESCE(j.metadata, '{}'::jsonb)
  INTO v_service_slug, v_metadata
  FROM jobs j
  LEFT JOIN service_types st ON st.id = j.service_type_id
  WHERE j.id = p_job_id;

  IF NOT FOUND THEN
    RETURN FALSE;
  END IF;

  v_required := LOWER(COALESCE(
    v_metadata->>'service_vehicle_class',
    v_metadata->>'vehicle_class',
    v_metadata->>'vehicleClass',
    v_metadata #>> '{ride_details,vehicle_class}',
    v_metadata #>> '{delivery_details,vehicleClass}',
    v_metadata #>> '{errand_details,vehicleClass}',
    ''
  ));

  IF v_required LIKE '%bike%' OR v_required LIKE '%motorcycle%' OR v_required LIKE '%scooter%' THEN
    v_required := 'bike';
  ELSIF v_required LIKE '%minibus%' OR v_required LIKE '%7 seater%' OR v_required LIKE '%7-seater%' THEN
    v_required := 'minibus';
  ELSIF v_required LIKE '%xl%' OR v_required LIKE '%7%' THEN
    v_required := 'xl';
  ELSIF v_required LIKE '%large_van%' OR v_required LIKE '%large van%' OR v_required LIKE '%luton%' THEN
    v_required := 'large_van';
  ELSIF v_required LIKE '%small_van%' OR v_required LIKE '%small van%' OR v_required LIKE '%van%' THEN
    v_required := 'small_van';
  ELSIF v_required LIKE '%standard%' THEN
    v_required := 'standard';
  ELSIF v_required LIKE '%car%' THEN
    v_required := 'car';
  ELSIF LOWER(v_service_slug) LIKE '%van%' OR LOWER(v_service_slug) LIKE '%moving%' THEN
    v_required := 'small_van';
  ELSIF LOWER(v_service_slug) LIKE '%delivery%' OR LOWER(v_service_slug) LIKE '%errand%' THEN
    v_required := 'car';
  ELSE
    v_required := 'standard';
  END IF;

  SELECT *
  INTO v_vehicle
  FROM vehicles
  WHERE user_id = p_driver_id
  LIMIT 1;

  IF NOT FOUND THEN
    RETURN FALSE;
  END IF;

  v_vehicle_text := LOWER(
    COALESCE(to_jsonb(v_vehicle)->>'type', '') || ' ' ||
    COALESCE(to_jsonb(v_vehicle)->>'capacity', '') || ' ' ||
    COALESCE(to_jsonb(v_vehicle)->>'service_class', '')
  );

  IF v_vehicle_text LIKE '%bike%' OR v_vehicle_text LIKE '%motorcycle%' OR v_vehicle_text LIKE '%scooter%' THEN
    RETURN v_required = 'bike';
  END IF;

  IF v_vehicle_text LIKE '%minibus%' OR v_vehicle_text LIKE '%7 seater%' OR v_vehicle_text LIKE '%7-seater%' OR v_vehicle_text LIKE '%xl%' OR v_vehicle_text LIKE '%7%' THEN
    RETURN v_required IN ('standard', 'xl', 'minibus', 'car');
  END IF;

  IF v_vehicle_text LIKE '%large_van%' OR v_vehicle_text LIKE '%large van%' OR v_vehicle_text LIKE '%luton%' THEN
    RETURN v_required IN ('standard', 'xl', 'car', 'small_van', 'large_van');
  END IF;

  IF v_vehicle_text LIKE '%small_van%' OR v_vehicle_text LIKE '%small van%' OR v_vehicle_text LIKE '%van%' THEN
    RETURN v_required IN ('standard', 'car', 'small_van');
  END IF;

  RETURN v_required IN ('standard', 'car');
END;
$$ LANGUAGE plpgsql;

-- Assign Driver Safely
CREATE OR REPLACE FUNCTION assign_driver_to_job(
  p_job_id UUID,
  p_driver_id UUID
)
RETURNS BOOLEAN AS $$
BEGIN
  IF NOT driver_vehicle_can_accept_job(p_job_id, p_driver_id) THEN
    RAISE EXCEPTION 'Driver vehicle is not compatible with this request';
  END IF;

  UPDATE jobs
  SET driver_id = p_driver_id,
      status = 'assigned',
      updated_at = NOW()
  WHERE id = p_job_id
    AND status IN ('pending', 'requested', 'searching')
    AND driver_id IS NULL;

  RETURN FOUND;
END;
$$ LANGUAGE plpgsql;

CREATE OR REPLACE FUNCTION accept_searching_job(
  p_job_id UUID,
  p_driver_id UUID
)
RETURNS BOOLEAN AS $$
BEGIN
  IF NOT driver_vehicle_can_accept_job(p_job_id, p_driver_id) THEN
    RAISE EXCEPTION 'Driver vehicle is not compatible with this request';
  END IF;

  UPDATE jobs
  SET driver_id = p_driver_id,
      accepted_driver_id = p_driver_id,
      status = 'accepted',
      accepted_at = NOW(),
      updated_at = NOW()
  WHERE id = p_job_id
    AND status IN ('pending', 'requested', 'searching')
    AND driver_id IS NULL;

  RETURN FOUND;
END;
$$ LANGUAGE plpgsql;

-- Cancel Job Safely
DROP FUNCTION IF EXISTS cancel_job_safely(UUID);
DROP FUNCTION IF EXISTS cancel_job_safely(UUID, TEXT);
CREATE OR REPLACE FUNCTION cancel_job_safely(
  p_job_id UUID,
  p_reason TEXT DEFAULT 'User cancelled'
)
RETURNS BOOLEAN AS $$
DECLARE
  v_cancelled BOOLEAN;
BEGIN
  UPDATE jobs
  SET status = 'cancelled',
      metadata = COALESCE(metadata, '{}'::jsonb) || jsonb_build_object(
        'cancellation_reason', p_reason,
        'cancelled_at', NOW()
      ),
      updated_at = NOW()
  WHERE id = p_job_id
    AND status IN ('requested', 'searching', 'assigned', 'accepted', 'heading_to_pickup');

  v_cancelled := FOUND;

  IF v_cancelled THEN
    PERFORM release_job_wallet_reservation(p_job_id, p_reason);
  END IF;

  RETURN v_cancelled;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public SET row_security = off;

ALTER FUNCTION cancel_job_safely(UUID, TEXT) OWNER TO postgres;
GRANT EXECUTE ON FUNCTION cancel_job_safely(UUID, TEXT) TO authenticated;

CREATE OR REPLACE FUNCTION cancel_job_safely(p_job_id UUID)
RETURNS BOOLEAN AS $$
BEGIN
  RETURN cancel_job_safely(p_job_id, 'User cancelled');
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public SET row_security = off;

ALTER FUNCTION cancel_job_safely(UUID) OWNER TO postgres;
GRANT EXECUTE ON FUNCTION cancel_job_safely(UUID) TO authenticated;

-- Process Payout Batch
CREATE OR REPLACE FUNCTION process_payout_batch()
RETURNS UUID AS $$
DECLARE
  v_batch_id UUID := gen_random_uuid();
BEGIN
  INSERT INTO payout_batches (id, status, created_at)
  VALUES (v_batch_id, 'processing', NOW());

  UPDATE driver_earnings
  SET status = 'paid',
      payout_batch_id = v_batch_id,
      paid_out_at = NOW()
  WHERE status = 'payable';

  UPDATE payout_batches
  SET status = 'completed',
      processed_at = NOW(),
      total_amount = COALESCE((SELECT SUM(net_amount) FROM driver_earnings WHERE payout_batch_id = v_batch_id), 0)
  WHERE id = v_batch_id;

  RETURN v_batch_id;
END;
$$ LANGUAGE plpgsql;

-- PART 12 — Indexes
CREATE INDEX IF NOT EXISTS idx_jobs_status ON jobs(status);
CREATE INDEX IF NOT EXISTS idx_jobs_customer ON jobs(customer_id);
CREATE INDEX IF NOT EXISTS idx_jobs_driver ON jobs(driver_id);
CREATE INDEX IF NOT EXISTS idx_profiles_location ON profiles(lat, lng) WHERE lat IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_wallet_transactions_user ON wallet_transactions(user_id);
CREATE INDEX IF NOT EXISTS idx_driver_earnings_status ON driver_earnings(status);
CREATE INDEX IF NOT EXISTS idx_cities_active ON cities(is_active) WHERE is_active = TRUE;

-- Keep short package delivery competitive. Bike/small package delivery should
-- not inherit ride or van-style minimums for sub-1km local jobs.
CREATE TABLE IF NOT EXISTS pricing_config (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    service_type TEXT NOT NULL UNIQUE,
    base_fare NUMERIC(10,2) NOT NULL DEFAULT 0,
    per_km NUMERIC(10,2) NOT NULL DEFAULT 0,
    per_min NUMERIC(10,2) NOT NULL DEFAULT 0,
    service_fee NUMERIC(10,2) NOT NULL DEFAULT 0,
    minimum_fare NUMERIC(10,2) NOT NULL DEFAULT 0,
    currency_code TEXT NOT NULL DEFAULT 'GBP',
    is_active BOOLEAN NOT NULL DEFAULT TRUE,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

ALTER TABLE pricing_config ENABLE ROW LEVEL SECURITY;

DO $$
BEGIN
    ALTER TABLE pricing_config DROP CONSTRAINT IF EXISTS service_type_check;
    ALTER TABLE pricing_config
        ADD CONSTRAINT service_type_check
        CHECK (service_type IN ('ride', 'errand', 'delivery', 'van-moving'));

    DROP POLICY IF EXISTS "Allow active pricing read" ON public.pricing_config;
    CREATE POLICY "Allow active pricing read" ON public.pricing_config
        FOR SELECT USING (is_active = TRUE);

    DROP POLICY IF EXISTS "Allow admin pricing management" ON public.pricing_config;
    CREATE POLICY "Allow admin pricing management" ON public.pricing_config
        FOR ALL
        USING (EXISTS (SELECT 1 FROM public.profiles WHERE profiles.id = auth.uid() AND profiles.role = 'admin'))
        WITH CHECK (EXISTS (SELECT 1 FROM public.profiles WHERE profiles.id = auth.uid() AND profiles.role = 'admin'));

    INSERT INTO pricing_config (service_type, base_fare, per_km, per_min, service_fee, minimum_fare, currency_code, is_active)
    VALUES ('delivery', 2.25, 0.55, 0.04, 0.10, 2.99, 'GBP', TRUE)
    ON CONFLICT (service_type) DO UPDATE SET
        base_fare = EXCLUDED.base_fare,
        per_km = EXCLUDED.per_km,
        per_min = EXCLUDED.per_min,
        service_fee = EXCLUDED.service_fee,
        minimum_fare = EXCLUDED.minimum_fare,
        currency_code = EXCLUDED.currency_code,
        is_active = TRUE,
        updated_at = NOW();

    INSERT INTO pricing_rules (service_type_id, currency_code, country_code, base_fare, per_km_rate, minimum_fare)
    SELECT id, 'GBP', 'GB', 2.25, 0.55, 2.99
    FROM service_types
    WHERE slug = 'delivery'
    ON CONFLICT (service_type_id, currency_code, country_code) DO UPDATE SET
        base_fare = EXCLUDED.base_fare,
        per_km_rate = EXCLUDED.per_km_rate,
        minimum_fare = EXCLUDED.minimum_fare;

    IF to_regclass('public.regional_pricing_rules') IS NOT NULL THEN
        EXECUTE $sql$
            UPDATE regional_pricing_rules
            SET base_fare = 2.25,
                price_per_km = 0.55,
                minimum_fare = 2.99
            WHERE country_code = 'GB'
              AND service_slug = 'delivery'
              AND pricing_plan IN ('starter', 'pro')
        $sql$;
    END IF;
END $$;

-- Global AI pricing foundation. These tables are admin-managed guardrails for
-- market, zone, service, waiting, calendar and audit data. Live AI pricing is
-- disabled unless a market and service rule explicitly enable it.
CREATE TABLE IF NOT EXISTS public.pricing_markets (
    country_code TEXT PRIMARY KEY,
    currency_code TEXT NOT NULL,
    timezone TEXT NOT NULL,
    distance_unit TEXT NOT NULL CHECK (distance_unit IN ('km', 'mi')),
    tax_inclusive_display BOOLEAN NOT NULL DEFAULT TRUE,
    tax_rate NUMERIC(8,4) NOT NULL DEFAULT 0,
    default_language TEXT NULL,
    rounding_rule JSONB NOT NULL DEFAULT '{}'::jsonb,
    minimum_charge_unit_minor INTEGER NOT NULL DEFAULT 1,
    pricing_model TEXT NOT NULL DEFAULT 'rules_shadow',
    market_enabled BOOLEAN NOT NULL DEFAULT FALSE,
    ai_pricing_enabled BOOLEAN NOT NULL DEFAULT FALSE,
    shadow_mode_enabled BOOLEAN NOT NULL DEFAULT TRUE,
    experimentation_enabled BOOLEAN NOT NULL DEFAULT FALSE,
    emergency_pricing_disabled BOOLEAN NOT NULL DEFAULT FALSE,
    confidence_threshold NUMERIC(5,4) NOT NULL DEFAULT 0.75,
    model_version TEXT NOT NULL DEFAULT 'global-pricing-v1',
    configuration_version INTEGER NOT NULL DEFAULT 1,
    metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS public.pricing_zones (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    country_code TEXT NOT NULL REFERENCES public.pricing_markets(country_code) ON DELETE CASCADE,
    city_id UUID NULL,
    city_name TEXT NULL,
    zone_id TEXT NOT NULL,
    polygon JSONB NULL,
    base_cost_index NUMERIC(10,4) NOT NULL DEFAULT 1,
    congestion_index NUMERIC(10,4) NOT NULL DEFAULT 1,
    purchasing_power_index NUMERIC(10,4) NOT NULL DEFAULT 1,
    driver_cost_index NUMERIC(10,4) NOT NULL DEFAULT 1,
    fuel_cost_index NUMERIC(10,4) NOT NULL DEFAULT 1,
    insurance_cost_index NUMERIC(10,4) NOT NULL DEFAULT 1,
    regulatory_fee_minor INTEGER NOT NULL DEFAULT 0,
    airport_fee_minor INTEGER NOT NULL DEFAULT 0,
    max_surge_multiplier NUMERIC(6,3) NOT NULL DEFAULT 1,
    minimum_driver_earnings_minor INTEGER NOT NULL DEFAULT 0,
    enabled_services TEXT[] NULL,
    priority INTEGER NOT NULL DEFAULT 100,
    is_active BOOLEAN NOT NULL DEFAULT TRUE,
    metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    UNIQUE (country_code, zone_id)
);

CREATE TABLE IF NOT EXISTS public.service_market_rules (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    country_code TEXT NOT NULL REFERENCES public.pricing_markets(country_code) ON DELETE CASCADE,
    zone_id TEXT NULL,
    service_slug TEXT NOT NULL,
    vehicle_class TEXT NULL,
    base_fare_minor INTEGER NOT NULL DEFAULT 0,
    per_distance_unit_minor INTEGER NOT NULL DEFAULT 0,
    per_minute_minor INTEGER NOT NULL DEFAULT 0,
    minimum_fare_minor INTEGER NOT NULL DEFAULT 0,
    booking_fee_minor INTEGER NOT NULL DEFAULT 0,
    cancellation_fee_minor INTEGER NOT NULL DEFAULT 0,
    waiting_fee_per_minute_minor INTEGER NOT NULL DEFAULT 0,
    maximum_fare_minor INTEGER NULL,
    maximum_surge_multiplier NUMERIC(6,3) NOT NULL DEFAULT 1,
    commission_percent NUMERIC(8,4) NOT NULL DEFAULT 0,
    tax_treatment TEXT NOT NULL DEFAULT 'market',
    toll_treatment TEXT NOT NULL DEFAULT 'actual',
    payment_rules JSONB NOT NULL DEFAULT '{}'::jsonb,
    ai_pricing_enabled BOOLEAN NOT NULL DEFAULT FALSE,
    surge_enabled BOOLEAN NOT NULL DEFAULT FALSE,
    is_active BOOLEAN NOT NULL DEFAULT TRUE,
    metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    UNIQUE (country_code, zone_id, service_slug, vehicle_class)
);

CREATE TABLE IF NOT EXISTS public.pricing_waiting_rules (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    country_code TEXT NOT NULL REFERENCES public.pricing_markets(country_code) ON DELETE CASCADE,
    zone_id TEXT NULL,
    service_slug TEXT NOT NULL,
    free_waiting_minutes INTEGER NOT NULL DEFAULT 0,
    airport_free_waiting_minutes INTEGER NOT NULL DEFAULT 0,
    accessibility_free_waiting_minutes INTEGER NOT NULL DEFAULT 0,
    per_minute_charge_minor INTEGER NOT NULL DEFAULT 0,
    maximum_charge_minor INTEGER NOT NULL DEFAULT 0,
    cancellation_threshold_minutes INTEGER NULL,
    partial_minute_rounding TEXT NOT NULL DEFAULT 'ceil',
    is_active BOOLEAN NOT NULL DEFAULT TRUE,
    metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    UNIQUE (country_code, zone_id, service_slug)
);

CREATE TABLE IF NOT EXISTS public.pricing_calendar_events (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    country_code TEXT NOT NULL,
    region_code TEXT NULL,
    zone_id TEXT NULL,
    event_type TEXT NOT NULL,
    title TEXT NOT NULL,
    starts_at TIMESTAMPTZ NOT NULL,
    ends_at TIMESTAMPTZ NOT NULL,
    expected_demand_impact NUMERIC(8,4) NOT NULL DEFAULT 0,
    expected_supply_impact NUMERIC(8,4) NOT NULL DEFAULT 0,
    source TEXT NULL,
    is_active BOOLEAN NOT NULL DEFAULT TRUE,
    metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS public.ai_pricing_audits (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    job_id UUID NULL REFERENCES public.jobs(id) ON DELETE SET NULL,
    country_code TEXT NOT NULL,
    currency_code TEXT NOT NULL,
    service_slug TEXT NOT NULL,
    zone_id TEXT NULL,
    input_snapshot JSONB NOT NULL DEFAULT '{}'::jsonb,
    rule_price_minor INTEGER NOT NULL DEFAULT 0,
    recommended_price_minor INTEGER NOT NULL DEFAULT 0,
    final_price_minor INTEGER NOT NULL DEFAULT 0,
    guardrails JSONB NOT NULL DEFAULT '{}'::jsonb,
    confidence NUMERIC(5,4) NOT NULL DEFAULT 0,
    reasons JSONB NOT NULL DEFAULT '[]'::jsonb,
    model_version TEXT NOT NULL,
    configuration_version INTEGER NOT NULL DEFAULT 1,
    shadow_mode BOOLEAN NOT NULL DEFAULT TRUE,
    fallback_used BOOLEAN NOT NULL DEFAULT FALSE,
    fallback_reason TEXT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_pricing_zones_country_active
    ON public.pricing_zones(country_code, is_active, priority);
CREATE INDEX IF NOT EXISTS idx_service_market_rules_lookup
    ON public.service_market_rules(country_code, service_slug, zone_id, is_active);
CREATE INDEX IF NOT EXISTS idx_pricing_calendar_events_lookup
    ON public.pricing_calendar_events(country_code, region_code, starts_at, ends_at)
    WHERE is_active = TRUE;
CREATE INDEX IF NOT EXISTS idx_ai_pricing_audits_market
    ON public.ai_pricing_audits(country_code, service_slug, created_at DESC);

ALTER TABLE public.pricing_markets ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.pricing_zones ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.service_market_rules ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.pricing_waiting_rules ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.pricing_calendar_events ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.ai_pricing_audits ENABLE ROW LEVEL SECURITY;

DO $$
BEGIN
    DROP POLICY IF EXISTS "Allow active pricing markets read" ON public.pricing_markets;
    CREATE POLICY "Allow active pricing markets read" ON public.pricing_markets
        FOR SELECT USING (market_enabled = TRUE);

    DROP POLICY IF EXISTS "Allow active pricing zones read" ON public.pricing_zones;
    CREATE POLICY "Allow active pricing zones read" ON public.pricing_zones
        FOR SELECT USING (is_active = TRUE);

    DROP POLICY IF EXISTS "Allow active service market rules read" ON public.service_market_rules;
    CREATE POLICY "Allow active service market rules read" ON public.service_market_rules
        FOR SELECT USING (is_active = TRUE);

    DROP POLICY IF EXISTS "Allow active waiting rules read" ON public.pricing_waiting_rules;
    CREATE POLICY "Allow active waiting rules read" ON public.pricing_waiting_rules
        FOR SELECT USING (is_active = TRUE);

    DROP POLICY IF EXISTS "Allow active pricing events read" ON public.pricing_calendar_events;
    CREATE POLICY "Allow active pricing events read" ON public.pricing_calendar_events
        FOR SELECT USING (is_active = TRUE);

    DROP POLICY IF EXISTS "Allow admin pricing markets management" ON public.pricing_markets;
    CREATE POLICY "Allow admin pricing markets management" ON public.pricing_markets
        FOR ALL
        USING (EXISTS (SELECT 1 FROM public.profiles WHERE profiles.id = auth.uid() AND profiles.role = 'admin'))
        WITH CHECK (EXISTS (SELECT 1 FROM public.profiles WHERE profiles.id = auth.uid() AND profiles.role = 'admin'));

    DROP POLICY IF EXISTS "Allow admin pricing zones management" ON public.pricing_zones;
    CREATE POLICY "Allow admin pricing zones management" ON public.pricing_zones
        FOR ALL
        USING (EXISTS (SELECT 1 FROM public.profiles WHERE profiles.id = auth.uid() AND profiles.role = 'admin'))
        WITH CHECK (EXISTS (SELECT 1 FROM public.profiles WHERE profiles.id = auth.uid() AND profiles.role = 'admin'));

    DROP POLICY IF EXISTS "Allow admin service market rules management" ON public.service_market_rules;
    CREATE POLICY "Allow admin service market rules management" ON public.service_market_rules
        FOR ALL
        USING (EXISTS (SELECT 1 FROM public.profiles WHERE profiles.id = auth.uid() AND profiles.role = 'admin'))
        WITH CHECK (EXISTS (SELECT 1 FROM public.profiles WHERE profiles.id = auth.uid() AND profiles.role = 'admin'));

    DROP POLICY IF EXISTS "Allow admin waiting rules management" ON public.pricing_waiting_rules;
    CREATE POLICY "Allow admin waiting rules management" ON public.pricing_waiting_rules
        FOR ALL
        USING (EXISTS (SELECT 1 FROM public.profiles WHERE profiles.id = auth.uid() AND profiles.role = 'admin'))
        WITH CHECK (EXISTS (SELECT 1 FROM public.profiles WHERE profiles.id = auth.uid() AND profiles.role = 'admin'));

    DROP POLICY IF EXISTS "Allow admin pricing events management" ON public.pricing_calendar_events;
    CREATE POLICY "Allow admin pricing events management" ON public.pricing_calendar_events
        FOR ALL
        USING (EXISTS (SELECT 1 FROM public.profiles WHERE profiles.id = auth.uid() AND profiles.role = 'admin'))
        WITH CHECK (EXISTS (SELECT 1 FROM public.profiles WHERE profiles.id = auth.uid() AND profiles.role = 'admin'));

    DROP POLICY IF EXISTS "Allow admin pricing audit read" ON public.ai_pricing_audits;
    CREATE POLICY "Allow admin pricing audit read" ON public.ai_pricing_audits
        FOR SELECT
        USING (EXISTS (SELECT 1 FROM public.profiles WHERE profiles.id = auth.uid() AND profiles.role = 'admin'));
END $$;

-- Marketplace engine settings are admin-managed and provide the single source
-- of truth for commissions, negotiation, bidding and matching defaults.
CREATE TABLE IF NOT EXISTS public.marketplace_settings (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id UUID NULL,
    key TEXT NOT NULL,
    value JSONB NOT NULL DEFAULT '{}'::jsonb,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS public.marketplace_commission_overrides (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id UUID NULL,
    service_type_slug TEXT NULL,
    city_zone TEXT NULL,
    driver_tier TEXT NULL,
    promotion_period_id TEXT NULL,
    commission_percent NUMERIC(8,2) NOT NULL DEFAULT 5,
    platform_fee_percent NUMERIC(8,2) NOT NULL DEFAULT 0,
    is_active BOOLEAN NOT NULL DEFAULT TRUE,
    starts_at TIMESTAMPTZ NULL,
    ends_at TIMESTAMPTZ NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_marketplace_settings_global_key
    ON public.marketplace_settings (key)
    WHERE tenant_id IS NULL;

CREATE UNIQUE INDEX IF NOT EXISTS idx_marketplace_settings_tenant_key
    ON public.marketplace_settings (tenant_id, key)
    WHERE tenant_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_marketplace_commission_overrides_lookup
    ON public.marketplace_commission_overrides(tenant_id, service_type_slug, city_zone, driver_tier, is_active, starts_at, ends_at);

ALTER TABLE public.marketplace_settings ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.marketplace_commission_overrides ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS marketplace_settings_admin_read ON public.marketplace_settings;
CREATE POLICY marketplace_settings_admin_read
    ON public.marketplace_settings
    FOR SELECT
    USING (EXISTS (SELECT 1 FROM public.profiles WHERE profiles.id = auth.uid() AND profiles.role = 'admin'));

DROP POLICY IF EXISTS marketplace_settings_admin_write ON public.marketplace_settings;
CREATE POLICY marketplace_settings_admin_write
    ON public.marketplace_settings
    FOR ALL
    USING (EXISTS (SELECT 1 FROM public.profiles WHERE profiles.id = auth.uid() AND profiles.role = 'admin'))
    WITH CHECK (EXISTS (SELECT 1 FROM public.profiles WHERE profiles.id = auth.uid() AND profiles.role = 'admin'));

DROP POLICY IF EXISTS marketplace_commission_overrides_admin ON public.marketplace_commission_overrides;
CREATE POLICY marketplace_commission_overrides_admin
    ON public.marketplace_commission_overrides
    FOR ALL
    USING (EXISTS (SELECT 1 FROM public.profiles WHERE profiles.id = auth.uid() AND profiles.role = 'admin'))
    WITH CHECK (EXISTS (SELECT 1 FROM public.profiles WHERE profiles.id = auth.uid() AND profiles.role = 'admin'));

DO $$
DECLARE
    v_key TEXT;
    v_value JSONB;
BEGIN
    FOR v_key, v_value IN
        SELECT *
        FROM (VALUES
            ('commission', '{"percent": 5, "minFee": 0, "maxFee": null}'::jsonb),
            ('dynamic_pricing', '{"enabled": true, "maxSurge": 3, "trafficMultiplier": 1, "weatherMultiplier": 1, "demandMultiplier": 1, "fuelMultiplier": 1}'::jsonb),
            ('hybrid_negotiation', '{"enabled": false, "enabledServices": ["shop", "errand"], "allowlist": [], "makeOfferEnabled": true, "acceptFareEnabled": true, "maxRounds": 3, "timeoutSeconds": 120, "claimTimeoutSeconds": 60, "maxDriverAttempts": 5, "rideMinimumDistanceKm": 30}'::jsonb),
            ('bidding', '{"enabled": false, "enabledServices": ["van", "van_moving"]}'::jsonb),
            ('smart_matching', '{"enabled": true, "maxDistanceKm": 10, "distanceWeight": 0.30, "ratingWeight": 0.25, "completionWeight": 0.35, "responseWeight": 0.10}'::jsonb)
        ) AS defaults(key, value)
    LOOP
        IF NOT EXISTS (
            SELECT 1
            FROM public.marketplace_settings
            WHERE tenant_id IS NULL
              AND key = v_key
        ) THEN
            INSERT INTO public.marketplace_settings (tenant_id, key, value)
            VALUES (NULL, v_key, v_value);
        END IF;
    END LOOP;
END $$;

-- Repair incomplete Pro subscription copy without overwriting admin-customized plans.
DO $$
BEGIN
    IF to_regclass('public.subscription_plans') IS NULL THEN
        RETURN;
    END IF;

    IF EXISTS (
        SELECT 1
        FROM information_schema.columns
        WHERE table_schema = 'public'
          AND table_name = 'subscription_plans'
          AND column_name = 'description'
    ) THEN
        UPDATE public.subscription_plans
        SET description = 'For active drivers who want priority access to suitable requests, zero platform commission on completed fares, and premium support.',
            updated_at = NOW()
        WHERE LOWER(COALESCE(plan_code, '')) LIKE '%pro%'
          AND COALESCE(BTRIM(description), '') = '';
    END IF;

    IF EXISTS (
        SELECT 1
        FROM information_schema.columns
        WHERE table_schema = 'public'
          AND table_name = 'subscription_plans'
          AND column_name = 'features'
    ) THEN
        UPDATE public.subscription_plans
        SET features = '["Priority matching for suitable nearby requests", "Keep 100% of completed fares with 0% platform commission", "Access to Pro driver opportunities", "Enhanced earnings and performance insights", "Premium driver support"]'::jsonb,
            updated_at = NOW()
        WHERE LOWER(COALESCE(plan_code, '')) LIKE '%pro%'
          AND (
              features IS NULL
              OR features = '[]'::jsonb
              OR features @> '["Basic job matching"]'::jsonb
              OR features @> '["5% Platform fee"]'::jsonb
          );
    END IF;
END $$;

NOTIFY pgrst, 'reload schema';
