-- ============================================================================
-- Errand purchase payer authority.
--
-- 1. errand_funding.purchase_method records the job-level purchase method.
--    Values for every agreed method are valid column values; only 'vaydu_card'
--    and 'driver_personal' are writable by any code path today. The remaining
--    methods ('customer_direct','vaydu_direct','cash_advance') are recognised
--    but unreachable until their evidence/charging semantics are integrated.
-- 2. public.errand_purchase_payments is the per-purchase payer record:
--    who paid (payer), how (purchase_method), how much (minor units, with the
--    same convention as job_issuing_* tables which store major elsewhere),
--    evidence (provider_reference / merchant_name) and settlement state.
--    Mixed-method purchases are rejected. Unsupported methods are rejected.
-- 3. enforce_errand_spending_budget is corrected: the deployed trigger
--    granted estimated_budget + requested_over_budget_amount, where
--    requested_over_budget_amount is the NEW TOTAL (approve_*_budget sets
--    item_budget = requested_over_budget_amount). That granted
--    estimated + approved_total instead of the funded amount. The cap is now
--    the successfully reserved/authorised budget only:
--      errand_funding.item_budget        (post-approval = new funded total;
--                                       the card create-intent writes the
--                                       authorised item budget here)
--      errand_funding.amount_reserved    (legacy 'pending' budget-only rows)
--    A missing funding row means no spend was funded and fails closed. A
--    higher estimate never permits spend beyond the funded budget.
-- 4. Driver-personal spend reaches the driver as reimbursement through the
--    existing payout outbox: complete_job_with_pending_payout adds the
--    recorded driver spend to the queued transfer amount and terms;
--    finish_queued_job_payout marks the purchase payments 'reimbursed' with
--    the same transfer id, in the same transaction that settles earnings.
--    Reimbursement is separate from commissionable earnings: driver_earnings
--    keeps settlement_purpose='job_earnings' and gross = service fare only.
-- 5. Method lock: once payer evidence exists, the method cannot change while
--    the original payment is unresolved (activation after recorded manual
--    spend, or manual spend while a spend control is active, are rejected).
--
-- Forward-only. Defensive IF NOT EXISTS / CREATE OR REPLACE. No existing rows
-- are rewritten: legacy spend simply has no purchase_method until new evidence.
-- ============================================================================
BEGIN;

DO $$ BEGIN
 IF to_regclass('public.errand_funding') IS NULL OR to_regclass('public.errand_details') IS NULL
 OR to_regclass('public.jobs') IS NULL OR to_regclass('public.job_payout_queue') IS NULL
 OR to_regclass('public.job_issuing_spend_controls') IS NULL OR to_regclass('public.job_issuing_transactions') IS NULL
 OR to_regprocedure('public.complete_job_with_pending_payout(uuid,uuid,jsonb,jsonb)') IS NULL
 OR to_regprocedure('public.finish_queued_job_payout(uuid,uuid,text)') IS NULL
 OR to_regprocedure('public.release_job_wallet_reservation(uuid,text)') IS NULL THEN
   RAISE EXCEPTION 'Errand purchase payer prerequisites missing';
 END IF;
END $$;

-- ---------------------------------------------------------------------------
-- 1. Job-level purchase method on the funding record.
-- ---------------------------------------------------------------------------
ALTER TABLE public.errand_funding ADD COLUMN IF NOT EXISTS purchase_method text;
DO $$ BEGIN
 IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname='errand_funding_purchase_method_check' AND conrelid='public.errand_funding'::regclass) THEN
  ALTER TABLE public.errand_funding
   ADD CONSTRAINT errand_funding_purchase_method_check
   CHECK (purchase_method IS NULL OR purchase_method IN
     ('vaydu_card','driver_personal','customer_direct','vaydu_direct','cash_advance'));
 END IF;
END $$;

