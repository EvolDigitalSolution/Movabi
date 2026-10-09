-- Atomic wallet booking activation and reservation lifecycle.
-- Apply to develop only after the isolated regression suite passes.
BEGIN;
DO $$ BEGIN
 IF to_regprocedure('public.finalize_job_payment(uuid,text,text,text,numeric,boolean,timestamptz,timestamptz,integer,bigint,text)') IS NULL THEN
  RAISE EXCEPTION 'Canonical payment finalizer missing';
 END IF;
 IF EXISTS (SELECT 1 FROM public.wallet_transactions WHERE transaction_type='settlement' AND job_id IS NOT NULL GROUP BY job_id,user_id HAVING count(*)>1) THEN
  RAISE EXCEPTION 'Duplicate settlements require reconciliation before migration';
 END IF;
END $$;
CREATE UNIQUE INDEX IF NOT EXISTS wallet_one_job_settlement
 ON public.wallet_transactions(job_id,user_id) WHERE transaction_type='settlement' AND job_id IS NOT NULL;

CREATE OR REPLACE FUNCTION public.pay_job_from_wallet(p_job_id uuid,p_customer_id uuid,p_amount numeric,p_currency_code text DEFAULT 'GBP',p_tenant_id uuid DEFAULT NULL)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE
 j public.jobs%ROWTYPE; w public.wallets%ROWTYPE; f public.errand_funding%ROWTYPE;
 fare numeric; budget numeric:=0; total numeric; net numeric; result text; next_status text;
 slug text; deferred boolean; quote_expiry text; quote_ref text; quote_version text;
