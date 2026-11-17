-- Driver earnings wallet settlement mode (develop/NG sandbox scope).
--
-- Agreed product: automatic bank transfer and wallet withdrawal are
-- ALTERNATIVE settlement modes. Double payment is prevented by freezing one
-- mode per entitlement (job_settlement_methods + frozen queue terms), not by
-- making wallet withdrawal impossible. Wallet-mode earnings post once to the
-- shared double-entry ledger (earnings_payable); a withdrawal reserves funds
-- into earnings_payable_held before any provider contact and only settles or
-- reverses on a verified provider outcome. Uncertain payouts stay held in
-- 'reconcile' — never double-paid, never silently re-spendable.
--
-- GB Stripe payouts are untouched: non-NG jobs keep method 'transfer'.
BEGIN;
DO $$ BEGIN
 IF current_database()<>'movabi_develop' THEN RAISE EXCEPTION 'Develop database required'; END IF;
 IF to_regclass('public.job_settlement_methods') IS NULL OR to_regclass('public.driver_payment_accounts') IS NULL
  OR to_regclass('public.wallet_movements') IS NULL OR to_regclass('public.flutterwave_job_submissions') IS NULL
 THEN RAISE EXCEPTION 'Wallet settlement requires the payout outbox, settlement methods and shared ledger'; END IF;
END $$;

-- ---------------------------------------------------------------------------
-- 1. 'wallet' becomes a third frozen settlement method per job.
-- ---------------------------------------------------------------------------
ALTER TABLE public.job_settlement_methods DROP CONSTRAINT IF EXISTS job_settlement_methods_method_check;
ALTER TABLE public.job_settlement_methods ADD CONSTRAINT job_settlement_methods_method_check CHECK(method IN('transfer','split','wallet'));

-- Queue insertion freezes the settlement method that owns the entitlement.
-- NG allows 'transfer' (provider outbox) or 'wallet' (earnings ledger); the
-- queue terms must carry the matching settlement_mode, and a different
-- existing method refuses the insert.
CREATE OR REPLACE FUNCTION public.guard_job_transfer_method() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE m text;chosen text; BEGIN
 PERFORM 1 FROM public.jobs WHERE id=NEW.job_id FOR UPDATE;
 SELECT j.metadata->>'driver_settlement_method' INTO m FROM public.jobs j WHERE j.id=NEW.job_id;
 IF EXISTS(SELECT 1 FROM public.jobs WHERE id=NEW.job_id AND country_code='NG' AND m IS DISTINCT FROM 'transfer' AND m IS DISTINCT FROM 'wallet')
 THEN RAISE EXCEPTION 'An explicit settlement method is required for a new NG payout';END IF;
 chosen:=CASE WHEN m='wallet' THEN 'wallet' ELSE 'transfer' END;
 IF chosen='wallet' THEN
  IF NOT EXISTS(SELECT 1 FROM public.jobs WHERE id=NEW.job_id AND country_code='NG') THEN RAISE EXCEPTION 'Wallet settlement is only defined for NG payouts';END IF;
  IF (NEW.terms->>'settlement_mode') IS DISTINCT FROM 'wallet' THEN RAISE EXCEPTION 'Wallet settlement requires frozen wallet terms';END IF;
 END IF;
 IF chosen='transfer' AND (NEW.terms->>'settlement_mode')='wallet' THEN RAISE EXCEPTION 'Transfer settlement cannot carry wallet terms';END IF;
 INSERT INTO public.job_settlement_methods(job_id,method,terms) VALUES(NEW.job_id,chosen,NEW.terms) ON CONFLICT(job_id) DO NOTHING;
 IF NOT EXISTS(SELECT 1 FROM public.job_settlement_methods WHERE job_id=NEW.job_id AND method=chosen)
 THEN RAISE EXCEPTION 'Another settlement method owns these earnings';END IF;RETURN NEW;
END $$;

