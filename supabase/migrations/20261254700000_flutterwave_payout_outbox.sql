BEGIN;
DO $$ BEGIN IF current_database()<>'movabi_develop' THEN RAISE EXCEPTION 'Develop database required'; END IF; END $$;
ALTER TABLE public.jobs ADD COLUMN payout_provider text,ADD COLUMN payout_transfer_id text;
ALTER TABLE public.driver_earnings ADD COLUMN payout_provider text,ADD COLUMN payout_transfer_id text;
CREATE TABLE public.flutterwave_job_submissions(
 job_id uuid PRIMARY KEY REFERENCES public.job_payout_queue(job_id),reference text NOT NULL UNIQUE,
 submitted_at timestamptz NOT NULL DEFAULT now(),provider_transfer_id text UNIQUE,provider_fee numeric CHECK(provider_fee>=0)
);
ALTER TABLE public.flutterwave_job_submissions ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.flutterwave_job_submissions FROM PUBLIC,anon,authenticated,service_role;
GRANT SELECT ON public.flutterwave_job_submissions TO service_role;
CREATE FUNCTION public.guard_flutterwave_payout_terms() RETURNS trigger LANGUAGE plpgsql SET search_path=public,pg_temp AS $$
BEGIN
 IF OLD.terms->>'payout_provider'='flutterwave' AND
  (NEW.terms,NEW.driver_id,NEW.destination,NEW.amount_minor,NEW.currency)
  IS DISTINCT FROM (OLD.terms,OLD.driver_id,OLD.destination,OLD.amount_minor,OLD.currency)
 THEN RAISE EXCEPTION 'Frozen Flutterwave payout terms cannot change'; END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER guard_flutterwave_payout_terms BEFORE UPDATE ON public.job_payout_queue
 FOR EACH ROW EXECUTE FUNCTION public.guard_flutterwave_payout_terms();
REVOKE ALL ON FUNCTION public.guard_flutterwave_payout_terms() FROM PUBLIC,anon,authenticated,service_role;

-- Preserve the existing completion/earnings/wallet authority, extending only its
-- verified destination check. Refuse unexpected deployed source instead of rewriting it.
DO $$ DECLARE source text;old_check text;new_check text; BEGIN
 source:=pg_get_functiondef('public.complete_job_with_pending_payout(uuid,uuid,jsonb,jsonb)'::regprocedure);
 old_check:=$s$IF lower(p_terms->>'currency')<>'gbp' OR (p_terms->>'amountMinor')::bigint<>round(payout*100)::bigint OR coalesce(p_terms->>'destination','') NOT LIKE 'acct_%' THEN RAISE EXCEPTION 'Invalid payout identity'; END IF;$s$;
 new_check:=$s$IF p_terms->>'payout_provider'='flutterwave' THEN
  IF lower(p_terms->>'currency')<>'ngn' OR p_terms->>'country'<>'NG' OR (p_terms->>'amountMinor')::bigint<>round(payout*100)::bigint
   OR NOT EXISTS(SELECT 1 FROM public.driver_payment_accounts a JOIN public.driver_payout_markets m USING(country_code,currency_code)
    JOIN public.profiles p ON p.id=a.driver_id
    WHERE a.id::text=p_terms->>'payout_account_id' AND a.driver_id=p_driver_id AND a.tenant_id=j.tenant_id
    AND a.country_code=j.country_code AND upper(j.currency_code)=a.currency_code AND a.state='completed'
    AND a.tenant_id=p.tenant_id AND p.role='driver' AND p.registration_activated_at IS NOT NULL
    AND coalesce(p.registration_country_code,p.country_code)=a.country_code
    AND p_terms->>'destination'='flw:'||a.id::text AND p_terms->>'payout_tenant'=a.tenant_id::text
    AND a.merchant_account_ref=p_terms->>'payout_merchant' AND m.merchant_account_ref=a.merchant_account_ref
    AND m.provider='flutterwave' AND m.enabled AND m.merchant_approved AND m.adapter_ready AND m.capability_verified_at IS NOT NULL AND m.capability_evidence_ref IS NOT NULL AND m.merchant_mode='test'
    AND m.sandbox_driver_id=p_driver_id AND m.sandbox_tenant_id=j.tenant_id)
  THEN RAISE EXCEPTION 'Invalid sandbox payout identity'; END IF;
 ELSE
  IF coalesce(p_terms->>'payout_provider','stripe')<>'stripe' THEN RAISE EXCEPTION 'Unsupported payout provider'; END IF;
  IF lower(p_terms->>'currency')<>'gbp' OR (p_terms->>'amountMinor')::bigint<>round(payout*100)::bigint OR coalesce(p_terms->>'destination','') NOT LIKE 'acct_%' THEN RAISE EXCEPTION 'Invalid payout identity'; END IF;
 END IF;$s$;
 IF position(old_check IN source)=0 THEN RAISE EXCEPTION 'Completion authority differs; review required'; END IF;
 EXECUTE replace(source,old_check,new_check);
