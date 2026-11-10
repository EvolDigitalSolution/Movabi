BEGIN;
DO $preflight$
BEGIN
  IF to_regclass('public.jobs') IS NULL OR to_regclass('public.service_types') IS NULL
    OR to_regclass('public.journey_evidence_v23') IS NULL
    OR to_regprocedure('public.create_booking_support_request(uuid,uuid,uuid,text,text,text,uuid,text,text,uuid)') IS NULL THEN
    RAISE EXCEPTION 'Early-stop pilot requires jobs, services, journey evidence and durable booking support';
  END IF;
END
$preflight$;

CREATE TABLE public.journey_stop_requests_v23 (
  id uuid PRIMARY KEY,
  job_id uuid NOT NULL UNIQUE REFERENCES public.jobs(id) ON DELETE CASCADE,
  customer_id uuid NOT NULL,driver_id uuid NOT NULL,requested_by uuid NOT NULL,
  reason text NOT NULL CHECK(reason IN ('breakdown','safety','medical','other')),
  note text NOT NULL DEFAULT '' CHECK(length(note)<=1000),
  state text NOT NULL CHECK(state IN ('awaiting_other','stop_agreed','disputed')),
  customer_confirmed_at timestamptz,driver_confirmed_at timestamptz,
  location_snapshot jsonb,
  support_reference uuid NOT NULL,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  expires_at timestamptz NOT NULL DEFAULT clock_timestamp()+interval '15 minutes',
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  CHECK(customer_id<>driver_id),CHECK(requested_by IN (customer_id,driver_id))
);
CREATE TABLE public.journey_stop_events_v23 (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  request_id uuid NOT NULL REFERENCES public.journey_stop_requests_v23(id) ON DELETE CASCADE,
  actor_id uuid NOT NULL,event_type text NOT NULL CHECK(event_type IN ('requested','confirmed','disputed')),
  note text NOT NULL DEFAULT '' CHECK(length(note)<=1000),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp()
);
ALTER TABLE public.journey_stop_requests_v23 ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.journey_stop_events_v23 ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.journey_stop_requests_v23,public.journey_stop_events_v23 FROM PUBLIC,anon,authenticated,service_role;
GRANT SELECT ON public.journey_stop_requests_v23,public.journey_stop_events_v23 TO service_role;
REVOKE ALL ON SEQUENCE public.journey_stop_events_v23_id_seq FROM PUBLIC,anon,authenticated,service_role;

CREATE OR REPLACE FUNCTION public.journey_stop_pilot_v23(
  p_actor uuid,p_job_id uuid,p_action text,p_request_id uuid DEFAULT NULL,
  p_reason text DEFAULT NULL,p_note text DEFAULT NULL
) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public
AS $function$
DECLARE
  j record;r public.journey_stop_requests_v23%ROWTYPE;
  actor_role text;active boolean;bound boolean;effective_state text;point jsonb;support_id uuid;
  clean_note text:=btrim(coalesce(p_note,''));