-- ---------------------------------------------------------------------------
-- 2. Per-purchase payer records.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.errand_purchase_payments (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  job_id uuid NOT NULL REFERENCES public.jobs(id) ON DELETE CASCADE,
  purchase_method text NOT NULL
    CHECK (purchase_method IN ('vaydu_card','driver_personal','customer_direct','vaydu_direct','cash_advance')),
  payer text NOT NULL CHECK (payer IN ('vaydu','driver','customer')),
  kind text NOT NULL CHECK (kind IN ('capture','refund','manual')),
  amount_minor bigint NOT NULL CHECK (amount_minor >= 0),
  currency text NOT NULL,
  provider_reference text,
  merchant_name text,
  status text NOT NULL DEFAULT 'recorded' CHECK (status IN ('recorded','reimbursed','released','cancelled')),
  reimbursement_transfer_id text,
  created_by uuid,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE public.errand_purchase_payments ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.errand_purchase_payments FROM PUBLIC, anon, authenticated;
GRANT ALL ON public.errand_purchase_payments TO service_role;
-- Exactly one payer record per purchase evidence item per job. Manual driver
-- spend is a single aggregate row (provider_reference='manual-spend') that
-- tracks the recorded total; issuing rows dedupe on the Stripe transaction id.
CREATE UNIQUE INDEX IF NOT EXISTS errand_purchase_payments_dedupe
  ON public.errand_purchase_payments (job_id, purchase_method, provider_reference);
CREATE INDEX IF NOT EXISTS errand_purchase_payments_driver_pending
  ON public.errand_purchase_payments (job_id) WHERE payer='driver' AND status='recorded';

-- Reject unsupported methods and mixed-method purchases. SECURITY DEFINER:
-- the table has no authenticated grants, so RLS must not hide existing rows.
CREATE OR REPLACE FUNCTION public.guard_errand_purchase_method() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
BEGIN
 IF NEW.purchase_method NOT IN ('vaydu_card','driver_personal') THEN
  RAISE EXCEPTION 'Purchase method % is not enabled', NEW.purchase_method;
 END IF;
 IF (NEW.purchase_method='vaydu_card' AND NEW.payer<>'vaydu')
 OR (NEW.purchase_method='driver_personal' AND NEW.payer<>'driver') THEN
  RAISE EXCEPTION 'Purchase payer does not match the purchase method';
 END IF;
 IF EXISTS(SELECT 1 FROM public.errand_purchase_payments
   WHERE job_id=NEW.job_id AND purchase_method<>NEW.purchase_method AND status NOT IN ('cancelled')) THEN
  RAISE EXCEPTION 'Mixed purchase methods are not supported for one booking';
 END IF;
 RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS trg_guard_errand_purchase_method ON public.errand_purchase_payments;
CREATE TRIGGER trg_guard_errand_purchase_method
  BEFORE INSERT OR UPDATE ON public.errand_purchase_payments
  FOR EACH ROW EXECUTE FUNCTION public.guard_errand_purchase_method();

-- ---------------------------------------------------------------------------
-- 3. Spend cap = funded budget; method lock + payer record on manual spend.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.enforce_errand_spending_budget() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE
  v_funding public.errand_funding%ROWTYPE;
  v_job public.jobs%ROWTYPE;
  v_funded numeric := 0;
  v_card_spend numeric;
BEGIN
 IF NEW.actual_spending IS NULL OR NEW.actual_spending IS NOT DISTINCT FROM OLD.actual_spending THEN RETURN NEW; END IF;
 IF NEW.actual_spending < 0 THEN RAISE EXCEPTION 'Item spending cannot be negative'; END IF;

 SELECT * INTO v_job FROM public.jobs WHERE id=NEW.job_id;
 IF v_job.status IN ('completed','settled','cancelled','canceled','expired','failed') THEN
  RAISE EXCEPTION 'Shopping spend cannot change after the booking has ended';
 END IF;

 SELECT * INTO v_funding FROM public.errand_funding WHERE job_id=NEW.job_id FOR UPDATE;

 -- Vaydu card authority: while a spend control exists (or the method is locked
 -- to the card), spend must equal the captured issuing ledger. The issuing
 -- sync writes exactly that; anything else is a mixed-method write.
 IF v_funding.purchase_method='vaydu_card'
 OR EXISTS(SELECT 1 FROM public.job_issuing_spend_controls WHERE job_id=NEW.job_id AND status IN ('active','pending')) THEN
  SELECT greatest(0,coalesce(sum(CASE WHEN status='capture' THEN amount WHEN status='refund' THEN -amount ELSE 0 END),0))
   INTO v_card_spend FROM public.job_issuing_transactions WHERE job_id=NEW.job_id;
  IF round(NEW.actual_spending,2) IS DISTINCT FROM round(v_card_spend,2) THEN
   RAISE EXCEPTION 'Vaydu card spend is recorded from the card ledger; manual spending is not allowed on this booking';
  END IF;
  UPDATE public.errand_funding SET purchase_method='vaydu_card',updated_at=now()
   WHERE job_id=NEW.job_id AND purchase_method IS DISTINCT FROM 'vaydu_card';
  NEW.actual_spending := round(NEW.actual_spending,2);
  RETURN NEW;
 END IF;

 -- Funded budget is authoritative; a higher estimate never grants spend.
 -- The card create-intent upserts item_budget = the authorised item budget and
 -- the wallet path reserves item_budget; a missing funding row therefore means
 -- no shopping spend was ever funded and must fail closed. (Composite IS NULL
 -- tests every column, so presence is checked on the NOT NULL key.)
 IF v_funding.job_id IS NULL THEN
  v_funded := 0;
 ELSIF v_funding.item_budget > 0 THEN
  v_funded := round(v_funding.item_budget,2);
 ELSIF v_funding.status='pending' THEN
  v_funded := round(coalesce(v_funding.amount_reserved,0),2);
 ELSE
  v_funded := 0;
 END IF;

 IF round(NEW.actual_spending,2) > v_funded THEN
  RAISE EXCEPTION 'Item spending exceeds the funded budget. Maximum: %', v_funded;
 END IF;

 IF v_funding.job_id IS NOT NULL THEN
  IF v_funding.purchase_method IS NOT NULL AND v_funding.purchase_method<>'driver_personal' THEN
   RAISE EXCEPTION 'A different purchase method is already recorded for this booking';
  END IF;
  IF v_funding.purchase_method IS NULL THEN
   UPDATE public.errand_funding SET purchase_method='driver_personal',updated_at=now() WHERE job_id=NEW.job_id;
  END IF;
  INSERT INTO public.errand_purchase_payments
    (job_id,purchase_method,payer,kind,amount_minor,currency,provider_reference,created_by)
  VALUES (NEW.job_id,'driver_personal','driver','manual',
    round(NEW.actual_spending*100)::bigint,upper(coalesce(v_job.currency_code,'GBP')),
    'manual-spend',coalesce(auth.uid(),v_job.driver_id))
  ON CONFLICT (job_id,purchase_method,provider_reference)
  DO UPDATE SET amount_minor=excluded.amount_minor,updated_at=now()
  WHERE public.errand_purchase_payments.status='recorded';
 END IF;

 NEW.actual_spending := round(NEW.actual_spending,2);
 RETURN NEW;
END $$;

-- ---------------------------------------------------------------------------
-- 4. Card activation locks the job to the card method.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.activate_job_issuing_control(p_job uuid,p_card text,p_budget numeric,p_metadata jsonb)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE j public.jobs%ROWTYPE; f public.errand_funding%ROWTYPE;
BEGIN
 PERFORM pg_advisory_xact_lock(hashtextextended('issuing-card-'||p_card,0));
 SELECT * INTO STRICT j FROM public.jobs WHERE id=p_job;
 IF EXISTS(SELECT 1 FROM public.job_issuing_spend_controls c JOIN public.jobs x ON x.id=c.job_id
   WHERE c.stripe_card_id=p_card AND c.job_id<>p_job AND c.status='active'
   AND x.status NOT IN ('completed','settled','cancelled','canceled','expired','failed','no_driver_found')) THEN
  RAISE EXCEPTION 'Card is already assigned to another active shopping job';
 END IF;
 SELECT * INTO f FROM public.errand_funding WHERE job_id=p_job FOR UPDATE;
 IF (f.purchase_method IS NOT NULL AND f.purchase_method<>'vaydu_card')
 OR EXISTS(SELECT 1 FROM public.errand_details WHERE job_id=p_job AND coalesce(actual_spending,0)>0)
 OR EXISTS(SELECT 1 FROM public.errand_purchase_payments WHERE job_id=p_job AND purchase_method<>'vaydu_card' AND status NOT IN ('cancelled')) THEN
  RAISE EXCEPTION 'A different purchase method is already recorded for this booking';
 END IF;
 UPDATE public.job_issuing_spend_controls SET status='pending',updated_at=now() WHERE stripe_card_id=p_card AND job_id<>p_job AND status='active';
 INSERT INTO public.job_issuing_spend_controls(job_id,driver_id,customer_id,tenant_id,stripe_card_id,amount_limit,currency_code,status,metadata,activated_at)
 VALUES(j.id,j.driver_id,j.customer_id,j.tenant_id,p_card,p_budget,j.currency_code,'active',p_metadata,now())
 ON CONFLICT(job_id) DO UPDATE SET stripe_card_id=excluded.stripe_card_id,amount_limit=excluded.amount_limit,
 status='active',metadata=excluded.metadata,updated_at=now();
 UPDATE public.errand_funding SET purchase_method='vaydu_card',updated_at=now()
 WHERE job_id=p_job AND purchase_method IS DISTINCT FROM 'vaydu_card';
END $$;

-- ---------------------------------------------------------------------------
-- 5. Issuing ledger writes per-purchase payer rows (payer='vaydu').
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.record_issuing_transaction(p_id text,p_authorization text,p_card text,p_amount numeric,p_currency text,p_type text,p_event jsonb)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE a public.job_issuing_authorizations%ROWTYPE; c public.job_issuing_spend_controls%ROWTYPE; old public.job_issuing_transactions%ROWTYPE; delta numeric;
BEGIN
 PERFORM pg_advisory_xact_lock(hashtextextended('issuing-card-'||p_card,0));
 SELECT * INTO STRICT a FROM public.job_issuing_authorizations WHERE stripe_authorization_id=p_authorization;
 SELECT * INTO STRICT c FROM public.job_issuing_spend_controls WHERE job_id=a.job_id FOR UPDATE;
 IF lower(p_currency)<>lower(c.currency_code) OR p_card<>a.stripe_card_id OR p_amount<0 OR p_type NOT IN ('capture','refund') THEN RAISE EXCEPTION 'Issuing transaction requires reconciliation'; END IF;
 SELECT * INTO old FROM public.job_issuing_transactions WHERE stripe_transaction_id=p_id FOR UPDATE;
 IF FOUND AND (old.job_id IS DISTINCT FROM a.job_id OR old.status IS DISTINCT FROM p_type) THEN RAISE EXCEPTION 'Transaction identity changed'; END IF;
 delta:=p_amount-coalesce(old.amount,0);
 IF p_type='refund' THEN delta:=-delta; END IF;
 INSERT INTO public.job_issuing_transactions(stripe_transaction_id,stripe_authorization_id,job_id,driver_id,stripe_card_id,amount,currency_code,merchant_name,status,raw_event)
 VALUES(p_id,p_authorization,a.job_id,a.driver_id,p_card,p_amount,upper(p_currency),p_event#>>'{merchant_data,name}',p_type,p_event)
 ON CONFLICT(stripe_transaction_id) DO UPDATE SET amount=excluded.amount,raw_event=excluded.raw_event,updated_at=now();
 UPDATE public.job_issuing_spend_controls SET amount_captured=greatest(0,amount_captured+delta),updated_at=now() WHERE id=c.id;
 INSERT INTO public.errand_purchase_payments
   (job_id,purchase_method,payer,kind,amount_minor,currency,provider_reference,merchant_name,created_by)
 VALUES (a.job_id,'vaydu_card','vaydu',p_type,round(p_amount*100)::bigint,upper(p_currency),
   p_id,p_event#>>'{merchant_data,name}',c.driver_id)
 ON CONFLICT (job_id,purchase_method,provider_reference)
 DO UPDATE SET amount_minor=excluded.amount_minor,updated_at=now();
END $$;

-- ---------------------------------------------------------------------------
-- 6. Completion queues payout + driver reimbursement in one outbox transfer.
--    Reimbursement is DB-derived from recorded payer evidence, never trusted
--    from caller terms, and is capped at the funded purchase budget.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.complete_job_with_pending_payout(p_job_id uuid,p_driver_id uuid,p_terms jsonb,p_metadata jsonb)
RETURNS SETOF public.jobs LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE j public.jobs%ROWTYPE; q public.job_payout_queue%ROWTYPE; f public.errand_funding%ROWTYPE;
  total numeric; payout numeric; fee numeric; commission numeric; v_legacy_spend numeric;
  v_reimb_minor bigint; v_amount_minor bigint; v_budget_minor bigint; v_terms jsonb;
BEGIN
 SELECT * INTO STRICT j FROM public.jobs WHERE id=p_job_id FOR UPDATE;
 IF coalesce(j.driver_id,j.accepted_driver_id) IS DISTINCT FROM p_driver_id THEN RAISE EXCEPTION 'Only the assigned driver can complete this request'; END IF;
 PERFORM 1 FROM public.errand_funding WHERE job_id=p_job_id FOR UPDATE;
 IF EXISTS(SELECT 1 FROM public.errand_funding WHERE job_id=p_job_id AND over_budget_status='requested') THEN RAISE EXCEPTION 'Shopping budget approval must finish before completion'; END IF;
 IF EXISTS(SELECT 1 FROM public.errand_purchase_payments WHERE job_id=p_job_id
   AND purchase_method NOT IN ('vaydu_card','driver_personal')) THEN
  RAISE EXCEPTION 'Unsupported purchase method requires review before settlement';
 END IF;
 SELECT * INTO f FROM public.errand_funding WHERE job_id=p_job_id;
 -- Every recorded driver purchase is the obligation; 'reimbursed' rows still
 -- count so a replayed completion recomputes the identical frozen terms.
 SELECT coalesce(sum(CASE WHEN kind='capture' THEN amount_minor WHEN kind='refund' THEN -amount_minor ELSE amount_minor END),0)
 INTO v_reimb_minor FROM public.errand_purchase_payments
 WHERE job_id=p_job_id AND payer='driver' AND status IN ('recorded','reimbursed');
 -- In-flight driver spend recorded before payer records existed must still be
 -- reimbursed: backfill the payer record from the verified spend, unless the
 -- job ran through the card or is already locked to another method. Spend
 -- above the funded budget still raises below; it is never paid silently.
 IF v_reimb_minor=0 AND coalesce(f.purchase_method,'')<>'vaydu_card'
 AND NOT EXISTS(SELECT 1 FROM public.errand_purchase_payments WHERE job_id=p_job_id)
 AND NOT EXISTS(SELECT 1 FROM public.job_issuing_spend_controls WHERE job_id=p_job_id AND status<>'cancelled') THEN
  SELECT coalesce(actual_spending,0) INTO v_legacy_spend FROM public.errand_details WHERE job_id=p_job_id;
  IF v_legacy_spend>0 THEN
   INSERT INTO public.errand_purchase_payments
     (job_id,purchase_method,payer,kind,amount_minor,currency,provider_reference,created_by)
   VALUES (p_job_id,'driver_personal','driver','manual',round(v_legacy_spend*100)::bigint,
     upper(coalesce(j.currency_code,'GBP')),'manual-spend',p_driver_id)
   ON CONFLICT (job_id,purchase_method,provider_reference) DO NOTHING;
   UPDATE public.errand_funding SET purchase_method='driver_personal',updated_at=now()
    WHERE job_id=p_job_id AND purchase_method IS NULL;
   v_reimb_minor := round(v_legacy_spend*100)::bigint;
  END IF;
 END IF;
 v_budget_minor := CASE WHEN f.item_budget>0 THEN round(f.item_budget*100)::bigint
   WHEN f.status='pending' THEN round(coalesce(f.amount_reserved,0)*100)::bigint ELSE 0 END;
 IF v_reimb_minor<0 OR v_reimb_minor>v_budget_minor THEN RAISE EXCEPTION 'Driver purchase spend requires reconciliation before payout'; END IF;

 total=(p_terms->>'total')::numeric; payout=(p_terms->>'payout')::numeric;
 fee=(p_terms->>'platformFee')::numeric; commission=(p_terms->>'commission')::numeric;
 IF total IS NULL OR payout IS NULL OR fee IS NULL OR commission IS NULL OR total::text='NaN' OR payout::text='NaN' OR fee::text='NaN' OR commission::text='NaN' OR total<=0 OR payout<=0 OR fee<0 OR commission<0 OR abs(total-payout-fee-commission)>0.01 THEN RAISE EXCEPTION 'Invalid frozen payout terms'; END IF;
 IF lower(p_terms->>'currency')<>'gbp' OR (p_terms->>'amountMinor')::bigint<>round(payout*100)::bigint OR coalesce(p_terms->>'destination','') NOT LIKE 'acct_%' THEN RAISE EXCEPTION 'Invalid payout identity'; END IF;
 v_amount_minor := (p_terms->>'amountMinor')::bigint + v_reimb_minor;
 v_terms := p_terms || jsonb_build_object('reimbursementMinor',v_reimb_minor,'purchaseMethod',coalesce(f.purchase_method,'none'));

 SELECT * INTO q FROM public.job_payout_queue WHERE job_id=p_job_id;
 IF FOUND THEN
   IF q.driver_id<>p_driver_id OR q.terms<>v_terms THEN RAISE EXCEPTION 'Payout terms changed; reconciliation required'; END IF;
   RETURN QUERY SELECT * FROM public.jobs WHERE id=p_job_id; RETURN;
 END IF;
 IF j.status NOT IN ('in_progress','en_route_to_customer','arrived_at_customer','on_trip','completed') THEN RAISE EXCEPTION 'Request is not ready for completion'; END IF;
 IF j.stripe_transfer_id IS NOT NULL OR j.settlement_status IN ('claimed','unknown','transferred','reversed') THEN RAISE EXCEPTION 'Existing transfer needs reconciliation'; END IF;

 IF coalesce(p_metadata->>'completion_pin_verified_at','')='' THEN RAISE EXCEPTION 'Verified completion evidence missing'; END IF;
 IF EXISTS(SELECT 1 FROM public.refund_operations WHERE job_id=p_job_id) THEN RAISE EXCEPTION 'Existing refund requires reconciliation'; END IF;
 IF (j.payment_method='wallet' OR j.payment_status='wallet_funded') AND j.payment_status<>'paid' THEN
   PERFORM public.settle_job_wallet_reservation(p_job_id,total);
 END IF;
 INSERT INTO public.job_payout_queue(job_id,driver_id,destination,amount_minor,currency,terms)
 VALUES(p_job_id,p_driver_id,p_terms->>'destination',v_amount_minor,lower(p_terms->>'currency'),v_terms);
 UPDATE public.jobs SET status='completed',payment_status='paid',completed_at=coalesce(completed_at,now()),
   driver_payout=payout,platform_fee=fee,commission_fee=commission,commission_rate_used=(p_terms->>'commissionRate')::numeric,
   settlement_status='pending',stripe_transfer_status='pending',
   metadata=coalesce(j.metadata,'{}'::jsonb)||p_metadata||jsonb_build_object('driver_payout_pending',true)
   ||jsonb_build_object('driver_reimbursement_minor',v_reimb_minor),updated_at=now()
 WHERE id=p_job_id;
 INSERT INTO public.driver_earnings(driver_id,job_id,amount,platform_fee,gross_amount,status,currency_code,country_code)
 VALUES(p_driver_id,p_job_id,payout,fee,total,'pending',upper(p_terms->>'currency'),p_terms->>'country')
 ON CONFLICT(job_id) DO UPDATE SET amount=excluded.amount,platform_fee=excluded.platform_fee,gross_amount=excluded.gross_amount,status='pending',currency_code=excluded.currency_code,country_code=excluded.country_code
 WHERE public.driver_earnings.status<>'paid' AND public.driver_earnings.stripe_transfer_id IS NULL;
 IF NOT FOUND THEN RAISE EXCEPTION 'Existing paid earnings require reconciliation'; END IF;
 RETURN QUERY SELECT * FROM public.jobs WHERE id=p_job_id;
END $$;

-- ---------------------------------------------------------------------------
-- 7. Transfer finish marks driver purchases reimbursed with the same
--    transfer id, atomically with settlement. A failed/pending payout leaves
--    purchases 'recorded' — money is never marked paid prematurely.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.finish_queued_job_payout(p_job_id uuid,p_token uuid,p_transfer_id text)
RETURNS boolean LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE q public.job_payout_queue%ROWTYPE; j public.jobs%ROWTYPE;
  v_reimb_minor bigint; v_done_minor bigint;
BEGIN
 SELECT * INTO STRICT j FROM public.jobs WHERE id=p_job_id FOR UPDATE;
 SELECT * INTO STRICT q FROM public.job_payout_queue WHERE job_id=p_job_id FOR UPDATE;
 IF q.status='paid' THEN RETURN q.transfer_id=p_transfer_id; END IF;
 IF q.token IS DISTINCT FROM p_token OR q.status NOT IN ('processing','reconcile') THEN RETURN false; END IF;
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

-- ---------------------------------------------------------------------------
-- 8. Cancellation protection: an unresolved driver-paid purchase must not be
--    silently released back to the customer. Route to review instead.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.release_job_wallet_reservation(p_job_id uuid,p_reason text DEFAULT 'Wallet reservation released')
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE j public.jobs%ROWTYPE; w public.wallets%ROWTYPE; f public.errand_funding%ROWTYPE; net numeric; reserved_count integer;
BEGIN
 SELECT * INTO STRICT j FROM public.jobs WHERE id=p_job_id FOR UPDATE;
 IF j.payment_method IS DISTINCT FROM 'wallet' AND j.payment_status IS DISTINCT FROM 'wallet_funded' THEN RETURN jsonb_build_object('released',false,'reason','Job is not wallet-funded'); END IF;
 IF j.status NOT IN ('cancelled','canceled','expired','failed','no_driver_found') THEN RAISE EXCEPTION 'Wallet release requires a terminal cancelled booking'; END IF;
 IF j.payment_status IN ('paid','captured','succeeded') THEN RAISE EXCEPTION 'Captured funds require refund review'; END IF;
 SELECT * INTO STRICT w FROM public.wallets WHERE user_id=j.customer_id FOR UPDATE;
 SELECT * INTO f FROM public.errand_funding WHERE job_id=j.id FOR UPDATE;
 IF EXISTS(SELECT 1 FROM public.wallet_transactions WHERE job_id=j.id AND user_id=j.customer_id AND transaction_type='settlement') OR f.status='settled' THEN
  RAISE EXCEPTION 'Settled reservation cannot be released as cancellation';
 END IF;
 IF EXISTS(SELECT 1 FROM public.errand_purchase_payments WHERE job_id=j.id AND status='recorded') THEN
  RAISE EXCEPTION 'Recorded purchase payments require reconciliation before release';
 END IF;
 SELECT coalesce(sum(CASE WHEN transaction_type='reservation' THEN amount WHEN transaction_type='release' THEN -amount ELSE 0 END),0),count(*) FILTER(WHERE transaction_type='reservation')
 INTO net,reserved_count FROM public.wallet_transactions WHERE job_id=j.id AND user_id=j.customer_id;
 -- Legacy errand reservations had no ledger row; their locked funding marker
 -- is the evidence. Never combine or double-count the two representations.
 IF reserved_count=0 AND f.status IN ('reserved','approved','over_budget_requested') THEN net:=f.amount_reserved; END IF;
 IF net<0 THEN RAISE EXCEPTION 'Wallet ledger requires reconciliation'; END IF;
 IF net=0 THEN
  UPDATE public.jobs SET payment_status='cancelled',updated_at=now() WHERE id=j.id;
  RETURN jsonb_build_object('released',false,'reason','No active wallet reservation');
 END IF;
 IF w.reserved_balance<net THEN RAISE EXCEPTION 'Reserved balance is inconsistent with this booking'; END IF;
 UPDATE public.wallets SET available_balance=w.available_balance+net,reserved_balance=w.reserved_balance-net,updated_at=now() WHERE id=w.id;
 INSERT INTO public.wallet_transactions(wallet_id,user_id,job_id,transaction_type,amount,description,metadata,
  balance_before_available,balance_after_available,balance_before_reserved,balance_after_reserved)
 VALUES(w.id,j.customer_id,j.id,'release',net,p_reason,jsonb_build_object('payment_method','wallet','legacy_funding',reserved_count=0),
  w.available_balance,w.available_balance+net,w.reserved_balance,w.reserved_balance-net);
 UPDATE public.errand_funding SET status='cancelled',metadata=coalesce(metadata,'{}'::jsonb)||jsonb_build_object('released_amount',net,'release_reason',p_reason),updated_at=now()
 WHERE job_id=j.id AND status IN ('reserved','approved','over_budget_requested');
 UPDATE public.jobs SET payment_status='cancelled',updated_at=now() WHERE id=j.id;
 RETURN jsonb_build_object('released',true,'amount',net,'job_id',j.id);
END $$;

REVOKE ALL ON FUNCTION public.guard_errand_purchase_method() FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.guard_errand_purchase_method() TO postgres,service_role;
REVOKE ALL ON FUNCTION public.activate_job_issuing_control(uuid,text,numeric,jsonb),
 public.record_issuing_transaction(text,text,text,numeric,text,text,jsonb),
 public.complete_job_with_pending_payout(uuid,uuid,jsonb,jsonb),
 public.finish_queued_job_payout(uuid,uuid,text),
 public.release_job_wallet_reservation(uuid,text),
 public.enforce_errand_spending_budget() FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.activate_job_issuing_control(uuid,text,numeric,jsonb),
 public.record_issuing_transaction(text,text,text,numeric,text,text,jsonb),
 public.complete_job_with_pending_payout(uuid,uuid,jsonb,jsonb),
 public.finish_queued_job_payout(uuid,uuid,text),
 public.release_job_wallet_reservation(uuid,text) TO service_role;
NOTIFY pgrst,'reload schema';
COMMIT;