-- ---------------------------------------------------------------------------
-- 2. Mutual exclusion on every finish/submit path. A wallet-mode entitlement
--    can never be submitted to or finished by a provider transfer, and a
--    transfer-mode entitlement can never be credited to the wallet.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.claim_flutterwave_job_submission(p_job uuid,p_token uuid,p_reference text)
RETURNS boolean LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE q public.job_payout_queue%ROWTYPE;BEGIN
 PERFORM 1 FROM public.jobs WHERE id=p_job AND status='completed' AND payment_status='paid' FOR UPDATE;
 IF NOT FOUND THEN RETURN false; END IF;
 SELECT * INTO STRICT q FROM public.job_payout_queue WHERE job_id=p_job FOR UPDATE;
 IF q.token IS DISTINCT FROM p_token OR q.status NOT IN('processing','reconcile') OR (q.terms->>'payout_provider') IS DISTINCT FROM 'flutterwave'
  OR (q.terms->>'settlement_mode')='wallet' OR p_reference IS DISTINCT FROM 'vaydu-'||p_job::text||'_PMCK' THEN RETURN false; END IF;
 INSERT INTO public.flutterwave_job_submissions(job_id,reference) VALUES(p_job,p_reference) ON CONFLICT(job_id) DO NOTHING;
 RETURN FOUND;
END $$;

CREATE OR REPLACE FUNCTION public.finish_queued_job_payout(p_job_id uuid,p_token uuid,p_transfer_id text)
RETURNS boolean LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE q public.job_payout_queue%ROWTYPE; j public.jobs%ROWTYPE;
  v_reimb_minor bigint; v_done_minor bigint;
BEGIN
 SELECT * INTO STRICT j FROM public.jobs WHERE id=p_job_id FOR UPDATE;
 SELECT * INTO STRICT q FROM public.job_payout_queue WHERE job_id=p_job_id FOR UPDATE;
 IF q.status='paid' THEN RETURN q.transfer_id=p_transfer_id; END IF;
 IF q.token IS DISTINCT FROM p_token OR q.status NOT IN ('processing','reconcile') OR (q.terms->>'settlement_mode')='wallet' THEN RETURN false; END IF;
 IF p_transfer_id IS NULL OR p_transfer_id NOT LIKE 'tr_%' THEN RAISE EXCEPTION 'Genuine transfer ID required'; END IF;
 PERFORM public.record_job_settlement(p_job_id,q.driver_id,(q.terms->>'total')::numeric,(q.terms->>'payout')::numeric,
   (q.terms->>'platformFee')::numeric,(q.terms->>'commission')::numeric,(q.terms->>'commissionRate')::numeric,
   p_transfer_id,upper(q.currency),q.terms->>'country',true);
 v_reimb_minor := coalesce((q.terms->>'reimbursementMinor')::bigint,0);
 IF v_reimb_minor>0 THEN
  WITH upd AS (
   UPDATE public.errand_purchase_payments
     SET status='reimbursed',reimbursement_transfer_id=p_transfer_id,updated_at=now()
   WHERE job_id=p_job_id AND payer='driver' AND status='recorded'
   RETURNING amount_minor)
  SELECT coalesce(sum(amount_minor),0) INTO v_done_minor FROM upd;
  IF v_done_minor<>v_reimb_minor THEN RAISE EXCEPTION 'Purchase reimbursement requires reconciliation'; END IF;
 END IF;
 UPDATE public.jobs SET metadata=coalesce(metadata,'{}'::jsonb)||jsonb_build_object('driver_payout_pending',false) WHERE id=p_job_id;
 UPDATE public.job_payout_queue SET status='paid',transfer_id=p_transfer_id,lease_until=NULL,last_error=NULL,updated_at=now() WHERE job_id=p_job_id;
 RETURN true;
END $$;

