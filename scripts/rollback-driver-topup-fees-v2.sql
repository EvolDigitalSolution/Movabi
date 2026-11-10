-- Refuse destructive rollback once any v2 financial terms have been frozen.
BEGIN;
LOCK TABLE public.wallet_topup_attempts,public.wallet_topup_fee_schedules IN ACCESS EXCLUSIVE MODE;
DO $$ BEGIN
 IF EXISTS(SELECT 1 FROM public.wallet_topup_attempts WHERE fee_schedule_id IS NOT NULL) THEN
 RAISE EXCEPTION 'Retain v2 schema: frozen financial schedules exist'; END IF;
END $$;
DROP TRIGGER wallet_fee_schedule_freeze ON public.wallet_topup_attempts;
DROP FUNCTION public.wallet_fee_schedule_freeze();
DROP FUNCTION public.freeze_wallet_topup_fee(uuid,text);
ALTER FUNCTION public.freeze_wallet_topup_fee_v1(uuid,text) RENAME TO freeze_wallet_topup_fee;
GRANT EXECUTE ON FUNCTION public.freeze_wallet_topup_fee(uuid,text) TO service_role;
ALTER TABLE public.wallet_topup_attempts DROP COLUMN fee_schedule_id;
DROP TABLE public.wallet_topup_fee_schedules;
DROP FUNCTION public.wallet_fee_schedule_terms_immutable();
DROP FUNCTION public.wallet_scheduled_fee(numeric,integer,bigint,bigint,text);
COMMIT;