BEGIN
 SELECT * INTO STRICT j FROM public.jobs WHERE id=p_job_id AND customer_id=p_customer_id FOR UPDATE;
 -- Terminal state wins before any idempotency check. Never reopen or re-debit.
 IF lower(j.status) IN ('cancelled','canceled','expired','failed','no_driver_found','completed','settled','delivered') THEN
  RAISE EXCEPTION 'Wallet payment is not available for this job status';
 END IF;
 IF upper(coalesce(p_currency_code,''))<>upper(coalesce(j.currency_code,'GBP')) THEN RAISE EXCEPTION 'Wallet currency mismatch'; END IF;
 IF p_tenant_id IS NOT NULL AND p_tenant_id IS DISTINCT FROM j.tenant_id THEN RAISE EXCEPTION 'Wallet tenant mismatch'; END IF;
 SELECT * INTO STRICT w FROM public.wallets WHERE user_id=p_customer_id FOR UPDATE;
 IF upper(w.currency_code)<>upper(coalesce(j.currency_code,'GBP')) THEN RAISE EXCEPTION 'Wallet currency mismatch'; END IF;
 SELECT coalesce(sum(CASE WHEN transaction_type='reservation' THEN amount WHEN transaction_type IN ('release','settlement') THEN -amount ELSE 0 END),0)
 INTO net FROM public.wallet_transactions WHERE job_id=j.id AND user_id=j.customer_id;
 IF j.payment_method='wallet' AND j.payment_status='wallet_funded' THEN
  IF j.status IN ('requested','searching','assigned','accepted','heading_to_pickup','driver_en_route','arrived','in_progress','shopping_in_progress','collected','en_route_to_customer') AND net>0 THEN
   RETURN jsonb_build_object('status','already_paid','job_id',j.id,'payment_method','wallet');
  END IF;
  RAISE EXCEPTION 'Stalled wallet reservation requires reconciliation';
 END IF;
 IF j.payment_status IS DISTINCT FROM 'pending' OR net<>0 THEN RAISE EXCEPTION 'Job already has payment or reservation'; END IF;
 IF j.status NOT IN ('pending','pending_payment','requested','pending_fare_confirmation','negotiating','fare_agreed') THEN RAISE EXCEPTION 'Job is not payable'; END IF;
 SELECT * INTO f FROM public.errand_funding WHERE job_id=j.id FOR UPDATE;
 IF FOUND AND f.status IN ('reserved','approved','over_budget_requested','settled') THEN RAISE EXCEPTION 'Existing errand reservation requires reconciliation'; END IF;
 IF j.status='fare_agreed' AND j.driver_id IS NOT NULL AND j.agreed_fare>0 THEN fare:=round(j.agreed_fare,2);
 ELSE
  fare:=coalesce(nullif(round(j.total_price,2),0),nullif(round(j.estimated_price,2),0),nullif(round(j.price,2),0));
  quote_ref:=coalesce(nullif(j.quote_id::text,''),nullif(j.metadata->>'quote_id',''),nullif(j.fare_breakdown->>'quoteId',''));
  quote_version:=coalesce(nullif(j.fare_breakdown->>'calculationVersion',''),nullif(j.fare_breakdown->>'marketPricingVersion',''));
  quote_expiry:=coalesce(nullif(j.metadata->>'quote_expires_at',''),nullif(j.fare_breakdown->>'quoteExpiresAt',''));
  IF quote_ref IS NULL OR quote_version IS NULL OR quote_expiry IS NULL OR quote_expiry::timestamptz<=now() THEN RAISE EXCEPTION 'Fare quote is missing or expired'; END IF;
 END IF;
 IF fare IS NULL OR fare<=0 THEN RAISE EXCEPTION 'Invalid service fare'; END IF;
 SELECT st.slug INTO slug FROM public.service_types st WHERE st.id=j.service_type_id;
 IF lower(coalesce(slug,j.metadata->>'service_slug','')) IN ('errand','errands','shop','shopping') THEN
  PERFORM 1 FROM public.errand_details WHERE job_id=j.id FOR UPDATE;
  SELECT coalesce(nullif(f.item_budget,0),nullif(ed.estimated_budget,0),CASE WHEN f.status='pending' THEN nullif(f.amount_reserved,0) END,0)
  INTO budget FROM (SELECT 1) anchor LEFT JOIN public.errand_details ed ON ed.job_id=j.id;
  budget:=round(coalesce(budget,0),2);
 END IF;
 IF budget<0 THEN RAISE EXCEPTION 'Invalid item budget'; END IF;
 total:=round(fare+budget,2);
 IF p_amount IS NULL OR round(p_amount,2) IS DISTINCT FROM total THEN RAISE EXCEPTION 'Wallet amount changed; refresh the fare'; END IF;
 IF w.available_balance<total THEN RAISE EXCEPTION 'Insufficient wallet balance'; END IF;
 deferred:=j.scheduled_time IS NOT NULL AND j.scheduled_time>now() AND j.driver_id IS NULL;
 next_status:=CASE WHEN j.driver_id IS NOT NULL THEN 'assigned' WHEN deferred THEN 'requested' ELSE 'searching' END;
 -- Finalize while payment is still pending. All agreement/driver checks remain
 -- inside the canonical finalizer. Any error below rolls this transition back.
 result:=public.finalize_job_payment(j.id,NULL,'wallet_funded',next_status,fare,false,
  CASE WHEN next_status='searching' THEN now() ELSE NULL END,
  CASE WHEN next_status='searching' THEN now()+interval '5 minutes' ELSE NULL END,
  CASE WHEN next_status='searching' THEN 1 ELSE 0 END,NULL,lower(j.currency_code));
 IF result IS DISTINCT FROM 'finalized' THEN RAISE EXCEPTION 'Wallet activation rejected: %',result; END IF;
 UPDATE public.wallets SET available_balance=w.available_balance-total,reserved_balance=w.reserved_balance+total,updated_at=now() WHERE id=w.id;
 INSERT INTO public.wallet_transactions(wallet_id,user_id,job_id,transaction_type,amount,description,metadata,
  balance_before_available,balance_after_available,balance_before_reserved,balance_after_reserved)
 VALUES(w.id,j.customer_id,j.id,'reservation',total,'Job payment reserved from wallet',
  jsonb_build_object('payment_method','wallet','service_fare',fare,'item_budget',budget,'currency_code',j.currency_code),
  w.available_balance,w.available_balance-total,w.reserved_balance,w.reserved_balance+total);
 IF lower(coalesce(slug,'')) IN ('errand','errands','shop','shopping') THEN
  INSERT INTO public.errand_funding(job_id,customer_id,item_budget,service_estimate,amount_reserved,status)
  VALUES(j.id,j.customer_id,budget,fare,total,'reserved')
  ON CONFLICT(job_id) DO UPDATE SET item_budget=excluded.item_budget,service_estimate=excluded.service_estimate,amount_reserved=excluded.amount_reserved,status='reserved',updated_at=now();
 END IF;
 UPDATE public.jobs SET payment_method='wallet',payment_intent_id=NULL,confirmed_at=now(),price=fare,total_price=fare,
  metadata=coalesce(metadata,'{}'::jsonb)||jsonb_build_object('wallet_payment',jsonb_build_object('service_fare',fare,'item_budget',budget,'total_reserved',total)),updated_at=now()
 WHERE id=j.id;
 RETURN jsonb_build_object('status','paid','job_id',j.id,'amount',total,'payment_method','wallet','job_status',next_status);
