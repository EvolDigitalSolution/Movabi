BEGIN;
DO $preflight$
BEGIN
 IF current_database()<>'movabi_develop' THEN RAISE EXCEPTION 'Expected movabi_develop development database'; END IF;
 IF to_regclass('public.journey_stop_requests_v23') IS NULL OR to_regclass('public.journey_evidence_v23') IS NULL THEN
  RAISE EXCEPTION 'Stop confirmation and journey evidence migrations required';
 END IF;
END
$preflight$;
CREATE TABLE public.journey_fare_enrolments_v23(
 job_id uuid PRIMARY KEY REFERENCES public.jobs(id) ON DELETE CASCADE,customer_id uuid NOT NULL,driver_id uuid NOT NULL,
 valid_until timestamptz NOT NULL,created_at timestamptz NOT NULL DEFAULT clock_timestamp(),CHECK(customer_id<>driver_id)
);
CREATE TABLE public.journey_start_markers_v23(
 job_id uuid PRIMARY KEY REFERENCES public.jobs(id) ON DELETE CASCADE,customer_id uuid NOT NULL,driver_id uuid NOT NULL,
 started_at timestamptz NOT NULL,booking_snapshot jsonb NOT NULL
);
CREATE TABLE public.journey_fare_proposals_v23(
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),stop_id uuid NOT NULL UNIQUE REFERENCES public.journey_stop_requests_v23(id),
 source_digest text NOT NULL,calculation jsonb NOT NULL,state text NOT NULL DEFAULT 'proposed' CHECK(state IN('proposed','agreed','rejected')),
 customer_accepted_at timestamptz,driver_accepted_at timestamptz,rejected_by uuid,rejection_note text,
 created_at timestamptz NOT NULL DEFAULT clock_timestamp(),expires_at timestamptz NOT NULL DEFAULT clock_timestamp()+interval '15 minutes'
);
CREATE TABLE public.journey_fare_events_v23(
 id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,proposal_id uuid NOT NULL REFERENCES public.journey_fare_proposals_v23(id),
 actor_id uuid NOT NULL,event_type text NOT NULL CHECK(event_type IN('proposed','accepted','rejected')),created_at timestamptz NOT NULL DEFAULT clock_timestamp()
);
ALTER TABLE public.journey_fare_enrolments_v23 ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.journey_start_markers_v23 ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.journey_fare_proposals_v23 ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.journey_fare_events_v23 ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.journey_fare_enrolments_v23,public.journey_start_markers_v23,public.journey_fare_proposals_v23,public.journey_fare_events_v23 FROM PUBLIC,anon,authenticated,service_role;
GRANT SELECT ON public.journey_fare_enrolments_v23,public.journey_start_markers_v23,public.journey_fare_proposals_v23,public.journey_fare_events_v23 TO service_role;
REVOKE ALL ON SEQUENCE public.journey_fare_events_v23_id_seq FROM PUBLIC,anon,authenticated,service_role;

-- Only explicitly enrolled development bookings can acquire a start marker.
-- No historic marker is manufactured and no enrolments are created here.
CREATE FUNCTION public.mark_enrolled_ride_start_v23() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $marker$
BEGIN
 IF NEW.status='in_progress' AND OLD.status IN('arrived','driver_arrived')
   AND (auth.uid()=NEW.driver_id OR auth.role()='service_role')
   AND EXISTS(SELECT 1 FROM public.journey_fare_enrolments_v23 e WHERE e.job_id=NEW.id
     AND e.customer_id=NEW.customer_id AND e.driver_id=NEW.driver_id AND e.valid_until>clock_timestamp())
 THEN
  INSERT INTO public.journey_start_markers_v23(job_id,customer_id,driver_id,started_at,booking_snapshot)
  VALUES(NEW.id,NEW.customer_id,NEW.driver_id,clock_timestamp(),jsonb_build_object(
   'fare_breakdown',NEW.fare_breakdown,'currency_code',NEW.currency_code,'distance_meters',NEW.distance_meters,
   'estimated_distance_km',NEW.estimated_distance_km,'pickup_lat',NEW.pickup_lat,'pickup_lng',NEW.pickup_lng))
  ON CONFLICT(job_id) DO NOTHING;
 END IF;
 RETURN NEW;
