-- ============================================================================
-- MAJOR-MONEY STORAGE PRECISION (additive)
-- numeric(12,2) rounds three-decimal currencies (KWD=3) before
-- funding_amount_to_minor can convert them, so 6.666 KWD became 6.67 -> 6670
-- instead of 6666. Widening the quote -> negotiation -> bid -> job path to
-- numeric(18,4) preserves every existing value and constraint. Triggers that
-- list a widened column in UPDATE OF are dropped and recreated verbatim.
-- Reporting/benchmark/wallet tables are intentionally left unchanged: they are
-- not on the funding path and several are consumed by views.
-- ============================================================================
ALTER TABLE public.marketplace_negotiation_sessions
  ALTER COLUMN suggested_fare TYPE numeric(18,4),
  ALTER COLUMN customer_offer TYPE numeric(18,4),
  ALTER COLUMN driver_counter_offer TYPE numeric(18,4),
  ALTER COLUMN agreed_fare TYPE numeric(18,4);

DROP TRIGGER IF EXISTS a_sync_agreed_fare_snapshot ON public.jobs;
DROP TRIGGER IF EXISTS guard_booking_payment_margin ON public.jobs;
DROP TRIGGER IF EXISTS zz_finalize_agreed_fare_aliases ON public.jobs;
ALTER TABLE public.jobs
  ALTER COLUMN negotiated_fare TYPE numeric(18,4),
  ALTER COLUMN agreed_fare TYPE numeric(18,4);
CREATE TRIGGER a_sync_agreed_fare_snapshot BEFORE UPDATE OF agreed_fare ON public.jobs FOR EACH ROW EXECUTE FUNCTION public.sync_agreed_fare_snapshot();
CREATE TRIGGER guard_booking_payment_margin BEFORE UPDATE OF agreed_fare, fare_breakdown ON public.jobs FOR EACH ROW EXECUTE FUNCTION public.guard_booking_payment_margin();
CREATE TRIGGER zz_finalize_agreed_fare_aliases BEFORE UPDATE OF agreed_fare, fare_breakdown, driver_id ON public.jobs FOR EACH ROW EXECUTE FUNCTION public.finalize_agreed_fare_aliases();

ALTER TABLE public.driver_bids
  ALTER COLUMN bid_amount TYPE numeric(18,4);

ALTER TABLE public.fare_negotiations
  ALTER COLUMN amount TYPE numeric(18,4);

ALTER TABLE public.quote_market_adjustments
  ALTER COLUMN base_service_fare TYPE numeric(18,4),
  ALTER COLUMN market_reference_fare TYPE numeric(18,4),
  ALTER COLUMN requested_target_fare TYPE numeric(18,4),
  ALTER COLUMN driver_protection_floor TYPE numeric(18,4),
  ALTER COLUMN platform_margin_floor TYPE numeric(18,4),
  ALTER COLUMN applied_market_adjustment TYPE numeric(18,4),
  ALTER COLUMN adjusted_service_fare TYPE numeric(18,4),
  ALTER COLUMN platform_fee_amount TYPE numeric(18,4),
  ALTER COLUMN customer_total TYPE numeric(18,4),
  ALTER COLUMN driver_commission_amount TYPE numeric(18,4),
  ALTER COLUMN driver_payout TYPE numeric(18,4),
  ALTER COLUMN original_service_fare TYPE numeric(18,4),
  ALTER COLUMN original_customer_total TYPE numeric(18,4),
  ALTER COLUMN minimum_sustainable_fare TYPE numeric(18,4),
  ALTER COLUMN suggested_final_fare TYPE numeric(18,4),
  ALTER COLUMN returned_customer_fare TYPE numeric(18,4),
  ALTER COLUMN platform_revenue TYPE numeric(18,4);
