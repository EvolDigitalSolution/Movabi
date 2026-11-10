BEGIN;
DO $$ BEGIN IF current_database()<>'movabi_develop' OR to_regclass('public.driver_payout_markets') IS NULL
 OR to_regclass('public.job_payout_queue') IS NULL THEN RAISE EXCEPTION 'Verified develop payout/schema prerequisites required'; END IF;END $$;
CREATE TABLE public.driver_collection_markets(
 country_code text NOT NULL,currency_code text NOT NULL,provider text NOT NULL,environment text NOT NULL DEFAULT 'test' CHECK(environment='test'),
 merchant_account_ref text,sandbox_driver_id uuid,sandbox_tenant_id uuid,
 setup_approved boolean NOT NULL DEFAULT false,adapter_ready boolean NOT NULL DEFAULT false,f4b_approved boolean NOT NULL DEFAULT false,
 capability_evidence_ref text,default_split_type text CHECK(default_split_type IN('flat','percentage')),default_split_value numeric CHECK(default_split_value>=0),
 split_collection_approved boolean NOT NULL DEFAULT false,split_semantics_verified boolean NOT NULL DEFAULT false,
 fee_passing_verified boolean NOT NULL DEFAULT false,settlement_verified boolean NOT NULL DEFAULT false,
 provider_fee_budget_minor bigint CHECK(provider_fee_budget_minor>=0),max_charge_minor bigint CHECK(max_charge_minor>0),
 PRIMARY KEY(country_code,currency_code),
 CHECK(NOT setup_approved OR (provider='flutterwave' AND country_code='NG' AND currency_code='NGN' AND merchant_account_ref IS NOT NULL
  AND sandbox_driver_id IS NOT NULL AND sandbox_tenant_id IS NOT NULL AND adapter_ready AND capability_evidence_ref IS NOT NULL
  AND default_split_type IS NOT NULL AND default_split_value IS NOT NULL)),
 CHECK(default_split_type<>'percentage' OR default_split_value<=1),
 CHECK(NOT split_collection_approved OR (setup_approved AND split_semantics_verified AND fee_passing_verified AND settlement_verified
  AND provider_fee_budget_minor IS NOT NULL AND max_charge_minor IS NOT NULL))
);
INSERT INTO public.driver_collection_markets(country_code,currency_code,provider,merchant_account_ref)
 SELECT country_code,currency_code,provider,merchant_account_ref FROM public.driver_payout_markets;
CREATE TABLE public.driver_collection_subaccounts(
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),driver_id uuid NOT NULL REFERENCES public.profiles(id),tenant_id uuid NOT NULL,
 country_code text NOT NULL DEFAULT 'NG' CHECK(country_code='NG'),currency_code text NOT NULL DEFAULT 'NGN' CHECK(currency_code='NGN'),
 provider text NOT NULL DEFAULT 'flutterwave' CHECK(provider='flutterwave'),environment text NOT NULL DEFAULT 'test' CHECK(environment='test'),
 merchant_account_ref text NOT NULL,account_type text NOT NULL CHECK(account_type IN('bank','flutterwave')),
 request_hash text NOT NULL CHECK(request_hash ~ '^[a-f0-9]{64}$'),destination_hash text NOT NULL CHECK(destination_hash ~ '^[a-f0-9]{64}$'),
 last4 text NOT NULL CHECK(last4 ~ '^\d{4}$'),default_split_type text NOT NULL,default_split_value numeric NOT NULL,
 state text NOT NULL DEFAULT 'in_progress' CHECK(state IN('in_progress','action_required','completed','unavailable')),
 subaccount_id text,provider_numeric_id text,verification text CHECK(verification='retrieved'),updated_at timestamptz NOT NULL DEFAULT now(),
 UNIQUE(driver_id,tenant_id,country_code,currency_code,merchant_account_ref,environment),
 UNIQUE(merchant_account_ref,environment,subaccount_id),
 CHECK(state<>'completed' OR (subaccount_id IS NOT NULL AND subaccount_id ~ '^RS_[A-Za-z0-9]+$' AND provider_numeric_id IS NOT NULL AND verification IS NOT NULL))
);
ALTER TABLE public.driver_collection_markets ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.driver_collection_subaccounts ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.driver_collection_markets,public.driver_collection_subaccounts FROM PUBLIC,anon,authenticated,service_role;
GRANT SELECT ON public.driver_collection_markets TO service_role;
GRANT SELECT ON public.driver_collection_subaccounts TO service_role;
GRANT UPDATE(state,subaccount_id,provider_numeric_id,verification,updated_at) ON public.driver_collection_subaccounts TO service_role;
CREATE FUNCTION public.guard_collection_subaccount_identity() RETURNS trigger LANGUAGE plpgsql SET search_path=public,pg_temp AS $$
BEGIN
 IF (to_jsonb(NEW)-ARRAY['state','subaccount_id','provider_numeric_id','verification','updated_at']) IS DISTINCT FROM
    (to_jsonb(OLD)-ARRAY['state','subaccount_id','provider_numeric_id','verification','updated_at'])
  OR (OLD.subaccount_id IS NOT NULL AND (NEW.subaccount_id,NEW.provider_numeric_id) IS DISTINCT FROM (OLD.subaccount_id,OLD.provider_numeric_id))
 THEN RAISE EXCEPTION 'Collection setup terms/reference are immutable';END IF;RETURN NEW;
