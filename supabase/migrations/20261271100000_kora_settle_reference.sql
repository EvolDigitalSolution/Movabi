-- Kora settle identity correction (develop scope).
--
-- 202612709 guessed a Kora-shaped transfer id (KPY-D-...) for settle
-- validation. Verified against the official Payout API: Kora assigns no
-- separate payout identifier. The merchant-supplied `reference` is echoed in
-- every response (`data.reference`) and is the query key for
-- GET /merchant/api/v1/transactions/:reference. The `KPY-...` strings in the
-- documentation are Kora's own *example* merchant references, not a returned
-- id. `trace_id` is an internal Kora trace, not a settle identity.
--
-- Correct rule: a Kora withdrawal settles only when the provider-confirmed
-- reference IS the frozen submission reference for this withdrawal — i.e.
-- Kora reports the exact transaction we submitted. The simulated-adapter
-- evidence that produced KPY-D-9901 was a fixture artifact, not a provider
-- response.
BEGIN;
DO $$ BEGIN
 IF current_database()<>'movabi_develop' THEN RAISE EXCEPTION 'Develop database required'; END IF;
 IF to_regprocedure('public.finish_driver_withdrawal(uuid,uuid,text,numeric)') IS NULL
  OR to_regclass('public.driver_withdrawal_submissions') IS NULL THEN
  RAISE EXCEPTION 'Kora settle reference requires the withdrawal settlement chain'; END IF;
END $$;

CREATE OR REPLACE FUNCTION public.finish_driver_withdrawal(p_id uuid,p_lease uuid,p_transfer text,p_fee numeric)
RETURNS boolean LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE w public.driver_withdrawals%ROWTYPE; v_event uuid;BEGIN
 SELECT * INTO STRICT w FROM public.driver_withdrawals WHERE id=p_id FOR UPDATE;
 IF w.status='paid' THEN RETURN w.provider_transfer_id=p_transfer;END IF;
 IF w.lease_token IS DISTINCT FROM p_lease OR w.status NOT IN('processing','reconcile')
  OR p_transfer IS NULL
  OR NOT (CASE w.provider WHEN 'flutterwave' THEN p_transfer ~ '^\d+$'
          WHEN 'kora' THEN p_transfer = (SELECT s.reference FROM public.driver_withdrawal_submissions s WHERE s.withdrawal_id=p_id)
          ELSE false END)
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
REVOKE ALL ON FUNCTION public.finish_driver_withdrawal(uuid,uuid,text,numeric) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.finish_driver_withdrawal(uuid,uuid,text,numeric) TO service_role;
COMMIT;
