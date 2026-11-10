-- =============================================================================
-- Cancellation-fee compensation: canonical earnings destination + application
-- wiring (supersedes the wallet-ledger-only 640 RPC bodies).
--
-- The 640 increment proved the accounting split; this increment finishes it:
--   1. Compensation lands in the canonical driver earnings table
--      (public.driver_earnings, settlement_purpose='cancellation_compensation'),
--      NOT a new wallet_accounts.balance_purpose that payout/reporting ignores.
--   2. The receivable freezes its driver + market + policy version at record
--      time. Settlement resolves ONLY that frozen version; a historical fee
--      with no policy version is routed to review, never silently re-priced by
--      today's active policy.
--   3. Collection and refund are cumulative and bounded by the charged fee and
--      the collected amount; the compensation target is recomputed from net
--      collected (collected - refunded) so partial collection/refund cannot
--      over- or under-compensate.
--   4. Every event is deduped by (provider, provider_reference), so concurrent
--      or replayed webhooks converge to one accounting outcome; refunds carry a
--      linked_event_id back to the collection they adjust.
--
-- Forward-only. Defensive IF NOT EXISTS / CREATE OR REPLACE.
-- =============================================================================
BEGIN;

DO $$
BEGIN
  IF to_regclass('public.customer_receivables') IS NULL
     OR to_regclass('public.cancellation_policies') IS NULL
     OR to_regclass('public.driver_earnings') IS NULL
     OR to_regclass('public.jobs') IS NULL THEN
    RAISE EXCEPTION 'Cancellation compensation prerequisites missing (customer_receivables, cancellation_policies, driver_earnings, jobs)';
  END IF;
END $$;

-- ---------------------------------------------------------------------------
-- Receivable freeze + cumulative collection/refund state.
-- ---------------------------------------------------------------------------
ALTER TABLE public.customer_receivables
  ADD COLUMN IF NOT EXISTS driver_id uuid,
  ADD COLUMN IF NOT EXISTS market_code text,
  ADD COLUMN IF NOT EXISTS review_required boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS collected_minor bigint NOT NULL DEFAULT 0 CHECK (collected_minor >= 0),
  ADD COLUMN IF NOT EXISTS refunded_minor bigint NOT NULL DEFAULT 0 CHECK (refunded_minor >= 0),
  ADD COLUMN IF NOT EXISTS compensation_minor bigint NOT NULL DEFAULT 0 CHECK (compensation_minor >= 0),
  ADD COLUMN IF NOT EXISTS platform_share_minor bigint NOT NULL DEFAULT 0 CHECK (platform_share_minor >= 0);

-- Immutable compensation event log: replay dedup + linked reversal.
CREATE TABLE IF NOT EXISTS public.cancellation_compensation_events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  receivable_id uuid NOT NULL REFERENCES public.customer_receivables(id),
  kind text NOT NULL CHECK (kind IN ('collection','refund')),
  amount_minor bigint NOT NULL CHECK (amount_minor > 0),
  provider text,
  provider_reference text,
  linked_event_id uuid REFERENCES public.cancellation_compensation_events(id),
  compensation_delta_minor bigint NOT NULL DEFAULT 0,
  platform_delta_minor bigint NOT NULL DEFAULT 0,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS cancellation_compensation_events_dedupe
  ON public.cancellation_compensation_events (coalesce(provider,''), provider_reference)
  WHERE provider_reference IS NOT NULL;
ALTER TABLE public.cancellation_compensation_events ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.cancellation_compensation_events FROM PUBLIC, anon, authenticated;
GRANT SELECT, INSERT ON public.cancellation_compensation_events TO service_role;

-- ---------------------------------------------------------------------------
-- record_customer_receivable: freeze driver + market from the (terminal) job
-- at record time, so settlement never re-reads a mutable booking.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.record_customer_receivable(
  p_tenant uuid, p_customer uuid, p_job uuid, p_currency text,
  p_amount bigint, p_reason text, p_policy_version int default null)