CREATE OR REPLACE FUNCTION public.finish_flutterwave_job_payout(p_job uuid,p_token uuid,p_reference text,p_transfer text,p_fee numeric)
RETURNS boolean LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE q public.job_payout_queue%ROWTYPE; v_reimb_minor bigint; v_done_minor bigint; BEGIN
 PERFORM 1 FROM public.jobs WHERE id=p_job FOR UPDATE;
 SELECT * INTO STRICT q FROM public.job_payout_queue WHERE job_id=p_job FOR UPDATE;
 IF q.status='paid' THEN RETURN q.transfer_id='flw:'||p_transfer; END IF;
 IF q.token IS DISTINCT FROM p_token OR q.status NOT IN('processing','reconcile') OR (q.terms->>'payout_provider') IS DISTINCT FROM 'flutterwave'
  OR (q.terms->>'settlement_mode')='wallet'
  OR p_transfer IS NULL OR p_transfer !~ '^\d+$' OR p_reference IS DISTINCT FROM 'vaydu-'||p_job::text||'_PMCK'
  OR NOT EXISTS(SELECT 1 FROM public.flutterwave_job_submissions WHERE job_id=p_job AND reference=p_reference)
 THEN RETURN false; END IF;
 -- Reuse the established settlement writer and single earnings row. Provider
 -- references occupy separate columns; never disguise a Flutterwave ID as Stripe.
 PERFORM public.record_job_settlement(p_job,q.driver_id,(q.terms->>'total')::numeric,(q.terms->>'payout')::numeric,
  (q.terms->>'platformFee')::numeric,(q.terms->>'commission')::numeric,(q.terms->>'commissionRate')::numeric,
  NULL,upper(q.currency),q.terms->>'country',true);
 v_reimb_minor := coalesce((q.terms->>'reimbursementMinor')::bigint,0);
 IF v_reimb_minor>0 THEN
  WITH upd AS (
   UPDATE public.errand_purchase_payments
     SET status='reimbursed',reimbursement_transfer_id='flw:'||p_transfer,updated_at=now()
   WHERE job_id=p_job AND payer='driver' AND status='recorded'
   RETURNING amount_minor)
  SELECT coalesce(sum(amount_minor),0) INTO v_done_minor FROM upd;
  IF v_done_minor<>v_reimb_minor THEN RAISE EXCEPTION 'Purchase reimbursement requires reconciliation'; END IF;
 END IF;
 UPDATE public.jobs SET payout_provider='flutterwave',payout_transfer_id=p_transfer,stripe_transfer_status=NULL,
  metadata=coalesce(metadata,'{}'::jsonb)||jsonb_build_object('driver_payout_pending',false) WHERE id=p_job;
 UPDATE public.driver_earnings SET payout_provider='flutterwave',payout_transfer_id=p_transfer WHERE job_id=p_job;
 UPDATE public.flutterwave_job_submissions SET provider_transfer_id=p_transfer,provider_fee=p_fee WHERE job_id=p_job;
 UPDATE public.job_payout_queue SET status='paid',transfer_id='flw:'||p_transfer,lease_until=NULL,last_error=NULL,updated_at=now() WHERE job_id=p_job;
 RETURN true;
END $$;

-- ---------------------------------------------------------------------------
-- 3. Wallet finish: credits earnings_payable once via the shared ledger and
--    marks driver-paid purchases reimbursed with the wallet reference.
-- ---------------------------------------------------------------------------
CREATE FUNCTION public.finish_wallet_job_payout(p_job uuid,p_token uuid)
RETURNS boolean LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE q public.job_payout_queue%ROWTYPE; j public.jobs%ROWTYPE;
  v_reimb_minor bigint; v_done_minor bigint; v_event uuid;