END $$;

CREATE FUNCTION public.claim_flutterwave_job_submission(p_job uuid,p_token uuid,p_reference text)
RETURNS boolean LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE q public.job_payout_queue%ROWTYPE;BEGIN
 PERFORM 1 FROM public.jobs WHERE id=p_job AND status='completed' AND payment_status='paid' FOR UPDATE;
 IF NOT FOUND THEN RETURN false; END IF;
 SELECT * INTO STRICT q FROM public.job_payout_queue WHERE job_id=p_job FOR UPDATE;
 IF q.token IS DISTINCT FROM p_token OR q.status NOT IN('processing','reconcile') OR (q.terms->>'payout_provider') IS DISTINCT FROM 'flutterwave'
  OR p_reference IS DISTINCT FROM 'vaydu-'||p_job::text||'_PMCK' THEN RETURN false; END IF;
 INSERT INTO public.flutterwave_job_submissions(job_id,reference) VALUES(p_job,p_reference) ON CONFLICT(job_id) DO NOTHING;
 RETURN FOUND;
END $$;

CREATE FUNCTION public.finish_flutterwave_job_payout(p_job uuid,p_token uuid,p_reference text,p_transfer text,p_fee numeric)
RETURNS boolean LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE q public.job_payout_queue%ROWTYPE;BEGIN
 PERFORM 1 FROM public.jobs WHERE id=p_job FOR UPDATE;
 SELECT * INTO STRICT q FROM public.job_payout_queue WHERE job_id=p_job FOR UPDATE;
 IF q.status='paid' THEN RETURN q.transfer_id='flw:'||p_transfer; END IF;
 IF q.token IS DISTINCT FROM p_token OR q.status NOT IN('processing','reconcile') OR (q.terms->>'payout_provider') IS DISTINCT FROM 'flutterwave'
  OR p_transfer IS NULL OR p_transfer !~ '^\d+$' OR p_reference IS DISTINCT FROM 'vaydu-'||p_job::text||'_PMCK'
  OR NOT EXISTS(SELECT 1 FROM public.flutterwave_job_submissions WHERE job_id=p_job AND reference=p_reference)
 THEN RETURN false; END IF;
 -- Reuse the established settlement writer and single earnings row. Provider
 -- references occupy separate columns; never disguise a Flutterwave ID as Stripe.
 PERFORM public.record_job_settlement(p_job,q.driver_id,(q.terms->>'total')::numeric,(q.terms->>'payout')::numeric,
  (q.terms->>'platformFee')::numeric,(q.terms->>'commission')::numeric,(q.terms->>'commissionRate')::numeric,
  NULL,upper(q.currency),q.terms->>'country',true);
 UPDATE public.jobs SET payout_provider='flutterwave',payout_transfer_id=p_transfer,stripe_transfer_status=NULL,
  metadata=coalesce(metadata,'{}'::jsonb)||jsonb_build_object('driver_payout_pending',false) WHERE id=p_job;
 UPDATE public.driver_earnings SET payout_provider='flutterwave',payout_transfer_id=p_transfer WHERE job_id=p_job;
 UPDATE public.flutterwave_job_submissions SET provider_transfer_id=p_transfer,provider_fee=p_fee WHERE job_id=p_job;
 UPDATE public.job_payout_queue SET status='paid',transfer_id='flw:'||p_transfer,lease_until=NULL,last_error=NULL,updated_at=now() WHERE job_id=p_job;
 RETURN true;
END $$;
REVOKE ALL ON FUNCTION public.claim_flutterwave_job_submission(uuid,uuid,text),public.finish_flutterwave_job_payout(uuid,uuid,text,text,numeric) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.claim_flutterwave_job_submission(uuid,uuid,text),public.finish_flutterwave_job_payout(uuid,uuid,text,text,numeric) TO service_role;
NOTIFY pgrst,'reload schema';
COMMIT;
