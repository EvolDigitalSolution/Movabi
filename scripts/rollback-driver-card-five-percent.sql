BEGIN;
LOCK TABLE public.wallet_topup_attempts,public.payment_checkout_attempts,public.wallet_topup_provider_observations,public.driver_card_topup_sandbox_scopes IN ACCESS EXCLUSIVE MODE;
DO $$ BEGIN
 IF EXISTS(SELECT 1 FROM public.wallet_topup_attempts WHERE provider_account_id IS NOT NULL OR card_sandbox_scope_id IS NOT NULL)
 OR EXISTS(SELECT 1 FROM public.payment_checkout_attempts WHERE provider_session_id IS NOT NULL)
 OR EXISTS(SELECT 1 FROM public.wallet_topup_provider_observations)
 OR EXISTS(SELECT 1 FROM public.driver_card_topup_sandbox_scopes) THEN
 RAISE EXCEPTION 'Retain reviewed scope and payment evidence; schema rollback refused'; END IF;
END $$;
DO $patch$ DECLARE definition text; BEGIN
 definition:=pg_get_functiondef('public.initiate_wallet_topup(text,uuid,uuid,text,text,bigint,text,text,text,text)'::regprocedure);
 EXECUTE replace(definition,'IF NOT public.wallet_collection_enabled() AND NOT public.driver_card_sandbox_permit(p_tenant_id,p_owner_id,p_country_code,p_currency_code,p_destination_account_purpose,p_payment_provider,p_merchant_account_ref) THEN','IF NOT public.wallet_collection_enabled() THEN');
 definition:=pg_get_functiondef('public.claim_wallet_topup_submission(uuid)'::regprocedure);
 EXECUTE replace(definition,'IF NOT public.wallet_collection_enabled() AND NOT public.driver_card_sandbox_attempt_permit(p_attempt_id) THEN','IF NOT public.wallet_collection_enabled() THEN');
END $patch$;
DROP FUNCTION public.driver_card_sandbox_attempt_permit(uuid);
DROP FUNCTION public.driver_card_sandbox_permit(uuid,uuid,text,text,text,text,text);
DROP FUNCTION public.driver_card_sandbox_enabled();
DROP TRIGGER driver_card_attempt_scope_freeze ON public.wallet_topup_attempts;
DROP FUNCTION public.driver_card_attempt_scope_freeze();
DROP FUNCTION public.freeze_wallet_topup_fee(uuid,text);
ALTER FUNCTION public.freeze_wallet_topup_fee_v2(uuid,text) RENAME TO freeze_wallet_topup_fee;
GRANT EXECUTE ON FUNCTION public.freeze_wallet_topup_fee(uuid,text) TO service_role;
DROP FUNCTION public.record_driver_topup_provider_observation(uuid,jsonb);
DROP TABLE public.wallet_topup_provider_observations;
ALTER TABLE public.payment_checkout_attempts DROP COLUMN provider_session_id;
ALTER TABLE public.wallet_topup_attempts DROP COLUMN card_sandbox_scope_id,DROP COLUMN provider_account_id;
DROP TABLE public.driver_card_topup_sandbox_scopes;
DROP FUNCTION public.driver_card_scope_freeze();
DROP TABLE public.driver_card_fee_policy_versions;
COMMIT;