END $$;

CREATE OR REPLACE FUNCTION public.release_job_wallet_reservation(p_job_id uuid,p_reason text DEFAULT 'Wallet reservation released')
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE j public.jobs%ROWTYPE; w public.wallets%ROWTYPE; f public.errand_funding%ROWTYPE; net numeric; reserved_count integer;
BEGIN
 SELECT * INTO STRICT j FROM public.jobs WHERE id=p_job_id FOR UPDATE;
 IF j.payment_method IS DISTINCT FROM 'wallet' AND j.payment_status IS DISTINCT FROM 'wallet_funded' THEN RETURN jsonb_build_object('released',false,'reason','Job is not wallet-funded'); END IF;
 IF j.status NOT IN ('cancelled','canceled','expired','failed','no_driver_found') THEN RAISE EXCEPTION 'Wallet release requires a terminal cancelled booking'; END IF;
 IF j.payment_status IN ('paid','captured','succeeded') THEN RAISE EXCEPTION 'Captured funds require refund review'; END IF;
 SELECT * INTO STRICT w FROM public.wallets WHERE user_id=j.customer_id FOR UPDATE;
 SELECT * INTO f FROM public.errand_funding WHERE job_id=j.id FOR UPDATE;
 IF EXISTS(SELECT 1 FROM public.wallet_transactions WHERE job_id=j.id AND user_id=j.customer_id AND transaction_type='settlement') OR f.status='settled' THEN
  RAISE EXCEPTION 'Settled reservation cannot be released as cancellation';
 END IF;
 SELECT coalesce(sum(CASE WHEN transaction_type='reservation' THEN amount WHEN transaction_type='release' THEN -amount ELSE 0 END),0),count(*) FILTER(WHERE transaction_type='reservation')
 INTO net,reserved_count FROM public.wallet_transactions WHERE job_id=j.id AND user_id=j.customer_id;
 -- Legacy errand reservations had no ledger row; their locked funding marker
 -- is the evidence. Never combine or double-count the two representations.
 IF reserved_count=0 AND f.status IN ('reserved','approved','over_budget_requested') THEN net:=f.amount_reserved; END IF;
 IF net<0 THEN RAISE EXCEPTION 'Wallet ledger requires reconciliation'; END IF;
 IF net=0 THEN
  UPDATE public.jobs SET payment_status='cancelled',updated_at=now() WHERE id=j.id;
  RETURN jsonb_build_object('released',false,'reason','No active wallet reservation');
 END IF;
 IF w.reserved_balance<net THEN RAISE EXCEPTION 'Reserved balance is inconsistent with this booking'; END IF;
 UPDATE public.wallets SET available_balance=w.available_balance+net,reserved_balance=w.reserved_balance-net,updated_at=now() WHERE id=w.id;
 INSERT INTO public.wallet_transactions(wallet_id,user_id,job_id,transaction_type,amount,description,metadata,
  balance_before_available,balance_after_available,balance_before_reserved,balance_after_reserved)
 VALUES(w.id,j.customer_id,j.id,'release',net,p_reason,jsonb_build_object('payment_method','wallet','legacy_funding',reserved_count=0),
  w.available_balance,w.available_balance+net,w.reserved_balance,w.reserved_balance-net);
 UPDATE public.errand_funding SET status='cancelled',metadata=coalesce(metadata,'{}'::jsonb)||jsonb_build_object('released_amount',net,'release_reason',p_reason),updated_at=now()
 WHERE job_id=j.id AND status IN ('reserved','approved','over_budget_requested');
 UPDATE public.jobs SET payment_status='cancelled',updated_at=now() WHERE id=j.id;
 RETURN jsonb_build_object('released',true,'amount',net,'job_id',j.id);
