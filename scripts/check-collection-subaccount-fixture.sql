-- Synthetic prerequisite columns already used by existing production booking routes/migrations.
ALTER TABLE public.jobs ADD COLUMN customer_id uuid,ADD COLUMN payment_intent_id text,
 ADD COLUMN total_refunded_minor bigint NOT NULL DEFAULT 0,ADD COLUMN no_show_status text;