END $$;
CREATE TRIGGER guard_collection_subaccount_identity BEFORE UPDATE ON public.driver_collection_subaccounts FOR EACH ROW EXECUTE FUNCTION public.guard_collection_subaccount_identity();
REVOKE ALL ON FUNCTION public.guard_collection_subaccount_identity() FROM PUBLIC,anon,authenticated,service_role;
CREATE FUNCTION public.claim_driver_collection_subaccount(p_driver uuid,p_tenant uuid,p_merchant text,p_request_hash text,p_destination_hash text,p_account_type text,p_last4 text)
RETURNS SETOF public.driver_collection_subaccounts LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE m public.driver_collection_markets%ROWTYPE;BEGIN
 SELECT * INTO STRICT m FROM public.driver_collection_markets WHERE country_code='NG' AND currency_code='NGN' AND provider='flutterwave'
  AND environment='test' AND merchant_account_ref=p_merchant AND sandbox_driver_id=p_driver AND sandbox_tenant_id=p_tenant
  AND setup_approved AND adapter_ready AND capability_evidence_ref IS NOT NULL;
 IF NOT EXISTS(SELECT 1 FROM public.profiles WHERE id=p_driver AND role='driver' AND tenant_id=p_tenant AND registration_activated_at IS NOT NULL
  AND coalesce(registration_country_code,country_code)='NG') OR (p_account_type='flutterwave' AND NOT m.f4b_approved)
 THEN RAISE EXCEPTION 'Approved driver/account type required';END IF;
 RETURN QUERY INSERT INTO public.driver_collection_subaccounts(driver_id,tenant_id,merchant_account_ref,request_hash,destination_hash,account_type,last4,default_split_type,default_split_value)
 VALUES(p_driver,p_tenant,p_merchant,p_request_hash,p_destination_hash,p_account_type,p_last4,m.default_split_type,m.default_split_value)
 ON CONFLICT(driver_id,tenant_id,country_code,currency_code,merchant_account_ref,environment) DO NOTHING RETURNING *;
END $$;
REVOKE ALL ON FUNCTION public.claim_driver_collection_subaccount(uuid,uuid,text,text,text,text,text) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.claim_driver_collection_subaccount(uuid,uuid,text,text,text,text,text) TO service_role;

-- A job chooses exactly one settlement authority before any provider submission.
CREATE TABLE public.job_settlement_methods(
 job_id uuid PRIMARY KEY REFERENCES public.jobs(id),method text NOT NULL CHECK(method IN('transfer','split')),
 terms jsonb NOT NULL,state text NOT NULL DEFAULT 'reserved' CHECK(state IN('reserved','submitting','checkout','collected','settled','cancelled','refund_review')),
 reference text UNIQUE,provider_transaction_id text UNIQUE,checkout_url text,collection_evidence jsonb,settlement_evidence jsonb,created_at timestamptz NOT NULL DEFAULT now()
);
INSERT INTO public.job_settlement_methods(job_id,method,terms,state)
 SELECT job_id,'transfer',terms,CASE WHEN status='paid' THEN 'settled' ELSE 'reserved' END FROM public.job_payout_queue;
