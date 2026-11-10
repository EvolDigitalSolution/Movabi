-- Additive approved fee schedules. No merchant, fee or collection enablement.
BEGIN;
DO $$ BEGIN
 IF to_regprocedure('public.confirm_wallet_topup_with_total(uuid,text,text,text,bigint,text)') IS NULL
 OR to_regprocedure('public.freeze_wallet_topup_fee(uuid,text)') IS NULL
 OR to_regclass('public.wallet_topup_fee_policies') IS NULL THEN
 RAISE EXCEPTION 'Fee v2 requires the verified Batch 2A-2D schema'; END IF;
END $$;
-- Durable provider submission store was previously referenced only by source.
CREATE TABLE IF NOT EXISTS public.payment_checkout_attempts (
 reference text PRIMARY KEY,
 request jsonb NOT NULL,
 state text NOT NULL CHECK(state IN ('started','submitted','unknown')),
 checkout_url text,
 created_at timestamptz NOT NULL DEFAULT now()
);
DO $$ DECLARE c record; BEGIN
 FOR c IN SELECT * FROM (VALUES ('reference','text'),('request','jsonb'),('state','text'),('checkout_url','text'),('created_at','timestamptz')) AS required(name,kind) LOOP
  IF NOT EXISTS(SELECT 1 FROM information_schema.columns WHERE table_schema='public' AND table_name='payment_checkout_attempts' AND column_name=c.name AND udt_name=c.kind) THEN
   RAISE EXCEPTION 'Incompatible payment_checkout_attempts column %',c.name;
  END IF;
 END LOOP;
END $$;
ALTER TABLE public.payment_checkout_attempts ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.payment_checkout_attempts FROM PUBLIC,anon,authenticated;
GRANT SELECT,INSERT,UPDATE ON public.payment_checkout_attempts TO service_role;
CREATE TABLE public.wallet_topup_fee_schedules (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
 version text NOT NULL CHECK (btrim(version) <> ''),
 provider text NOT NULL, country_code text NOT NULL, currency_code text NOT NULL,
 method text NOT NULL CHECK (method = 'card'),
 exponent integer NOT NULL CHECK (exponent BETWEEN 0 AND 3),
 fee_basis text NOT NULL CHECK (fee_basis IN ('wallet','total')),
 fee_basis_points integer NOT NULL CHECK (fee_basis_points BETWEEN 0 AND 9999),
 fee_fixed_minor bigint NOT NULL CHECK (fee_fixed_minor BETWEEN 0 AND 9007199254740991),
 fee_cap_minor bigint CHECK (fee_cap_minor BETWEEN 0 AND 9007199254740991),
 rounding text NOT NULL CHECK (rounding IN ('half_up','ceil')),
 approved_by text NOT NULL CHECK (btrim(approved_by) <> ''),
 approved_at timestamptz NOT NULL,
 active boolean NOT NULL DEFAULT false,
 UNIQUE(provider,country_code,currency_code,method,version)
);
CREATE UNIQUE INDEX wallet_topup_fee_schedules_active ON public.wallet_topup_fee_schedules(provider,country_code,currency_code,method) WHERE active;
CREATE FUNCTION public.wallet_fee_schedule_terms_immutable() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF (to_jsonb(NEW)-'active') IS DISTINCT FROM (to_jsonb(OLD)-'active') THEN
 RAISE EXCEPTION 'Create a new approved fee schedule version instead of editing terms' USING ERRCODE='BP007'; END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER wallet_fee_schedule_terms_immutable BEFORE UPDATE ON public.wallet_topup_fee_schedules FOR EACH ROW EXECUTE FUNCTION public.wallet_fee_schedule_terms_immutable();
REVOKE ALL ON public.wallet_topup_fee_schedules FROM PUBLIC, anon, authenticated, service_role;
GRANT SELECT ON public.wallet_topup_fee_schedules TO service_role;
ALTER TABLE public.wallet_topup_attempts ADD COLUMN fee_schedule_id uuid REFERENCES public.wallet_topup_fee_schedules(id);

CREATE FUNCTION public.wallet_scheduled_fee(p_amount numeric, p_rate integer, p_fixed bigint, p_cap bigint, p_rounding text)
RETURNS numeric LANGUAGE sql IMMUTABLE SET search_path=pg_catalog AS $$
 SELECT least(CASE WHEN p_rounding='ceil' THEN ceil(p_amount*p_rate/10000+p_fixed)
 ELSE round(p_amount*p_rate/10000+p_fixed) END, coalesce(p_cap::numeric, 9007199254740992::numeric))
