-- Create pricing_config table
CREATE TABLE IF NOT EXISTS pricing_config (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    service_type text NOT NULL UNIQUE,
    base_fare numeric(10,2) NOT NULL,
    per_km numeric(10,2) NOT NULL,
    per_min numeric(10,2) NOT NULL,
    service_fee numeric(10,2) NOT NULL,
    minimum_fare numeric(10,2) NOT NULL,
    currency_code text NOT NULL DEFAULT 'GBP',
    is_active boolean NOT NULL DEFAULT true,
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now(),
    CONSTRAINT service_type_check CHECK (service_type IN ('ride', 'errand', 'van-moving'))
);

-- Enable RLS
ALTER TABLE pricing_config ENABLE ROW LEVEL SECURITY;

-- Create policy to allow public read access (or authenticated if preferred, but usually pricing is public)
CREATE POLICY "Allow public read access" ON pricing_config
    FOR SELECT USING (is_active = true);

-- Seed default values
INSERT INTO pricing_config (service_type, base_fare, per_km, per_min, service_fee, minimum_fare)
VALUES 
    ('ride', 3.50, 1.20, 0.18, 1.00, 6.00),
    ('errand', 5.00, 0.90, 0.28, 1.50, 8.00),
    ('van-moving', 18.00, 1.80, 0.35, 3.50, 25.00)
ON CONFLICT (service_type) DO UPDATE SET
    base_fare = EXCLUDED.base_fare,
    per_km = EXCLUDED.per_km,
    per_min = EXCLUDED.per_min,
    service_fee = EXCLUDED.service_fee,
    minimum_fare = EXCLUDED.minimum_fare,
    updated_at = now();