BEGIN
  IF p_actor IS NULL OR p_job_id IS NULL OR p_action NOT IN ('read','request','confirm','dispute') OR p_action IS NULL THEN
    RAISE EXCEPTION 'STOP_INVALID_INPUT';
  END IF;
  -- One lock order for request/confirmation and current booking ownership.
  SELECT job.*,service.slug AS stop_service_slug INTO j FROM public.jobs job
    LEFT JOIN public.service_types service ON service.id=job.service_type_id
    WHERE job.id=p_job_id FOR UPDATE OF job;
  IF NOT FOUND OR (j.customer_id IS DISTINCT FROM p_actor AND j.driver_id IS DISTINCT FROM p_actor) THEN
    RAISE EXCEPTION 'STOP_NOT_PARTICIPANT';
  END IF;
  actor_role:=CASE WHEN j.customer_id=p_actor THEN 'customer' ELSE 'driver' END;
  active:=j.status IN ('in_progress','picked_up','on_trip') AND lower(coalesce(j.stop_service_slug,'')) IN ('ride','rides')
    AND j.driver_id IS NOT NULL AND j.customer_id IS NOT NULL AND j.customer_id IS DISTINCT FROM j.driver_id;
  active:=coalesce(active,false);
  SELECT * INTO r FROM public.journey_stop_requests_v23 WHERE job_id=p_job_id FOR UPDATE;
  IF FOUND AND p_actor NOT IN (r.customer_id,r.driver_id) THEN RAISE EXCEPTION 'STOP_NOT_PARTICIPANT'; END IF;
  bound:=r.id IS NULL OR (r.customer_id IS NOT DISTINCT FROM j.customer_id AND r.driver_id IS NOT DISTINCT FROM j.driver_id);

  IF p_action='request' THEN
    IF p_request_id IS NULL OR p_reason NOT IN ('breakdown','safety','medical','other') OR p_reason IS NULL OR length(clean_note)>1000 THEN
      RAISE EXCEPTION 'STOP_INVALID_INPUT';
    END IF;
    IF r.id IS NOT NULL THEN
      IF r.id IS DISTINCT FROM p_request_id OR r.requested_by IS DISTINCT FROM p_actor
        OR r.reason IS DISTINCT FROM p_reason OR r.note IS DISTINCT FROM clean_note THEN
        RAISE EXCEPTION 'STOP_REQUEST_EXISTS';
      END IF;
      -- Exact retry reads the saved result, never signs on behalf of another actor.
    ELSE
      IF NOT active THEN RAISE EXCEPTION 'STOP_NOT_ACTIVE_RIDE'; END IF;
      SELECT jsonb_build_object('latitude',e.latitude,'longitude',e.longitude,
        'accuracyMetres',e.accuracy_metres,'sampledAt',e.sampled_at,'receivedAt',e.received_at,
        'source','authenticated_driver_report') INTO point
      FROM public.journey_evidence_v23 e
      WHERE e.job_id=p_job_id AND e.driver_id=j.driver_id AND e.tenant_id=j.tenant_id
        AND e.sampled_at>=clock_timestamp()-interval '90 seconds'
        AND e.received_at>=clock_timestamp()-interval '90 seconds'
        AND e.booking_phase IN ('in_progress','picked_up','on_trip')
      ORDER BY e.sampled_at DESC LIMIT 1;
      -- Queue support in the SAME transaction. A request is never reported saved
      -- unless there is also a durable support reference. Delivery may be pending.
      SELECT ticket.id INTO support_id FROM public.create_booking_support_request(
        p_actor,p_job_id,p_request_id,'safety',
        'Early-stop review requested. This records a request only; it does not close the booking or authorise a revised fare. Reason: '
          ||p_reason||CASE WHEN clean_note='' THEN '' ELSE '. Note: '||clean_note END,
        NULL,j.tenant_id,to_jsonb(j)->>'country_code',to_jsonb(j)->>'market_city',j.driver_id
      ) ticket LIMIT 1;
      IF support_id IS NULL THEN RAISE EXCEPTION 'STOP_SUPPORT_UNAVAILABLE'; END IF;
      INSERT INTO public.journey_stop_requests_v23(id,job_id,customer_id,driver_id,requested_by,reason,note,state,
        customer_confirmed_at,driver_confirmed_at,location_snapshot,support_reference)
      VALUES(p_request_id,p_job_id,j.customer_id,j.driver_id,p_actor,p_reason,clean_note,'awaiting_other',
        CASE WHEN actor_role='customer' THEN clock_timestamp() END,
        CASE WHEN actor_role='driver' THEN clock_timestamp() END,point,support_id)
      RETURNING * INTO r;
      INSERT INTO public.journey_stop_events_v23(request_id,actor_id,event_type,note) VALUES(r.id,p_actor,'requested',clean_note);
    END IF;
  ELSIF p_action IN ('confirm','dispute') THEN
    IF r.id IS NULL OR r.id IS DISTINCT FROM p_request_id THEN RAISE EXCEPTION 'STOP_REQUEST_MISMATCH'; END IF;
    IF NOT active OR NOT bound THEN RAISE EXCEPTION 'STOP_BOOKING_CHANGED'; END IF;
    IF p_action='confirm' THEN
      IF r.state='disputed' THEN RAISE EXCEPTION 'STOP_REVIEW_REQUIRED'; END IF;
      IF r.state='awaiting_other' AND r.expires_at<=clock_timestamp() THEN RAISE EXCEPTION 'STOP_CONFIRMATION_EXPIRED'; END IF;
      IF (actor_role='customer' AND r.customer_confirmed_at IS NULL)
        OR (actor_role='driver' AND r.driver_confirmed_at IS NULL) THEN
        UPDATE public.journey_stop_requests_v23 SET
          customer_confirmed_at=CASE WHEN actor_role='customer' THEN clock_timestamp() ELSE customer_confirmed_at END,
          driver_confirmed_at=CASE WHEN actor_role='driver' THEN clock_timestamp() ELSE driver_confirmed_at END,
          updated_at=clock_timestamp() WHERE id=r.id RETURNING * INTO r;
        IF r.customer_confirmed_at IS NOT NULL AND r.driver_confirmed_at IS NOT NULL THEN
          UPDATE public.journey_stop_requests_v23 SET state='stop_agreed',updated_at=clock_timestamp() WHERE id=r.id RETURNING * INTO r;
        END IF;
        INSERT INTO public.journey_stop_events_v23(request_id,actor_id,event_type) VALUES(r.id,p_actor,'confirmed');
      END IF;
    ELSE
      IF length(clean_note)<3 OR length(clean_note)>1000 THEN RAISE EXCEPTION 'STOP_INVALID_INPUT'; END IF;
      IF r.state<>'disputed' THEN
        UPDATE public.journey_stop_requests_v23 SET state='disputed',updated_at=clock_timestamp() WHERE id=r.id RETURNING * INTO r;
        INSERT INTO public.journey_stop_events_v23(request_id,actor_id,event_type,note) VALUES(r.id,p_actor,'disputed',clean_note);
      END IF;
    END IF;
  END IF;

  effective_state:=CASE WHEN r.state='awaiting_other' AND r.expires_at<=clock_timestamp() THEN 'expired' ELSE r.state END;
  RETURN jsonb_build_object('enabled',true,'viewer',actor_role,'canRequest',active AND r.id IS NULL,
    'canRespond',active AND bound AND r.id IS NOT NULL,
    'request',CASE WHEN r.id IS NULL THEN NULL ELSE jsonb_build_object(
      'id',r.id,'state',effective_state,'reason',r.reason,'note',r.note,
      'customerConfirmed',r.customer_confirmed_at IS NOT NULL,'driverConfirmed',r.driver_confirmed_at IS NOT NULL,
      'createdAt',r.created_at,'expiresAt',r.expires_at,'locationRecorded',r.location_snapshot IS NOT NULL,
      'supportReference',r.support_reference,'bookingChanged',NOT bound OR NOT active
    ) END,'bookingUpdated',false,'fareUpdated',false);
END
$function$;
REVOKE ALL ON FUNCTION public.journey_stop_pilot_v23(uuid,uuid,text,uuid,text,text) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.journey_stop_pilot_v23(uuid,uuid,text,uuid,text,text) TO service_role;
COMMENT ON TABLE public.journey_stop_requests_v23 IS
  'Early-stop confirmation pilot only. Stop agreement is not fare consent, booking completion, capture, refund or payout authority.';
NOTIFY pgrst,'reload schema';
COMMIT;