END $$;

CREATE OR REPLACE FUNCTION public.cancel_job_safely(p_job_id uuid,p_reason text DEFAULT 'User cancelled')
RETURNS boolean LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE j public.jobs%ROWTYPE;
BEGIN
 SELECT * INTO STRICT j FROM public.jobs WHERE id=p_job_id FOR UPDATE;
 IF j.status IN ('cancelled','canceled') THEN
  IF j.payment_method='wallet' OR j.payment_status='wallet_funded' THEN PERFORM public.release_job_wallet_reservation(j.id,p_reason); END IF;
  RETURN true;
 END IF;
 IF j.status NOT IN ('pending','requested','pending_fare_confirmation','negotiating','fare_agreed','searching','assigned','accepted','heading_to_pickup','driver_en_route') THEN RETURN false; END IF;
 IF j.payment_status IN ('paid','captured','succeeded') THEN RAISE EXCEPTION 'Captured payment requires refund review'; END IF;
 UPDATE public.jobs SET status='cancelled',metadata=coalesce(metadata,'{}'::jsonb)||jsonb_build_object('cancellation_reason',p_reason,'cancelled_at',now()),updated_at=now() WHERE id=j.id;
 IF j.payment_method='wallet' OR j.payment_status='wallet_funded' THEN PERFORM public.release_job_wallet_reservation(j.id,p_reason); END IF;
 RETURN true;
END $$;

CREATE OR REPLACE FUNCTION public.end_job_driver_search(p_job_id uuid)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE j public.jobs%ROWTYPE;
BEGIN
 SELECT * INTO STRICT j FROM public.jobs WHERE id=p_job_id FOR UPDATE;
 IF j.status<>'searching' OR j.driver_id IS NOT NULL THEN RETURN NULL; END IF;
 IF j.driver_search_expires_at IS NOT NULL THEN
  IF j.driver_search_expires_at>now() OR coalesce(j.dispatch_attempts,0)<3 THEN RETURN NULL; END IF;
 ELSIF coalesce(j.dispatch_started_at,j.created_at)+interval '5 minutes'>now() THEN RETURN NULL;
 END IF;
 UPDATE public.jobs SET status='no_driver_found',no_driver_reason='No available driver after dispatch attempts',last_dispatch_check_at=now(),updated_at=now() WHERE id=j.id;
 IF j.payment_method='wallet' OR j.payment_status='wallet_funded' THEN PERFORM public.release_job_wallet_reservation(j.id,'No driver found before completion'); END IF;
 SELECT * INTO j FROM public.jobs WHERE id=j.id;
 RETURN to_jsonb(j);
END $$;

CREATE OR REPLACE FUNCTION public.settle_job_wallet_reservation(p_job_id uuid,p_amount numeric)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE j public.jobs%ROWTYPE; w public.wallets%ROWTYPE; f public.errand_funding%ROWTYPE;
 net numeric; fare numeric; spend numeric:=0; budget numeric:=0; charge numeric; refund numeric; prior public.wallet_transactions%ROWTYPE; reserved_count integer;