ALTER TABLE public.job_settlement_methods ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.job_settlement_methods FROM PUBLIC,anon,authenticated,service_role;
GRANT SELECT ON public.job_settlement_methods TO service_role;
CREATE FUNCTION public.guard_job_transfer_method() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
BEGIN
 PERFORM 1 FROM public.jobs WHERE id=NEW.job_id FOR UPDATE;
 IF EXISTS(SELECT 1 FROM public.jobs WHERE id=NEW.job_id AND country_code='NG' AND (metadata->>'driver_settlement_method') IS DISTINCT FROM 'transfer')
 THEN RAISE EXCEPTION 'An explicit transfer method is required for a new NG payout';END IF;
 INSERT INTO public.job_settlement_methods(job_id,method,terms) VALUES(NEW.job_id,'transfer',NEW.terms) ON CONFLICT(job_id) DO NOTHING;
 IF NOT EXISTS(SELECT 1 FROM public.job_settlement_methods WHERE job_id=NEW.job_id AND method='transfer')
 THEN RAISE EXCEPTION 'Split settlement owns these earnings; a transfer is forbidden';END IF;RETURN NEW;
END $$;
CREATE TRIGGER guard_job_transfer_method BEFORE INSERT ON public.job_payout_queue FOR EACH ROW EXECUTE FUNCTION public.guard_job_transfer_method();
REVOKE ALL ON FUNCTION public.guard_job_transfer_method() FROM PUBLIC,anon,authenticated,service_role;
CREATE FUNCTION public.guard_payout_job_identity() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN IF NEW.job_id IS DISTINCT FROM OLD.job_id THEN RAISE EXCEPTION 'Payout job identity cannot change';END IF;RETURN NEW;END $$;
CREATE TRIGGER guard_payout_job_identity BEFORE UPDATE OF job_id ON public.job_payout_queue FOR EACH ROW EXECUTE FUNCTION public.guard_payout_job_identity();
REVOKE ALL ON FUNCTION public.guard_payout_job_identity() FROM PUBLIC,anon,authenticated,service_role;
CREATE FUNCTION public.guard_split_refund() RETURNS trigger LANGUAGE plpgsql SET search_path=public,pg_temp AS $$
BEGIN
 PERFORM 1 FROM public.jobs WHERE id=NEW.job_id FOR UPDATE;
 IF EXISTS(SELECT 1 FROM public.job_settlement_methods WHERE job_id=NEW.job_id AND method='split')
 THEN RAISE EXCEPTION 'Split refund requires provider allocation/reversal reconciliation; generic Stripe refund forbidden';END IF;RETURN NEW;
END $$;
CREATE TRIGGER guard_split_refund BEFORE INSERT ON public.refund_operations FOR EACH ROW EXECUTE FUNCTION public.guard_split_refund();
CREATE FUNCTION public.guard_split_job_changes() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE s public.job_settlement_methods%ROWTYPE;BEGIN
 SELECT * INTO s FROM public.job_settlement_methods WHERE job_id=OLD.id AND method='split';IF NOT FOUND THEN RETURN NEW;END IF;
 IF (NEW.driver_id,NEW.customer_id,NEW.tenant_id,NEW.country_code,NEW.currency_code,NEW.agreed_fare,NEW.fare_breakdown,NEW.payment_method,NEW.no_show_status)
  IS DISTINCT FROM (OLD.driver_id,OLD.customer_id,OLD.tenant_id,OLD.country_code,OLD.currency_code,OLD.agreed_fare,OLD.fare_breakdown,OLD.payment_method,OLD.no_show_status)
 OR (NEW.price IS DISTINCT FROM OLD.price AND NEW.price IS DISTINCT FROM (s.terms->>'totalMinor')::numeric/100)
  OR (NEW.total_price IS DISTINCT FROM OLD.total_price AND NEW.total_price IS DISTINCT FROM (s.terms->>'totalMinor')::numeric/100)
  OR (NEW.metadata->>'driver_settlement_method') IS DISTINCT FROM (OLD.metadata->>'driver_settlement_method')
 THEN RAISE EXCEPTION 'Frozen split fare/identity cannot change; reconcile cancellation/refund first';END IF;
 IF NEW.status IN('cancelled','canceled') AND NEW.status IS DISTINCT FROM OLD.status THEN
  UPDATE public.job_settlement_methods SET state=CASE WHEN s.state='reserved' THEN 'cancelled' ELSE 'refund_review' END WHERE job_id=OLD.id;
 ELSIF NEW.status IS DISTINCT FROM OLD.status THEN RAISE EXCEPTION 'Split booking state requires reconciliation';END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER guard_split_job_changes BEFORE UPDATE ON public.jobs FOR EACH ROW EXECUTE FUNCTION public.guard_split_job_changes();
REVOKE ALL ON FUNCTION public.guard_split_refund(),public.guard_split_job_changes() FROM PUBLIC,anon,authenticated,service_role;
NOTIFY pgrst,'reload schema';
COMMIT;