END
$marker$;
REVOKE ALL ON FUNCTION public.mark_enrolled_ride_start_v23() FROM PUBLIC,anon,authenticated,service_role;
CREATE TRIGGER mark_enrolled_ride_start_v23 AFTER UPDATE OF status ON public.jobs
 FOR EACH ROW WHEN(OLD.status IS DISTINCT FROM NEW.status) EXECUTE FUNCTION public.mark_enrolled_ride_start_v23();

CREATE FUNCTION public.early_stop_fare_context_v23(p_actor uuid,p_job_id uuid,p_stop_id uuid)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $context$
DECLARE j public.jobs%ROWTYPE;s public.journey_stop_requests_v23%ROWTYPE;m public.journey_start_markers_v23%ROWTYPE;points jsonb;basis jsonb;
BEGIN
 SELECT * INTO j FROM public.jobs WHERE id=p_job_id FOR UPDATE;
 IF NOT FOUND OR p_actor IS NULL OR (j.customer_id IS DISTINCT FROM p_actor AND j.driver_id IS DISTINCT FROM p_actor) THEN RAISE EXCEPTION 'FARE_NOT_PARTICIPANT'; END IF;
 SELECT * INTO s FROM public.journey_stop_requests_v23 WHERE id=p_stop_id AND job_id=p_job_id FOR UPDATE;
 IF NOT FOUND OR (s.customer_id IS DISTINCT FROM p_actor AND s.driver_id IS DISTINCT FROM p_actor) THEN RAISE EXCEPTION 'FARE_NOT_PARTICIPANT'; END IF;
 IF s.customer_id IS DISTINCT FROM j.customer_id OR s.driver_id IS DISTINCT FROM j.driver_id OR j.status NOT IN('in_progress','picked_up','on_trip') OR j.status IS NULL THEN RAISE EXCEPTION 'FARE_BOOKING_CHANGED'; END IF;
 IF s.state<>'stop_agreed' THEN RAISE EXCEPTION 'FARE_STOP_AGREEMENT_REQUIRED'; END IF;
 IF NOT EXISTS(SELECT 1 FROM public.journey_fare_enrolments_v23 e WHERE e.job_id=j.id AND e.customer_id=j.customer_id AND e.driver_id=j.driver_id AND e.valid_until>clock_timestamp()) THEN RAISE EXCEPTION 'FARE_NOT_ENROLLED'; END IF;
 SELECT * INTO m FROM public.journey_start_markers_v23 WHERE job_id=j.id;
 IF NOT FOUND THEN RAISE EXCEPTION 'FARE_MISSING_START'; END IF;
 SELECT coalesce(jsonb_agg(to_jsonb(e) ORDER BY e.sampled_at),'[]'::jsonb) INTO points
 FROM public.journey_evidence_v23 e WHERE e.job_id=j.id AND e.sampled_at>=m.started_at AND e.sampled_at<=s.created_at
  AND e.received_at>=m.started_at AND e.received_at<=s.created_at;
 basis:=jsonb_build_object('job',jsonb_build_object('id',j.id,'customer_id',j.customer_id,'driver_id',j.driver_id,
  'tenant_id',j.tenant_id,'status',j.status,'fare_breakdown',j.fare_breakdown,'currency_code',j.currency_code,
  'payment_status',j.payment_status,'payment_intent_id',j.payment_intent_id,'settlement_status',j.settlement_status),
  'start',to_jsonb(m),'stop',jsonb_build_object('id',s.id,'customer_id',s.customer_id,'driver_id',s.driver_id,'created_at',s.created_at,'state',s.state),'points',points);
 RETURN jsonb_build_object('digest',md5(basis::text),'frame',basis,'authorityJob',to_jsonb(j));