BEGIN
 SELECT * INTO STRICT j FROM public.jobs WHERE id=p_job FOR UPDATE;
 SELECT * INTO STRICT q FROM public.job_payout_queue WHERE job_id=p_job FOR UPDATE;
 IF q.status='paid' THEN RETURN q.transfer_id='wallet:'||p_job::text; END IF;
 IF q.token IS DISTINCT FROM p_token OR q.status NOT IN('processing','reconcile')
  OR (q.terms->>'payout_provider') IS DISTINCT FROM 'flutterwave'
  OR (q.terms->>'settlement_mode') IS DISTINCT FROM 'wallet'
  OR NOT EXISTS(SELECT 1 FROM public.job_settlement_methods WHERE job_id=p_job AND method='wallet')
  OR EXISTS(SELECT 1 FROM public.flutterwave_job_submissions WHERE job_id=p_job)
 THEN RETURN false; END IF;
 PERFORM public.record_job_settlement(p_job,q.driver_id,(q.terms->>'total')::numeric,(q.terms->>'payout')::numeric,
  (q.terms->>'platformFee')::numeric,(q.terms->>'commission')::numeric,(q.terms->>'commissionRate')::numeric,
  NULL,upper(q.currency),q.terms->>'country',true);
 -- Idempotent on the job key: a replay returns the same event, never a second credit.
 v_event:=public.post_wallet_event('driver-earnings:'||p_job::text,'driver_earnings_credit',j.tenant_id,q.driver_id,upper(q.currency),
  jsonb_build_array(jsonb_build_object('accountPurpose','earnings_clearing','amountMinor',-q.amount_minor),
                    jsonb_build_object('accountPurpose','earnings_payable','amountMinor',q.amount_minor)));
 v_reimb_minor := coalesce((q.terms->>'reimbursementMinor')::bigint,0);
 IF v_reimb_minor>0 THEN
  WITH upd AS (
   UPDATE public.errand_purchase_payments
     SET status='reimbursed',reimbursement_transfer_id='wallet:'||p_job::text,updated_at=now()
   WHERE job_id=p_job AND payer='driver' AND status='recorded'
   RETURNING amount_minor)
  SELECT coalesce(sum(amount_minor),0) INTO v_done_minor FROM upd;
  IF v_done_minor<>v_reimb_minor THEN RAISE EXCEPTION 'Purchase reimbursement requires reconciliation'; END IF;
 END IF;
 UPDATE public.jobs SET payout_provider='wallet',payout_transfer_id='wallet:'||p_job::text,stripe_transfer_status=NULL,
  metadata=coalesce(metadata,'{}'::jsonb)||jsonb_build_object('driver_payout_pending',false) WHERE id=p_job;
 UPDATE public.driver_earnings SET payout_provider='wallet',payout_transfer_id='wallet:'||p_job::text WHERE job_id=p_job;
 UPDATE public.job_payout_queue SET status='paid',transfer_id='wallet:'||p_job::text,lease_until=NULL,last_error=NULL,updated_at=now() WHERE job_id=p_job;
 RETURN true;
END $$;

