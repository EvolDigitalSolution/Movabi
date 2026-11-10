-- Derive shopping spend from the attributed transaction ledger, never from a receipt total.
CREATE OR REPLACE FUNCTION public.sync_job_issuing_spend(p_job uuid,p_finalize boolean DEFAULT false)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE card text; c public.job_issuing_spend_controls%ROWTYPE; spent numeric; pending boolean; j public.jobs%ROWTYPE;
BEGIN
 SELECT stripe_card_id INTO card FROM public.job_issuing_spend_controls WHERE job_id=p_job;
 IF card IS NULL THEN RETURN jsonb_build_object('automated',false); END IF;
 PERFORM pg_advisory_xact_lock(hashtextextended('issuing-card-'||card,0));
 SELECT * INTO c FROM public.job_issuing_spend_controls WHERE job_id=p_job FOR UPDATE;
 IF NOT FOUND THEN RETURN jsonb_build_object('automated',false); END IF;
 SELECT * INTO STRICT j FROM public.jobs WHERE id=p_job;
 SELECT greatest(0,coalesce(sum(CASE WHEN status='capture' THEN amount WHEN status='refund' THEN -amount ELSE 0 END),0))
 INTO spent FROM public.job_issuing_transactions WHERE job_id=p_job;
 IF spent>c.amount_limit THEN RAISE EXCEPTION 'Shopping card spend requires reconciliation'; END IF;
 UPDATE public.job_issuing_spend_controls SET amount_captured=spent,updated_at=now() WHERE job_id=p_job AND amount_captured IS DISTINCT FROM spent;
 SELECT EXISTS(SELECT 1 FROM public.job_issuing_authorizations a WHERE a.job_id=p_job AND a.approved AND
  (a.status='pending' OR (a.status='closed' AND a.amount>0 AND NOT EXISTS(
    SELECT 1 FROM public.job_issuing_transactions t WHERE t.stripe_authorization_id=a.stripe_authorization_id AND t.status='capture')))) INTO pending;
 IF j.status NOT IN ('completed','cancelled','expired','no_driver_found') THEN
  UPDATE public.errand_details SET actual_spending=spent,updated_at=now() WHERE job_id=p_job AND actual_spending IS DISTINCT FROM spent;
  UPDATE public.errand_funding SET metadata=coalesce(metadata,'{}'::jsonb)||jsonb_build_object('shopping_spend_source','issuing','shopping_spend_pending',pending,'shopping_spend_amount',spent),updated_at=now()
   WHERE job_id=p_job AND (metadata->>'shopping_spend_source' IS DISTINCT FROM 'issuing' OR (metadata->>'shopping_spend_pending') IS DISTINCT FROM pending::text OR metadata->>'shopping_spend_amount' IS DISTINCT FROM spent::text);
 END IF;
 IF p_finalize AND NOT pending THEN UPDATE public.job_issuing_spend_controls SET status='completed',deactivated_at=now(),updated_at=now() WHERE job_id=p_job; END IF;
 RETURN jsonb_build_object('automated',true,'pending',pending,'spent',spent);
END $$;
REVOKE ALL ON FUNCTION public.sync_job_issuing_spend(uuid,boolean) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.sync_job_issuing_spend(uuid,boolean) TO service_role;
NOTIFY pgrst,'reload schema';