RETURNS customer_receivables LANGUAGE plpgsql security definer set search_path=public AS $$
DECLARE v customer_receivables; v_driver uuid; v_market text;
BEGIN
  select * into v from customer_receivables
   where job_id=p_job and customer_id=p_customer and reason=p_reason and status in ('open','disputed','paid')
   order by created_at desc limit 1;
  if found then return v; end if;
  select coalesce(driver_id, accepted_driver_id), country_code into v_driver, v_market
    from jobs where id = p_job;
  insert into customer_receivables(tenant_id,customer_id,job_id,currency_code,amount_minor,reason,policy_version,driver_id,market_code)
    values(p_tenant,p_customer,p_job,p_currency,p_amount,p_reason,p_policy_version,v_driver,v_market) returning * into v;
  return v;
END $$;
REVOKE ALL ON FUNCTION public.record_customer_receivable(uuid,uuid,uuid,text,bigint,text,int) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.record_customer_receivable(uuid,uuid,uuid,text,bigint,text,int) TO service_role;

-- ---------------------------------------------------------------------------
-- Resolve the FROZEN policy for a receivable. Returns NULL when the version is
-- missing or no longer resolvable — callers route that ambiguity to review.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.cancellation_compensation_policy(p_receivable uuid)
RETURNS SETOF cancellation_policies LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=public AS $$
DECLARE r customer_receivables%ROWTYPE;
BEGIN
  SELECT * INTO r FROM customer_receivables WHERE id = p_receivable;
  IF NOT FOUND OR r.policy_version IS NULL OR r.market_code IS NULL THEN RETURN; END IF;
  RETURN QUERY SELECT * FROM cancellation_policies
   WHERE tenant_id = r.tenant_id AND market_code = r.market_code AND version = r.policy_version;