BEGIN
 SELECT * INTO STRICT j FROM public.jobs WHERE id=p_job_id FOR UPDATE;
 IF j.status IN ('cancelled','canceled','expired','failed','no_driver_found') THEN RAISE EXCEPTION 'Cancelled booking cannot settle'; END IF;
 IF j.payment_method IS DISTINCT FROM 'wallet' AND j.payment_status IS DISTINCT FROM 'wallet_funded' THEN RAISE EXCEPTION 'Not a wallet booking'; END IF;
 SELECT * INTO prior FROM public.wallet_transactions WHERE job_id=j.id AND user_id=j.customer_id AND transaction_type='settlement';
 IF FOUND THEN RETURN jsonb_build_object('status','already_settled','job_id',j.id,'amount_settled',prior.amount); END IF;
 SELECT * INTO STRICT w FROM public.wallets WHERE user_id=j.customer_id FOR UPDATE;
 SELECT * INTO f FROM public.errand_funding WHERE job_id=j.id FOR UPDATE;
 IF f.status='settled' THEN RETURN jsonb_build_object('status','already_settled','job_id',j.id); END IF;
 SELECT coalesce(sum(CASE WHEN transaction_type='reservation' THEN amount WHEN transaction_type IN ('release','settlement') THEN -amount ELSE 0 END),0),count(*) FILTER(WHERE transaction_type='reservation')
 INTO net,reserved_count FROM public.wallet_transactions WHERE job_id=j.id AND user_id=j.customer_id;
 IF reserved_count=0 AND f.status IN ('reserved','approved','over_budget_requested') THEN net:=f.amount_reserved; END IF;
 IF net<=0 OR w.reserved_balance<net THEN RAISE EXCEPTION 'Wallet reservation is missing or inconsistent'; END IF;
 SELECT (metadata->>'service_fare')::numeric INTO fare FROM public.wallet_transactions WHERE job_id=j.id AND user_id=j.customer_id AND transaction_type='reservation' AND metadata ? 'service_fare' ORDER BY created_at,id LIMIT 1;
 fare:=coalesce(fare,round(p_amount,2));
 IF fare IS NULL OR fare<=0 OR fare IS DISTINCT FROM round(p_amount,2) OR fare>net THEN RAISE EXCEPTION 'Wallet settlement fare mismatch'; END IF;
 budget:=net-fare;
 SELECT coalesce(actual_spending,0) INTO spend FROM public.errand_details WHERE job_id=j.id FOR UPDATE;
 spend:=round(coalesce(spend,0),2);
 -- Never hide overspending by clamping it. Approval/funding must happen first.
 IF spend<0 OR spend>budget THEN RAISE EXCEPTION 'Shopping spend exceeds the funded budget; review required'; END IF;
 charge:=fare+spend; refund:=net-charge;
 UPDATE public.wallets SET available_balance=w.available_balance+refund,reserved_balance=w.reserved_balance-net,updated_at=now() WHERE id=w.id;
 INSERT INTO public.wallet_transactions(wallet_id,user_id,job_id,transaction_type,amount,description,metadata,
  balance_before_available,balance_after_available,balance_before_reserved,balance_after_reserved)
 VALUES(w.id,j.customer_id,j.id,'settlement',charge,'Job payment settled from wallet reservation',
  jsonb_build_object('payment_method','wallet','service_fare',fare,'actual_item_spend',spend),
  w.available_balance,w.available_balance,w.reserved_balance,w.reserved_balance-charge);
 IF refund>0 THEN
  INSERT INTO public.wallet_transactions(wallet_id,user_id,job_id,transaction_type,amount,description,metadata,
   balance_before_available,balance_after_available,balance_before_reserved,balance_after_reserved)
  VALUES(w.id,j.customer_id,j.id,'release',refund,'Unused shopping budget returned',jsonb_build_object('payment_method','wallet','reason','unused_budget'),
   w.available_balance,w.available_balance+refund,w.reserved_balance-charge,w.reserved_balance-net);
 END IF;
 UPDATE public.errand_funding SET status='settled',actual_item_spend=spend,refund_amount=refund,
  metadata=coalesce(metadata,'{}'::jsonb)||jsonb_build_object('settlement',jsonb_build_object('amount_settled',charge,'amount_released',refund)),updated_at=now() WHERE job_id=j.id;
 UPDATE public.jobs SET payment_status='paid',updated_at=now() WHERE id=j.id;
 RETURN jsonb_build_object('status','settled','job_id',j.id,'amount_settled',charge,'amount_released',refund);
END $$;