$$;
-- Keep the old freeze for historical callers; new driver attempts require v2.
ALTER FUNCTION public.freeze_wallet_topup_fee(uuid,text) RENAME TO freeze_wallet_topup_fee_v1;
CREATE FUNCTION public.freeze_wallet_topup_fee(p_attempt_id uuid,p_fee_policy_version text)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
DECLARE a public.wallet_topup_attempts%ROWTYPE; p public.wallet_topup_fee_schedules%ROWTYPE;
 lo numeric; hi numeric; mid numeric; total numeric; fee numeric;
BEGIN
 SELECT * INTO a FROM public.wallet_topup_attempts WHERE id=p_attempt_id FOR UPDATE;
 IF NOT FOUND THEN RAISE EXCEPTION 'attempt missing' USING ERRCODE='BP003'; END IF;
 IF a.fee_policy_version IS NOT NULL THEN
   IF a.fee_policy_version IS DISTINCT FROM p_fee_policy_version THEN RAISE EXCEPTION 'conflicting policy' USING ERRCODE='BP002'; END IF;
   RETURN;
 END IF;
 SELECT * INTO p FROM public.wallet_topup_fee_schedules WHERE active AND provider=a.payment_provider
 AND country_code=a.country_code AND currency_code=a.currency_code AND method='card' AND version=p_fee_policy_version FOR SHARE;
 IF NOT FOUND THEN
   IF a.attempt_key LIKE 'driver-topup:%' THEN RAISE EXCEPTION 'approved schedule missing' USING ERRCODE='BP008'; END IF;
   PERFORM public.freeze_wallet_topup_fee_v1(p_attempt_id,p_fee_policy_version); RETURN;
 END IF;
 IF a.status <> 'initiated' OR p.exponent IS DISTINCT FROM public.wallet_currency_minor_exponent(a.currency_code)
 OR a.amount_minor > 9007199254740991 THEN RAISE EXCEPTION 'invalid fee terms' USING ERRCODE='BP008'; END IF;
 IF p.fee_basis='wallet' THEN
   total := a.amount_minor + public.wallet_scheduled_fee(a.amount_minor,p.fee_basis_points,p.fee_fixed_minor,p.fee_cap_minor,p.rounding);
 ELSE
   lo:=a.amount_minor; hi:=9007199254740991;
   IF hi-public.wallet_scheduled_fee(hi,p.fee_basis_points,p.fee_fixed_minor,p.fee_cap_minor,p.rounding)<lo THEN
     RAISE EXCEPTION 'total overflow' USING ERRCODE='BP008';
   END IF;
   WHILE lo<hi LOOP
     mid:=floor((lo+hi)/2);
     IF mid-public.wallet_scheduled_fee(mid,p.fee_basis_points,p.fee_fixed_minor,p.fee_cap_minor,p.rounding)>=a.amount_minor THEN hi:=mid; ELSE lo:=mid+1; END IF;
   END LOOP;
   total:=lo;
 END IF;
 IF total>9007199254740991 THEN RAISE EXCEPTION 'total overflow' USING ERRCODE='BP008'; END IF;
 UPDATE public.wallet_topup_attempts SET provider_fee_minor=total-a.amount_minor,total_charge_minor=total,
 fee_policy_version=p.version,fee_exponent=p.exponent,fee_schedule_id=p.id WHERE id=a.id;
END $$;
REVOKE ALL ON FUNCTION public.freeze_wallet_topup_fee(uuid,text) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.freeze_wallet_topup_fee(uuid,text) TO service_role;
-- The legacy helper cannot bypass the driver schedule requirement.
REVOKE ALL ON FUNCTION public.freeze_wallet_topup_fee_v1(uuid,text) FROM PUBLIC,anon,authenticated,service_role;
CREATE FUNCTION public.wallet_fee_schedule_freeze() RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog,public AS $$
BEGIN
 IF NEW.fee_schedule_id IS DISTINCT FROM OLD.fee_schedule_id AND OLD.fee_policy_version IS NOT NULL THEN
 RAISE EXCEPTION 'immutable fee identity' USING ERRCODE='BP007'; END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER wallet_fee_schedule_freeze BEFORE UPDATE ON public.wallet_topup_attempts FOR EACH ROW EXECUTE FUNCTION public.wallet_fee_schedule_freeze();
COMMIT;