-- ---------------------------------------------------------------------------
-- 4. Withdrawals: request reserves spendable earnings into a held purpose;
--    the provider transfer only ever touches held funds.
-- ---------------------------------------------------------------------------
CREATE TABLE public.driver_withdrawals(
 id uuid PRIMARY KEY,
 driver_id uuid NOT NULL REFERENCES public.profiles(id),
 tenant_id uuid NOT NULL,
 currency_code text NOT NULL CHECK(currency_code='NGN'),
 amount_minor bigint NOT NULL CHECK(amount_minor>0),
 payout_account_id uuid NOT NULL REFERENCES public.driver_payment_accounts(id),
 merchant_account_ref text NOT NULL,
 reference text NOT NULL UNIQUE,
 status text NOT NULL DEFAULT 'processing' CHECK(status IN('processing','reconcile','paid','failed','blocked')),
 reserve_event_id uuid NOT NULL REFERENCES public.wallet_business_events(id),
 settle_event_id uuid REFERENCES public.wallet_business_events(id),
 provider_transfer_id text,provider_fee numeric CHECK(provider_fee>=0),
 last_error text,attempt integer NOT NULL DEFAULT 0,
 retry_at timestamptz NOT NULL DEFAULT now(),
 lease_until timestamptz,lease_token uuid,
 created_at timestamptz NOT NULL DEFAULT now(),updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE public.flutterwave_withdrawal_submissions(
 withdrawal_id uuid PRIMARY KEY REFERENCES public.driver_withdrawals(id),
 reference text NOT NULL UNIQUE,
 submitted_at timestamptz NOT NULL DEFAULT now(),
 provider_transfer_id text UNIQUE,provider_fee numeric CHECK(provider_fee>=0)
);
ALTER TABLE public.driver_withdrawals ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.flutterwave_withdrawal_submissions ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.driver_withdrawals,public.flutterwave_withdrawal_submissions FROM PUBLIC,anon,authenticated,service_role;
GRANT SELECT ON public.driver_withdrawals,public.flutterwave_withdrawal_submissions TO service_role;

CREATE FUNCTION public.guard_withdrawal_identity() RETURNS trigger LANGUAGE plpgsql SET search_path=public,pg_temp AS $$
BEGIN
 IF (NEW.driver_id,NEW.tenant_id,NEW.currency_code,NEW.amount_minor,NEW.payout_account_id,NEW.merchant_account_ref,NEW.reference,NEW.reserve_event_id)
  IS DISTINCT FROM (OLD.driver_id,OLD.tenant_id,OLD.currency_code,OLD.amount_minor,OLD.payout_account_id,OLD.merchant_account_ref,OLD.reference,OLD.reserve_event_id)
 THEN RAISE EXCEPTION 'Frozen withdrawal identity cannot change';END IF;RETURN NEW;
END $$;
CREATE TRIGGER guard_withdrawal_identity BEFORE UPDATE ON public.driver_withdrawals FOR EACH ROW EXECUTE FUNCTION public.guard_withdrawal_identity();
REVOKE ALL ON FUNCTION public.guard_withdrawal_identity() FROM PUBLIC,anon,authenticated,service_role;

-- Spendable earnings: only the earnings_payable purpose counts; held and
-- paid-out purposes are never spendable.
CREATE FUNCTION public.driver_earnings_wallet_balance(p_driver uuid,p_tenant uuid,p_currency text)
RETURNS bigint LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
BEGIN
 RETURN (SELECT coalesce(sum(m.amount_minor),0)::bigint FROM public.wallet_movements m
  JOIN public.wallet_accounts a ON a.id=m.account_id
  WHERE a.owner_id=p_driver AND a.tenant_id=p_tenant AND a.currency_code=upper(p_currency) AND a.balance_purpose='earnings_payable');
END $$;

CREATE FUNCTION public.request_driver_withdrawal(p_driver uuid,p_amount_minor bigint)
RETURNS public.driver_withdrawals LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE pr public.profiles%ROWTYPE; a public.driver_payment_accounts%ROWTYPE;
 w public.driver_withdrawals%ROWTYPE; v_account uuid; v_event uuid; v_balance bigint;
BEGIN
 IF p_amount_minor IS NULL OR p_amount_minor<=0 THEN RAISE EXCEPTION 'A positive withdrawal amount is required';END IF;
 SELECT * INTO STRICT pr FROM public.profiles WHERE id=p_driver AND role='driver' AND registration_activated_at IS NOT NULL FOR UPDATE;
 SELECT * INTO STRICT a FROM public.driver_payment_accounts WHERE driver_id=p_driver AND tenant_id=pr.tenant_id
  AND country_code=coalesce(pr.registration_country_code,pr.country_code) AND state='completed' ORDER BY updated_at DESC LIMIT 1 FOR UPDATE;
 IF a.provider<>'flutterwave' OR a.country_code<>'NG' OR a.currency_code<>'NGN'
  OR NOT EXISTS(SELECT 1 FROM public.driver_payout_markets m WHERE m.country_code=a.country_code AND m.currency_code=a.currency_code
   AND m.merchant_account_ref=a.merchant_account_ref AND m.provider='flutterwave' AND m.enabled AND m.merchant_approved AND m.adapter_ready
   AND m.capability_verified_at IS NOT NULL AND m.capability_evidence_ref IS NOT NULL AND m.merchant_mode='test'
   AND m.sandbox_driver_id=p_driver AND m.sandbox_tenant_id=pr.tenant_id)
 THEN RAISE EXCEPTION 'Approved payout destination required';END IF;
 -- Serialize reservations on the spendable account row, then re-check the balance.
 SELECT a2.id INTO v_account FROM public.wallet_accounts a2 WHERE a2.owner_id=p_driver AND a2.tenant_id=pr.tenant_id
  AND a2.currency_code=a.currency_code AND a2.balance_purpose='earnings_payable' FOR UPDATE;
 v_balance:=public.driver_earnings_wallet_balance(p_driver,pr.tenant_id,a.currency_code);
 IF v_balance<p_amount_minor THEN RAISE EXCEPTION 'Withdrawal exceeds the withdrawable earnings balance';END IF;
 w.id:=gen_random_uuid();
 v_event:=public.post_wallet_event('driver-withdraw-reserve:'||w.id::text,'withdrawal_reserve',pr.tenant_id,p_driver,a.currency_code,
  jsonb_build_array(jsonb_build_object('accountPurpose','earnings_payable','amountMinor',-p_amount_minor),
                    jsonb_build_object('accountPurpose','earnings_payable_held','amountMinor',p_amount_minor)));
 INSERT INTO public.driver_withdrawals(id,driver_id,tenant_id,currency_code,amount_minor,payout_account_id,merchant_account_ref,reference,reserve_event_id)
 VALUES(w.id,p_driver,pr.tenant_id,a.currency_code,p_amount_minor,a.id,a.merchant_account_ref,'vaydu-'||w.id::text||'_PMCK',v_event)
 RETURNING * INTO w;
 RETURN w;
END $$;

CREATE FUNCTION public.claim_driver_withdrawal(p_id uuid)
RETURNS SETOF public.driver_withdrawals LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
BEGIN
 RETURN QUERY UPDATE public.driver_withdrawals SET lease_token=gen_random_uuid(),lease_until=now()+interval '2 minutes',
  attempt=CASE WHEN status='processing' THEN attempt+1 ELSE attempt END,updated_at=now()
 WHERE id=p_id AND retry_at<=now() AND status IN('processing','reconcile') AND (lease_until IS NULL OR lease_until<now())
 RETURNING *;
END $$;

-- The irreversible submission marker commits BEFORE any provider contact.
CREATE FUNCTION public.claim_withdrawal_submission(p_id uuid,p_lease uuid,p_reference text)
RETURNS boolean LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE w public.driver_withdrawals%ROWTYPE;BEGIN
 SELECT * INTO STRICT w FROM public.driver_withdrawals WHERE id=p_id FOR UPDATE;
 IF w.lease_token IS DISTINCT FROM p_lease OR w.status NOT IN('processing','reconcile')
  OR p_reference IS DISTINCT FROM 'vaydu-'||p_id::text||'_PMCK' THEN RETURN false;END IF;
 INSERT INTO public.flutterwave_withdrawal_submissions(withdrawal_id,reference) VALUES(p_id,p_reference) ON CONFLICT(withdrawal_id) DO NOTHING;
 RETURN FOUND;
END $$;

CREATE FUNCTION public.finish_driver_withdrawal(p_id uuid,p_lease uuid,p_transfer text,p_fee numeric)
RETURNS boolean LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE w public.driver_withdrawals%ROWTYPE; v_event uuid;BEGIN
 SELECT * INTO STRICT w FROM public.driver_withdrawals WHERE id=p_id FOR UPDATE;
 IF w.status='paid' THEN RETURN w.provider_transfer_id=p_transfer;END IF;
 IF w.lease_token IS DISTINCT FROM p_lease OR w.status NOT IN('processing','reconcile')
  OR p_transfer IS NULL OR p_transfer !~ '^\d+$'
  OR NOT EXISTS(SELECT 1 FROM public.flutterwave_withdrawal_submissions WHERE withdrawal_id=p_id)
 THEN RETURN false;END IF;
 v_event:=public.post_wallet_event('driver-withdraw-settle:'||p_id::text,'withdrawal_settle',w.tenant_id,w.driver_id,w.currency_code,
  jsonb_build_array(jsonb_build_object('accountPurpose','earnings_payable_held','amountMinor',-w.amount_minor),
                    jsonb_build_object('accountPurpose','earnings_paid_out','amountMinor',w.amount_minor)));
 UPDATE public.driver_withdrawals SET status='paid',provider_transfer_id=p_transfer,provider_fee=p_fee,settle_event_id=v_event,
  lease_until=NULL,lease_token=NULL,last_error=NULL,updated_at=now() WHERE id=p_id;
 UPDATE public.flutterwave_withdrawal_submissions SET provider_transfer_id=p_transfer,provider_fee=p_fee WHERE withdrawal_id=p_id;
 RETURN true;
END $$;

-- A definitive provider failure reverses the reserve event exactly (controlled
-- reversal: the ledger validates the legs negate the original) so the funds
-- return to the spendable balance instead of staying stuck.
CREATE FUNCTION public.reverse_driver_withdrawal(p_id uuid,p_lease uuid,p_code text)
RETURNS boolean LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE w public.driver_withdrawals%ROWTYPE; v_legs jsonb;BEGIN
 SELECT * INTO STRICT w FROM public.driver_withdrawals WHERE id=p_id FOR UPDATE;
 IF w.status IN('failed','paid') THEN RETURN false;END IF;
 IF w.lease_token IS DISTINCT FROM p_lease OR w.status NOT IN('processing','reconcile') THEN RETURN false;END IF;
 SELECT jsonb_agg(jsonb_build_object('accountPurpose',a.balance_purpose,'amountMinor',-m.amount_minor) ORDER BY a.balance_purpose)
  INTO v_legs FROM public.wallet_movements m JOIN public.wallet_accounts a ON a.id=m.account_id WHERE m.event_id=w.reserve_event_id;
 PERFORM public.post_wallet_event('driver-withdraw-reverse:'||p_id::text,'reversal',w.tenant_id,w.driver_id,w.currency_code,v_legs,NULL,NULL,NULL,w.reserve_event_id);
 UPDATE public.driver_withdrawals SET status='failed',last_error=coalesce(p_code,'provider_transfer_failed'),lease_until=NULL,lease_token=NULL,updated_at=now() WHERE id=p_id;
 RETURN true;
END $$;

REVOKE ALL ON FUNCTION public.finish_wallet_job_payout(uuid,uuid),
 public.driver_earnings_wallet_balance(uuid,uuid,text),
 public.request_driver_withdrawal(uuid,bigint),
 public.claim_driver_withdrawal(uuid),
 public.claim_withdrawal_submission(uuid,uuid,text),
 public.finish_driver_withdrawal(uuid,uuid,text,numeric),
 public.reverse_driver_withdrawal(uuid,uuid,text) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.finish_wallet_job_payout(uuid,uuid),
 public.driver_earnings_wallet_balance(uuid,uuid,text),
 public.request_driver_withdrawal(uuid,bigint),
 public.claim_driver_withdrawal(uuid),
 public.claim_withdrawal_submission(uuid,uuid,text),
 public.finish_driver_withdrawal(uuid,uuid,text,numeric),
 public.reverse_driver_withdrawal(uuid,uuid,text) TO service_role;
NOTIFY pgrst,'reload schema';
COMMIT;