-- Retain old signatures for server integrations, but delegate to one authority.
CREATE OR REPLACE FUNCTION public.reserve_errand_funds(p_job_id uuid,p_customer_id uuid,p_item_budget numeric,p_service_estimate numeric)
RETURNS boolean LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE j public.jobs%ROWTYPE;
BEGIN
 SELECT * INTO STRICT j FROM public.jobs WHERE id=p_job_id;
 PERFORM public.pay_job_from_wallet(p_job_id,p_customer_id,p_item_budget+p_service_estimate,j.currency_code,j.tenant_id);
 RETURN true;
END $$;
CREATE OR REPLACE FUNCTION public.settle_errand_funds(p_booking_id uuid)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE j public.jobs%ROWTYPE; fare numeric;
BEGIN
 SELECT * INTO STRICT j FROM public.jobs WHERE id=p_booking_id;
 SELECT (metadata->>'service_fare')::numeric INTO fare FROM public.wallet_transactions WHERE job_id=j.id AND user_id=j.customer_id AND transaction_type='reservation' AND metadata ? 'service_fare' ORDER BY created_at,id LIMIT 1;
 fare:=coalesce(fare,j.total_price,j.price);
 PERFORM public.settle_job_wallet_reservation(p_booking_id,fare);
END $$;

-- Budget changes keep the same job -> wallet -> funding lock order as payment.
CREATE OR REPLACE FUNCTION public.request_errand_over_budget(p_job_id uuid,p_amount numeric,p_reason text DEFAULT NULL::text)
RETURNS boolean LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE j public.jobs%ROWTYPE; f public.errand_funding%ROWTYPE;
BEGIN
 SELECT * INTO STRICT j FROM public.jobs WHERE id=p_job_id FOR UPDATE;
 IF auth.uid() IS DISTINCT FROM j.driver_id AND coalesce(auth.role(),'')<>'service_role' AND session_user NOT IN ('postgres','supabase_admin') THEN RAISE EXCEPTION 'Only the assigned driver can request a budget increase'; END IF;
 IF j.payment_status<>'wallet_funded' OR j.status NOT IN ('assigned','accepted','heading_to_pickup','arrived','arrived_at_store','shopping_in_progress','in_progress') THEN RAISE EXCEPTION 'Booking is not eligible for a budget increase'; END IF;
 SELECT * INTO STRICT f FROM public.errand_funding WHERE job_id=j.id FOR UPDATE;
 IF f.status NOT IN ('reserved','approved','over_budget_requested') OR p_amount IS NULL OR round(p_amount,2)<=f.item_budget OR length(trim(coalesce(p_reason,'')))<3 THEN RAISE EXCEPTION 'Invalid budget increase'; END IF;
 UPDATE public.errand_funding SET status='over_budget_requested',over_budget_status='requested',requested_over_budget_amount=round(p_amount,2),over_budget_amount=round(p_amount-f.item_budget,2),over_budget_reason=p_reason,updated_at=now() WHERE job_id=j.id;
 RETURN TRUE;
