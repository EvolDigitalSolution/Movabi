-- Driver settlement authority — single per-job settlement path.
--
-- Adds the timestamp that records when an earnings row was actually settled
-- (the per-job transfer succeeded). Settlement is server-authoritative; the
-- retired hardcoded-10% `calculate_job_payouts` trigger/function (dropped in
-- 20261204000000_release_final_hardening.sql) is deliberately NOT re-introduced.
--
-- Forward-only. No historical migration is edited. Defensive IF NOT EXISTS.

ALTER TABLE public.driver_earnings ADD COLUMN IF NOT EXISTS settled_at timestamptz;