END $$;
REVOKE ALL ON FUNCTION public.cancellation_compensation_policy(uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.cancellation_compensation_policy(uuid) TO service_role;

-- ---------------------------------------------------------------------------
-- Settlement authority: confirmed fee collection -> driver compensation +
-- platform share in canonical driver_earnings. on_collection only.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.settle_cancellation_compensation(
  p_receivable uuid,
  p_collected_minor bigint,
  p_payment_reference text,
  p_provider text DEFAULT NULL,
  p_merchant_account_ref text DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_catalog
AS $$
DECLARE
  r customer_receivables%ROWTYPE;
  pol cancellation_policies%ROWTYPE;
  v_event_id uuid;
  v_net bigint; v_comp bigint; v_platform bigint; v_delta_comp bigint; v_delta_platform bigint;
  v_comp_major numeric; v_platform_major numeric; v_gross_major numeric;
BEGIN
  IF p_receivable IS NULL THEN RAISE EXCEPTION 'Receivable required' USING ERRCODE='CC001'; END IF;
  IF p_collected_minor IS NULL OR p_collected_minor <= 0 THEN RAISE EXCEPTION 'Collected amount must be positive' USING ERRCODE='CC001'; END IF;

  SELECT * INTO r FROM customer_receivables WHERE id = p_receivable FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Receivable not found' USING ERRCODE='CC002'; END IF;

  -- Replay: the same provider reference must converge to one outcome.
  IF p_provider IS NOT NULL AND p_payment_reference IS NOT NULL THEN
    SELECT id INTO v_event_id FROM cancellation_compensation_events
     WHERE provider = p_provider AND provider_reference = p_payment_reference;
    IF FOUND THEN RETURN jsonb_build_object('status','already_settled','event_id',v_event_id); END IF;
  END IF;

  -- Frozen policy only. A missing/irresolvable version is routed to review —
  -- the fee is still recorded as collected, but no compensation is computed.
  SELECT * INTO pol FROM public.cancellation_compensation_policy(p_receivable);
  IF NOT FOUND OR pol.compensation_funding IS DISTINCT FROM 'on_collection'
     OR r.driver_id IS NULL OR r.job_id IS NULL THEN
    UPDATE customer_receivables
       SET status='paid', review_required=true, resolved_at=now(),
           collected_minor = collected_minor + p_collected_minor,
           payment_reference = COALESCE(p_payment_reference, payment_reference),
           payment_provider = COALESCE(p_provider, payment_provider),
           merchant_account_ref = COALESCE(p_merchant_account_ref, merchant_account_ref)
     WHERE id = p_receivable;
    INSERT INTO cancellation_compensation_events(receivable_id,kind,amount_minor,provider,provider_reference)
      VALUES(p_receivable,'collection',p_collected_minor,p_provider,p_payment_reference)
      ON CONFLICT DO NOTHING;
    RETURN jsonb_build_object('status','review_required','collected_minor',p_collected_minor,
      'driver_compensation_minor',0,'platform_share_minor',0);
  END IF;

  -- Cumulative bounds: never collect more than the charged fee.
  IF r.collected_minor + p_collected_minor > r.amount_minor THEN
    RAISE EXCEPTION 'Collected amount exceeds the charged fee' USING ERRCODE='CC004';
  END IF;

  v_net := r.collected_minor + p_collected_minor - r.refunded_minor;
  v_comp := floor(v_net::numeric * pol.driver_compensation_percent / 100)::bigint;
  v_platform := v_net - v_comp;
  v_delta_comp := v_comp - r.compensation_minor;
  v_delta_platform := v_platform - r.platform_share_minor;

  v_comp_major := v_comp / 100.0;
  v_platform_major := v_platform / 100.0;
  v_gross_major := v_net / 100.0;

  INSERT INTO public.driver_earnings
    (driver_id, job_id, amount, platform_fee, gross_amount, status, currency_code, country_code, settlement_purpose, settled_at)
  VALUES
    (r.driver_id, r.job_id, v_comp_major, v_platform_major, v_gross_major, 'pending',
     r.currency_code, coalesce(r.market_code, 'GB'), 'cancellation_compensation', now())
  ON CONFLICT (job_id) DO UPDATE SET
    amount = EXCLUDED.amount,
    platform_fee = EXCLUDED.platform_fee,
    gross_amount = EXCLUDED.gross_amount,
    status = 'pending',
    currency_code = EXCLUDED.currency_code,
    country_code = EXCLUDED.country_code,
    settlement_purpose = 'cancellation_compensation',
    settled_at = COALESCE(driver_earnings.settled_at, now())
  WHERE driver_earnings.settlement_purpose = 'cancellation_compensation';
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Existing earnings for this job have a different purpose; reconciliation required' USING ERRCODE='CC005';
  END IF;

  INSERT INTO cancellation_compensation_events
    (receivable_id,kind,amount_minor,provider,provider_reference,compensation_delta_minor,platform_delta_minor)
  VALUES
    (p_receivable,'collection',p_collected_minor,p_provider,p_payment_reference,v_delta_comp,v_delta_platform)
  RETURNING id INTO v_event_id;

  UPDATE customer_receivables
     SET status='paid', review_required=false, resolved_at=now(),
         collected_minor = r.collected_minor + p_collected_minor,
         compensation_minor = v_comp,
         platform_share_minor = v_platform,
         payment_reference = COALESCE(p_payment_reference, payment_reference),
         payment_provider = COALESCE(p_provider, payment_provider),
         merchant_account_ref = COALESCE(p_merchant_account_ref, merchant_account_ref)
   WHERE id = p_receivable;

  RETURN jsonb_build_object(
    'status','settled','event_id',v_event_id,
    'collected_minor', p_collected_minor,
    'driver_compensation_minor', v_comp,
    'platform_share_minor', v_platform,
    'policy_version', pol.version);
END;
$$;

-- ---------------------------------------------------------------------------
-- Reversal authority: confirmed refund reduces the collected total and
-- recomputes compensation downward, with a linked adjustment back to the
-- collection event. Cumulative and bounded; never refunds more than collected.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.reverse_cancellation_compensation(
  p_receivable uuid,
  p_refund_minor bigint,
  p_refund_reference text,
  p_provider text DEFAULT NULL,
  p_merchant_account_ref text DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_catalog
AS $$
DECLARE
  r customer_receivables%ROWTYPE;
  pol cancellation_policies%ROWTYPE;
  v_event_id uuid; v_linked uuid;
  v_net bigint; v_comp bigint; v_platform bigint; v_delta_comp bigint; v_delta_platform bigint;
  v_comp_major numeric; v_platform_major numeric; v_gross_major numeric;
BEGIN
  IF p_receivable IS NULL THEN RAISE EXCEPTION 'Receivable required' USING ERRCODE='CC001'; END IF;
  IF p_refund_minor IS NULL OR p_refund_minor <= 0 THEN RAISE EXCEPTION 'Refund amount must be positive' USING ERRCODE='CC001'; END IF;

  SELECT * INTO r FROM customer_receivables WHERE id = p_receivable FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Receivable not found' USING ERRCODE='CC002'; END IF;

  IF p_provider IS NOT NULL AND p_refund_reference IS NOT NULL THEN
    SELECT id INTO v_event_id FROM cancellation_compensation_events
     WHERE provider = p_provider AND provider_reference = p_refund_reference;
    IF FOUND THEN RETURN jsonb_build_object('status','already_reversed','event_id',v_event_id); END IF;
  END IF;

  -- Never refund more than was collected.
  IF r.refunded_minor + p_refund_minor > r.collected_minor THEN
    RAISE EXCEPTION 'Refund exceeds the collected amount' USING ERRCODE='CC006';
  END IF;

  SELECT * INTO pol FROM public.cancellation_compensation_policy(p_receivable);
  IF NOT FOUND OR pol.compensation_funding IS DISTINCT FROM 'on_collection' THEN
    UPDATE customer_receivables SET review_required=true WHERE id = p_receivable;
    RETURN jsonb_build_object('status','review_required');
  END IF;

  v_net := r.collected_minor - (r.refunded_minor + p_refund_minor);
  v_comp := floor(v_net::numeric * pol.driver_compensation_percent / 100)::bigint;
  v_platform := v_net - v_comp;
  v_delta_comp := v_comp - r.compensation_minor;
  v_delta_platform := v_platform - r.platform_share_minor;

  v_comp_major := v_comp / 100.0;
  v_platform_major := v_platform / 100.0;
  v_gross_major := v_net / 100.0;

  IF r.job_id IS NOT NULL AND r.driver_id IS NOT NULL THEN
    INSERT INTO public.driver_earnings
      (driver_id, job_id, amount, platform_fee, gross_amount, status, currency_code, country_code, settlement_purpose, settled_at)
    VALUES
      (r.driver_id, r.job_id, v_comp_major, v_platform_major, v_gross_major, 'pending',
       r.currency_code, coalesce(r.market_code, 'GB'), 'cancellation_compensation', now())
    ON CONFLICT (job_id) DO UPDATE SET
      amount = EXCLUDED.amount,
      platform_fee = EXCLUDED.platform_fee,
      gross_amount = EXCLUDED.gross_amount,
      status = 'pending',
      settlement_purpose = 'cancellation_compensation',
      settled_at = COALESCE(driver_earnings.settled_at, now())
    WHERE driver_earnings.settlement_purpose = 'cancellation_compensation';
    IF NOT FOUND THEN
      RAISE EXCEPTION 'Existing earnings for this job have a different purpose; reconciliation required' USING ERRCODE='CC005';
    END IF;
  END IF;

  SELECT id INTO v_linked FROM cancellation_compensation_events
   WHERE receivable_id = p_receivable AND kind = 'collection'
   ORDER BY created_at DESC, id DESC LIMIT 1;

  INSERT INTO cancellation_compensation_events
    (receivable_id,kind,amount_minor,provider,provider_reference,linked_event_id,compensation_delta_minor,platform_delta_minor)
  VALUES
    (p_receivable,'refund',p_refund_minor,p_provider,p_refund_reference,v_linked,v_delta_comp,v_delta_platform)
  RETURNING id INTO v_event_id;

  UPDATE customer_receivables
     SET refunded_minor = r.refunded_minor + p_refund_minor,
         compensation_minor = v_comp,
         platform_share_minor = v_platform,
         review_required = false,
         resolved_at = now()
   WHERE id = p_receivable;

  RETURN jsonb_build_object(
    'status','reversed','event_id',v_event_id,
    'driver_compensation_minor', v_comp,
    'platform_share_minor', v_platform);
END;
$$;

-- Drop the wallet-ledger-only 640 overloads; this migration is the authority.
DROP FUNCTION IF EXISTS public.settle_cancellation_compensation(uuid,uuid,bigint,text,text,text,text);
DROP FUNCTION IF EXISTS public.reverse_cancellation_compensation(uuid);

REVOKE ALL ON FUNCTION public.settle_cancellation_compensation(uuid,bigint,text,text,text)
  FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.reverse_cancellation_compensation(uuid,bigint,text,text,text)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.settle_cancellation_compensation(uuid,bigint,text,text,text) TO service_role;
GRANT EXECUTE ON FUNCTION public.reverse_cancellation_compensation(uuid,bigint,text,text,text) TO service_role;

COMMIT;
