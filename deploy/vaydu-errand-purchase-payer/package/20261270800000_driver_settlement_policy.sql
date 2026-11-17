-- Trusted server policy for the NG settlement method (develop scope).
--
-- The settlement method (transfer | wallet) is assigned by server policy, not
-- by jobs.metadata: booking create accepts a client-supplied metadata blob, so
-- a metadata key can never be trusted to route money. This migration adds a
-- service-role-owned preference per driver, a resolver the completion path and
-- the queue guard both consult, and re-derives the frozen method from policy
-- alone. 'split' jobs are unaffected — they never enter job_payout_queue.
BEGIN;
DO $$ BEGIN
 IF current_database()<>'movabi_develop' THEN RAISE EXCEPTION 'Develop database required'; END IF;
 IF to_regclass('public.job_settlement_methods') IS NULL OR to_regclass('public.driver_withdrawals') IS NULL
 THEN RAISE EXCEPTION 'Settlement policy requires the wallet-settlement chain (202612707)'; END IF;
END $$;

-- Server-owned preference. Drivers may ask to be paid by transfer or to accrue
-- a withdrawable wallet balance; only service_role writes, and 'wallet' is
-- validated against an activated NG driver. Absence of a row means 'transfer'.
CREATE TABLE public.driver_payout_preferences(
 driver_id uuid PRIMARY KEY REFERENCES public.profiles(id),
 method text NOT NULL CHECK(method IN('transfer','wallet')),
 updated_at timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE public.driver_payout_preferences ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.driver_payout_preferences FROM PUBLIC,anon,authenticated,service_role;
GRANT SELECT ON public.driver_payout_preferences TO service_role;

CREATE FUNCTION public.set_driver_settlement_preference(p_driver uuid,p_method text)
RETURNS public.driver_payout_preferences LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE pr public.profiles%ROWTYPE; row_out public.driver_payout_preferences%ROWTYPE;BEGIN
 IF p_method NOT IN('transfer','wallet') THEN RAISE EXCEPTION 'Unknown settlement method';END IF;
 SELECT * INTO STRICT pr FROM public.profiles WHERE id=p_driver AND role='driver' AND registration_activated_at IS NOT NULL FOR UPDATE;
 IF p_method='wallet' AND coalesce(pr.registration_country_code,pr.country_code)<>'NG'
 THEN RAISE EXCEPTION 'Wallet settlement is only defined for NG drivers';END IF;
 INSERT INTO public.driver_payout_preferences(driver_id,method) VALUES(p_driver,p_method)
 ON CONFLICT(driver_id) DO UPDATE SET method=EXCLUDED.method,updated_at=now() RETURNING * INTO row_out;
 RETURN row_out;
END $$;

-- The single resolver every money path consults. Never reads jobs.metadata:
-- non-NG drivers and drivers without a preference settle by 'transfer'.
CREATE FUNCTION public.resolve_driver_settlement_method(p_driver uuid)
RETURNS text LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE pr public.profiles%ROWTYPE; m text;BEGIN
 SELECT * INTO STRICT pr FROM public.profiles WHERE id=p_driver AND role='driver';
 IF coalesce(pr.registration_country_code,pr.country_code)<>'NG' THEN RETURN 'transfer';END IF;
 SELECT d.method INTO m FROM public.driver_payout_preferences d WHERE d.driver_id=p_driver;
 RETURN coalesce(m,'transfer');
END $$;

-- The queue guard derives the method from policy at freeze time. Client
-- metadata is ignored entirely: a 'wallet' metadata key cannot create a wallet
-- entitlement, and its absence cannot force a transfer.
CREATE OR REPLACE FUNCTION public.guard_job_transfer_method() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE m text;chosen text; BEGIN
 PERFORM 1 FROM public.jobs WHERE id=NEW.job_id FOR UPDATE;
 SELECT public.resolve_driver_settlement_method(NEW.driver_id) INTO m;
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

REVOKE ALL ON FUNCTION public.set_driver_settlement_preference(uuid,text),
 public.resolve_driver_settlement_method(uuid) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.set_driver_settlement_preference(uuid,text),
 public.resolve_driver_settlement_method(uuid) TO service_role;
COMMIT;
