-- Budget increases remain customer-approved and funded; extend only active delivery stages.
CREATE OR REPLACE FUNCTION public.request_errand_over_budget(p_job_id uuid,p_amount numeric,p_reason text DEFAULT NULL::text)
RETURNS boolean LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE j public.jobs%ROWTYPE; f public.errand_funding%ROWTYPE;
BEGIN
 SELECT * INTO STRICT j FROM public.jobs WHERE id=p_job_id FOR UPDATE;
 IF auth.uid() IS DISTINCT FROM j.driver_id AND coalesce(auth.role(),'')<>'service_role' AND session_user NOT IN ('postgres','supabase_admin') THEN RAISE EXCEPTION 'Only the assigned driver can request a budget increase'; END IF;
 IF coalesce(j.payment_status,'') NOT IN ('wallet_funded','authorized') OR j.status NOT IN ('assigned','accepted','heading_to_pickup','arrived','arrived_at_store','shopping_in_progress','collected','en_route_to_customer','in_progress') THEN RAISE EXCEPTION 'Booking is not eligible for a budget increase'; END IF;
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
