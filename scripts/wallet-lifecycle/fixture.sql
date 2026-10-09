CREATE ROLE anon; CREATE ROLE authenticated; CREATE ROLE service_role; CREATE ROLE authenticator NOINHERIT;
GRANT anon,authenticated,service_role TO authenticator;
CREATE SCHEMA auth;
CREATE FUNCTION auth.uid() RETURNS uuid LANGUAGE sql AS $$ SELECT nullif(current_setting('test.user',true),'')::uuid $$;
CREATE FUNCTION auth.role() RETURNS text LANGUAGE sql AS $$ SELECT current_setting('test.role',true) $$;
GRANT USAGE ON SCHEMA auth TO anon,authenticated,service_role;
GRANT EXECUTE ON ALL FUNCTIONS IN SCHEMA auth TO anon,authenticated,service_role;
CREATE TABLE service_types(id uuid PRIMARY KEY,slug text,name text);
CREATE TABLE jobs(id uuid PRIMARY KEY,customer_id uuid,tenant_id uuid,driver_id uuid,accepted_driver_id uuid,status text,payment_status text,payment_method text,payment_intent_id text,
 service_type_id uuid,agreed_fare numeric,total_price numeric,estimated_price numeric,price numeric,currency_code text,metadata jsonb DEFAULT '{}',fare_breakdown jsonb DEFAULT '{}',quote_id uuid,
 scheduled_time timestamptz,created_at timestamptz DEFAULT now(),updated_at timestamptz DEFAULT now(),confirmed_at timestamptz,dispatch_started_at timestamptz,driver_search_expires_at timestamptz,
 dispatch_attempts integer DEFAULT 0,no_driver_reason text,last_dispatch_check_at timestamptz);
CREATE TABLE wallets(id uuid PRIMARY KEY DEFAULT gen_random_uuid(),user_id uuid UNIQUE NOT NULL,available_balance numeric NOT NULL CHECK(available_balance>=0),reserved_balance numeric NOT NULL CHECK(reserved_balance>=0),currency_code text,updated_at timestamptz);
CREATE TABLE wallet_transactions(id uuid PRIMARY KEY DEFAULT gen_random_uuid(),wallet_id uuid NOT NULL REFERENCES wallets(id),user_id uuid NOT NULL,job_id uuid REFERENCES jobs(id),transaction_type text,amount numeric CHECK(amount>0),description text,metadata jsonb DEFAULT '{}',balance_before_available numeric,balance_after_available numeric,balance_before_reserved numeric,balance_after_reserved numeric,created_at timestamptz DEFAULT now());
CREATE TABLE errand_funding(id uuid PRIMARY KEY DEFAULT gen_random_uuid(),job_id uuid UNIQUE REFERENCES jobs(id),customer_id uuid,item_budget numeric DEFAULT 0,service_estimate numeric DEFAULT 0,amount_reserved numeric DEFAULT 0,actual_item_spend numeric DEFAULT 0,refund_amount numeric DEFAULT 0,status text DEFAULT 'pending',metadata jsonb DEFAULT '{}',updated_at timestamptz,over_budget_status text DEFAULT 'none',over_budget_amount numeric DEFAULT 0,requested_over_budget_amount numeric DEFAULT 0,over_budget_reason text);
CREATE TABLE errand_details(id uuid PRIMARY KEY DEFAULT gen_random_uuid(),job_id uuid UNIQUE REFERENCES jobs(id),estimated_budget numeric,actual_spending numeric DEFAULT 0);
CREATE TABLE marketplace_negotiation_sessions(id uuid DEFAULT gen_random_uuid(),job_id uuid,status text,agreed_fare numeric,payment_deadline timestamptz,expires_at timestamptz,active_driver_id uuid,created_at timestamptz DEFAULT now());
CREATE OR REPLACE FUNCTION public.finalize_job_payment(p_job_id uuid, p_payment_intent_id text, p_payment_status text, p_job_status text, p_expected_service_fare numeric DEFAULT NULL::numeric, p_require_unowned boolean DEFAULT false, p_dispatch_started_at timestamp with time zone DEFAULT NULL::timestamp with time zone, p_driver_search_expires_at timestamp with time zone DEFAULT NULL::timestamp with time zone, p_dispatch_attempts integer DEFAULT 0, p_intent_amount_minor bigint DEFAULT NULL::bigint, p_currency text DEFAULT NULL::text)
 RETURNS text
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_job public.jobs;
  v_session public.marketplace_negotiation_sessions;
  v_status TEXT;
  v_deadline TIMESTAMPTZ;
  v_item_budget NUMERIC;
  v_expected_minor NUMERIC;