END $$;
CREATE OR REPLACE FUNCTION public.approve_errand_over_budget(p_job_id uuid)
RETURNS boolean LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE j public.jobs%ROWTYPE; w public.wallets%ROWTYPE; f public.errand_funding%ROWTYPE; delta numeric;
BEGIN
 SELECT * INTO STRICT j FROM public.jobs WHERE id=p_job_id FOR UPDATE;
 IF auth.uid() IS DISTINCT FROM j.customer_id AND coalesce(auth.role(),'')<>'service_role' AND session_user NOT IN ('postgres','supabase_admin') THEN RAISE EXCEPTION 'Only the customer can approve a budget increase'; END IF;
 IF j.payment_status<>'wallet_funded' OR j.status IN ('cancelled','canceled','expired','failed','no_driver_found','completed','settled','delivered') THEN RAISE EXCEPTION 'Booking is not eligible for budget approval'; END IF;
 SELECT * INTO STRICT w FROM public.wallets WHERE user_id=j.customer_id FOR UPDATE;
 SELECT * INTO STRICT f FROM public.errand_funding WHERE job_id=j.id FOR UPDATE;
 IF f.over_budget_status='approved' AND f.status='reserved' THEN RETURN TRUE; END IF;
 IF f.status<>'over_budget_requested' OR f.over_budget_status<>'requested' THEN RAISE EXCEPTION 'No pending budget increase'; END IF;
 delta:=round(f.requested_over_budget_amount-f.item_budget,2);
 IF delta IS NULL OR delta<=0 OR w.available_balance<delta THEN RAISE EXCEPTION 'Invalid budget increase or insufficient wallet balance'; END IF;
 UPDATE public.wallets SET available_balance=w.available_balance-delta,reserved_balance=w.reserved_balance+delta,updated_at=now() WHERE id=w.id;
 INSERT INTO public.wallet_transactions(wallet_id,user_id,job_id,transaction_type,amount,description,metadata,balance_before_available,balance_after_available,balance_before_reserved,balance_after_reserved)
 VALUES(w.id,j.customer_id,j.id,'reservation',delta,'Additional errand budget approved',jsonb_build_object('payment_method','wallet','reason','budget_increase'),w.available_balance,w.available_balance-delta,w.reserved_balance,w.reserved_balance+delta);
 UPDATE public.errand_funding SET status='reserved',over_budget_status='approved',item_budget=f.requested_over_budget_amount,amount_reserved=f.amount_reserved+delta,metadata=coalesce(metadata,'{}'::jsonb)||jsonb_build_object('item_budget',f.requested_over_budget_amount),updated_at=now() WHERE job_id=j.id;
 UPDATE public.jobs SET metadata=coalesce(metadata,'{}'::jsonb)||jsonb_build_object('wallet_payment',coalesce(metadata->'wallet_payment','{}'::jsonb)||jsonb_build_object('item_budget',f.requested_over_budget_amount,'total_reserved',f.amount_reserved+delta)),updated_at=now() WHERE id=j.id;
 RETURN TRUE;
END $$;
CREATE OR REPLACE FUNCTION public.reject_errand_over_budget(p_job_id uuid)
RETURNS boolean LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE j public.jobs%ROWTYPE;
BEGIN
 SELECT * INTO STRICT j FROM public.jobs WHERE id=p_job_id FOR UPDATE;
 IF auth.uid() IS DISTINCT FROM j.customer_id AND coalesce(auth.role(),'')<>'service_role' AND session_user NOT IN ('postgres','supabase_admin') THEN RAISE EXCEPTION 'Only the customer can reject a budget increase'; END IF;
 IF j.status IN ('cancelled','canceled','expired','failed','no_driver_found','completed','settled','delivered') THEN RAISE EXCEPTION 'Booking is no longer active'; END IF;
 UPDATE public.errand_funding SET status='reserved',over_budget_status='rejected',requested_over_budget_amount=0,updated_at=now() WHERE job_id=j.id AND status='over_budget_requested';
 RETURN TRUE;
END $$;
REVOKE ALL ON FUNCTION public.request_errand_over_budget(uuid,numeric,text),public.approve_errand_over_budget(uuid),public.reject_errand_over_budget(uuid) FROM PUBLIC,anon;
GRANT EXECUTE ON FUNCTION public.request_errand_over_budget(uuid,numeric,text),public.approve_errand_over_budget(uuid),public.reject_errand_over_budget(uuid) TO authenticated,service_role;
REVOKE ALL ON FUNCTION public.pay_job_from_wallet(uuid,uuid,numeric,text,uuid),
 public.release_job_wallet_reservation(uuid,text),public.reserve_errand_funds(uuid,uuid,numeric,numeric),
 public.settle_errand_funds(uuid),public.settle_job_wallet_reservation(uuid,numeric),
 public.cancel_job_safely(uuid,text),public.end_job_driver_search(uuid)
 FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.pay_job_from_wallet(uuid,uuid,numeric,text,uuid),
 public.release_job_wallet_reservation(uuid,text),public.reserve_errand_funds(uuid,uuid,numeric,numeric),
 public.settle_errand_funds(uuid),public.settle_job_wallet_reservation(uuid,numeric),
 public.cancel_job_safely(uuid,text),public.end_job_driver_search(uuid)
 TO service_role;
REVOKE INSERT,UPDATE,DELETE,TRUNCATE ON public.wallets,public.wallet_transactions FROM PUBLIC,anon,authenticated;
NOTIFY pgrst,'reload schema';
COMMIT;
