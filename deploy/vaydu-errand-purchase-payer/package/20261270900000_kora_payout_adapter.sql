-- Kora beneficiary-payout adapter (develop/NG sandbox scope).
--
-- The provider-neutral withdrawal interface now has a second reviewed adapter:
-- Kora's official payout API (POST /merchant/api/v1/transactions/disburse,
-- GET /merchant/api/v1/transactions/:reference, POST /misc/banks/resolve).
-- Kora does not require a provider-side beneficiary object for single payouts;
-- the "verified beneficiary" is the resolved bank account, frozen with the
-- same bank_code/account fingerprint scheme. beneficiary_id stores the NUBV
-- account number the disburse targets.
--
-- Nothing here enables a transfer: request still requires a test-mode
-- driver_payout_markets row bound to the sandbox driver/tenant, dispatch still
-- requires VAYDU_DRIVER_PAYOUT_TRANSFERS=true plus the Kora sandbox env
-- bundle, and Flutterwave stays exactly as it was.
BEGIN;
DO $$ BEGIN
 IF current_database()<>'movabi_develop' THEN RAISE EXCEPTION 'Develop database required'; END IF;
 IF to_regclass('public.driver_withdrawals') IS NULL OR to_regclass('public.driver_payment_accounts') IS NULL
  OR to_regprocedure('public.finish_driver_withdrawal(uuid,uuid,text,numeric)') IS NULL
 THEN RAISE EXCEPTION 'Kora payout support requires the driver wallet settlement migration'; END IF;
END $$;

-- Withdrawal provider allow-list: the reviewed adapters only. Paystack (setup
-- only) and any unreviewed provider stay refused.
CREATE OR REPLACE FUNCTION public.payout_withdrawal_provider_supported(p_provider text)
RETURNS boolean LANGUAGE sql IMMUTABLE SET search_path=public,pg_temp AS $$
 SELECT p_provider IN ('flutterwave','kora');
$$;

-- Settle-time transfer identity is provider-shaped: Flutterwave ids are
-- numeric, Kora references are alphanumeric (e.g. KPY-D-...).
CREATE OR REPLACE FUNCTION public.finish_driver_withdrawal(p_id uuid,p_lease uuid,p_transfer text,p_fee numeric)
RETURNS boolean LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE w public.driver_withdrawals%ROWTYPE; v_event uuid;BEGIN
 SELECT * INTO STRICT w FROM public.driver_withdrawals WHERE id=p_id FOR UPDATE;
 IF w.status='paid' THEN RETURN w.provider_transfer_id=p_transfer;END IF;
 IF w.lease_token IS DISTINCT FROM p_lease OR w.status NOT IN('processing','reconcile')
  OR p_transfer IS NULL
  OR NOT (CASE w.provider WHEN 'flutterwave' THEN p_transfer ~ '^\d+$'
          WHEN 'kora' THEN p_transfer ~ '^KPY-[A-Za-z0-9_-]{3,60}$' ELSE false END)
  OR NOT EXISTS(SELECT 1 FROM public.driver_withdrawal_submissions WHERE withdrawal_id=p_id)
 THEN RETURN false;END IF;
 v_event:=public.post_wallet_event('driver-withdraw-settle:'||p_id::text,'withdrawal_settle',w.tenant_id,w.driver_id,w.currency_code,
  jsonb_build_array(jsonb_build_object('accountPurpose','earnings_payable_held','amountMinor',-w.amount_minor),
                    jsonb_build_object('accountPurpose','earnings_paid_out','amountMinor',w.amount_minor)));
 UPDATE public.driver_withdrawals SET status='paid',provider_transfer_id=p_transfer,provider_fee=p_fee,settle_event_id=v_event,
  lease_until=NULL,lease_token=NULL,last_error=NULL,updated_at=now() WHERE id=p_id;
 UPDATE public.driver_withdrawal_submissions SET provider_transfer_id=p_transfer,provider_fee=p_fee WHERE withdrawal_id=p_id;
 RETURN true;
END $$;

-- Accounts may now bind the Kora provider; a completed Kora account's
-- beneficiary identity is the verified 10-digit NUBV account number.
ALTER TABLE public.driver_payment_accounts DROP CONSTRAINT driver_payment_accounts_provider_check;
ALTER TABLE public.driver_payment_accounts ADD CONSTRAINT driver_payment_accounts_provider_check
 CHECK ((provider = ANY (ARRAY['flutterwave'::text, 'paystack'::text, 'kora'::text])));
ALTER TABLE public.driver_payment_accounts DROP CONSTRAINT driver_payment_accounts_completion_check;
ALTER TABLE public.driver_payment_accounts ADD CONSTRAINT driver_payment_accounts_completion_check
 CHECK (((state <> 'completed'::text) OR ((beneficiary_id IS NOT NULL) AND (fingerprint IS NOT NULL) AND (bank_code IS NOT NULL) AND (last4 IS NOT NULL) AND (fingerprint ~ '^[a-f0-9]{64}$'::text)
  AND (((provider = 'flutterwave'::text) AND (beneficiary_id ~ '^\d+$'::text))
   OR ((provider = 'paystack'::text) AND (beneficiary_id ~ '^RCP_[A-Za-z0-9_-]+$'::text))
   OR ((provider = 'kora'::text) AND (beneficiary_id ~ '^\d{10}$'::text))))));
COMMIT;
