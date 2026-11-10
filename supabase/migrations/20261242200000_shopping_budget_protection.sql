-- New shopping reservation and replacement authorization records are service-only.
CREATE TABLE public.job_issuing_reserves (
 job_id uuid PRIMARY KEY REFERENCES public.jobs(id), currency text NOT NULL,
 amount_remaining numeric NOT NULL CHECK(amount_remaining>=0), updated_at timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE public.job_issuing_reserves ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.job_issuing_reserves FROM PUBLIC,anon,authenticated;
GRANT ALL ON public.job_issuing_reserves TO service_role;
CREATE TABLE public.job_budget_authorizations (
 id uuid PRIMARY KEY, job_id uuid NOT NULL REFERENCES public.jobs(id),
 old_intent_id text NOT NULL, new_intent_id text UNIQUE, total_budget numeric NOT NULL CHECK(total_budget>0),
 status text NOT NULL DEFAULT 'created' CHECK(status IN ('created','approved','abandoned')),
 cleanup_done boolean NOT NULL DEFAULT false, created_at timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE public.job_budget_authorizations ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.job_budget_authorizations FROM PUBLIC,anon,authenticated;
GRANT ALL ON public.job_budget_authorizations TO service_role;

CREATE FUNCTION public.reserve_job_issuing_budget(p_job uuid,p_budget numeric,p_available numeric,p_currency text)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE j public.jobs%ROWTYPE; spent numeric; needed numeric; others numeric;
BEGIN
 PERFORM pg_advisory_xact_lock(hashtextextended('issuing-reserve-'||lower(p_currency),0));
 SELECT * INTO STRICT j FROM public.jobs WHERE id=p_job FOR UPDATE;
 IF lower(j.currency_code)<>lower(p_currency) OR j.payment_status NOT IN ('authorized','wallet_funded','paid')
 OR j.status IN ('completed','settled','cancelled','canceled','expired','failed','no_driver_found')
 OR p_budget IS NULL OR p_budget<=0 OR p_available IS NULL OR p_available<0 THEN
  RAISE EXCEPTION 'Invalid shopping reserve';
 END IF;
 SELECT greatest(coalesce(amount_captured,0),coalesce(amount_authorized,0)) INTO spent
 FROM public.job_issuing_spend_controls WHERE job_id=p_job;
 -- Conservatively retain pending card holds; Stripe also deducts them from available funds.
 needed:=greatest(0,p_budget-coalesce(spent,0));
 SELECT coalesce(sum(r.amount_remaining),0) INTO others FROM public.job_issuing_reserves r
 JOIN public.jobs x ON x.id=r.job_id WHERE r.job_id<>p_job AND lower(r.currency)=lower(p_currency)
 AND x.status NOT IN ('completed','settled','cancelled','canceled','expired','failed','no_driver_found');
 IF needed+others>p_available THEN RAISE EXCEPTION 'Movabi shopping funds cannot cover this budget yet'; END IF;
 INSERT INTO public.job_issuing_reserves(job_id,currency,amount_remaining) VALUES(p_job,lower(p_currency),needed)
 ON CONFLICT(job_id) DO UPDATE SET amount_remaining=excluded.amount_remaining,updated_at=now();
END $$;

CREATE FUNCTION public.approve_card_errand_budget(p_job uuid,p_request uuid,p_old_intent text,p_new_intent text,p_budget numeric,p_available numeric,p_currency text)
RETURNS boolean LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE j public.jobs%ROWTYPE; f public.errand_funding%ROWTYPE; a public.job_budget_authorizations%ROWTYPE;
BEGIN
 -- Keep reserve currency lock before job lock, as used by activation.
 PERFORM pg_advisory_xact_lock(hashtextextended('issuing-reserve-'||lower(p_currency),0));
 SELECT * INTO STRICT j FROM public.jobs WHERE id=p_job FOR UPDATE;
 SELECT * INTO STRICT f FROM public.errand_funding WHERE job_id=p_job FOR UPDATE;
 SELECT * INTO STRICT a FROM public.job_budget_authorizations WHERE id=p_request FOR UPDATE;
 IF a.status='approved' AND a.new_intent_id=p_new_intent THEN RETURN TRUE; END IF;
 IF a.job_id<>p_job OR a.new_intent_id IS DISTINCT FROM p_new_intent OR a.old_intent_id<>p_old_intent
 OR a.total_budget<>p_budget OR a.status<>'created' OR j.payment_method IS DISTINCT FROM 'card' OR j.payment_status IS DISTINCT FROM 'authorized'
 OR j.payment_intent_id IS DISTINCT FROM p_old_intent OR f.over_budget_status IS DISTINCT FROM 'requested'
 OR f.requested_over_budget_amount<>p_budget OR (f.metadata->>'budget_request_id')::uuid IS DISTINCT FROM p_request THEN
  RAISE EXCEPTION 'Budget request changed; approval requires review';
 END IF;
 PERFORM public.reserve_job_issuing_budget(p_job,p_budget,p_available,p_currency);
 UPDATE public.errand_funding SET item_budget=p_budget,amount_reserved=p_budget,status='reserved',over_budget_status='approved',
 metadata=coalesce(metadata,'{}'::jsonb)||jsonb_build_object('item_budget',p_budget),updated_at=now() WHERE job_id=p_job;
 UPDATE public.jobs SET payment_intent_id=p_new_intent,updated_at=now() WHERE id=p_job;
 UPDATE public.job_budget_authorizations SET status='approved' WHERE id=p_request;
 RETURN TRUE;
END $$;

CREATE FUNCTION public.record_issuing_authorization_request(p_card text,p_authorization text,p_amount numeric,p_currency text,p_event jsonb)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE c public.job_issuing_spend_controls%ROWTYPE; a public.job_issuing_authorizations%ROWTYPE; ok boolean; j public.jobs%ROWTYPE;
BEGIN
 PERFORM pg_advisory_xact_lock(hashtextextended('issuing-card-'||p_card,0));
 SELECT * INTO c FROM public.job_issuing_spend_controls WHERE stripe_card_id=p_card AND status='active' ORDER BY updated_at DESC LIMIT 1 FOR UPDATE;
 IF NOT FOUND THEN RETURN jsonb_build_object('approved',false); END IF;
 SELECT * INTO a FROM public.job_issuing_authorizations WHERE stripe_authorization_id=p_authorization;
 IF FOUND THEN RETURN jsonb_build_object('approved',a.approved AND a.job_id=c.job_id AND a.amount=p_amount AND lower(a.currency_code)=lower(p_currency)); END IF;
 SELECT * INTO STRICT j FROM public.jobs WHERE id=c.job_id;
 ok:=p_amount>0 AND lower(p_currency)=lower(c.currency_code) AND j.driver_id=c.driver_id
 AND j.payment_status IN ('authorized','wallet_funded','paid')
 AND j.status NOT IN ('completed','settled','cancelled','canceled','expired','failed','no_driver_found')
 AND EXISTS(SELECT 1 FROM public.job_issuing_reserves r WHERE r.job_id=c.job_id AND lower(r.currency)=lower(p_currency))
 AND c.amount_authorized+p_amount<=c.amount_limit;
 INSERT INTO public.job_issuing_authorizations(stripe_authorization_id,job_id,driver_id,stripe_card_id,amount,currency_code,approved,merchant_name,merchant_category,status,raw_event)
 VALUES(p_authorization,c.job_id,c.driver_id,p_card,p_amount,upper(p_currency),ok,p_event#>>'{merchant_data,name}',p_event#>>'{merchant_data,category}',p_event->>'status',p_event);
 IF ok THEN UPDATE public.job_issuing_spend_controls SET amount_authorized=amount_authorized+p_amount,updated_at=now() WHERE id=c.id; END IF;
 RETURN jsonb_build_object('approved',ok,'metadata',jsonb_build_object('job_id',c.job_id,'decision',CASE WHEN ok THEN 'within_job_budget' ELSE 'budget_or_payment_unavailable' END));
END $$;

CREATE FUNCTION public.record_issuing_transaction(p_id text,p_authorization text,p_card text,p_amount numeric,p_currency text,p_type text,p_event jsonb)
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
END $$;
REVOKE ALL ON FUNCTION public.reserve_job_issuing_budget(uuid,numeric,numeric,text),public.approve_card_errand_budget(uuid,uuid,text,text,numeric,numeric,text),public.record_issuing_authorization_request(text,text,numeric,text,jsonb),public.record_issuing_transaction(text,text,text,numeric,text,text,jsonb) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.reserve_job_issuing_budget(uuid,numeric,numeric,text),public.approve_card_errand_budget(uuid,uuid,text,text,numeric,numeric,text),public.record_issuing_authorization_request(text,text,numeric,text,jsonb),public.record_issuing_transaction(text,text,text,numeric,text,text,jsonb) TO service_role;

CREATE OR REPLACE FUNCTION public.request_errand_over_budget(p_job_id uuid,p_amount numeric,p_reason text DEFAULT NULL::text)
RETURNS boolean LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE j public.jobs%ROWTYPE; f public.errand_funding%ROWTYPE;
BEGIN
 SELECT * INTO STRICT j FROM public.jobs WHERE id=p_job_id FOR UPDATE;
 IF auth.uid() IS DISTINCT FROM j.driver_id AND coalesce(auth.role(),'')<>'service_role' AND session_user NOT IN ('postgres','supabase_admin') THEN RAISE EXCEPTION 'Only the assigned driver can request a budget increase'; END IF;
 IF coalesce(j.payment_status,'') NOT IN ('wallet_funded','authorized') OR j.status NOT IN ('assigned','accepted','heading_to_pickup','arrived','arrived_at_store','shopping_in_progress','in_progress') THEN RAISE EXCEPTION 'Booking is not eligible for a budget increase'; END IF;
 SELECT * INTO STRICT f FROM public.errand_funding WHERE job_id=j.id FOR UPDATE;
 IF f.item_budget<=0 THEN
  SELECT coalesce(estimated_budget,0) INTO f.item_budget FROM public.errand_details WHERE job_id=j.id;
  UPDATE public.errand_funding SET item_budget=coalesce(f.item_budget,0) WHERE job_id=j.id;
 END IF;
 IF f.over_budget_status='requested' THEN
   IF f.requested_over_budget_amount=round(p_amount,2) AND f.over_budget_reason=p_reason THEN RETURN TRUE; END IF;
   RAISE EXCEPTION 'Resolve the current budget request before making another';
 END IF;
 IF f.status NOT IN ('reserved','approved','over_budget_requested') OR p_amount IS NULL OR round(p_amount,2)<=f.item_budget OR length(trim(coalesce(p_reason,'')))<3 THEN RAISE EXCEPTION 'Invalid budget increase'; END IF;
 UPDATE public.errand_funding SET status='over_budget_requested',over_budget_status='requested',requested_over_budget_amount=round(p_amount,2),over_budget_amount=round(p_amount-f.item_budget,2),over_budget_reason=p_reason,metadata=coalesce(metadata,'{}'::jsonb)||jsonb_build_object('budget_request_id',gen_random_uuid()),updated_at=now() WHERE job_id=j.id;
 RETURN TRUE;
END $$;

NOTIFY pgrst,'reload schema';
CREATE FUNCTION public.activate_job_issuing_control(p_job uuid,p_card text,p_budget numeric,p_metadata jsonb)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE j public.jobs%ROWTYPE;
BEGIN
 PERFORM pg_advisory_xact_lock(hashtextextended('issuing-card-'||p_card,0));
 SELECT * INTO STRICT j FROM public.jobs WHERE id=p_job;
 IF EXISTS(SELECT 1 FROM public.job_issuing_spend_controls c JOIN public.jobs x ON x.id=c.job_id
   WHERE c.stripe_card_id=p_card AND c.job_id<>p_job AND c.status='active'
   AND x.status NOT IN ('completed','settled','cancelled','canceled','expired','failed','no_driver_found')) THEN
  RAISE EXCEPTION 'Card is already assigned to another active shopping job';
 END IF;
 UPDATE public.job_issuing_spend_controls SET status='pending',updated_at=now() WHERE stripe_card_id=p_card AND job_id<>p_job AND status='active';
 INSERT INTO public.job_issuing_spend_controls(job_id,driver_id,customer_id,tenant_id,stripe_card_id,amount_limit,currency_code,status,metadata,activated_at)
 VALUES(j.id,j.driver_id,j.customer_id,j.tenant_id,p_card,p_budget,j.currency_code,'active',p_metadata,now())
 ON CONFLICT(job_id) DO UPDATE SET stripe_card_id=excluded.stripe_card_id,amount_limit=excluded.amount_limit,
 status='active',metadata=excluded.metadata,updated_at=now();
END $$;
REVOKE ALL ON FUNCTION public.activate_job_issuing_control(uuid,text,numeric,jsonb) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.activate_job_issuing_control(uuid,text,numeric,jsonb) TO service_role;
NOTIFY pgrst,'reload schema';

CREATE FUNCTION public.shopping_authorizations_pending_cleanup()
RETURNS SETOF public.job_budget_authorizations LANGUAGE sql SECURITY DEFINER SET search_path=public,pg_temp AS $$
 SELECT a.* FROM public.job_budget_authorizations a JOIN public.jobs j ON j.id=a.job_id
 JOIN public.errand_funding f ON f.job_id=a.job_id WHERE NOT a.cleanup_done
 AND (a.status='approved' OR j.status IN ('completed','settled','cancelled','canceled','expired','failed')
 OR f.over_budget_status='rejected' OR f.metadata->>'budget_request_id' IS DISTINCT FROM a.id::text)
 ORDER BY a.created_at LIMIT 50
$$;
REVOKE ALL ON FUNCTION public.shopping_authorizations_pending_cleanup() FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.shopping_authorizations_pending_cleanup() TO service_role;
NOTIFY pgrst,'reload schema';