BEGIN
  IF p_job_id IS NULL THEN
    RETURN 'job_not_found';
  END IF;

  -- DETERMINISTIC LOCK ORDER: job, then session. Every authority in this
  -- migration takes them in this order, so no deadlock is possible.
  SELECT * INTO v_job FROM public.jobs WHERE id = p_job_id FOR UPDATE;
  IF NOT FOUND THEN
    RETURN 'job_not_found';
  END IF;

  -- IDEMPOTENCY FIRST. A repeat of an already-successful finalization must be
  -- reported as such (NOT as a lost agreement) — otherwise a legitimate retry or
  -- duplicate webhook would be misread as a conflict and would wrongly enter the
  -- Stripe compensation path for an already-paid booking. Terminal/expired/
  -- cancelled agreements still have payment_status='pending', so they fall
  -- through to the agreement checks below.
  IF LOWER(COALESCE(v_job.payment_status, '')) <> 'pending' THEN
    RETURN 'already_finalized';
  END IF;

  SELECT * INTO v_session
  FROM public.marketplace_negotiation_sessions
  WHERE job_id = p_job_id
  ORDER BY created_at DESC NULLS LAST
  LIMIT 1
  FOR UPDATE;

  IF FOUND THEN
    -- NEGOTIATED: the fare agreement must STILL be authoritative. This is the
    -- check the old finalizers were missing.
    IF v_session.status IS DISTINCT FROM 'fare_agreed' THEN
      RETURN 'agreement_lost';
    END IF;

    -- The JOB must still be the live negotiated agreement — not released back to
    -- the pool, superseded, cancelled or expired.
    IF LOWER(COALESCE(v_job.status, '')) <> 'fare_agreed' THEN
      RETURN 'agreement_lost';
    END IF;

    IF v_session.agreed_fare IS NULL OR v_session.agreed_fare <= 0 THEN
      RETURN 'agreement_lost';
    END IF;

    IF v_job.agreed_fare IS NULL THEN
      RETURN 'agreement_lost';
    END IF;

    -- AUTHORITATIVE DEADLINE. Effective deadline = persisted payment_deadline,
    -- falling back to expires_at for agreements accepted BEFORE 360 started
    -- writing payment_deadline (310 set expires_at = now() + 300s). It must
    -- EXIST and must NOT have elapsed.
    v_deadline := COALESCE(v_session.payment_deadline, v_session.expires_at);
    IF v_deadline IS NULL THEN
      RETURN 'agreement_lost';
    END IF;
    IF v_deadline <= now() THEN
      RETURN 'agreement_expired';
    END IF;

    IF p_expected_service_fare IS NOT NULL
       AND ROUND(p_expected_service_fare, 2) IS DISTINCT FROM ROUND(v_session.agreed_fare, 2) THEN
      RETURN 'agreed_fare_mismatch';
    END IF;

    IF v_job.driver_id IS DISTINCT FROM v_session.active_driver_id THEN
      RETURN 'driver_mismatch';
    END IF;

    -- AUTHORITATIVE AMOUNT. For a negotiated job the customer charge is exactly
    -- agreed_fare + item budget. The item budget is READ from its persisted home
    -- (public.errand_funding is a TABLE, not a job column) using the same
    -- precedence the client uses; NO pricing/fee formula is duplicated here — this
    -- only proves the intent amount against the persisted authority, which is what
    -- stops a stale £9.06 quote from finalising a £9.00 agreement.
    IF p_intent_amount_minor IS NOT NULL THEN
      SELECT COALESCE(NULLIF(ef.amount_reserved, 0), NULLIF(ef.item_budget, 0), 0)
        INTO v_item_budget
        FROM public.errand_funding ef
       WHERE ef.job_id = p_job_id
       LIMIT 1;

      v_item_budget := COALESCE(v_item_budget, 0);
      v_expected_minor := ROUND((v_session.agreed_fare + v_item_budget) * 100);
      IF v_expected_minor IS DISTINCT FROM p_intent_amount_minor THEN
        RETURN 'amount_mismatch';
      END IF;
    END IF;
  ELSE
    -- NON-NEGOTIATED: preserve the pre-existing semantics exactly. The webhook
    -- only advances an UNPAID, UNOWNED job; /confirm may advance a locked-driver
    -- (assigned) job.
    IF p_require_unowned AND v_job.driver_id IS NOT NULL THEN
      RETURN 'driver_mismatch';
    END IF;
  END IF;

  -- CURRENCY: the money must be in the job's own currency.
  IF p_currency IS NOT NULL
     AND LOWER(p_currency) IS DISTINCT FROM LOWER(COALESCE(v_job.currency_code, 'gbp')) THEN
    RETURN 'currency_mismatch';
  END IF;

  v_status := LOWER(COALESCE(v_job.status, ''));
  IF v_status IN ('cancelled', 'canceled', 'expired', 'completed', 'settled') THEN
    RETURN 'job_terminal';
  END IF;

  IF p_payment_intent_id IS NOT NULL
     AND v_job.payment_intent_id IS NOT NULL
     AND v_job.payment_intent_id IS DISTINCT FROM p_payment_intent_id THEN
    RETURN 'intent_mismatch';
  END IF;

  UPDATE public.jobs
  SET payment_status = p_payment_status,
      status = p_job_status,
      dispatch_started_at = p_dispatch_started_at,
      driver_search_expires_at = p_driver_search_expires_at,
      dispatch_attempts = COALESCE(p_dispatch_attempts, 0),
      no_driver_reason = NULL,
      updated_at = now()
  WHERE id = p_job_id;

  RETURN 'finalized';
END;
$function$