END
$context$;
REVOKE ALL ON FUNCTION public.early_stop_fare_context_v23(uuid,uuid,uuid) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.early_stop_fare_context_v23(uuid,uuid,uuid) TO service_role;

CREATE FUNCTION public.journey_fare_pilot_v23(p_actor uuid,p_job_id uuid,p_stop_id uuid,p_action text,
 p_source_digest text DEFAULT NULL,p_calculation jsonb DEFAULT NULL,p_proposal_id uuid DEFAULT NULL,p_note text DEFAULT NULL)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $fare$
DECLARE context jsonb;p public.journey_fare_proposals_v23%ROWTYPE;role_name text;display_state text;amount numeric;original numeric;covered numeric;planned numeric;
BEGIN
 IF p_action IS NULL OR p_action NOT IN('read','propose','accept','reject') THEN RAISE EXCEPTION 'FARE_INVALID_INPUT'; END IF;
 context:=public.early_stop_fare_context_v23(p_actor,p_job_id,p_stop_id);
 role_name:=CASE WHEN context->'frame'->'job'->>'customer_id'=p_actor::text THEN 'customer' ELSE 'driver' END;
 SELECT * INTO p FROM public.journey_fare_proposals_v23 WHERE stop_id=p_stop_id FOR UPDATE;
 IF p_action='propose' THEN
  IF p_source_digest IS DISTINCT FROM context->>'digest' THEN RAISE EXCEPTION 'FARE_SOURCE_CHANGED'; END IF;
  IF p_calculation IS NULL OR p_calculation->>'policyVersion' IS DISTINCT FROM 'early-stop-distance-prorata-v1'
    OR p_calculation->>'currency' IS DISTINCT FROM context->'frame'->'job'->>'currency_code' THEN RAISE EXCEPTION 'FARE_INVALID_INPUT'; END IF;
  BEGIN
   amount:=(p_calculation->>'amountMinor')::numeric;original:=(p_calculation->>'originalMinor')::numeric;
   covered:=(p_calculation->>'coveredMetres')::numeric;planned:=(p_calculation->>'plannedMetres')::numeric;
   IF amount IS NULL OR original IS NULL OR covered IS NULL OR planned IS NULL OR original<=0 OR original>9007199254740991
    OR amount<0 OR amount>original OR covered<0 OR planned<=0 OR covered>planned OR planned>2000000
    OR amount<>trunc(amount) OR original<>trunc(original) OR covered<>trunc(covered) OR planned<>trunc(planned)
    OR amount<>floor(original*covered/planned)
    OR (p_calculation->'split'->>'platformFeeMinor')::numeric<0
    OR (p_calculation->'split'->>'driverCommissionMinor')::numeric<0
    OR (p_calculation->'split'->>'driverEntitlementMinor')::numeric<0
    OR ((p_calculation->'split'->>'platformFeeMinor')::numeric+(p_calculation->'split'->>'driverCommissionMinor')::numeric+(p_calculation->'split'->>'driverEntitlementMinor')::numeric) IS DISTINCT FROM amount
   THEN RAISE EXCEPTION 'FARE_INVALID_INPUT'; END IF;
  EXCEPTION WHEN invalid_text_representation OR numeric_value_out_of_range THEN RAISE EXCEPTION 'FARE_INVALID_INPUT'; END;
  IF p.id IS NOT NULL THEN
   IF p.source_digest IS DISTINCT FROM p_source_digest OR p.calculation IS DISTINCT FROM p_calculation THEN RAISE EXCEPTION 'FARE_PROPOSAL_EXISTS'; END IF;
  ELSE
   INSERT INTO public.journey_fare_proposals_v23(stop_id,source_digest,calculation) VALUES(p_stop_id,p_source_digest,p_calculation) RETURNING * INTO p;
   INSERT INTO public.journey_fare_events_v23(proposal_id,actor_id,event_type) VALUES(p.id,p_actor,'proposed');
  END IF;
 ELSIF p_action IN('accept','reject') THEN
  IF p.id IS NULL OR p.id IS DISTINCT FROM p_proposal_id THEN RAISE EXCEPTION 'FARE_PROPOSAL_MISMATCH'; END IF;
  IF p.source_digest IS DISTINCT FROM context->>'digest' THEN RAISE EXCEPTION 'FARE_SOURCE_CHANGED'; END IF;
  IF p_action='accept' THEN
   IF p.state='rejected' THEN RAISE EXCEPTION 'FARE_REVIEW_REQUIRED'; END IF;
   IF p.state='proposed' AND p.expires_at<=clock_timestamp() THEN RAISE EXCEPTION 'FARE_EXPIRED'; END IF;
   IF (role_name='customer' AND p.customer_accepted_at IS NULL) OR (role_name='driver' AND p.driver_accepted_at IS NULL) THEN
    UPDATE public.journey_fare_proposals_v23 SET customer_accepted_at=CASE WHEN role_name='customer' THEN clock_timestamp() ELSE customer_accepted_at END,
      driver_accepted_at=CASE WHEN role_name='driver' THEN clock_timestamp() ELSE driver_accepted_at END WHERE id=p.id RETURNING * INTO p;
    IF p.customer_accepted_at IS NOT NULL AND p.driver_accepted_at IS NOT NULL THEN UPDATE public.journey_fare_proposals_v23 SET state='agreed' WHERE id=p.id RETURNING * INTO p; END IF;
    INSERT INTO public.journey_fare_events_v23(proposal_id,actor_id,event_type) VALUES(p.id,p_actor,'accepted');
   END IF;
  ELSE
   IF length(btrim(coalesce(p_note,''))) NOT BETWEEN 3 AND 1000 THEN RAISE EXCEPTION 'FARE_INVALID_INPUT'; END IF;
   IF p.state<>'rejected' THEN
    UPDATE public.journey_fare_proposals_v23 SET state='rejected',rejected_by=p_actor,rejection_note=btrim(p_note) WHERE id=p.id RETURNING * INTO p;
    INSERT INTO public.journey_fare_events_v23(proposal_id,actor_id,event_type) VALUES(p.id,p_actor,'rejected');
   END IF;
  END IF;
 END IF;
 display_state:=CASE WHEN p.source_digest IS DISTINCT FROM context->>'digest' THEN 'stale' WHEN p.state='proposed' AND p.expires_at<=clock_timestamp() THEN 'expired' ELSE p.state END;
 RETURN jsonb_build_object('enabled',true,'viewer',role_name,'bookingUpdated',false,'paymentUpdated',false,'proposal',CASE WHEN p.id IS NULL THEN NULL ELSE jsonb_build_object(
  'id',p.id,'state',display_state,'currency',p.calculation->'currency','exponent',p.calculation->'exponent','originalMinor',p.calculation->'originalMinor',
  'amountMinor',p.calculation->'amountMinor','coveredMetres',p.calculation->'coveredMetres','plannedMetres',p.calculation->'plannedMetres','unusedQuotedMetres',p.calculation->'unusedQuotedMetres',
  'customerAccepted',p.customer_accepted_at IS NOT NULL,'driverAccepted',p.driver_accepted_at IS NOT NULL,'expiresAt',p.expires_at) END);
END
$fare$;
REVOKE ALL ON FUNCTION public.journey_fare_pilot_v23(uuid,uuid,uuid,text,text,jsonb,uuid,text) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.journey_fare_pilot_v23(uuid,uuid,uuid,text,text,jsonb,uuid,text) TO service_role;
NOTIFY pgrst,'reload schema';
COMMIT;
