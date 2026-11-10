--
-- PostgreSQL database dump
--

-- Dumped from database version 15.1 (Ubuntu 15.1-1.pgdg20.04+1)
-- Dumped by pg_dump version 15.7 (Ubuntu 15.7-1.pgdg20.04+1)

SET statement_timeout = 0;
SET lock_timeout = 0;
SET idle_in_transaction_session_timeout = 0;
SET client_encoding = 'UTF8';
SET standard_conforming_strings = on;
SELECT pg_catalog.set_config('search_path', '', false);
SET check_function_bodies = false;
SET xmloption = content;
SET client_min_messages = warning;
SET row_security = off;

--
-- Name: public; Type: SCHEMA; Schema: -; Owner: -
--

CREATE SCHEMA public;


--
-- Name: SCHEMA public; Type: COMMENT; Schema: -; Owner: -
--

COMMENT ON SCHEMA public IS 'standard public schema';


--
-- Name: aal_level; Type: TYPE; Schema: public; Owner: -
--

CREATE TYPE public.aal_level AS ENUM (
    'aal1',
    'aal2',
    'aal3'
);


--
-- Name: code_challenge_method; Type: TYPE; Schema: public; Owner: -
--

CREATE TYPE public.code_challenge_method AS ENUM (
    's256',
    'plain'
);


--
-- Name: factor_status; Type: TYPE; Schema: public; Owner: -
--

CREATE TYPE public.factor_status AS ENUM (
    'unverified',
    'verified'
);


--
-- Name: factor_type; Type: TYPE; Schema: public; Owner: -
--

CREATE TYPE public.factor_type AS ENUM (
    'totp',
    'webauthn'
);


--
-- Name: accept_assigned_job(uuid, uuid); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.accept_assigned_job(p_job_id uuid, p_driver_id uuid DEFAULT NULL::uuid) RETURNS boolean
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'public', 'pg_temp'
    AS $$
DECLARE
    v_caller UUID := auth.uid();
    v_updated BOOLEAN;
    v_constraint TEXT;
BEGIN
    IF p_job_id IS NULL THEN
        RAISE EXCEPTION 'p_job_id is required';
    END IF;

    IF v_caller IS NULL THEN
        RAISE EXCEPTION 'Authentication required to confirm an assignment';
    END IF;

    IF p_driver_id IS NOT NULL AND p_driver_id <> v_caller THEN
        RAISE EXCEPTION 'A driver may only confirm a request assigned to themselves';
    END IF;

    -- N12: defensive. Ownership was created earlier by assign_driver_to_job, so
    -- this cannot itself create a second ownership; the check rejects only the
    -- case where the driver holds ANOTHER occupying job besides this target.
    IF public.driver_has_other_active_job(v_caller, p_job_id) THEN
        RAISE EXCEPTION 'Driver already has an active job'
            USING ERRCODE = 'MB001',
                  CONSTRAINT = 'idx_jobs_one_active_per_driver',
                  DETAIL = 'driver_single_active_job';
    END IF;

    -- Atomic: only the driver already stored on the job may confirm it, only from
    -- 'assigned', and only while accepted_driver_id is still unset. A repeat call
    -- matches no row and returns FALSE without raising.
    BEGIN
        UPDATE public.jobs
        SET status = 'accepted',
            accepted_driver_id = v_caller,
            accepted_at = NOW(),
            updated_at = NOW()
        WHERE id = p_job_id
          AND status = 'assigned'
          AND driver_id = v_caller
          AND accepted_driver_id IS NULL;

        v_updated := FOUND;
    EXCEPTION
        WHEN unique_violation THEN
            GET STACKED DIAGNOSTICS v_constraint = CONSTRAINT_NAME;
            IF v_constraint = 'idx_jobs_one_active_per_driver' THEN
                RAISE EXCEPTION 'Driver already has an active job'
                    USING ERRCODE = 'MB001',
                          CONSTRAINT = 'idx_jobs_one_active_per_driver',
                          DETAIL = 'driver_single_active_job';
            END IF;
            RAISE;
    END;

    RETURN v_updated;
END;
$$;


--
-- Name: accept_driver_offer(uuid, uuid); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.accept_driver_offer(p_job_id uuid, p_driver_id uuid) RETURNS jsonb
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'public', 'pg_temp'
    AS $$
DECLARE
    v_job        public.jobs;
    v_offer      public.fare_negotiations;
    v_caller     UUID := auth.uid();
    v_constraint TEXT;
BEGIN
    -- Identity: a browser caller may only accept their OWN offer. service_role
    -- (the trusted server) may act on behalf of the negotiation's driver, whose
    -- id is derived server-side from the negotiation row, never from the client.
    IF v_caller IS NOT NULL AND v_caller <> p_driver_id THEN
        RAISE EXCEPTION 'You can only accept your own fare offer'
            USING ERRCODE = '42501',
                  DETAIL  = 'caller_mismatch';
    END IF;

    -- Lock the job first so concurrent acceptances serialise on one row.
    SELECT * INTO v_job
      FROM public.jobs
     WHERE id = p_job_id
     FOR UPDATE;

    IF NOT FOUND THEN
        RAISE EXCEPTION 'Job not found'
            USING ERRCODE = 'P0002',
                  DETAIL  = 'job_not_found';
    END IF;

    -- The job must still be open for negotiation.
    IF v_job.status NOT IN ('pending_fare_confirmation', 'negotiating') THEN
        RAISE EXCEPTION 'This offer is no longer available'
            USING ERRCODE = '23514',
                  DETAIL  = 'job_not_negotiating';
    END IF;

    -- Ownership transition: free, or already this driver. A -> B is refused.
    IF v_job.driver_id IS NOT NULL AND v_job.driver_id <> p_driver_id THEN
        RAISE EXCEPTION 'This job is already owned by another driver'
            USING ERRCODE = '23505',
                  DETAIL  = 'job_already_owned_by_other_driver';
    END IF;

    -- The offer must exist, come from THIS driver, and still be pending.
    SELECT * INTO v_offer
      FROM public.fare_negotiations
     WHERE job_id = p_job_id
       AND proposed_by = p_driver_id
       AND proposed_by_role = 'driver'
       AND status = 'pending'
     ORDER BY created_at DESC
     LIMIT 1
     FOR UPDATE;

    IF NOT FOUND THEN
        RAISE EXCEPTION 'No pending driver offer found'
            USING ERRCODE = 'P0002',
                  DETAIL  = 'offer_not_found';
    END IF;

    IF v_offer.amount IS NULL OR v_offer.amount <= 0 THEN
        RAISE EXCEPTION 'Offer amount is not valid'
            USING ERRCODE = '22023',
                  DETAIL  = 'invalid_offer_amount';
    END IF;

    UPDATE public.fare_negotiations
       SET status = 'accepted',
           updated_at = now()
     WHERE id = v_offer.id;

    -- Guarded ownership write. The predicate plus the FOUND check mean this can
    -- never report success unless the row actually moved to fare_agreed.
    BEGIN
        UPDATE public.jobs
           SET status       = 'fare_agreed',
               driver_id    = p_driver_id,
               agreed_fare  = v_offer.amount,
               updated_at   = now()
         WHERE id = p_job_id
           AND status IN ('pending_fare_confirmation', 'negotiating')
           AND (driver_id IS NULL OR driver_id = p_driver_id)
        RETURNING * INTO v_job;

        IF NOT FOUND THEN
            RAISE EXCEPTION 'Ownership was not applied'
                USING ERRCODE = '23514',
                      DETAIL  = 'ownership_not_applied';
        END IF;
    EXCEPTION
        WHEN unique_violation THEN
            GET STACKED DIAGNOSTICS v_constraint = CONSTRAINT_NAME;
            IF v_constraint = 'idx_jobs_one_active_per_driver' THEN
                RAISE EXCEPTION 'Driver already has an active job'
                    USING ERRCODE    = 'MB001',
                          CONSTRAINT = 'idx_jobs_one_active_per_driver',
                          DETAIL     = 'driver_single_active_job';
            END IF;
            RAISE;
    END;

    RETURN jsonb_build_object(
        'job_id',         p_job_id,
        'driver_id',      p_driver_id,
        'negotiation_id', v_offer.id,
        'agreed_fare',    v_offer.amount,
        'status',         v_job.status,
        'accepted_at',    now()
    );
END;
$$;


--
-- Name: accept_fare_negotiation(uuid, uuid); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.accept_fare_negotiation(p_job_id uuid, p_driver_id uuid) RETURNS jsonb
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'public', 'pg_temp'
    AS $$
DECLARE
    v_job public.jobs;
    v_negotiation public.fare_negotiations;
    v_agreed_fare NUMERIC;
    v_now TIMESTAMPTZ := now();
    v_constraint TEXT;
BEGIN
    IF p_job_id IS NULL OR p_driver_id IS NULL THEN
        RAISE EXCEPTION 'p_job_id and p_driver_id are required'
            USING ERRCODE = '22023';
    END IF;

    -- ------------------------------------------------------------------
    -- 1. Lock the job first. This is the serialisation point: concurrent
    --    accepts for the same job queue here, so the loser observes the
    --    winner's committed state.
    -- ------------------------------------------------------------------
    SELECT * INTO v_job
    FROM public.jobs
    WHERE id = p_job_id
    FOR UPDATE;

    IF NOT FOUND THEN
        RAISE EXCEPTION 'Job not found'
            USING ERRCODE = 'P0002';
    END IF;

    IF v_job.negotiation_mode_enabled IS NOT TRUE THEN
        RAISE EXCEPTION 'Job is not in negotiation mode'
            USING ERRCODE = '22023';
    END IF;

    -- Job must still be in a negotiation state. Both statuses are reachable:
    -- the discovery query below is the only one this function performs, and
    -- POST /api/booking/negotiation sets 'negotiating' for a customer offer
    -- and 'pending_fare_confirmation' for a driver offer.
    IF v_job.status NOT IN ('pending_fare_confirmation', 'negotiating') THEN
        RAISE EXCEPTION 'Job is no longer available for negotiation (status %)', v_job.status
            USING ERRCODE = '23514';
    END IF;

    -- ------------------------------------------------------------------
    -- 2. Ownership guard. A job already owned by a different driver is lost.
    -- ------------------------------------------------------------------
    IF v_job.driver_id IS NOT NULL AND v_job.driver_id <> p_driver_id THEN
        RAISE EXCEPTION 'Job is already owned by another driver'
            USING ERRCODE = '23505';
    END IF;

    -- ------------------------------------------------------------------
    -- 2b. N12 (secondary, deterministic UX only). Fails fast BEFORE locking a
    --     fare_negotiations row. The target job is excluded so this can never
    --     reject the driver's own job. The unique index remains the guarantee.
    -- ------------------------------------------------------------------
    IF public.driver_has_other_active_job(p_driver_id, p_job_id) THEN
        RAISE EXCEPTION 'Driver already has an active job'
            USING ERRCODE = 'MB001',
                  CONSTRAINT = 'idx_jobs_one_active_per_driver',
                  DETAIL = 'driver_single_active_job';
    END IF;

    -- ------------------------------------------------------------------
    -- 3. Deterministic selection of the newest pending CUSTOMER offer, then
    --    lock that row. Lock order is jobs -> fare_negotiations, matching the
    --    convention used by the other negotiation RPCs.
    -- ------------------------------------------------------------------
    SELECT * INTO v_negotiation
    FROM public.fare_negotiations
    WHERE job_id = p_job_id
      AND proposed_by_role = 'customer'
      AND status = 'pending'
    ORDER BY created_at DESC, id DESC
    LIMIT 1
    FOR UPDATE;

    IF NOT FOUND THEN
        RAISE EXCEPTION 'No pending customer offer found'
            USING ERRCODE = 'P0002';
    END IF;

    -- Re-assert under the row lock. The SELECT above filtered on status, but
    -- this makes the invariant explicit and fails closed if the predicate is
    -- ever changed.
    IF v_negotiation.status <> 'pending' THEN
        RAISE EXCEPTION 'Offer is no longer pending'
            USING ERRCODE = '23514';
    END IF;

    v_agreed_fare := ROUND(COALESCE(v_negotiation.amount, 0)::NUMERIC, 2);

    IF v_agreed_fare <= 0 THEN
        RAISE EXCEPTION 'Agreed fare must be greater than zero'
            USING ERRCODE = '22023';
    END IF;

    -- ------------------------------------------------------------------
    -- 4. Writes. Both inside this transaction, so ownership and status can
    --    never diverge.
    -- ------------------------------------------------------------------
    UPDATE public.fare_negotiations
    SET status = 'accepted',
        updated_at = v_now
    WHERE id = v_negotiation.id
    RETURNING * INTO v_negotiation;

    BEGIN
        UPDATE public.jobs
        SET status = 'fare_agreed',
            driver_id = p_driver_id,
            negotiated_fare = v_agreed_fare,
            agreed_fare = v_agreed_fare,
            updated_at = v_now
        WHERE id = p_job_id
        RETURNING * INTO v_job;
    EXCEPTION
        WHEN unique_violation THEN
            GET STACKED DIAGNOSTICS v_constraint = CONSTRAINT_NAME;
            IF v_constraint = 'idx_jobs_one_active_per_driver' THEN
                RAISE EXCEPTION 'Driver already has an active job'
                    USING ERRCODE = 'MB001',
                          CONSTRAINT = 'idx_jobs_one_active_per_driver',
                          DETAIL = 'driver_single_active_job';
            END IF;
            RAISE;
    END;

    -- Sufficient data for the route to build its existing HTTP response and to
    -- re-derive the pricing breakdown via PricingService.applyAgreedFare.
    RETURN jsonb_build_object(
        'job_id', p_job_id,
        'driver_id', p_driver_id,
        'agreed_fare', v_agreed_fare,
        'negotiation', to_jsonb(v_negotiation)
    );
END;
$$;


--
-- Name: accept_searching_job(uuid, uuid); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.accept_searching_job(p_job_id uuid, p_driver_id uuid) RETURNS boolean
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'public', 'pg_temp'
    AS $$
DECLARE
    v_caller UUID := auth.uid();
    v_updated BOOLEAN;
    v_constraint TEXT;
BEGIN
    IF p_job_id IS NULL OR p_driver_id IS NULL THEN
        RAISE EXCEPTION 'p_job_id and p_driver_id are required';
    END IF;

    -- Browser/authenticated callers may only claim work for themselves.
    -- service_role calls have no auth.uid() and remain available to trusted server code.
    IF v_caller IS NOT NULL AND v_caller <> p_driver_id THEN
        RAISE EXCEPTION 'A driver may only accept a request for themselves';
    END IF;

    IF NOT public.driver_vehicle_can_accept_job(p_job_id, p_driver_id) THEN
        RAISE EXCEPTION 'Driver vehicle is not compatible with this request';
    END IF;

    -- N12 (secondary, deterministic UX only). The target job is excluded, so a
    -- repeat call on a job this driver already owns behaves exactly as before:
    -- the UPDATE predicate below matches no row and the function returns FALSE.
    IF public.driver_has_other_active_job(p_driver_id, p_job_id) THEN
        RAISE EXCEPTION 'Driver already has an active job'
            USING ERRCODE = 'MB001',
                  CONSTRAINT = 'idx_jobs_one_active_per_driver',
                  DETAIL = 'driver_single_active_job';
    END IF;

    BEGIN
        UPDATE public.jobs
        SET driver_id = p_driver_id,
            accepted_driver_id = p_driver_id,
            status = 'accepted',
            accepted_at = NOW(),
            updated_at = NOW()
        WHERE id = p_job_id
          -- Exactly the statuses the driver UI advertises as available
          -- (driver.service.ts availableRequestStatuses + the realtime filter +
          --  dispatch.service.ts, which writes 'broadcasting' and 'waiting').
          AND status IN ('pending', 'requested', 'searching', 'broadcasting', 'waiting')
          AND driver_id IS NULL
          AND accepted_driver_id IS NULL;

        v_updated := FOUND;
    EXCEPTION
        WHEN unique_violation THEN
            GET STACKED DIAGNOSTICS v_constraint = CONSTRAINT_NAME;
            IF v_constraint = 'idx_jobs_one_active_per_driver' THEN
                RAISE EXCEPTION 'Driver already has an active job'
                    USING ERRCODE = 'MB001',
                          CONSTRAINT = 'idx_jobs_one_active_per_driver',
                          DETAIL = 'driver_single_active_job';
            END IF;
            RAISE;
    END;

    RETURN v_updated;
END;
$$;


--
-- Name: activate_job_issuing_control(uuid, text, numeric, jsonb); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.activate_job_issuing_control(p_job uuid, p_card text, p_budget numeric, p_metadata jsonb) RETURNS void
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'public', 'pg_temp'
    AS $$
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


--
-- Name: admin_live_presence(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.admin_live_presence() RETURNS jsonb
    LANGUAGE plpgsql STABLE SECURITY DEFINER
    SET search_path TO 'public'
    AS $$
DECLARE actor public.profiles%ROWTYPE; result jsonb;
BEGIN
 SELECT * INTO actor FROM profiles WHERE id=auth.uid();
 IF actor.id IS NULL OR actor.role<>'admin' THEN RAISE EXCEPTION 'Admin required' USING ERRCODE='42501'; END IF;
 SELECT jsonb_build_object(
  'online_drivers_count',count(*) FILTER(WHERE p.role='driver' AND p.is_online=true),
  'online_customers_count',count(*) FILTER(WHERE p.role='customer'),
  'checked_at',now()
 ) INTO result FROM profiles p
 WHERE p.tenant_id IS NOT DISTINCT FROM actor.tenant_id
 AND EXISTS(SELECT 1 FROM app_presence_sessions s WHERE s.user_id=p.id AND s.seen_at>now()-interval '2 minutes');
 RETURN result;
END;$$;


--
-- Name: admin_message_conversation(uuid, text, uuid, jsonb); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.admin_message_conversation(p_actor uuid, p_action text, p_thread uuid DEFAULT NULL::uuid, p_input jsonb DEFAULT '{}'::jsonb) RETURNS jsonb
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'public'
    AS $$
DECLARE actor public.profiles; t public.admin_message_threads; target uuid; is_admin boolean; msg text; rid uuid; e public.admin_message_entries; n uuid; through_id bigint; result jsonb;
BEGIN
 SELECT * INTO actor FROM public.profiles WHERE id=p_actor;
 IF NOT FOUND THEN RAISE EXCEPTION 'Account unavailable'; END IF;
 is_admin:=COALESCE(actor.role='admin',false);
 IF p_action='list' THEN
  SELECT COALESCE(jsonb_agg(row_to_json(x) ORDER BY x.updated_at DESC),'[]'::jsonb) INTO result FROM (
   SELECT th.*,p.full_name AS user_name,p.role AS user_role,
    (SELECT count(*) FROM public.admin_message_entries m WHERE m.thread_id=th.id AND m.direction=CASE WHEN is_admin THEN 'user' ELSE 'admin' END AND m.read_at IS NULL) AS unread
   FROM public.admin_message_threads th JOIN public.profiles p ON p.id=th.user_id
   WHERE CASE WHEN is_admin THEN (COALESCE(th.assigned_admin_id=p_actor,false) OR th.tenant_id IS NOT DISTINCT FROM actor.tenant_id) AND p.tenant_id IS NOT DISTINCT FROM th.tenant_id ELSE th.user_id=p_actor END
   ORDER BY th.updated_at DESC LIMIT 100
  ) x; RETURN result;
 END IF;
 target:=p_thread;
 SELECT * INTO t FROM public.admin_message_threads WHERE id=target;
 IF NOT FOUND THEN
  SELECT thread_id INTO target FROM public.admin_message_entries WHERE notification_id=p_thread;
  IF NOT FOUND THEN
   -- Legacy lazy conversion is restricted to the notification's recipient (or same-tenant admin).
   IF NOT EXISTS(SELECT 1 FROM public.notifications n JOIN public.profiles p ON p.id=n.user_id WHERE n.id=p_thread
      AND CASE WHEN is_admin THEN (p.tenant_id IS NOT DISTINCT FROM actor.tenant_id OR COALESCE(n.metadata->>'admin_sender_id',n.data->>'admin_sender_id')=p_actor::text) ELSE n.user_id=p_actor END) THEN RAISE EXCEPTION 'Conversation unavailable'; END IF;
   target:=public.seed_admin_message_thread(p_thread,false);
  END IF;
  SELECT * INTO t FROM public.admin_message_threads WHERE id=target;
 END IF;
 IF t.id IS NULL OR NOT(CASE WHEN is_admin THEN (COALESCE(t.assigned_admin_id=p_actor,false) OR t.tenant_id IS NOT DISTINCT FROM actor.tenant_id) ELSE t.user_id=p_actor END) THEN RAISE EXCEPTION 'Conversation unavailable'; END IF;
 -- Recheck current account tenant, so a transferred account cannot leak old messages.
 IF is_admin AND NOT EXISTS(SELECT 1 FROM public.profiles p WHERE p.id=t.user_id AND p.tenant_id IS NOT DISTINCT FROM t.tenant_id) THEN RAISE EXCEPTION 'Conversation unavailable'; END IF;
 IF p_action='send' THEN
  msg:=btrim(COALESCE(p_input->>'message','')); rid:=(p_input->>'requestId')::uuid;
  IF length(msg)<1 OR length(msg)>2000 OR rid IS NULL THEN RAISE EXCEPTION 'A message of 1–2000 characters and request reference are required'; END IF;
  PERFORM 1 FROM public.admin_message_threads WHERE id=t.id FOR UPDATE;
  SELECT * INTO e FROM public.admin_message_entries WHERE thread_id=t.id AND sender_id=p_actor AND request_id=rid;
  IF FOUND THEN
   IF e.body<>msg THEN RAISE EXCEPTION 'Request reference reused with another message'; END IF;
   RETURN jsonb_build_object('id',e.id::text,'threadId',t.id,'saved',true);
  END IF;
  INSERT INTO public.admin_message_entries(thread_id,sender_id,direction,body,request_id)
  VALUES(t.id,p_actor,CASE WHEN is_admin THEN 'admin' ELSE 'user' END,msg,rid) RETURNING * INTO e;
  IF is_admin THEN
   n:=gen_random_uuid();
   -- The notification trigger links this existing entry and queues email in the same transaction.
   INSERT INTO public.notifications(id,user_id,title,body,type,is_read,route,data,metadata)
   VALUES(n,t.user_id,'Reply from Vaydu',msg,'system_alert',false,'/account/messages',
    jsonb_build_object('action','admin_message','thread_id',t.id,'entry_id',e.id),
    jsonb_build_object('action','admin_message','thread_id',t.id,'entry_id',e.id));
   UPDATE public.admin_message_entries SET notification_id=n WHERE id=e.id;
   INSERT INTO public.admin_message_email_outbox(entry_id,user_id) VALUES(e.id,t.user_id) ON CONFLICT DO NOTHING;
  END IF;
  UPDATE public.admin_message_threads SET updated_at=now() WHERE id=t.id;
  RETURN jsonb_build_object('id',e.id::text,'threadId',t.id,'notificationId',n,'userId',t.user_id,'role',(SELECT role FROM public.profiles WHERE id=t.user_id),'saved',true);
 ELSIF p_action='read' THEN
  IF jsonb_typeof(p_input->'ids') IS DISTINCT FROM 'array' OR jsonb_array_length(p_input->'ids') NOT BETWEEN 1 AND 100 THEN RAISE EXCEPTION 'Displayed messages required'; END IF;
  IF EXISTS(SELECT 1 FROM jsonb_array_elements_text(p_input->'ids') x(id) WHERE NOT EXISTS(SELECT 1 FROM public.admin_message_entries m WHERE m.id=x.id::bigint AND m.thread_id=t.id)) THEN RAISE EXCEPTION 'Displayed messages unavailable'; END IF;
  UPDATE public.admin_message_entries SET read_at=COALESCE(read_at,now()) WHERE thread_id=t.id AND id IN (SELECT x::bigint FROM jsonb_array_elements_text(p_input->'ids') x)
   AND direction=CASE WHEN is_admin THEN 'user' ELSE 'admin' END AND read_at IS NULL;
  IF NOT is_admin THEN UPDATE public.notifications SET is_read=true WHERE id IN
   (SELECT notification_id FROM public.admin_message_entries WHERE thread_id=t.id AND id IN (SELECT x::bigint FROM jsonb_array_elements_text(p_input->'ids') x) AND direction='admin') AND user_id=p_actor; END IF;
  RETURN jsonb_build_object('saved',true);
 ELSIF p_action='thread' THEN
  SELECT COALESCE(jsonb_agg(row_to_json(x) ORDER BY x.seq),'[]'::jsonb) INTO result FROM (
   SELECT m.id::text AS id,m.id AS seq,m.direction,m.body,m.created_at,m.read_at,
    CASE WHEN is_admin THEN o.status ELSE NULL END AS email_status
   FROM public.admin_message_entries m LEFT JOIN public.admin_message_email_outbox o ON o.entry_id=m.id
   WHERE m.thread_id=t.id AND ((p_input->>'before') IS NULL OR m.id<(p_input->>'before')::bigint) ORDER BY m.id DESC LIMIT 100
  ) x;
  RETURN jsonb_build_object('id',t.id,'subject',t.subject,'userId',t.user_id,'messages',result,'hasMore',EXISTS(SELECT 1 FROM public.admin_message_entries WHERE thread_id=t.id AND id<(SELECT min((v->>'id')::bigint) FROM jsonb_array_elements(result) v)));
 ELSE RAISE EXCEPTION 'Unsupported conversation action'; END IF;
END; $$;


--
-- Name: append_journey_evidence_v23(uuid, uuid, uuid, double precision, double precision, double precision, timestamp with time zone); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.append_journey_evidence_v23(p_job_id uuid, p_driver_id uuid, p_tenant_id uuid, p_lat double precision, p_lng double precision, p_accuracy double precision, p_sampled_at timestamp with time zone) RETURNS text
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'pg_catalog', 'public'
    AS $$
DECLARE
  current_job record;
  latest_time timestamptz;
  row_count bigint;
BEGIN
  IF p_job_id IS NULL OR p_driver_id IS NULL OR p_tenant_id IS NULL
    OR p_lat IS NULL OR p_lng IS NULL OR p_accuracy IS NULL OR p_sampled_at IS NULL
    OR NOT (p_lat BETWEEN -90 AND 90) OR NOT (p_lng BETWEEN -180 AND 180)
    OR (abs(p_lat)<0.00001 AND abs(p_lng)<0.00001)
    OR NOT (p_accuracy BETWEEN 0 AND 100)
    OR p_sampled_at<clock_timestamp()-interval '90 seconds'
    OR p_sampled_at>clock_timestamp()+interval '30 seconds'
  THEN RAISE EXCEPTION 'Fresh accurate journey point required'; END IF;

  -- Serialise samples for this booking. Lock current assignment/status so a
  -- concurrent completion/reassignment cannot authorise a post-transition sample.
  PERFORM pg_advisory_xact_lock(hashtextextended('journey-evidence-v23:'||p_job_id::text,0));
  SELECT j.id,j.driver_id,j.tenant_id,j.status INTO current_job
  FROM public.jobs j WHERE j.id=p_job_id FOR SHARE;
  IF NOT FOUND OR current_job.driver_id IS DISTINCT FROM p_driver_id
    OR current_job.tenant_id IS DISTINCT FROM p_tenant_id
    OR current_job.status IS NULL OR current_job.status NOT IN (
      'assigned','accepted','heading_to_pickup','over_budget_requested','delivered','en_route',
      'en_route_to_pickup','arrived','arrived_at_pickup','arrived_at_store','shopping_in_progress',
      'shopping_completed','items_collected','collected','en_route_to_customer','arrived_at_customer',
      'in_progress','on_trip'
    ) THEN RAISE EXCEPTION 'Active assigned journey required'; END IF;

  SELECT e.sampled_at INTO latest_time FROM public.journey_evidence_v23 e
    WHERE e.job_id=p_job_id ORDER BY e.sampled_at DESC LIMIT 1;
  IF latest_time=p_sampled_at THEN RETURN 'duplicate'; END IF;
  IF latest_time>p_sampled_at THEN RETURN 'out_of_order'; END IF;
  IF latest_time IS NOT NULL AND p_sampled_at-latest_time<interval '5 seconds' THEN RETURN 'throttled'; END IF;
  SELECT count(*) INTO row_count FROM public.journey_evidence_v23 e WHERE e.job_id=p_job_id;
  IF row_count>=7200 THEN RETURN 'limit_reached'; END IF;

  INSERT INTO public.journey_evidence_v23(job_id,driver_id,tenant_id,latitude,longitude,accuracy_metres,sampled_at,booking_phase)
    VALUES(p_job_id,p_driver_id,p_tenant_id,p_lat,p_lng,p_accuracy,p_sampled_at,current_job.status);
  RETURN 'recorded';
END
$$;


--
-- Name: approve_card_errand_budget(uuid, uuid, text, text, numeric, numeric, text); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.approve_card_errand_budget(p_job uuid, p_request uuid, p_old_intent text, p_new_intent text, p_budget numeric, p_available numeric, p_currency text) RETURNS boolean
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'public', 'pg_temp'
    AS $$
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


--
-- Name: approve_errand_over_budget(uuid); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.approve_errand_over_budget(p_job_id uuid) RETURNS boolean
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'public', 'pg_temp'
    AS $$
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


--
-- Name: assign_driver_to_job(uuid, uuid); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.assign_driver_to_job(p_job_id uuid, p_driver_id uuid) RETURNS boolean
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'public', 'pg_temp'
    AS $$
DECLARE
    v_updated BOOLEAN;
    v_constraint TEXT;
BEGIN
    -- Release closure: a non-service_role caller must be a tenant admin.
    IF auth.uid() IS NOT NULL AND NOT EXISTS (
        SELECT 1
        FROM public.profiles
        WHERE id = auth.uid() AND role = 'admin'
    ) THEN
        RAISE EXCEPTION 'Only an administrator can assign a driver to a job';
    END IF;

    IF NOT public.driver_vehicle_can_accept_job(p_job_id, p_driver_id) THEN
        RAISE EXCEPTION 'Driver vehicle is not compatible with this request';
    END IF;

    -- N12 (secondary, deterministic UX only). The target job is excluded, so an
    -- idempotent re-assignment of a job this driver already owns behaves as
    -- before. The unique index still decides the race.
    IF public.driver_has_other_active_job(p_driver_id, p_job_id) THEN
        RAISE EXCEPTION 'Driver already has an active job'
            USING ERRCODE = 'MB001',
                  CONSTRAINT = 'idx_jobs_one_active_per_driver',
                  DETAIL = 'driver_single_active_job';
    END IF;

    BEGIN
        UPDATE public.jobs
        SET driver_id = p_driver_id,
            status = 'assigned',
            updated_at = NOW()
        WHERE id = p_job_id
          AND status IN ('pending', 'requested', 'searching')
          AND driver_id IS NULL;

        v_updated := FOUND;
    EXCEPTION
        WHEN unique_violation THEN
            GET STACKED DIAGNOSTICS v_constraint = CONSTRAINT_NAME;
            IF v_constraint = 'idx_jobs_one_active_per_driver' THEN
                RAISE EXCEPTION 'Driver already has an active job'
                    USING ERRCODE = 'MB001',
                          CONSTRAINT = 'idx_jobs_one_active_per_driver',
                          DETAIL = 'driver_single_active_job';
            END IF;
            RAISE;
    END;

    RETURN v_updated;
END;
$$;


--
-- Name: audit_market_payment_route_v23(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.audit_market_payment_route_v23() RETURNS trigger
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'pg_catalog', 'public'
    AS $$
BEGIN
 INSERT INTO public.market_payment_route_audit(route_id,actor,old_values,new_values)
 VALUES(NEW.id,session_user,CASE WHEN TG_OP='UPDATE' THEN to_jsonb(OLD) ELSE NULL END,to_jsonb(NEW));
 RETURN NEW;
END
$$;


--
-- Name: bind_driver_payment_recovery(uuid, text, text); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.bind_driver_payment_recovery(p_id uuid, p_candidate text, p_evidence text) RETURNS boolean
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'public', 'pg_temp'
    AS $_$
BEGIN
 IF length(btrim(p_evidence))<8 THEN RAISE EXCEPTION 'Reviewed candidate evidence required';END IF;
 UPDATE public.driver_payment_accounts SET beneficiary_id=p_candidate,recovery_evidence_ref=p_evidence,state='reconciliation_required',updated_at=now()
 WHERE id=p_id AND submission_attempted_at IS NOT NULL AND beneficiary_id IS NULL
 AND ((provider='flutterwave' AND p_candidate ~ '^[1-9][0-9]*$') OR (provider='paystack' AND p_candidate ~ '^RCP_[A-Za-z0-9_-]+$'));
 RETURN FOUND;
END $_$;


--
-- Name: can_view_job_details(uuid); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.can_view_job_details(p_job_id uuid) RETURNS boolean
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'public'
    AS $$
BEGIN
    RETURN EXISTS (
        SELECT 1 FROM jobs 
        WHERE id = p_job_id 
          AND (customer_id = auth.uid() OR driver_id = auth.uid())
    );
END;
$$;


--
-- Name: cancel_job_safely(uuid, text); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.cancel_job_safely(p_job_id uuid, p_reason text DEFAULT 'User cancelled'::text) RETURNS boolean
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'public', 'pg_temp'
    AS $$
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


--
-- Name: canonical_driver_service(text); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.canonical_driver_service(p_raw text) RETURNS text
    LANGUAGE sql IMMUTABLE
    SET search_path TO 'public', 'pg_temp'
    AS $$
    SELECT CASE LOWER(BTRIM(COALESCE(p_raw, '')))
        WHEN 'ride'        THEN 'ride'
        WHEN 'errand'      THEN 'errand'
        WHEN 'shop'        THEN 'errand'
        WHEN 'shopping'    THEN 'errand'
        WHEN 'delivery'    THEN 'delivery'
        WHEN 'deliver'     THEN 'delivery'
        WHEN 'van-moving'  THEN 'van-moving'
        WHEN 'van_moving'  THEN 'van-moving'
        WHEN 'move'        THEN 'van-moving'
        WHEN 'moving'      THEN 'van-moving'
        WHEN 'van'         THEN 'van-moving'
        ELSE NULL
    END;
$$;


--
-- Name: cash_credit_minor_v1e(jsonb, text); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.cash_credit_minor_v1e(v jsonb, c text) RETURNS bigint
    LANGUAGE plpgsql STABLE SECURITY DEFINER
    SET search_path TO 'pg_catalog', 'public'
    AS $_$
DECLARE n numeric; factor numeric;
BEGIN
 IF v IS NULL OR jsonb_typeof(v) NOT IN ('number','string') OR (v#>>'{}') !~ '^[0-9]+(\.[0-9]+)?$' THEN
  RAISE EXCEPTION 'Invalid frozen money value' USING ERRCODE='CE003'; END IF;
 factor:=power(10::numeric,public.wallet_currency_minor_exponent(c));
 n:=(v#>>'{}')::numeric*factor;
 IF n IS NULL OR n<>trunc(n) OR n<0 OR n>9223372036854775807 THEN
  RAISE EXCEPTION 'Frozen money is not representable in currency minor units' USING ERRCODE='CE003'; END IF;
 RETURN n::bigint;
END $_$;


--
-- Name: cash_credit_service_writer_v1e(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.cash_credit_service_writer_v1e() RETURNS boolean
    LANGUAGE sql STABLE
    SET search_path TO 'pg_catalog'
    AS $$
 SELECT current_setting('role',true)='service_role' OR
  (session_user IN ('postgres','supabase_admin') AND current_setting('role',true) IN ('none','postgres','supabase_admin')) $$;


--
-- Name: cash_credit_terms_v1e(jsonb, text); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.cash_credit_terms_v1e(b jsonb, c text) RETURNS jsonb
    LANGUAGE plpgsql STABLE SECURITY DEFINER
    SET search_path TO 'pg_catalog', 'public'
    AS $_$
DECLARE base bigint; charge bigint; fee bigint; commission bigint; net bigint; rate numeric;
BEGIN
 IF b->>'policyVersion' IS DISTINCT FROM 'fare-split-v1' OR b->>'currency' IS DISTINCT FROM c
 OR b->>'platformFeeType' IS DISTINCT FROM 'percentage' THEN
  RAISE EXCEPTION 'Canonical percentage-mode frozen fare required' USING ERRCODE='CE003'; END IF;
 base:=public.cash_credit_minor_v1e(b->'driverBase',c);
 charge:=public.cash_credit_minor_v1e(b->'customerCharge',c);
 fee:=public.cash_credit_minor_v1e(b->'platformFeeAmount',c);
 commission:=public.cash_credit_minor_v1e(b->'driverCommissionAmount',c);
 net:=public.cash_credit_minor_v1e(b->'driverEntitlement',c);
 IF base<=0 OR net<=0 OR charge::numeric<>base::numeric+fee::numeric OR net::numeric+commission::numeric<>base::numeric THEN
  RAISE EXCEPTION 'Unbalanced frozen cash fare' USING ERRCODE='CE003'; END IF;
 IF b->>'commissionPercent' IS NULL OR b->>'platformFeePercent' IS NULL
 OR b->>'commissionPercent' !~ '^[0-9]+(\.[0-9]+)?$' OR b->>'platformFeePercent' !~ '^[0-9]+(\.[0-9]+)?$' THEN
  RAISE EXCEPTION 'Frozen fee percentages missing' USING ERRCODE='CE003'; END IF;
 IF (b->>'commissionPercent')::numeric>=100 OR (b->>'platformFeePercent')::numeric>=100
 OR public.cash_credit_minor_v1e(b->'platformFeeFixed',c)<>0 THEN
  RAISE EXCEPTION 'Invalid percentage fee policy' USING ERRCODE='CE003'; END IF;
 IF b ? 'driverCommissionPolicy' AND b->'driverCommissionPolicy'->>'frozen' IS DISTINCT FROM 'true' THEN
  RAISE EXCEPTION 'Driver-specific commission must be frozen before cash acceptance' USING ERRCODE='CE003'; END IF;
 RETURN jsonb_build_object('charge',charge,'commission',commission,'fee',fee,'net',net,'required',commission::numeric+fee::numeric);
END $_$;


--
-- Name: check_errand_completion_guard(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.check_errand_completion_guard() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
BEGIN
    IF NEW.status = 'completed' AND OLD.status IS DISTINCT FROM NEW.status THEN
        IF EXISTS (
            SELECT 1
            FROM public.errand_funding
            WHERE job_id = NEW.id
              AND over_budget_status = 'requested'
        ) THEN
            RAISE EXCEPTION 'Cannot complete job with pending over-budget request';
        END IF;
    END IF;
    RETURN NEW;
END;
$$;


--
-- Name: check_wallet_integrity(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.check_wallet_integrity() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
BEGIN
    IF NEW.available_balance < 0 THEN
        RAISE EXCEPTION 'Wallet available balance cannot be negative';
    END IF;

    IF NEW.reserved_balance < 0 THEN
        RAISE EXCEPTION 'Wallet reserved balance cannot be negative';
    END IF;

    IF (NEW.available_balance + NEW.reserved_balance) < 0 THEN
        RAISE EXCEPTION 'Wallet total balance cannot be negative';
    END IF;

    RETURN NEW;
END;
$$;


--
-- Name: claim_admin_message_email(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.claim_admin_message_email() RETURNS jsonb
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'public'
    AS $$
DECLARE r public.admin_message_email_outbox; result jsonb;
BEGIN
 SELECT * INTO r FROM public.admin_message_email_outbox WHERE status='pending' AND retry_at<=now() AND (lease_until IS NULL OR lease_until<now())
 ORDER BY retry_at,entry_id FOR UPDATE SKIP LOCKED LIMIT 1;
 IF NOT FOUND THEN RETURN NULL; END IF;
 UPDATE public.admin_message_email_outbox SET lease_token=gen_random_uuid(),lease_until=now()+interval '5 minutes',attempts=attempts+1 WHERE entry_id=r.entry_id RETURNING * INTO r;
 SELECT jsonb_build_object('entryId',r.entry_id::text,'userId',r.user_id,'token',r.lease_token,'attempts',r.attempts,
  'body',m.body,'subject',th.subject,'notificationId',m.notification_id) INTO result
 FROM public.admin_message_entries m JOIN public.admin_message_threads th ON th.id=m.thread_id WHERE m.id=r.entry_id;
 RETURN result;
END; $$;


SET default_tablespace = '';

SET default_table_access_method = heap;

--
-- Name: booking_support_requests; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.booking_support_requests (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    request_id uuid NOT NULL,
    user_id uuid NOT NULL,
    job_id uuid NOT NULL,
    tenant_id uuid,
    category text NOT NULL,
    message text NOT NULL,
    sender_email text,
    country_code text,
    market_city text,
    driver_id uuid,
    status text DEFAULT 'open'::text NOT NULL,
    email_status text DEFAULT 'pending'::text NOT NULL,
    email_sent_at timestamp with time zone,
    driver_message_saved boolean DEFAULT false NOT NULL,
    attempt_count integer DEFAULT 0 NOT NULL,
    retry_at timestamp with time zone DEFAULT now() NOT NULL,
    lease_token uuid,
    lease_until timestamp with time zone,
    last_error text,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT booking_support_requests_category_check CHECK ((category = ANY (ARRAY['help'::text, 'issue'::text, 'payment'::text, 'safety'::text, 'lost_item'::text]))),
    CONSTRAINT booking_support_requests_check CHECK ((((length(message) >= 3) AND (length(message) <= 2000)) AND ((category <> 'lost_item'::text) OR (length(message) <= 1500)))),
    CONSTRAINT booking_support_requests_email_status_check CHECK ((email_status = ANY (ARRAY['pending'::text, 'processing'::text, 'sent'::text]))),
    CONSTRAINT booking_support_requests_status_check CHECK ((status = ANY (ARRAY['open'::text, 'resolved'::text])))
);


--
-- Name: claim_booking_support_email(uuid); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.claim_booking_support_email(p_id uuid DEFAULT NULL::uuid) RETURNS SETOF public.booking_support_requests
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'public', 'pg_temp'
    AS $$
DECLARE selected uuid;
BEGIN
 SELECT id INTO selected FROM public.booking_support_requests
 WHERE (p_id IS NULL OR id=p_id) AND email_status<>'sent'
 AND retry_at<=now() AND (lease_until IS NULL OR lease_until<now())
 ORDER BY created_at LIMIT 1 FOR UPDATE SKIP LOCKED;
 IF NOT FOUND THEN RETURN;END IF;
 RETURN QUERY UPDATE public.booking_support_requests SET email_status='processing',
 lease_token=gen_random_uuid(),lease_until=now()+interval '10 minutes',attempt_count=attempt_count+1
 WHERE id=selected RETURNING *;
END $$;


--
-- Name: claim_customer_wallet_sandbox_v1l(uuid, uuid, text); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.claim_customer_wallet_sandbox_v1l(p_owner uuid, p_id uuid, p_fingerprint text) RETURNS boolean
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'pg_catalog', 'public'
    AS $$
DECLARE a public.customer_wallet_sandbox_attempts_v1l%ROWTYPE; BEGIN
 SELECT * INTO a FROM public.customer_wallet_sandbox_attempts_v1l WHERE id=p_id AND owner_id=p_owner FOR UPDATE;
 IF NOT FOUND OR a.credential_fingerprint IS DISTINCT FROM p_fingerprint THEN RAISE EXCEPTION 'Original sandbox context required' USING ERRCODE='BL001';END IF;
 IF coalesce((SELECT value='true' FROM public.wallet_collection_config WHERE key='customer_wallet_sandbox_enabled'),false) IS DISTINCT FROM true OR NOT EXISTS(SELECT 1 FROM public.customer_wallet_sandbox_cohort_v1l WHERE owner_id=p_owner AND enabled AND tenant_id=a.tenant_id AND country_code=a.country_code AND currency_code=a.currency_code AND minor_exponent=a.minor_exponent AND max_amount_minor>=a.amount_minor) THEN RAISE EXCEPTION 'Sandbox admission disabled' USING ERRCODE='BL004';END IF;
 IF a.status<>'initiated' THEN RETURN false;END IF;
 UPDATE public.customer_wallet_sandbox_attempts_v1l SET status='submitting',updated_at=now() WHERE id=p_id;
 RETURN true;
END $$;


--
-- Name: driver_payment_accounts; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.driver_payment_accounts (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    driver_id uuid NOT NULL,
    tenant_id uuid NOT NULL,
    country_code text NOT NULL,
    currency_code text NOT NULL,
    provider text DEFAULT 'flutterwave'::text NOT NULL,
    merchant_account_ref text NOT NULL,
    state text NOT NULL,
    beneficiary_id text,
    bank_code text,
    last4 text,
    fingerprint text,
    setup_token uuid DEFAULT gen_random_uuid() NOT NULL,
    submission_attempted_at timestamp with time zone,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    recovery_evidence_ref text,
    CONSTRAINT driver_payment_accounts_completion_check CHECK (((state <> 'completed'::text) OR ((beneficiary_id IS NOT NULL) AND (fingerprint IS NOT NULL) AND (bank_code IS NOT NULL) AND (last4 IS NOT NULL) AND (fingerprint ~ '^[a-f0-9]{64}$'::text) AND (((provider = 'flutterwave'::text) AND (beneficiary_id ~ '^\d+$'::text)) OR ((provider = 'paystack'::text) AND (beneficiary_id ~ '^RCP_[A-Za-z0-9_-]+$'::text)))))),
    CONSTRAINT driver_payment_accounts_last4_check CHECK ((last4 ~ '^\d{4}$'::text)),
    CONSTRAINT driver_payment_accounts_provider_check CHECK ((provider = ANY (ARRAY['flutterwave'::text, 'paystack'::text]))),
    CONSTRAINT driver_payment_accounts_state_check CHECK ((state = ANY (ARRAY['not_started'::text, 'in_progress'::text, 'action_required'::text, 'reconciliation_required'::text, 'completed'::text, 'unavailable'::text])))
);


--
-- Name: claim_driver_payment_setup(uuid, uuid, text, text, text); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.claim_driver_payment_setup(p_driver uuid, p_tenant uuid, p_country text, p_currency text, p_merchant text) RETURNS SETOF public.driver_payment_accounts
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'public', 'pg_temp'
    AS $$
DECLARE v_provider text;
BEGIN
 SELECT m.provider INTO v_provider FROM public.driver_payout_markets m JOIN public.profiles p ON p.id=p_driver
  WHERE m.country_code=p_country AND m.currency_code=p_currency AND m.provider IN('flutterwave','paystack') AND m.enabled AND m.merchant_approved AND m.adapter_ready
  AND m.capability_verified_at IS NOT NULL AND m.capability_evidence_ref IS NOT NULL AND m.merchant_mode='test' AND m.merchant_account_ref=p_merchant AND m.sandbox_driver_id=p_driver AND m.sandbox_tenant_id=p_tenant
  AND p.tenant_id=p_tenant AND p.role='driver' AND p.registration_activated_at IS NOT NULL
  AND coalesce(p.registration_country_code,p.country_code)=p_country
  LIMIT 1;
 IF NOT FOUND THEN RAISE EXCEPTION 'Approved sandbox driver market required'; END IF;
 RETURN QUERY INSERT INTO public.driver_payment_accounts(driver_id,tenant_id,country_code,currency_code,provider,merchant_account_ref,state)
 VALUES(p_driver,p_tenant,p_country,p_currency,v_provider,p_merchant,'in_progress')
 ON CONFLICT(driver_id,tenant_id,country_code,currency_code,merchant_account_ref) DO UPDATE
 SET state='in_progress',setup_token=gen_random_uuid(),updated_at=now()
 WHERE public.driver_payment_accounts.submission_attempted_at IS NULL
    AND (public.driver_payment_accounts.state IN('not_started','action_required')
     OR (public.driver_payment_accounts.state='in_progress'
         AND public.driver_payment_accounts.updated_at<now()-interval '5 minutes'))
 RETURNING *;
END $$;


--
-- Name: claim_gb_mot_night(date); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.claim_gb_mot_night(p_day date) RETURNS boolean
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'public'
    AS $$
DECLARE claimed date;
BEGIN
 INSERT INTO gb_mot_night_runs(day,lease_until) VALUES(p_day,now()+interval '2 hours')
 ON CONFLICT(day) DO UPDATE SET lease_until=EXCLUDED.lease_until WHERE NOT gb_mot_night_runs.completed AND gb_mot_night_runs.lease_until<now()
 RETURNING day INTO claimed;
 RETURN claimed IS NOT NULL;
END;$$;


--
-- Name: claim_job_settlement(uuid, bigint, text, text, integer); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.claim_job_settlement(p_job_id uuid, p_amount_minor bigint, p_currency text, p_destination text, p_lease_seconds integer) RETURNS boolean
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'public'
    AS $$
DECLARE
  v_job_id uuid;
BEGIN
  UPDATE public.jobs SET
    settlement_status = 'claimed',
    settlement_claimed_at = now(),
    settlement_lease_expires_at = now() + make_interval(secs => p_lease_seconds),
    settlement_amount_minor = p_amount_minor,
    settlement_currency = p_currency,
    settlement_destination_account = p_destination,
    updated_at = now()
  WHERE id = p_job_id
    AND stripe_transfer_id IS NULL
    AND settlement_status IN ('pending','failed')
  RETURNING id INTO v_job_id;

  -- NOTE: a 'claimed' row whose lease has expired is deliberately NOT claimable
  -- here. The original worker may still be in-flight with Stripe, and a
  -- transfer_group lookup that returns nothing cannot prove the original request
  -- will never succeed. Recovery of a stale claim must go through reconciliation
  -- (record a found transfer) or become 'unknown' (block) — never auto re-claim.

  RETURN v_job_id IS NOT NULL;
END;
$$;


--
-- Name: claim_kora_sandbox_booking_refund(uuid, uuid, text, text); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.claim_kora_sandbox_booking_refund(p_job uuid, p_user uuid, p_account text, p_reference text) RETURNS jsonb
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'public', 'pg_temp'
    AS $_$
DECLARE b public.kora_sandbox_booking_payments;
BEGIN
 SELECT * INTO b FROM public.kora_sandbox_booking_payments WHERE job_id=p_job FOR UPDATE;
 IF NOT FOUND OR b.user_id IS DISTINCT FROM p_user OR b.merchant_account_ref IS DISTINCT FROM p_account
 OR b.state NOT IN ('verified','requires_refund','refunded') OR p_reference IS NULL
 OR p_reference !~ '^vaydu-refund-[a-f0-9]{32}$' THEN RAISE EXCEPTION 'Verified full refund binding required'; END IF;
 IF b.refund_reference IS NOT NULL THEN
   IF b.refund_reference IS DISTINCT FROM p_reference THEN RAISE EXCEPTION 'Original refund reference required'; END IF;
   RETURN jsonb_build_object('claimed',false,'payment',to_jsonb(b));
 END IF;
 UPDATE public.kora_sandbox_booking_payments SET state='requires_refund',refund_reference=p_reference,refund_state='started'
 WHERE job_id=p_job RETURNING * INTO b;
 RETURN jsonb_build_object('claimed',true,'payment',to_jsonb(b));
END $_$;


--
-- Name: marketplace_negotiation_sessions; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.marketplace_negotiation_sessions (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    job_id uuid NOT NULL,
    customer_id uuid NOT NULL,
    active_driver_id uuid,
    status text DEFAULT 'open'::text NOT NULL,
    suggested_fare numeric(12,2) NOT NULL,
    customer_offer numeric(12,2),
    driver_counter_offer numeric(12,2),
    agreed_fare numeric(12,2),
    round_count integer DEFAULT 0 NOT NULL,
    attempt_count integer DEFAULT 0 NOT NULL,
    claimed_at timestamp with time zone,
    expires_at timestamp with time zone NOT NULL,
    payment_deadline timestamp with time zone,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT marketplace_negotiation_sessions_status_check CHECK ((status = ANY (ARRAY['open'::text, 'driver_claimed'::text, 'negotiating'::text, 'fare_agreed'::text, 'driver_declined'::text, 'customer_declined'::text, 'released'::text, 'expired'::text, 'payment_pending'::text, 'paid'::text])))
);


--
-- Name: claim_marketplace_negotiation(uuid, uuid); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.claim_marketplace_negotiation(p_job_id uuid, p_driver_id uuid) RETURNS public.marketplace_negotiation_sessions
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'public'
    AS $$
DECLARE
  v_session public.marketplace_negotiation_sessions;
  v_job public.jobs;
  v_claim_lease INTEGER;
BEGIN
  -- Release closure: a driver may only claim for themselves.
  IF auth.uid() IS NULL OR auth.uid() <> p_driver_id THEN
    RAISE EXCEPTION 'You can only claim a negotiation for yourself';
  END IF;

  -- ELIGIBILITY PARITY: an ineligible driver must never become the active driver.
  IF NOT public.driver_vehicle_can_accept_job(p_job_id, p_driver_id) THEN
    RAISE EXCEPTION 'You are not eligible for this service';
  END IF;

  -- AUTOMATIC REASSIGNMENT: if the previous driver's lease lapsed, release it so
  -- this claim is not rejected as "already claimed". Released under FOR UPDATE.
  PERFORM public.release_stale_negotiation_lease(s.id)
  FROM public.marketplace_negotiation_sessions s
  WHERE s.job_id = p_job_id;

  SELECT * INTO v_session
  FROM public.marketplace_negotiation_sessions
  WHERE job_id = p_job_id
  FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'No negotiation session found for this job';
  END IF;

  IF v_session.status NOT IN ('open', 'released') OR v_session.active_driver_id IS NOT NULL THEN
    RAISE EXCEPTION 'Session already claimed';
  END IF;

  -- EXPIRY PARITY: a session past its own expiry cannot be newly claimed.
  IF v_session.expires_at <= now() THEN
    RAISE EXCEPTION 'Negotiation has expired';
  END IF;

  SELECT * INTO v_job FROM public.jobs WHERE id = p_job_id;

  IF v_job.status NOT IN ('pending_fare_confirmation', 'negotiating', 'open') THEN
    RAISE EXCEPTION 'Job is not available for negotiation';
  END IF;

  v_claim_lease := COALESCE(
    (public.get_marketplace_setting('hybrid_negotiation', v_job.tenant_id)->>'claimTimeoutSeconds')::INTEGER,
    60
  );

  UPDATE public.marketplace_negotiation_sessions
  SET active_driver_id = p_driver_id,
      status = 'negotiating',
      claimed_at = now(),
      expires_at = public.negotiation_lease_expiry(p_job_id, v_claim_lease),
      updated_at = now()
  WHERE job_id = p_job_id
  RETURNING * INTO v_session;

  INSERT INTO public.marketplace_negotiation_events
    (session_id, job_id, proposed_by, proposed_by_role, event_type, round_number, created_at)
  VALUES
    (v_session.id, p_job_id, p_driver_id, 'driver', 'session_claimed', v_session.round_count, now());

  RETURN v_session;
END;
$$;


--
-- Name: job_payout_queue; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.job_payout_queue (
    job_id uuid NOT NULL,
    driver_id uuid NOT NULL,
    destination text NOT NULL,
    amount_minor bigint NOT NULL,
    currency text NOT NULL,
    terms jsonb NOT NULL,
    status text DEFAULT 'pending'::text NOT NULL,
    attempt integer DEFAULT 0 NOT NULL,
    token uuid,
    attempted_at timestamp with time zone,
    lease_until timestamp with time zone,
    retry_at timestamp with time zone DEFAULT now() NOT NULL,
    transfer_id text,
    last_error text,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT job_payout_queue_amount_minor_check CHECK ((amount_minor > 0)),
    CONSTRAINT job_payout_queue_status_check CHECK ((status = ANY (ARRAY['pending'::text, 'processing'::text, 'reconcile'::text, 'paid'::text, 'blocked'::text])))
);


--
-- Name: claim_queued_job_payout(uuid); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.claim_queued_job_payout(p_job_id uuid) RETURNS SETOF public.job_payout_queue
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'public', 'pg_temp'
    AS $$
DECLARE j public.jobs%ROWTYPE;
BEGIN
 SELECT * INTO STRICT j FROM public.jobs WHERE id=p_job_id FOR UPDATE;
 IF j.status<>'completed' OR j.payment_status<>'paid' THEN RETURN; END IF;
 RETURN QUERY UPDATE public.job_payout_queue SET
   status=CASE WHEN status='pending' THEN 'processing' ELSE 'reconcile' END,
   attempt=CASE WHEN status='pending' THEN attempt+1 ELSE attempt END,
   attempted_at=CASE WHEN status='pending' THEN now() ELSE attempted_at END,
   token=gen_random_uuid(),lease_until=now()+interval '2 minutes',updated_at=now()
 WHERE job_id=p_job_id AND retry_at<=now()
 AND (status IN ('pending','reconcile') OR (status='processing' AND lease_until<now()))
 AND (lease_until IS NULL OR lease_until<now()) RETURNING *;
END $$;


--
-- Name: claim_wallet_topup_submission(uuid); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.claim_wallet_topup_submission(p_attempt_id uuid) RETURNS boolean
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'pg_catalog', 'public'
    AS $$
BEGIN
  IF NOT public.wallet_collection_enabled() THEN RAISE EXCEPTION 'Batch 1C: collection disabled at submission' USING ERRCODE='BP008'; END IF;
  UPDATE public.wallet_topup_attempts SET status = 'submitting'
  WHERE id = p_attempt_id AND status = 'initiated';
  RETURN FOUND;
END
$$;


--
-- Name: jobs; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.jobs (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    tenant_id uuid NOT NULL,
    customer_id uuid NOT NULL,
    driver_id uuid,
    pickup_address text NOT NULL,
    dropoff_address text NOT NULL,
    price numeric(10,2),
    status text DEFAULT 'pending'::text NOT NULL,
    scheduled_time timestamp with time zone NOT NULL,
    created_at timestamp with time zone DEFAULT now(),
    updated_at timestamp with time zone DEFAULT now(),
    estimated_distance numeric(10,2),
    estimated_price numeric(10,2),
    pickup_lat double precision,
    pickup_lng double precision,
    dropoff_lat double precision,
    dropoff_lng double precision,
    city_id uuid,
    payment_status text DEFAULT 'pending'::text,
    payment_intent_id text,
    platform_fee numeric(10,2),
    driver_payout numeric(10,2),
    pricing_plan_used text,
    commission_fee numeric(10,2) DEFAULT 0.00,
    base_fare numeric(10,2) DEFAULT 0.00,
    service_fee numeric(10,2) DEFAULT 0.00,
    commission_rate_used numeric(5,2),
    currency_code text DEFAULT 'GBP'::text NOT NULL,
    country_code text DEFAULT 'GB'::text NOT NULL,
    service_type_id uuid,
    metadata jsonb DEFAULT '{}'::jsonb,
    surge_multiplier numeric(10,2) DEFAULT 1,
    currency_symbol text DEFAULT '£'::text,
    regional_pricing_rule_id uuid,
    base_fare_used numeric DEFAULT 0,
    price_per_km_used numeric DEFAULT 0,
    tax_amount numeric DEFAULT 0,
    total_price numeric DEFAULT 0,
    payment_method text,
    refund_id text,
    dispatch_attempts integer DEFAULT 0,
    dispatch_started_at timestamp with time zone,
    driver_search_expires_at timestamp with time zone,
    no_driver_reason text,
    last_dispatch_check_at timestamp with time zone,
    accepted_at timestamp with time zone,
    accepted_driver_id uuid,
    completed_at timestamp with time zone,
    stripe_transfer_id text,
    stripe_transfer_status text,
    transferred_at timestamp with time zone,
    confirmed_at timestamp with time zone,
    distance_km numeric DEFAULT 0,
    estimated_distance_km numeric DEFAULT 0,
    distance_meters numeric DEFAULT 0,
    duration_seconds integer,
    fare_breakdown jsonb,
    dynamic_pricing_multiplier numeric(8,4) DEFAULT 1.00,
    negotiated_fare numeric(12,2),
    negotiation_deadline timestamp with time zone,
    bid_deadline timestamp with time zone,
    marketplace_flags jsonb DEFAULT '{}'::jsonb NOT NULL,
    bid_mode_enabled boolean DEFAULT false NOT NULL,
    negotiation_mode_enabled boolean DEFAULT false NOT NULL,
    agreed_fare numeric(12,2),
    driver_tier_at_assignment text,
    city_zone text,
    demand_score numeric(8,4) DEFAULT 0,
    supply_score numeric(8,4) DEFAULT 0,
    estimated_duration integer,
    is_draft boolean DEFAULT false,
    expires_at timestamp with time zone,
    expired_at timestamp with time zone,
    expiry_reason text,
    quote_id uuid,
    settlement_status text DEFAULT 'pending'::text NOT NULL,
    settlement_claimed_at timestamp with time zone,
    settlement_lease_expires_at timestamp with time zone,
    settlement_amount_minor bigint,
    settlement_currency text,
    settlement_destination_account text,
    reversal_id text,
    total_refunded_minor bigint DEFAULT 0 NOT NULL,
    total_reversed_minor bigint DEFAULT 0 NOT NULL,
    no_show_arrived_at timestamp with time zone,
    no_show_grace_until timestamp with time zone,
    no_show_status text,
    no_show_reason text,
    no_show_contact_attempted_at timestamp with time zone,
    total_service_refunded_minor bigint DEFAULT 0 NOT NULL,
    total_budget_refunded_minor bigint DEFAULT 0 NOT NULL,
    settlement_purpose text DEFAULT 'job_earnings'::text NOT NULL,
    CONSTRAINT jobs_no_show_status_check CHECK (((no_show_status IS NULL) OR (no_show_status = ANY (ARRAY['pending'::text, 'fee_charged'::text, 'released'::text, 'compensation_paid'::text, 'failed'::text, 'review'::text])))),
    CONSTRAINT jobs_payment_status_check CHECK (((payment_status IS NULL) OR (payment_status = ANY (ARRAY['pending'::text, 'authorized'::text, 'wallet_funded'::text, 'paid'::text, 'cancelled'::text, 'canceled'::text, 'refunded'::text, 'failed'::text, 'requires_refund'::text, 'requires_review'::text])))),
    CONSTRAINT jobs_pricing_plan_used_check CHECK ((pricing_plan_used = ANY (ARRAY['starter'::text, 'pro'::text]))),
    CONSTRAINT jobs_settlement_status_check CHECK ((settlement_status = ANY (ARRAY['pending'::text, 'claimed'::text, 'transferred'::text, 'failed'::text, 'unknown'::text, 'reversed'::text]))),
    CONSTRAINT jobs_status_check CHECK ((status = ANY (ARRAY['requested'::text, 'pending'::text, 'pending_payment'::text, 'payment_authorized'::text, 'pending_fare_confirmation'::text, 'negotiating'::text, 'fare_agreed'::text, 'searching'::text, 'broadcasting'::text, 'waiting'::text, 'accepted'::text, 'assigned'::text, 'arrived'::text, 'heading_to_pickup'::text, 'driver_en_route'::text, 'driver_arrived'::text, 'picked_up'::text, 'in_progress'::text, 'arrived_at_store'::text, 'shopping_in_progress'::text, 'collected'::text, 'en_route_to_customer'::text, 'delivered'::text, 'completed'::text, 'settled'::text, 'cancelled'::text, 'expired'::text, 'no_driver_found'::text, 'requires_review'::text, 'failed'::text])))
);


--
-- Name: COLUMN jobs.quote_id; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.jobs.quote_id IS 'Authoritative quote reference. UUID (proven live type; value originates from randomUUID() in the pricing quote route). Nullable: legacy jobs predate quote linkage.';


--
-- Name: complete_job_with_pending_payout(uuid, uuid, jsonb, jsonb); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.complete_job_with_pending_payout(p_job_id uuid, p_driver_id uuid, p_terms jsonb, p_metadata jsonb) RETURNS SETOF public.jobs
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'public', 'pg_temp'
    AS $$
DECLARE j public.jobs%ROWTYPE; q public.job_payout_queue%ROWTYPE; total numeric; payout numeric; fee numeric; commission numeric;
BEGIN
 SELECT * INTO STRICT j FROM public.jobs WHERE id=p_job_id FOR UPDATE;
 IF coalesce(j.driver_id,j.accepted_driver_id) IS DISTINCT FROM p_driver_id THEN RAISE EXCEPTION 'Only the assigned driver can complete this request'; END IF;
 PERFORM 1 FROM public.errand_funding WHERE job_id=p_job_id FOR UPDATE;
 IF EXISTS(SELECT 1 FROM public.errand_funding WHERE job_id=p_job_id AND over_budget_status='requested') THEN RAISE EXCEPTION 'Shopping budget approval must finish before completion'; END IF;
 SELECT * INTO q FROM public.job_payout_queue WHERE job_id=p_job_id;
 IF FOUND THEN
   IF q.driver_id<>p_driver_id OR q.terms<>p_terms THEN RAISE EXCEPTION 'Payout terms changed; reconciliation required'; END IF;
   RETURN QUERY SELECT * FROM public.jobs WHERE id=p_job_id; RETURN;
 END IF;
 IF j.status NOT IN ('in_progress','en_route_to_customer','arrived_at_customer','on_trip','completed') THEN RAISE EXCEPTION 'Request is not ready for completion'; END IF;
 IF j.stripe_transfer_id IS NOT NULL OR j.settlement_status IN ('claimed','unknown','transferred','reversed') THEN RAISE EXCEPTION 'Existing transfer needs reconciliation'; END IF;

 IF coalesce(p_metadata->>'completion_pin_verified_at','')='' THEN RAISE EXCEPTION 'Verified completion evidence missing'; END IF;
 total=(p_terms->>'total')::numeric; payout=(p_terms->>'payout')::numeric;
 fee=(p_terms->>'platformFee')::numeric; commission=(p_terms->>'commission')::numeric;
 IF total IS NULL OR payout IS NULL OR fee IS NULL OR commission IS NULL OR total::text='NaN' OR payout::text='NaN' OR fee::text='NaN' OR commission::text='NaN' OR total<=0 OR payout<=0 OR fee<0 OR commission<0 OR abs(total-payout-fee-commission)>0.01 THEN RAISE EXCEPTION 'Invalid frozen payout terms'; END IF;
 IF lower(p_terms->>'currency')<>'gbp' OR (p_terms->>'amountMinor')::bigint<>round(payout*100)::bigint OR coalesce(p_terms->>'destination','') NOT LIKE 'acct_%' THEN RAISE EXCEPTION 'Invalid payout identity'; END IF;
 IF EXISTS(SELECT 1 FROM public.refund_operations WHERE job_id=p_job_id) THEN RAISE EXCEPTION 'Existing refund requires reconciliation'; END IF;
 IF (j.payment_method='wallet' OR j.payment_status='wallet_funded') AND j.payment_status<>'paid' THEN
   PERFORM public.settle_job_wallet_reservation(p_job_id,total);
 END IF;
 INSERT INTO public.job_payout_queue(job_id,driver_id,destination,amount_minor,currency,terms)
 VALUES(p_job_id,p_driver_id,p_terms->>'destination',(p_terms->>'amountMinor')::bigint,lower(p_terms->>'currency'),p_terms);
 UPDATE public.jobs SET status='completed',payment_status='paid',completed_at=coalesce(completed_at,now()),
   driver_payout=payout,platform_fee=fee,commission_fee=commission,commission_rate_used=(p_terms->>'commissionRate')::numeric,
   settlement_status='pending',stripe_transfer_status='pending',
   metadata=coalesce(j.metadata,'{}'::jsonb)||p_metadata||jsonb_build_object('driver_payout_pending',true),updated_at=now()
 WHERE id=p_job_id;
 INSERT INTO public.driver_earnings(driver_id,job_id,amount,platform_fee,gross_amount,status,currency_code,country_code)
 VALUES(p_driver_id,p_job_id,payout,fee,total,'pending',upper(p_terms->>'currency'),p_terms->>'country')
 ON CONFLICT(job_id) DO UPDATE SET amount=excluded.amount,platform_fee=excluded.platform_fee,gross_amount=excluded.gross_amount,status='pending',currency_code=excluded.currency_code,country_code=excluded.country_code
 WHERE public.driver_earnings.status<>'paid' AND public.driver_earnings.stripe_transfer_id IS NULL;
 IF NOT FOUND THEN RAISE EXCEPTION 'Existing paid earnings require reconciliation'; END IF;
 RETURN QUERY SELECT * FROM public.jobs WHERE id=p_job_id;
END $$;


--
-- Name: configured_payment_countries_v23(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.configured_payment_countries_v23() RETURNS TABLE(country_code text, currency_code text)
    LANGUAGE plpgsql STABLE SECURITY DEFINER
    SET search_path TO 'pg_catalog', 'public'
    AS $_$
DECLARE countries jsonb;matches bigint;
BEGIN
 SELECT count(*) INTO matches FROM public.system_configs WHERE coalesce(key,config_key)='countries';
 IF matches<>1 THEN RAISE EXCEPTION 'Exactly one saved countries setting required'; END IF;
 SELECT coalesce(nullif(value,'null'::jsonb),config_value) INTO countries FROM public.system_configs WHERE coalesce(key,config_key)='countries';
 IF jsonb_typeof(countries) IS DISTINCT FROM 'array' THEN RAISE EXCEPTION 'Saved countries must be a JSON array'; END IF;
 IF jsonb_array_length(countries)>1000 THEN RAISE EXCEPTION 'Saved countries list is too large'; END IF;
 IF EXISTS(SELECT 1 FROM jsonb_array_elements(countries) e WHERE jsonb_typeof(e) IS DISTINCT FROM 'object'
  OR coalesce(upper(btrim(e->>'code')),'') !~ '^[A-Z]{2}$' OR coalesce(upper(btrim(e->>'currency')),'') !~ '^[A-Z]{3}$')
 THEN RAISE EXCEPTION 'Invalid saved country or fiat currency code'; END IF;
 IF EXISTS(SELECT 1 FROM jsonb_array_elements(countries) e GROUP BY upper(btrim(e->>'code')) HAVING count(*)>1)
 THEN RAISE EXCEPTION 'Duplicate saved country codes require review'; END IF;
 RETURN QUERY SELECT upper(btrim(e->>'code')),upper(btrim(e->>'currency')) FROM jsonb_array_elements(countries) e;
END
$_$;


--
-- Name: confirm_kora_sandbox_booking(uuid, uuid, text); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.confirm_kora_sandbox_booking(p_job uuid, p_user uuid, p_account text) RETURNS jsonb
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'public', 'pg_temp'
    AS $$
DECLARE j public.jobs; b public.kora_sandbox_booking_payments; valid boolean;
BEGIN
 SELECT * INTO j FROM public.jobs WHERE id=p_job FOR UPDATE;
 SELECT * INTO b FROM public.kora_sandbox_booking_payments WHERE job_id=p_job FOR UPDATE;
 IF NOT FOUND OR b.user_id IS DISTINCT FROM p_user OR b.merchant_account_ref IS DISTINCT FROM p_account THEN
   RAISE EXCEPTION 'Original booking payment binding required'; END IF;
 IF b.refund_state<>'none' THEN RETURN to_jsonb(b); END IF;
 valid:=j.customer_id IS NOT DISTINCT FROM p_user AND j.status='completed'
 AND public.kora_sandbox_booking_snapshot(p_job) IS NOT DISTINCT FROM b.booking_snapshot
 AND EXISTS(SELECT 1 FROM public.kora_sandbox_booking_enrolments WHERE job_id=p_job AND user_id=p_user AND active)
 AND NOT EXISTS(SELECT 1 FROM public.driver_earnings WHERE job_id=p_job)
 AND NOT EXISTS(SELECT 1 FROM public.job_payout_queue WHERE job_id=p_job)
 AND NOT EXISTS(SELECT 1 FROM public.job_payment_bindings WHERE job_id=p_job);
 UPDATE public.kora_sandbox_booking_payments SET state=CASE WHEN coalesce(valid,false) THEN 'verified' ELSE 'requires_refund' END
 WHERE job_id=p_job RETURNING * INTO b;
 RETURN to_jsonb(b);
END $$;


--
-- Name: confirm_wallet_topup(uuid, text, text, text, bigint, text); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.confirm_wallet_topup(p_attempt_id uuid, p_verified_provider_reference text, p_verified_merchant_account_ref text, p_verified_currency text, p_verified_amount_minor bigint, p_final_status text) RETURNS uuid
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'pg_catalog', 'public'
    AS $$
DECLARE
  a public.wallet_topup_attempts%ROWTYPE; v_event_id uuid; v_legs jsonb;
BEGIN
  SELECT * INTO a FROM public.wallet_topup_attempts WHERE id = p_attempt_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Batch 1C: attempt not found' USING ERRCODE = 'BP003'; END IF;

  IF p_final_status IS NULL OR p_final_status NOT IN ('succeeded','completed') THEN
    RAISE EXCEPTION 'Batch 1C: final status % is not a confirmed success', p_final_status USING ERRCODE = 'BP008';
  END IF;

  IF a.status = 'credited' AND a.credited_event_id IS NOT NULL THEN
    IF p_verified_provider_reference IS DISTINCT FROM a.provider_reference
       OR p_verified_merchant_account_ref IS DISTINCT FROM a.merchant_account_ref
       OR p_verified_currency IS DISTINCT FROM a.currency_code
       OR p_verified_amount_minor IS DISTINCT FROM a.amount_minor THEN
      RAISE EXCEPTION 'Batch 1C: replay terms do not match the credited attempt' USING ERRCODE = 'BP002';
    END IF;
    RETURN a.credited_event_id;
  END IF;
  IF a.status IN ('failed','refunded') THEN
    RAISE EXCEPTION 'Batch 1C: attempt is terminal (%)', a.status USING ERRCODE = 'BP008';
  END IF;
  -- 'uncertain' is recoverable: same-provider reconciliation proceeds below.
  IF a.provider_reference IS NULL THEN
    RAISE EXCEPTION 'Batch 1C: no provider reference bound yet (webhook-before-reference race)' USING ERRCODE = 'BP008';
  END IF;
  IF p_verified_provider_reference IS DISTINCT FROM a.provider_reference
     OR p_verified_merchant_account_ref IS DISTINCT FROM a.merchant_account_ref
     OR p_verified_currency IS DISTINCT FROM a.currency_code
     OR p_verified_amount_minor IS DISTINCT FROM a.amount_minor THEN
    RAISE EXCEPTION 'Batch 1C: verified terms do not match the frozen attempt' USING ERRCODE = 'BP008';
  END IF;

  v_legs := jsonb_build_array(
    jsonb_build_object('accountPurpose', a.destination_account_purpose, 'amountMinor', a.amount_minor),
    jsonb_build_object('accountPurpose', 'platform_funding', 'amountMinor', -a.amount_minor));
  v_event_id := public.post_wallet_event(
    'wallet-topup:' || a.id::text, 'topup', a.tenant_id, a.owner_id, a.currency_code,
    v_legs, a.payment_provider, a.merchant_account_ref, a.provider_reference);

  UPDATE public.wallet_topup_attempts SET status = 'credited', credited_event_id = v_event_id WHERE id = p_attempt_id;
  RETURN v_event_id;
END
$$;


--
-- Name: create_booking_support_request(uuid, uuid, uuid, text, text, text, uuid, text, text, uuid); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.create_booking_support_request(p_user_id uuid, p_job_id uuid, p_request_id uuid, p_category text, p_message text, p_email text, p_tenant_id uuid, p_country text, p_city text, p_driver_id uuid) RETURNS SETOF public.booking_support_requests
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'public', 'pg_temp'
    AS $$
DECLARE r public.booking_support_requests%ROWTYPE;
BEGIN
 PERFORM pg_advisory_xact_lock(hashtextextended(p_user_id::text,42));
 SELECT * INTO r FROM public.booking_support_requests WHERE user_id=p_user_id AND request_id=p_request_id;
 IF FOUND THEN
  IF r.job_id IS DISTINCT FROM p_job_id OR r.category IS DISTINCT FROM p_category OR r.message IS DISTINCT FROM p_message THEN
   RAISE EXCEPTION 'Request reference reused with different content';
  END IF;
  RETURN NEXT r;RETURN;
 END IF;
 IF NOT EXISTS(SELECT 1 FROM public.jobs WHERE id=p_job_id AND tenant_id IS NOT DISTINCT FROM p_tenant_id
  AND (customer_id=p_user_id OR coalesce(driver_id,accepted_driver_id)=p_user_id)) THEN
  RAISE EXCEPTION 'Only booking participants may contact support';
 END IF;
 IF (SELECT count(*) FROM public.booking_support_requests WHERE user_id=p_user_id AND created_at>now()-interval '15 minutes')>=5 THEN
  RAISE EXCEPTION 'Too many support requests. Please wait before starting another request.';
 END IF;
 INSERT INTO public.booking_support_requests(request_id,user_id,job_id,tenant_id,category,message,sender_email,country_code,market_city,driver_id)
 VALUES(p_request_id,p_user_id,p_job_id,p_tenant_id,p_category,p_message,p_email,p_country,p_city,p_driver_id)
 RETURNING * INTO r;
 RETURN NEXT r;
END $$;


--
-- Name: create_customer_offer(uuid, numeric); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.create_customer_offer(p_job_id uuid, p_amount numeric) RETURNS public.marketplace_negotiation_sessions
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'public'
    AS $$
DECLARE
  v_actor UUID := auth.uid();
  v_job public.jobs;
  v_session public.marketplace_negotiation_sessions;
  v_suggested NUMERIC;
  v_timeout INTEGER;
BEGIN
  IF v_actor IS NULL THEN
    RAISE EXCEPTION 'Authentication required';
  END IF;

  IF p_amount IS NULL OR p_amount <= 0 THEN
    RAISE EXCEPTION 'Offer amount must be a positive value';
  END IF;

  -- Lock the job: serialises a double-click / concurrent retry for this job.
  SELECT * INTO v_job
  FROM public.jobs
  WHERE id = p_job_id
  FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Job not found';
  END IF;

  IF v_job.customer_id IS DISTINCT FROM v_actor THEN
    RAISE EXCEPTION 'Only the job customer can open a negotiation';
  END IF;

  IF v_job.negotiation_mode_enabled IS NOT TRUE THEN
    RAISE EXCEPTION 'Negotiation is not enabled for this job';
  END IF;

  IF v_job.status IS NULL OR v_job.status NOT IN ('pending_fare_confirmation', 'negotiating', 'open') THEN
    RAISE EXCEPTION 'Job is not in a negotiable state';
  END IF;

  -- Authoritative reference fare: the persisted job fields the existing
  -- createCustomerOffer flow resolves through. No quote-table dependency.
  v_suggested := COALESCE(v_job.agreed_fare, v_job.total_price);
  IF v_suggested IS NULL OR v_suggested <= 0 THEN
    RAISE EXCEPTION 'No authoritative reference fare is available for this job';
  END IF;

  v_timeout := COALESCE(
    (public.get_marketplace_setting('hybrid_negotiation', v_job.tenant_id)->>'timeoutSeconds')::INTEGER,
    120
  );

  SELECT * INTO v_session
  FROM public.marketplace_negotiation_sessions
  WHERE job_id = p_job_id
  FOR UPDATE;

  IF FOUND THEN
    -- One session per job (job_id UNIQUE). Never insert a second row.
    IF v_session.status IN ('open', 'driver_claimed', 'negotiating') THEN
      RAISE EXCEPTION 'An offer is already awaiting a response for this request';
    END IF;

    IF v_session.status = 'released' THEN
      -- The customer's proposal survived the driver release; re-open the SAME row.
      UPDATE public.marketplace_negotiation_sessions
      SET customer_offer = p_amount,
          driver_counter_offer = NULL,
          agreed_fare = NULL,
          active_driver_id = NULL,
          suggested_fare = v_suggested,
          status = 'open',
          round_count = 1,
          -- Clear prior-lifecycle timestamps so a reused released row cannot leak a
          -- stale claim or payment deadline into the fresh offer. attempt_count is
          -- deliberately NOT reset: it is a cumulative driver-attempt counter across
          -- the negotiation's life, not a per-offer value.
          claimed_at = NULL,
          payment_deadline = NULL,
          expires_at = now() + make_interval(secs => v_timeout),
          updated_at = now()
      WHERE id = v_session.id
      RETURNING * INTO v_session;
    ELSE
      -- customer_declined / driver_declined / expired / fare_agreed /
      -- payment_pending / paid: closed. Never resurrected silently.
      RAISE EXCEPTION 'This negotiation is already closed';
    END IF;
  ELSE
    INSERT INTO public.marketplace_negotiation_sessions (
      job_id, customer_id, active_driver_id, status,
      suggested_fare, customer_offer, driver_counter_offer, agreed_fare,
      round_count, attempt_count, expires_at
    ) VALUES (
      p_job_id, v_actor, NULL, 'open',
      v_suggested, p_amount, NULL, NULL,
      1, 0, now() + make_interval(secs => v_timeout)
    )
    RETURNING * INTO v_session;
  END IF;

  INSERT INTO public.marketplace_negotiation_events (
    session_id, job_id, proposed_by, proposed_by_role,
    event_type, amount, round_number, created_at
  ) VALUES (
    v_session.id, p_job_id, v_actor, 'customer',
    'customer_offer', p_amount, v_session.round_count, now()
  );

  RETURN v_session;
END;
$$;


--
-- Name: credit_wallet_topup(uuid, numeric, text, text); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.credit_wallet_topup(p_user_id uuid, p_amount numeric, p_currency_code text, p_stripe_payment_intent_id text) RETURNS void
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'public'
    AS $$
DECLARE
    v_wallet_id UUID;
BEGIN
    -- 1. Get or create wallet
    INSERT INTO wallets (user_id, available_balance, currency_code)
    VALUES (p_user_id, 0, p_currency_code)
    ON CONFLICT (user_id) DO NOTHING;

    SELECT id INTO v_wallet_id FROM wallets WHERE user_id = p_user_id;

    -- 2. Record transaction (unique index will catch duplicates)
    INSERT INTO wallet_transactions (
        wallet_id,
        amount,
        type,
        status,
        description,
        stripe_payment_intent_id
    ) VALUES (
        v_wallet_id,
        p_amount,
        'topup',
        'completed',
        'Wallet top-up via Stripe',
        p_stripe_payment_intent_id
    );

    -- 3. Update wallet balance
    UPDATE wallets 
    SET available_balance = available_balance + p_amount,
        updated_at = NOW()
    WHERE id = v_wallet_id;

END;
$$;


--
-- Name: credit_wallet_topup(uuid, numeric, text, text, jsonb); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.credit_wallet_topup(p_user_id uuid, p_amount numeric, p_payment_intent_id text, p_currency_code text DEFAULT NULL::text, p_metadata jsonb DEFAULT '{}'::jsonb) RETURNS void
    LANGUAGE plpgsql SECURITY DEFINER
    AS $$
DECLARE
    v_wallet_id UUID;
    v_before_available NUMERIC(12,2);
    v_before_reserved NUMERIC(12,2);
    v_currency_code TEXT;
BEGIN
    IF p_user_id IS NULL THEN
        RAISE EXCEPTION 'p_user_id is required';
    END IF;

    IF p_amount IS NULL OR p_amount <= 0 THEN
        RAISE EXCEPTION 'p_amount must be greater than zero';
    END IF;

    IF p_payment_intent_id IS NULL OR btrim(p_payment_intent_id) = '' THEN
        RAISE EXCEPTION 'p_payment_intent_id is required';
    END IF;

    v_currency_code := COALESCE(NULLIF(btrim(p_currency_code), ''), 'GBP');

    INSERT INTO public.wallets (
        user_id,
        available_balance,
        reserved_balance,
        currency_code
    )
    VALUES (
        p_user_id,
        0,
        0,
        v_currency_code
    )
    ON CONFLICT (user_id) DO NOTHING;

    IF EXISTS (
        SELECT 1
        FROM public.wallet_transactions
        WHERE stripe_payment_intent_id = p_payment_intent_id
          AND transaction_type = 'topup'
    ) THEN
        RETURN;
    END IF;

    SELECT
        id,
        available_balance,
        reserved_balance
    INTO
        v_wallet_id,
        v_before_available,
        v_before_reserved
    FROM public.wallets
    WHERE user_id = p_user_id
    FOR UPDATE;

    IF NOT FOUND THEN
        RAISE EXCEPTION 'Wallet not found after bootstrap';
    END IF;

    IF EXISTS (
        SELECT 1
        FROM public.wallet_transactions
        WHERE stripe_payment_intent_id = p_payment_intent_id
          AND transaction_type = 'topup'
    ) THEN
        RETURN;
    END IF;

    UPDATE public.wallets
    SET
        available_balance = available_balance + p_amount,
        updated_at = NOW()
    WHERE id = v_wallet_id;

    INSERT INTO public.wallet_transactions (
        wallet_id,
        user_id,
        transaction_type,
        amount,
        balance_before_available,
        balance_after_available,
        balance_before_reserved,
        balance_after_reserved,
        stripe_payment_intent_id,
        metadata
    )
    VALUES (
        v_wallet_id,
        p_user_id,
        'topup',
        p_amount,
        v_before_available,
        v_before_available + p_amount,
        v_before_reserved,
        v_before_reserved,
        p_payment_intent_id,
        COALESCE(p_metadata, '{}'::jsonb) || jsonb_build_object(
            'currency_code', v_currency_code,
            'source', 'stripe_wallet_topup'
        )
    );

END;
$$;


--
-- Name: customer_accept_driver_counter(uuid); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.customer_accept_driver_counter(p_session_id uuid) RETURNS public.marketplace_negotiation_sessions
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'public'
    AS $$
DECLARE
  v_actor UUID := auth.uid();
  v_session public.marketplace_negotiation_sessions;
  v_agreed NUMERIC;
  v_job public.jobs;
  v_pay_window INTEGER;
BEGIN
  IF v_actor IS NULL THEN
    RAISE EXCEPTION 'Authentication required';
  END IF;

  SELECT * INTO v_session
  FROM public.marketplace_negotiation_sessions
  WHERE id = p_session_id
  FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Negotiation session not found';
  END IF;

  IF v_session.customer_id IS DISTINCT FROM v_actor THEN
    RAISE EXCEPTION 'Only the customer can accept this counter-offer';
  END IF;

  IF v_session.active_driver_id IS NULL THEN
    RAISE EXCEPTION 'No driver is currently negotiating';
  END IF;

  IF v_session.status NOT IN ('open', 'driver_claimed', 'negotiating') THEN
    RAISE EXCEPTION 'Negotiation is not open';
  END IF;

  IF v_session.expires_at <= now() THEN
    RAISE EXCEPTION 'Negotiation has expired';
  END IF;

  IF v_session.driver_counter_offer IS NULL
     OR public.negotiation_live_proposal_role(v_session.id) IS DISTINCT FROM 'driver' THEN
    RAISE EXCEPTION 'There is no driver counter-offer to accept';
  END IF;

  v_agreed := v_session.driver_counter_offer;

  SELECT * INTO v_job FROM public.jobs WHERE id = v_session.job_id;
  v_pay_window := COALESCE(
    (public.get_marketplace_setting('hybrid_negotiation', v_job.tenant_id)->>'paymentDeadlineAfterFareAgreement')::INTEGER,
    300
  );

  UPDATE public.marketplace_negotiation_sessions
  SET agreed_fare = v_agreed,
      status = 'fare_agreed',
      payment_deadline = public.negotiation_lease_expiry(v_session.job_id, v_pay_window),
      expires_at = public.negotiation_lease_expiry(v_session.job_id, v_pay_window),
      updated_at = now()
  WHERE id = v_session.id
  RETURNING * INTO v_session;

  UPDATE public.jobs
  SET agreed_fare = v_agreed,
      status = 'fare_agreed',
      driver_id = v_session.active_driver_id,
      updated_at = now()
  WHERE id = v_session.job_id;

  INSERT INTO public.marketplace_negotiation_events (
    session_id, job_id, proposed_by, proposed_by_role,
    event_type, amount, round_number, created_at
  ) VALUES (
    v_session.id, v_session.job_id, v_actor, 'customer',
    'customer_accept', v_agreed, v_session.round_count, now()
  );

  RETURN v_session;
END;
$$;


--
-- Name: customer_cancel_offer(uuid); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.customer_cancel_offer(p_session_id uuid) RETURNS public.marketplace_negotiation_sessions
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'public'
    AS $$
DECLARE
  v_actor UUID := auth.uid();
  v_session public.marketplace_negotiation_sessions;
  v_job public.jobs;
  v_payment TEXT;
  v_agreed_phase BOOLEAN;
BEGIN
  IF v_actor IS NULL THEN
    RAISE EXCEPTION 'Authentication required';
  END IF;

  SELECT * INTO v_session
  FROM public.marketplace_negotiation_sessions
  WHERE id = p_session_id
  FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Negotiation session not found';
  END IF;

  IF v_session.customer_id IS DISTINCT FROM v_actor THEN
    RAISE EXCEPTION 'Only the customer can cancel this negotiation';
  END IF;

  SELECT * INTO v_job FROM public.jobs WHERE id = v_session.job_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Job not found';
  END IF;

  -- A PAID request must NEVER be cancelled through this path.
  v_payment := LOWER(COALESCE(v_job.payment_status, 'pending'));
  IF v_payment IN ('authorized', 'requires_capture', 'succeeded', 'captured', 'paid', 'wallet_funded') THEN
    RAISE EXCEPTION 'This booking is already paid and cannot be cancelled here';
  END IF;

  v_agreed_phase := v_session.status = 'fare_agreed';

  -- Negotiable phases PLUS the agreed-but-unpaid phase. Terminal phases still
  -- reject: an already declined/expired/paid negotiation is not cancellable.
  IF v_session.status NOT IN ('open', 'driver_claimed', 'negotiating', 'released', 'fare_agreed') THEN
    RAISE EXCEPTION 'Negotiation can no longer be cancelled';
  END IF;

  UPDATE public.marketplace_negotiation_sessions
  SET status = 'customer_declined',
      active_driver_id = NULL,
      driver_counter_offer = NULL,
      agreed_fare = NULL,
      payment_deadline = NULL,
      updated_at = now()
  WHERE id = v_session.id
  RETURNING * INTO v_session;

  UPDATE public.jobs
  SET status = 'cancelled',
      agreed_fare = NULL,
      driver_id = NULL,
      updated_at = now()
  WHERE id = v_session.job_id
    AND status IN ('pending_fare_confirmation', 'negotiating', 'open', 'fare_agreed');

  INSERT INTO public.marketplace_negotiation_events (
    session_id, job_id, proposed_by, proposed_by_role,
    event_type, message, round_number, created_at
  ) VALUES (
    v_session.id, v_session.job_id, v_actor, 'customer',
    'customer_decline',
    CASE WHEN v_agreed_phase
         THEN 'Customer cancelled the agreed fare before payment'
         ELSE 'Customer cancelled request' END,
    v_session.round_count, now()
  );

  RETURN v_session;
END;
$$;


--
-- Name: customer_counter_offer(uuid, numeric); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.customer_counter_offer(p_session_id uuid, p_amount numeric) RETURNS public.marketplace_negotiation_sessions
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'public'
    AS $$
DECLARE
  v_actor UUID := auth.uid();
  v_session public.marketplace_negotiation_sessions;
  v_job public.jobs;
  v_max_rounds INTEGER;
  v_turn_lease INTEGER;
BEGIN
  IF v_actor IS NULL THEN
    RAISE EXCEPTION 'Authentication required';
  END IF;

  IF p_amount IS NULL OR p_amount <= 0 THEN
    RAISE EXCEPTION 'Counter amount must be a positive value';
  END IF;

  SELECT * INTO v_session
  FROM public.marketplace_negotiation_sessions
  WHERE id = p_session_id
  FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Negotiation session not found';
  END IF;

  -- Only the customer who owns this negotiation may counter.
  IF v_session.customer_id IS DISTINCT FROM v_actor THEN
    RAISE EXCEPTION 'Only the customer can counter this negotiation';
  END IF;

  IF v_session.active_driver_id IS NULL THEN
    RAISE EXCEPTION 'No driver is currently negotiating';
  END IF;

  IF v_session.status NOT IN ('open', 'driver_claimed', 'negotiating') THEN
    RAISE EXCEPTION 'Negotiation is not open';
  END IF;

  IF v_session.expires_at <= now() THEN
    RAISE EXCEPTION 'Negotiation has expired';
  END IF;

  -- Turn: the live proposal must belong to the driver.
  IF public.negotiation_live_proposal_role(v_session.id) IS DISTINCT FROM 'driver'
     OR v_session.driver_counter_offer IS NULL THEN
    RAISE EXCEPTION 'There is no driver counter-offer awaiting a response';
  END IF;

  SELECT * INTO v_job FROM public.jobs WHERE id = v_session.job_id;
  v_max_rounds := COALESCE(
    (public.get_marketplace_setting('hybrid_negotiation', v_job.tenant_id)->>'maxRounds')::INTEGER,
    3
  );

  IF v_session.round_count >= v_max_rounds THEN
    RAISE EXCEPTION 'Maximum negotiation rounds reached';
  END IF;

  v_turn_lease := COALESCE(
    (public.get_marketplace_setting('hybrid_negotiation', v_job.tenant_id)->>'timeoutSeconds')::INTEGER,
    120
  );

  UPDATE public.marketplace_negotiation_sessions
  SET customer_offer = p_amount,
      driver_counter_offer = NULL,   -- clears the answered counter: one live proposal
      status = 'negotiating',
      round_count = v_session.round_count + 1,
      -- TURN LEASE REFRESH: the driver now has a full response window. This is the
      -- fix for "customer counter rejected as expired" after reading the counter.
      expires_at = public.negotiation_lease_expiry(v_session.job_id, v_turn_lease),
      updated_at = now()
  WHERE id = v_session.id
  RETURNING * INTO v_session;

  INSERT INTO public.marketplace_negotiation_events (
    session_id, job_id, proposed_by, proposed_by_role,
    event_type, amount, round_number, created_at
  ) VALUES (
    v_session.id, v_session.job_id, v_actor, 'customer',
    'customer_offer', p_amount, v_session.round_count, now()
  );

  RETURN v_session;
END;
$$;


--
-- Name: customer_decline_counter(uuid); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.customer_decline_counter(p_session_id uuid) RETURNS public.marketplace_negotiation_sessions
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'public'
    AS $$
DECLARE
  v_actor UUID := auth.uid();
  v_session public.marketplace_negotiation_sessions;
  v_job public.jobs;
  v_turn_lease INTEGER;
BEGIN
  IF v_actor IS NULL THEN
    RAISE EXCEPTION 'Authentication required';
  END IF;

  SELECT * INTO v_session
  FROM public.marketplace_negotiation_sessions
  WHERE id = p_session_id
  FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Negotiation session not found';
  END IF;

  IF v_session.customer_id IS DISTINCT FROM v_actor THEN
    RAISE EXCEPTION 'Only the customer can decline this counter-offer';
  END IF;

  IF v_session.status NOT IN ('open', 'driver_claimed', 'negotiating') THEN
    RAISE EXCEPTION 'Negotiation is not open';
  END IF;

  IF v_session.active_driver_id IS NULL
     OR v_session.driver_counter_offer IS NULL
     OR public.negotiation_live_proposal_role(v_session.id) IS DISTINCT FROM 'driver' THEN
    RAISE EXCEPTION 'There is no driver counter-offer to decline';
  END IF;

  SELECT * INTO v_job FROM public.jobs WHERE id = v_session.job_id;
  IF v_job.status NOT IN ('pending_fare_confirmation', 'negotiating', 'open') THEN
    RAISE EXCEPTION 'Job is not available for negotiation';
  END IF;

  v_turn_lease := COALESCE(
    (public.get_marketplace_setting('hybrid_negotiation', v_job.tenant_id)->>'timeoutSeconds')::INTEGER,
    120
  );

  UPDATE public.marketplace_negotiation_sessions
  SET status = 'released',
      active_driver_id = NULL,
      driver_counter_offer = NULL,
      claimed_at = NULL,
      attempt_count = attempt_count + 1,   -- existing release convention
      -- Re-arm the discovery window so the next eligible driver can claim it even
      -- when this decline happened after the previous lease had already lapsed.
      expires_at = public.negotiation_lease_expiry(v_session.job_id, v_turn_lease),
      updated_at = now()
      -- customer_offer is INTENTIONALLY retained: the request stays live and
      -- another eligible driver can claim and answer it.
  WHERE id = v_session.id
  RETURNING * INTO v_session;

  INSERT INTO public.marketplace_negotiation_events (
    session_id, job_id, proposed_by, proposed_by_role,
    event_type, message, round_number, created_at
  ) VALUES (
    v_session.id, v_session.job_id, v_actor, 'customer',
    'customer_decline', 'Customer declined driver counter', v_session.round_count, now()
  );

  RETURN v_session;
END;
$$;


--
-- Name: customer_expire_unpaid_agreement(uuid); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.customer_expire_unpaid_agreement(p_session_id uuid) RETURNS public.marketplace_negotiation_sessions
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'public'
    AS $$
DECLARE
  v_actor UUID := auth.uid();
  v_session public.marketplace_negotiation_sessions;
BEGIN
  IF v_actor IS NULL THEN
    RAISE EXCEPTION 'Authentication required';
  END IF;

  SELECT * INTO v_session
  FROM public.marketplace_negotiation_sessions
  WHERE id = p_session_id
  FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Negotiation session not found';
  END IF;

  IF v_session.customer_id IS DISTINCT FROM v_actor THEN
    RAISE EXCEPTION 'Only the customer can expire this agreement';
  END IF;

  -- Delegate to the single authoritative expiry transition. It is a no-op unless
  -- the agreement is unpaid AND its deadline has actually elapsed.
  IF v_session.status = 'fare_agreed' THEN
    PERFORM public.expire_unpaid_fare_agreement(p_session_id);
  END IF;

  SELECT * INTO v_session
  FROM public.marketplace_negotiation_sessions
  WHERE id = p_session_id;

  RETURN v_session;
END;
$$;


--
-- Name: customer_has_active_job_with_driver(uuid); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.customer_has_active_job_with_driver(p_driver_id uuid) RETURNS boolean
    LANGUAGE plpgsql STABLE SECURITY DEFINER
    SET search_path TO 'public'
    AS $$
BEGIN
  RETURN EXISTS (
    SELECT 1
    FROM public.jobs
    WHERE jobs.driver_id = p_driver_id
      AND jobs.customer_id = auth.uid()
      AND jobs.status IN ('accepted', 'in_progress')
  );
END;
$$;


--
-- Name: customer_has_active_job_with_driver(uuid, uuid); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.customer_has_active_job_with_driver(p_customer_id uuid, p_driver_id uuid) RETURNS boolean
    LANGUAGE plpgsql STABLE SECURITY DEFINER
    SET search_path TO 'public'
    AS $$
BEGIN
  RETURN EXISTS (
    SELECT 1
    FROM public.jobs
    WHERE jobs.customer_id = p_customer_id
      AND jobs.driver_id = p_driver_id
      AND jobs.status IN (
        'accepted',
        'heading_to_pickup',
        'arrived',
        'shopping_in_progress',
        'collected',
        'en_route_to_customer',
        'in_progress'
      )
  );
END;
$$;


--
-- Name: customer_wallet_sandbox_eligibility_v1m(uuid); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.customer_wallet_sandbox_eligibility_v1m(p_owner uuid) RETURNS jsonb
    LANGUAGE plpgsql STABLE SECURITY DEFINER
    SET search_path TO 'pg_catalog', 'public'
    AS $$
DECLARE p public.profiles%ROWTYPE;c public.customer_wallet_sandbox_cohort_v1l%ROWTYPE;m jsonb;n integer;city text; BEGIN
 IF p_owner IS NULL OR coalesce((SELECT value='true' FROM public.wallet_collection_config WHERE key='customer_wallet_sandbox_enabled'),false) IS DISTINCT FROM true THEN RETURN jsonb_build_object('eligible',false);END IF;
 SELECT * INTO p FROM public.profiles WHERE id=p_owner;
 IF NOT FOUND OR p.role IS DISTINCT FROM 'customer' OR p.tenant_id IS NULL OR p.registration_activated_at IS NULL OR p.registration_activated_at>now() THEN RETURN jsonb_build_object('eligible',false);END IF;
 SELECT * INTO c FROM public.customer_wallet_sandbox_cohort_v1l WHERE owner_id=p_owner;
 IF NOT FOUND OR NOT c.enabled OR c.tenant_id IS DISTINCT FROM p.tenant_id OR c.country_code IS DISTINCT FROM p.registration_country_code OR c.minor_exponent IS DISTINCT FROM public.wallet_currency_minor_exponent(c.currency_code) OR NOT EXISTS(SELECT 1 FROM public.wallets WHERE user_id=p_owner AND currency_code=c.currency_code) THEN RETURN jsonb_build_object('eligible',false);END IF;
 city:=nullif(lower(regexp_replace(btrim(coalesce(p.registration_market_city,'')),'\s+',' ','g')),'');
 SELECT count(*) INTO n FROM public.market_availability a WHERE a.country_code=c.country_code AND to_jsonb(a)->>'enabled'='true' AND nullif(btrim(to_jsonb(a)->>'zone_id'),'') IS NULL AND nullif(lower(regexp_replace(btrim(coalesce(to_jsonb(a)->>'market_city','')),'\s+',' ','g')),'') IS NOT DISTINCT FROM city AND (nullif(to_jsonb(a)->>'valid_from','') IS NULL OR (to_jsonb(a)->>'valid_from')::timestamptz<=now()) AND (nullif(to_jsonb(a)->>'valid_until','') IS NULL OR (to_jsonb(a)->>'valid_until')::timestamptz>now());
 IF n=0 THEN city:=NULL;END IF;
 SELECT count(*),min(to_jsonb(a)::text)::jsonb INTO n,m FROM public.market_availability a WHERE a.country_code=c.country_code AND to_jsonb(a)->>'enabled'='true' AND nullif(btrim(to_jsonb(a)->>'zone_id'),'') IS NULL AND nullif(lower(regexp_replace(btrim(coalesce(to_jsonb(a)->>'market_city','')),'\s+',' ','g')),'') IS NOT DISTINCT FROM city AND (nullif(to_jsonb(a)->>'valid_from','') IS NULL OR (to_jsonb(a)->>'valid_from')::timestamptz<=now()) AND (nullif(to_jsonb(a)->>'valid_until','') IS NULL OR (to_jsonb(a)->>'valid_until')::timestamptz>now());
 IF n<>1 OR m->>'launch_status' IS DISTINCT FROM 'live' OR m->>'customer_app_enabled' IS DISTINCT FROM 'true' OR m->>'supported_currency' IS DISTINCT FROM c.currency_code THEN RETURN jsonb_build_object('eligible',false);END IF;
 RETURN jsonb_build_object('eligible',true,'ownerId',p_owner,'currency',c.currency_code,'minorExponent',c.minor_exponent,'limitMinor',c.max_amount_minor::text,'testOnly',true,'spendableCredit',false);
END $$;


--
-- Name: customer_wallet_setup_enabled_v1h(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.customer_wallet_setup_enabled_v1h() RETURNS boolean
    LANGUAGE sql STABLE SECURITY DEFINER
    SET search_path TO 'pg_catalog', 'public'
    AS $$
 SELECT coalesce((SELECT value='true' FROM public.wallet_collection_config WHERE key='customer_wallet_setup_enabled'),false)
$$;


--
-- Name: driver_accept_customer_offer(uuid); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.driver_accept_customer_offer(p_session_id uuid) RETURNS public.marketplace_negotiation_sessions
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'public'
    AS $$
DECLARE
  v_actor UUID := auth.uid();
  v_session public.marketplace_negotiation_sessions;
  v_agreed NUMERIC;
  v_job public.jobs;
  v_pay_window INTEGER;
BEGIN
  IF v_actor IS NULL THEN
    RAISE EXCEPTION 'Authentication required';
  END IF;

  SELECT * INTO v_session
  FROM public.marketplace_negotiation_sessions
  WHERE id = p_session_id
  FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Negotiation session not found';
  END IF;

  IF v_session.active_driver_id IS DISTINCT FROM v_actor THEN
    RAISE EXCEPTION 'Only the active driver can accept this offer';
  END IF;

  IF NOT public.driver_vehicle_can_accept_job(v_session.job_id, v_actor) THEN
    RAISE EXCEPTION 'You are not eligible for this service';
  END IF;

  IF v_session.status NOT IN ('open', 'driver_claimed', 'negotiating') THEN
    RAISE EXCEPTION 'Negotiation is not open';
  END IF;

  IF v_session.expires_at <= now() THEN
    RAISE EXCEPTION 'Negotiation has expired';
  END IF;

  IF v_session.customer_offer IS NULL
     OR public.negotiation_live_proposal_role(v_session.id) IS DISTINCT FROM 'customer' THEN
    RAISE EXCEPTION 'There is no customer offer to accept';
  END IF;

  v_agreed := v_session.customer_offer;

  SELECT * INTO v_job FROM public.jobs WHERE id = v_session.job_id;
  v_pay_window := COALESCE(
    (public.get_marketplace_setting('hybrid_negotiation', v_job.tenant_id)->>'paymentDeadlineAfterFareAgreement')::INTEGER,
    300
  );

  UPDATE public.marketplace_negotiation_sessions
  SET agreed_fare = v_agreed,
      driver_counter_offer = NULL,
      status = 'fare_agreed',
      payment_deadline = public.negotiation_lease_expiry(v_session.job_id, v_pay_window),
      expires_at = public.negotiation_lease_expiry(v_session.job_id, v_pay_window),
      updated_at = now()
  WHERE id = v_session.id
  RETURNING * INTO v_session;

  UPDATE public.jobs
  SET agreed_fare = v_agreed,
      status = 'fare_agreed',
      driver_id = v_actor,
      updated_at = now()
  WHERE id = v_session.job_id;

  INSERT INTO public.marketplace_negotiation_events (
    session_id, job_id, proposed_by, proposed_by_role,
    event_type, amount, round_number, created_at
  ) VALUES (
    v_session.id, v_session.job_id, v_actor, 'driver',
    'driver_accept', v_agreed, v_session.round_count, now()
  );

  RETURN v_session;
END;
$$;


--
-- Name: driver_can_read_earnings_v23(uuid); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.driver_can_read_earnings_v23(driver uuid) RETURNS boolean
    LANGUAGE sql STABLE SECURITY DEFINER
    SET search_path TO 'pg_catalog', 'public'
    SET row_security TO 'off'
    AS $$
 SELECT driver=auth.uid() OR EXISTS(SELECT 1 FROM public.profiles p WHERE p.id=auth.uid() AND p.role IN ('admin','super_admin'))
$$;


--
-- Name: driver_can_read_job_market_v23(jsonb); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.driver_can_read_job_market_v23(j jsonb) RETURNS boolean
    LANGUAGE plpgsql STABLE SECURITY DEFINER
    SET search_path TO 'pg_catalog', 'public'
    SET row_security TO 'off'
    AS $$
DECLARE p jsonb;
BEGIN
 SELECT to_jsonb(profile) INTO p FROM public.profiles profile WHERE profile.id=auth.uid();
 IF p->>'role' IS DISTINCT FROM 'driver' THEN RETURN true; END IF;
 IF (j->>'driver_id'=auth.uid()::text OR j->>'accepted_driver_id'=auth.uid()::text) AND j->>'status' IN ('completed','settled','cancelled','canceled','expired','failed') THEN RETURN true; END IF;
 RETURN j->>'customer_id'=auth.uid()::text OR public.driver_job_market_matches_v23(p,j);
END $$;


--
-- Name: driver_cash_credit_balance_v1e(uuid, uuid, text); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.driver_cash_credit_balance_v1e(t uuid, d uuid, c text) RETURNS jsonb
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'pg_catalog', 'public'
    AS $$
DECLARE eligible numeric; used numeric; held numeric; ledger_available numeric; ledger_reserved numeric; available numeric; deficit numeric;
BEGIN
 PERFORM public.driver_cash_credit_lock_v1e(t,d,c);
 SELECT coalesce(sum(a.amount_minor::numeric),0) INTO eligible
 FROM public.wallet_topup_attempts a JOIN public.wallet_business_events e ON e.id=a.credited_event_id
 WHERE a.tenant_id=t AND a.owner_id=d AND a.currency_code=c AND a.status='credited'
 AND a.destination_account_purpose='driver_cash_credit' AND e.operation='topup'
 AND e.event_key='wallet-topup:'||a.id::text AND e.tenant_id=t AND e.owner_id=d AND e.currency_code=c
 AND e.payment_provider=a.payment_provider AND e.merchant_account_ref=a.merchant_account_ref AND e.provider_reference=a.provider_reference
 AND e.entries=jsonb_build_array(jsonb_build_object('accountPurpose','driver_cash_credit','amountMinor',a.amount_minor),jsonb_build_object('accountPurpose','platform_funding','amountMinor',-a.amount_minor))
 AND NOT EXISTS(SELECT 1 FROM public.wallet_business_events r WHERE r.reverses_event_id=e.id);
 SELECT coalesce(sum(required_credit_minor::numeric) FILTER(WHERE status IN ('held','settled')),0),
        coalesce(sum(required_credit_minor::numeric) FILTER(WHERE status='held'),0)
 INTO used,held FROM public.driver_cash_credit_holds_v1e WHERE tenant_id=t AND driver_id=d AND currency_code=c;
 SELECT coalesce(sum(m.amount_minor::numeric) FILTER(WHERE a.balance_purpose='driver_cash_credit'),0),
        coalesce(sum(m.amount_minor::numeric) FILTER(WHERE a.balance_purpose='driver_cash_credit_reserved'),0)
 INTO ledger_available,ledger_reserved FROM public.wallet_accounts a JOIN public.wallet_movements m ON m.account_id=a.id
 WHERE a.tenant_id=t AND a.owner_id=d AND a.currency_code=c;
 available:=greatest(least(eligible-used,ledger_available),0);
 deficit:=greatest(used-eligible,-ledger_available,0);
 RETURN jsonb_build_object('eligibleDepositsMinor',eligible::text,'availableMinor',available::text,'heldMinor',held::text,
 'deficitMinor',deficit::text,'consistent',held=ledger_reserved,'currency',c);
END $$;


--
-- Name: driver_cash_credit_enabled_v1e(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.driver_cash_credit_enabled_v1e() RETURNS boolean
    LANGUAGE sql STABLE SECURITY DEFINER
    SET search_path TO 'pg_catalog', 'public'
    AS $$
 SELECT coalesce((SELECT enabled FROM public.driver_cash_credit_config_v1e WHERE key='ride_cash_credit'),false) $$;


--
-- Name: driver_cash_credit_lock_v1e(uuid, uuid, text); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.driver_cash_credit_lock_v1e(t uuid, d uuid, c text) RETURNS void
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'pg_catalog', 'public'
    AS $_$
BEGIN
 IF t IS NULL OR d IS NULL OR c IS NULL OR c!~'^[A-Z]{3}$' THEN RAISE EXCEPTION 'Invalid credit scope' USING ERRCODE='CE003'; END IF;
 PERFORM pg_advisory_xact_lock(hashtextextended('cash-credit-v1e:'||t::text||':'||d::text||':'||c,0));
END $_$;


--
-- Name: driver_cash_credit_status_v1f(uuid); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.driver_cash_credit_status_v1f(p_driver_id uuid) RETURNS jsonb
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'pg_catalog', 'public'
    AS $_$
DECLARE p public.profiles%ROWTYPE; v_country text; v_currency text; currencies integer; approved boolean; b jsonb;
BEGIN
 SELECT * INTO p FROM public.profiles WHERE id=p_driver_id;
 IF NOT FOUND OR p.role IS DISTINCT FROM 'driver' THEN RAISE EXCEPTION 'Driver access required' USING ERRCODE='CE002'; END IF;
 v_country:=upper(btrim(coalesce(nullif(p.registration_country_code,''),p.country_code,'')));
 IF p.tenant_id IS NULL OR v_country !~ '^[A-Z]{2}$' THEN RAISE EXCEPTION 'Driver market unresolved' USING ERRCODE='CE002'; END IF;
 SELECT count(DISTINCT upper(supported_currency)),min(upper(supported_currency)) INTO currencies,v_currency
 FROM public.market_availability WHERE country_code=v_country;
 IF currencies<>1 OR v_currency IS NULL OR v_currency !~ '^[A-Z]{3}$' THEN RAISE EXCEPTION 'Driver currency unresolved' USING ERRCODE='CE002'; END IF;
 approved:=p.registration_activated_at IS NOT NULL AND EXISTS(
  SELECT 1 FROM public.driver_cash_credit_enrolments_v1e e WHERE e.tenant_id=p.tenant_id AND e.driver_id=p.id
   AND e.country_code=v_country AND e.currency_code=v_currency AND e.enabled AND e.consented_at<=now());
 b:=public.driver_cash_credit_balance_v1e(p.tenant_id,p.id,v_currency);
 RETURN jsonb_build_object('tenantId',p.tenant_id,'driverId',p.id,'country',v_country,'currency',v_currency,
  'pilotEnabled',public.driver_cash_credit_enabled_v1e(),'enrolled',approved,'balance',b,
  'topupAvailable',false,'payoutAvailable',false,'acceptanceAuthority','database');
END $_$;


--
-- Name: driver_compliance_rule_passes(text, text, timestamp with time zone); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.driver_compliance_rule_passes(p_check_type text, p_value text, p_at timestamp with time zone) RETURNS boolean
    LANGUAGE sql IMMUTABLE
    SET search_path TO 'public', 'pg_temp'
    AS $_$
    SELECT CASE p_check_type
        WHEN 'boolean_true'    THEN COALESCE(p_value, 'false') = 'true'
        WHEN 'text_present'    THEN NULLIF(BTRIM(COALESCE(p_value, '')), '') IS NOT NULL
        WHEN 'number_gt_1900'  THEN p_value ~ '^\d{4}$' AND (p_value)::NUMERIC > 1900
        -- DATE semantics: valid THROUGH the expiry date, so only
        -- expiry < p_at::date is expired. An absent or malformed date fails
        -- closed (a document whose expiry cannot be read is not evidence).
        WHEN 'date_not_expired' THEN public.safe_iso_date(p_value) IS NOT NULL
                                   AND public.safe_iso_date(p_value) >= p_at::DATE
        WHEN 'status_ok'       THEN COALESCE(LOWER(p_value), '') NOT IN ('rejected', 'expired')
        WHEN 'tax_ok'          THEN COALESCE(LOWER(p_value), '') NOT IN ('untaxed', 'sorn', 'not_taxed')
        ELSE FALSE
    END;
$_$;


--
-- Name: driver_compliance_rules(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.driver_compliance_rules() RETURNS TABLE(rule_code text, service_scope text, country_scope text, condition text, kind text, field text, field_source text, check_type text, blocking boolean, label text)
    LANGUAGE sql IMMUTABLE
    SET search_path TO 'public', 'pg_temp'
    AS $$
    SELECT * FROM (VALUES
        -- account / approval ------------------------------------------------
        ('account.not_active',        'all',        'any', 'always', 'account',  'account_active',        'derived', 'boolean_true',    TRUE,  'Driver account is active'),
        ('onboarding.not_approved',   'all',        'any', 'always', 'approval', 'is_approved',           'derived', 'boolean_true',    TRUE,  'Driver is approved'),
        ('onboarding.not_complete',   'all',        'any', 'always', 'approval', 'onboarding_complete',   'derived', 'boolean_true',    TRUE,  'Driver onboarding is complete'),
        ('agreement.not_accepted',    'all',        'any', 'always', 'approval', 'agreement_accepted',    'derived', 'boolean_true',    TRUE,  'Driver agreement is accepted'),
        -- profile basics ----------------------------------------------------
        ('profile.full_name',         'all',        'any', 'always', 'profile',  'full_name',             'profile', 'text_present',    TRUE,  'Full legal name is present'),
        ('profile.phone',             'all',        'any', 'always', 'profile',  'phone',                 'profile', 'text_present',    TRUE,  'Contact phone is present'),
        ('profile.address',           'all',        'any', 'always', 'profile',  'address_present',       'derived', 'boolean_true',    TRUE,  'Residential address is present'),
        ('profile.date_of_birth',     'all',        'any', 'always', 'profile',  'driver_is_adult',       'derived', 'boolean_true',    TRUE,  'Driver meets the minimum age'),
        ('work.right_to_work',        'all',        'GB',  'always', 'document', 'right_to_work_present', 'derived', 'boolean_true',    TRUE,  'Right to work evidence is present'),
        -- vehicle -----------------------------------------------------------
        ('vehicle.present',           'all',        'any', 'always', 'vehicle',  'vehicle_present',       'derived', 'boolean_true',    TRUE,  'A vehicle is registered'),
        ('vehicle.make',              'all',        'any', 'motor',  'vehicle',  'make',                  'vehicle', 'text_present',    TRUE,  'Vehicle make is present'),
        ('vehicle.model',             'all',        'any', 'motor',  'vehicle',  'model',                 'vehicle', 'text_present',    TRUE,  'Vehicle model is present'),
        ('vehicle.colour',            'all',        'any', 'motor',  'vehicle',  'vehicle_colour',        'derived', 'text_present',    TRUE,  'Vehicle colour is present'),
        ('vehicle.year',              'all',        'any', 'motor',  'vehicle',  'year',                  'vehicle', 'number_gt_1900',  TRUE,  'Vehicle year is valid'),
        ('vehicle.registration',      'all',        'any', 'motor',  'vehicle',  'license_plate',         'vehicle', 'text_present',    TRUE,  'Vehicle registration is present'),
        -- base documents (presence — mirrors the authoritative engine) ------
        ('document.driving_licence',        'all', 'any', 'motor',  'document', 'driver_license_url',              'profile', 'text_present',    TRUE, 'Driving licence document is present'),
        ('document.driving_licence.expiry', 'all', 'any', 'motor',  'document', 'driver_license_expiry',           'profile', 'date_not_expired', TRUE, 'Driving licence is not expired'),
        ('document.insurance',              'all', 'any', 'motor',  'document', 'insurance_url',                   'profile', 'text_present',    TRUE, 'Vehicle insurance document is present'),
        ('document.insurance.expiry',       'all', 'any', 'motor',  'document', 'insurance_expiry',                'profile', 'date_not_expired', TRUE, 'Vehicle insurance is not expired'),
        -- ride-only passenger licensing -------------------------------------
        -- Read precedence is canonical-typed-column FIRST, then the legacy
        -- verification_items compatibility key, then the legacy alias column.
        -- Resolved into derived fields below so the evaluator stays generic.
        ('licence.private_hire.council',    'ride', 'any', 'always', 'licence', 'licence_council_name',           'derived', 'text_present',    TRUE, 'Licensing authority is present'),
        ('licence.private_hire.number',     'ride', 'any', 'always', 'licence', 'licence_number',                 'derived', 'text_present',    TRUE, 'Private hire licence number is present'),
        ('licence.private_hire.badge',      'ride', 'any', 'always', 'licence', 'licence_badge_number',           'derived', 'text_present',    TRUE, 'Taxi or private hire badge is present'),
        ('licence.private_hire.expiry',     'ride', 'any', 'always', 'licence', 'licence_expiry',                 'derived', 'date_not_expired', TRUE, 'Private hire licence is not expired'),
        ('document.private_hire_insurance', 'ride', 'any', 'always', 'document','private_hire_insurance_url',    'profile', 'text_present',    TRUE, 'Private hire insurance is present'),
        -- van-moving --------------------------------------------------------
        ('document.goods_in_transit',       'van-moving', 'any', 'non_gb', 'document', 'goods_in_transit_insurance_url', 'profile', 'text_present', TRUE, 'Goods in transit cover is present outside GB'),
        -- ADVISORY (blocking = FALSE) — named policy decisions, see header --
        ('document.courier_insurance',      'errand',     'any', 'motor', 'document', 'courier_insurance_url',          'profile', 'text_present',    FALSE, 'Courier insurance is present (advisory)'),
        ('document.courier_insurance',      'delivery',   'any', 'motor', 'document', 'courier_insurance_url',          'profile', 'text_present',    FALSE, 'Courier insurance is present (advisory)'),
        ('document.courier_insurance.expiry','delivery',  'any', 'motor', 'document', 'courier_insurance_expiry',       'profile', 'date_not_expired',FALSE, 'Courier insurance is not expired (advisory)'),
        ('document.moving_insurance',       'van-moving', 'any', 'always','document', 'moving_insurance_url',           'profile', 'text_present',    FALSE, 'Moving insurance is present (advisory)'),
        ('document.public_liability',       'van-moving', 'any', 'always','document', 'public_liability_insurance_url', 'profile', 'text_present',    FALSE, 'Public liability insurance is present (advisory)'),
        ('document.driving_licence.status', 'all',       'any', 'motor', 'document', 'driver_license_status',          'profile', 'status_ok',       FALSE, 'Driving licence status is not rejected or expired (advisory)'),
        ('document.insurance.status',       'all',       'any', 'motor', 'document', 'insurance_status',               'profile', 'status_ok',       FALSE, 'Insurance status is not rejected or expired (advisory)'),
        ('vehicle.mot_expiry',              'all',       'any', 'motor', 'vehicle',  'mot_expiry_date',                'vehicle', 'date_not_expired',FALSE, 'Vehicle MOT is not expired (advisory)'),
        ('vehicle.tax_status',              'all',       'any', 'motor', 'vehicle',  'dvla_tax_status',                'vehicle', 'tax_ok',          FALSE, 'Vehicle tax status is valid (advisory)'),
        ('vehicle.verified',                'all',       'any', 'motor', 'vehicle',  'vehicle_verified',               'vehicle', 'boolean_true',    FALSE, 'Vehicle is verified (advisory)')
    ) AS r(rule_code, service_scope, country_scope, condition, kind, field, field_source, check_type, blocking, label);
$$;


--
-- Name: driver_counter_offer(uuid, numeric); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.driver_counter_offer(p_session_id uuid, p_amount numeric) RETURNS public.marketplace_negotiation_sessions
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'public'
    AS $$
DECLARE
  v_actor UUID := auth.uid();
  v_session public.marketplace_negotiation_sessions;
  v_job public.jobs;
  v_max_rounds INTEGER;
  v_turn_lease INTEGER;
BEGIN
  IF v_actor IS NULL THEN
    RAISE EXCEPTION 'Authentication required';
  END IF;

  IF p_amount IS NULL OR p_amount <= 0 THEN
    RAISE EXCEPTION 'Counter amount must be a positive value';
  END IF;

  SELECT * INTO v_session
  FROM public.marketplace_negotiation_sessions
  WHERE id = p_session_id
  FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Negotiation session not found';
  END IF;

  IF v_session.active_driver_id IS DISTINCT FROM v_actor THEN
    RAISE EXCEPTION 'Only the active driver can counter this negotiation';
  END IF;

  IF NOT public.driver_vehicle_can_accept_job(v_session.job_id, v_actor) THEN
    RAISE EXCEPTION 'You are not eligible for this service';
  END IF;

  IF v_session.status NOT IN ('open', 'driver_claimed', 'negotiating') THEN
    RAISE EXCEPTION 'Negotiation is not open';
  END IF;

  IF v_session.expires_at <= now() THEN
    RAISE EXCEPTION 'Negotiation has expired';
  END IF;

  IF public.negotiation_live_proposal_role(v_session.id) IS DISTINCT FROM 'customer'
     OR v_session.customer_offer IS NULL THEN
    RAISE EXCEPTION 'There is no customer offer awaiting a response';
  END IF;

  SELECT * INTO v_job FROM public.jobs WHERE id = v_session.job_id;
  v_max_rounds := COALESCE(
    (public.get_marketplace_setting('hybrid_negotiation', v_job.tenant_id)->>'maxRounds')::INTEGER,
    3
  );

  IF v_session.round_count >= v_max_rounds THEN
    RAISE EXCEPTION 'Maximum negotiation rounds reached';
  END IF;

  v_turn_lease := COALESCE(
    (public.get_marketplace_setting('hybrid_negotiation', v_job.tenant_id)->>'timeoutSeconds')::INTEGER,
    120
  );

  UPDATE public.marketplace_negotiation_sessions
  SET driver_counter_offer = p_amount,
      status = 'negotiating',
      round_count = v_session.round_count + 1,
      -- TURN LEASE REFRESH: the customer now has a full response window.
      expires_at = public.negotiation_lease_expiry(v_session.job_id, v_turn_lease),
      updated_at = now()
  WHERE id = v_session.id
  RETURNING * INTO v_session;

  INSERT INTO public.marketplace_negotiation_events (
    session_id, job_id, proposed_by, proposed_by_role,
    event_type, amount, round_number, created_at
  ) VALUES (
    v_session.id, v_session.job_id, v_actor, 'driver',
    'driver_counter', p_amount, v_session.round_count, now()
  );

  RETURN v_session;
END;
$$;


--
-- Name: driver_has_active_job(uuid); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.driver_has_active_job(p_driver_id uuid) RETURNS boolean
    LANGUAGE sql STABLE
    SET search_path TO 'public', 'pg_temp'
    AS $$
    SELECT public.driver_has_other_active_job(p_driver_id, NULL);
$$;


--
-- Name: driver_has_other_active_job(uuid, uuid); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.driver_has_other_active_job(p_driver_id uuid, p_exclude_job_id uuid) RETURNS boolean
    LANGUAGE sql STABLE
    SET search_path TO 'public', 'pg_temp'
    AS $$
    SELECT p_driver_id IS NOT NULL
       AND EXISTS (
           SELECT 1
             FROM public.jobs j
            WHERE j.driver_id = p_driver_id
              AND j.status = ANY (public.driver_occupying_statuses())
              AND j.id IS DISTINCT FROM p_exclude_job_id
       );
$$;


--
-- Name: driver_job_market_matches_v23(jsonb, jsonb); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.driver_job_market_matches_v23(p jsonb, j jsonb) RETURNS boolean
    LANGUAGE sql IMMUTABLE
    SET search_path TO 'pg_catalog'
    AS $_$
 SELECT COALESCE(
  upper(btrim(COALESCE(NULLIF(p->>'registration_country_code',''),p->>'country_code',''))) ~ '^[A-Z]{2}$'
  AND upper(btrim(COALESCE(NULLIF(p->>'registration_country_code',''),p->>'country_code',''))) =
      upper(btrim(COALESCE(NULLIF(j->>'country_code',''),j->'metadata'->>'country_code','')))
  AND NULLIF(p->>'tenant_id','') IS NOT NULL AND p->>'tenant_id'=j->>'tenant_id'
  AND (NULLIF(j->'metadata'->>'country_code','') IS NULL OR
       upper(btrim(j->'metadata'->>'country_code'))=upper(btrim(j->>'country_code'))),false)
$_$;


--
-- Name: driver_occupying_statuses(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.driver_occupying_statuses() RETURNS text[]
    LANGUAGE sql IMMUTABLE
    SET search_path TO 'public', 'pg_temp'
    AS $$
    SELECT ARRAY[
        'assigned',
        'accepted',
        'fare_agreed',
        'heading_to_pickup',
        'driver_en_route',
        'arrived',
        'driver_arrived',
        'arrived_at_store',
        'shopping_in_progress',
        'collected',
        'picked_up',
        'en_route_to_customer',
        'in_progress',
        'delivered',
        'over_budget_requested',
        'requires_review'
    ]::TEXT[];
$$;


--
-- Name: driver_ranking_scores_v23(uuid[]); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.driver_ranking_scores_v23(p_driver_ids uuid[]) RETURNS TABLE(driver_id uuid, average_score numeric, review_count bigint)
    LANGUAGE plpgsql STABLE SECURITY DEFINER
    SET search_path TO 'pg_catalog', 'public'
    AS $$
BEGIN
  IF p_driver_ids IS NULL OR cardinality(p_driver_ids)>40 THEN
    RAISE EXCEPTION 'At most 40 driver IDs are allowed';
  END IF;
  RETURN QUERY
  WITH verified AS (
    -- Exactly one current review per genuine completed booking. The booking
    -- supplies the driver identity; profile aggregates are never trusted here.
    SELECT DISTINCT ON (j.id)
      j.id AS booking_id,j.driver_id AS reviewed_driver,r.score,r.created_at,r.id AS rating_id
    FROM public.jobs j
    JOIN public.ratings r ON r.job_id=j.id
      OR (r.job_id IS NULL AND to_jsonb(r)->>'booking_id'=j.id::text)
    WHERE j.driver_id=ANY(p_driver_ids)
      AND j.status IN ('completed','settled')
      AND j.customer_id=r.customer_id
      AND j.customer_id<>j.driver_id
      AND r.score BETWEEN 1 AND 5 AND r.score=trunc(r.score::numeric)
    ORDER BY j.id,r.created_at DESC NULLS LAST,r.id DESC
  ), recent AS (
    SELECT v.*,row_number() OVER (
      PARTITION BY v.reviewed_driver ORDER BY v.created_at DESC NULLS LAST,v.rating_id DESC
    ) AS position
    FROM verified v
  )
  SELECT r.reviewed_driver,avg(r.score::numeric),count(*)
  FROM recent r WHERE r.position<=100
  GROUP BY r.reviewed_driver;
END
$$;


--
-- Name: FUNCTION driver_ranking_scores_v23(p_driver_ids uuid[]); Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON FUNCTION public.driver_ranking_scores_v23(p_driver_ids uuid[]) IS 'Service-only ranking input: latest 100 verified completed-booking reviews per eligible candidate; does not mutate operational data.';


--
-- Name: driver_service_eligibility(uuid, text, timestamp with time zone); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.driver_service_eligibility(p_driver_id uuid, p_service text, p_at timestamp with time zone DEFAULT now()) RETURNS TABLE(eligible boolean, blocking_codes text[], advisory_codes text[])
    LANGUAGE plpgsql STABLE SECURITY DEFINER
    SET search_path TO 'public', 'pg_temp'
    AS $$
DECLARE
    v_service  TEXT;
    v_profile  JSONB;
    v_vehicle  JSONB;
    v_items    JSONB;
    v_derived  JSONB;
    v_vehicle_text TEXT;
    v_country  TEXT;
    v_blocking TEXT[];
    v_advisory TEXT[];
BEGIN
    v_service := public.canonical_driver_service(p_service);

    SELECT to_jsonb(p) INTO v_profile FROM public.profiles p WHERE p.id = p_driver_id;
    IF v_profile IS NULL THEN
        RETURN QUERY SELECT FALSE, ARRAY['service.unresolved']::TEXT[], ARRAY[]::TEXT[];
        RETURN;
    END IF;

    IF v_service IS NULL THEN
        RETURN QUERY SELECT FALSE, ARRAY['service.unresolved']::TEXT[], ARRAY[]::TEXT[];
        RETURN;
    END IF;

    SELECT to_jsonb(v) INTO v_vehicle
      FROM public.vehicles v
     WHERE v.user_id = p_driver_id
     ORDER BY v.created_at DESC NULLS LAST, v.id DESC
     LIMIT 1;

    v_vehicle_text := LOWER(
        COALESCE(v_vehicle ->> 'capacity', '') || ' ' || COALESCE(v_vehicle ->> 'type', '')
    );
    v_country := UPPER(COALESCE(v_profile ->> 'country_code', ''));

    -- Legacy compatibility bag. Only the object shape the onboarding flow writes
    -- is read; the array/string shapes the TypeScript parser also tolerates are
    -- deliberately not guessed at here.
    v_items := CASE WHEN jsonb_typeof(v_profile -> 'verification_items') = 'object'
                    THEN v_profile -> 'verification_items'
                    ELSE '{}'::JSONB END;

    -- Derived flags. Every one is a boolean in text form so the rule table can
    -- stay scalar and the parity test can compare it directly.
    v_derived := jsonb_build_object(
        'account_active',      (COALESCE(v_profile ->> 'account_status', 'active') NOT IN ('paused', 'suspended', 'blocked'))::TEXT,
        'is_approved',         ((v_profile ->> 'is_verified')::TEXT = 'true'
                                OR COALESCE(v_profile ->> 'verification_status', '') = 'approved')::TEXT,
        'onboarding_complete', (COALESCE(v_profile ->> 'onboarding_completed', 'false') = 'true')::TEXT,
        'agreement_accepted',  (NULLIF(BTRIM(COALESCE(v_profile ->> 'accepted_driver_agreement_at', '')), '') IS NOT NULL)::TEXT,
        'address_present',     ((NULLIF(BTRIM(COALESCE(v_profile ->> 'current_address', '')), '') IS NOT NULL)
                                OR (NULLIF(BTRIM(COALESCE(v_profile ->> 'address_line1', '')), '') IS NOT NULL)
                                OR (NULLIF(BTRIM(COALESCE(v_profile ->> 'home_address', '')), '') IS NOT NULL))::TEXT,
        'driver_is_adult',     (public.safe_iso_date(v_profile ->> 'date_of_birth') IS NOT NULL
                                AND public.safe_iso_date(v_profile ->> 'date_of_birth')
                                    <= (p_at::DATE - INTERVAL '18 years')::DATE)::TEXT,
        'right_to_work_present', ((NULLIF(BTRIM(COALESCE(v_profile ->> 'right_to_work_url', '')), '') IS NOT NULL)
                                OR (NULLIF(BTRIM(COALESCE(v_profile ->> 'right_to_work_share_code', '')), '') IS NOT NULL))::TEXT,
        'vehicle_present',     (v_vehicle IS NOT NULL)::TEXT,
        'driver_is_motor',     (v_vehicle IS NOT NULL
                                AND v_vehicle_text !~ 'bicycle|bike|cycle')::TEXT,
        -- Production stores the vehicle colour in the color column, while the
        -- mapped driver-vehicle model presents it as colour. Accept both, color
        -- first. Avoid apostrophes inside these comments: the repository SQL
        -- lexer does not strip comments inside dollar-quoted bodies.
        'vehicle_colour',      COALESCE(
            NULLIF(BTRIM(COALESCE(v_vehicle ->> 'color', '')), ''),
            NULLIF(BTRIM(COALESCE(v_vehicle ->> 'colour', '')), '')),
        -- Passenger licence: canonical typed column FIRST, then the legacy
        -- verification_items compatibility key, then the legacy alias column.
        'licence_council_name', COALESCE(
            NULLIF(BTRIM(COALESCE(v_profile ->> 'council_name', '')), ''),
            NULLIF(BTRIM(COALESCE(v_items ->> 'council_name', '')), ''),
            NULLIF(BTRIM(COALESCE(v_profile ->> 'council_license_authority', '')), '')),
        'licence_number',       COALESCE(
            NULLIF(BTRIM(COALESCE(v_profile ->> 'council_license_number', '')), ''),
            NULLIF(BTRIM(COALESCE(v_items ->> 'council_license_number', '')), '')),
        'licence_badge_number', COALESCE(
            NULLIF(BTRIM(COALESCE(v_profile ->> 'taxi_badge_number', '')), ''),
            NULLIF(BTRIM(COALESCE(v_items ->> 'taxi_badge_number', '')), '')),
        'licence_expiry',       COALESCE(
            v_profile ->> 'taxi_license_expiry',
            v_items ->> 'taxi_license_expiry',
            v_profile ->> 'council_license_expiry')
    );

    SELECT
        array_agg(DISTINCT r.rule_code ORDER BY r.rule_code) FILTER (WHERE r.blocking),
        array_agg(DISTINCT r.rule_code ORDER BY r.rule_code) FILTER (WHERE NOT r.blocking)
      INTO v_blocking, v_advisory
      FROM public.driver_compliance_rules() r
     WHERE (r.service_scope = 'all' OR r.service_scope = v_service)
       AND (r.country_scope = 'any' OR r.country_scope = v_country)
       AND (r.condition = 'always'
            OR (r.condition = 'motor'  AND (v_derived ->> 'driver_is_motor') = 'true')
            OR (r.condition = 'non_gb' AND v_country <> 'GB'))
       AND NOT public.driver_compliance_rule_passes(
                   r.check_type,
                   CASE r.field_source
                       WHEN 'vehicle' THEN v_vehicle ->> r.field
                       WHEN 'derived' THEN v_derived ->> r.field
                       ELSE v_profile ->> r.field
                   END,
                   p_at);

    RETURN QUERY SELECT
        COALESCE(array_length(v_blocking, 1), 0) = 0,
        COALESCE(v_blocking, ARRAY[]::TEXT[]),
        COALESCE(v_advisory, ARRAY[]::TEXT[]);
END;
$$;


--
-- Name: driver_vehicle_can_accept_job(uuid, uuid); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.driver_vehicle_can_accept_job(p_job_id uuid, p_driver_id uuid) RETURNS boolean
    LANGUAGE plpgsql
    SET search_path TO 'public', 'pg_temp'
    AS $$
DECLARE
    v_required TEXT;
    v_service_slug TEXT;
    v_metadata JSONB;
    v_vehicle RECORD;
    v_vehicle_text TEXT;
    v_goods_required TEXT;
    v_goods_required_rank integer;
    v_goods_actual_rank integer;
BEGIN
    IF p_job_id IS NULL OR p_driver_id IS NULL THEN
        RETURN FALSE;
    END IF;

    SELECT
        COALESCE(
            (SELECT COALESCE(st.slug::TEXT, st.name::TEXT)
               FROM public.service_types st
              WHERE st.id = j.service_type_id),
            j.metadata ->> 'service_slug',
            ''
        ),
        COALESCE(j.metadata, '{}'::jsonb)
    INTO v_service_slug, v_metadata
    FROM public.jobs j
    WHERE j.id = p_job_id;

    -- Missing job -> not acceptable.
    IF NOT FOUND THEN
        RETURN FALSE;
    END IF;

    v_required := LOWER(COALESCE(
        v_metadata ->> 'service_vehicle_class',
        v_metadata ->> 'vehicle_class',
        v_metadata ->> 'vehicleClass',
        v_metadata #>> '{ride_details,vehicle_class}',
        v_metadata #>> '{delivery_details,vehicleClass}',
        v_metadata #>> '{errand_details,vehicleClass}',
        ''
    ));

    IF v_required LIKE '%bike%' OR v_required LIKE '%motorcycle%' OR v_required LIKE '%scooter%' THEN
        v_required := 'bike';
    ELSIF v_required LIKE '%minibus%' OR v_required LIKE '%7 seater%' OR v_required LIKE '%7-seater%' THEN
        v_required := 'minibus';
    ELSIF v_required LIKE '%large_van%' OR v_required LIKE '%large van%' OR v_required LIKE '%luton%' THEN
        v_required := 'large_van';
    ELSIF v_required LIKE '%small_van%' OR v_required LIKE '%small van%' OR v_required LIKE '%van%' THEN
        v_required := 'small_van';
    ELSIF v_required LIKE '%xl%' OR v_required LIKE '%7%' THEN
        v_required := 'xl';
    ELSIF v_required LIKE '%standard%' THEN
        v_required := 'standard';
    ELSIF v_required LIKE '%car%' THEN
        v_required := 'car';
    ELSIF LOWER(v_service_slug) LIKE '%van%' OR LOWER(v_service_slug) LIKE '%moving%' THEN
        v_required := 'small_van';
    ELSIF LOWER(v_service_slug) LIKE '%delivery%' OR LOWER(v_service_slug) LIKE '%errand%' THEN
        v_required := 'car';
    ELSE
        v_required := 'standard';
    END IF;

    SELECT * INTO v_vehicle
    FROM public.vehicles
    WHERE user_id = p_driver_id
    LIMIT 1;

    -- Missing vehicle -> not acceptable.
    IF NOT FOUND THEN
        RETURN FALSE;
    END IF;

    -- service_class has no physical column in production; read it from the row
    -- as JSON so an absent key degrades to '' instead of erroring.
    v_vehicle_text := LOWER(
        COALESCE(to_jsonb(v_vehicle) ->> 'type', '') || ' ' ||
        COALESCE(to_jsonb(v_vehicle) ->> 'capacity', '') || ' ' ||
        COALESCE(to_jsonb(v_vehicle) ->> 'service_class', '')
    );

    -- Goods class is a minimum carrying capacity, matching API and app.
    IF lower(trim(v_service_slug)) IN ('delivery','errand') THEN
        v_goods_required := lower(coalesce(
            nullif(v_metadata->>'service_vehicle_class',''),
            nullif(v_metadata->>'vehicle_class',''),
            nullif(v_metadata->>'vehicleClass',''),
            nullif(v_metadata #>> '{delivery_details,vehicleClass}',''),
            nullif(v_metadata #>> '{errand_details,vehicleClass}',''), 'car'));
        v_goods_required_rank := CASE
            WHEN v_goods_required ~ 'bike|motorcycle|scooter' THEN 1
            WHEN v_goods_required ~ 'large[_ ]van|luton' THEN 4
            WHEN v_goods_required ~ 'van' THEN 3
            WHEN v_goods_required ~ 'car|standard|minibus|seater|xl' THEN 2
            ELSE 0 END;
        v_goods_actual_rank := CASE
            WHEN v_vehicle_text ~ 'bike|motorcycle|scooter' THEN 1
            WHEN v_vehicle_text ~ 'large[_ ]van|luton' THEN 4
            WHEN v_vehicle_text ~ 'van' THEN 3
            WHEN v_vehicle_text ~ 'car|standard|minibus|seater|xl' THEN 2
            ELSE 0 END;
        RETURN v_goods_required_rank > 0 AND v_goods_actual_rank >= v_goods_required_rank;
    END IF;

    IF v_vehicle_text LIKE '%bike%' OR v_vehicle_text LIKE '%motorcycle%' OR v_vehicle_text LIKE '%scooter%' THEN
        RETURN v_required = 'bike';
    END IF;

    IF v_vehicle_text LIKE '%minibus%' OR v_vehicle_text LIKE '%7 seater%' OR v_vehicle_text LIKE '%7-seater%' OR v_vehicle_text LIKE '%xl%' OR v_vehicle_text LIKE '%7%' THEN
        RETURN v_required IN ('standard', 'xl', 'minibus', 'car');
    END IF;

    IF v_vehicle_text LIKE '%large_van%' OR v_vehicle_text LIKE '%large van%' OR v_vehicle_text LIKE '%luton%' THEN
        RETURN v_required IN ('standard', 'xl', 'car', 'small_van', 'large_van');
    END IF;

    IF v_vehicle_text LIKE '%small_van%' OR v_vehicle_text LIKE '%small van%' OR v_vehicle_text LIKE '%van%' THEN
        RETURN v_required IN ('standard', 'car', 'small_van');
    END IF;

    RETURN v_required IN ('standard', 'car');
END;
$$;


--
-- Name: early_stop_fare_context_v23(uuid, uuid, uuid); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.early_stop_fare_context_v23(p_actor uuid, p_job_id uuid, p_stop_id uuid) RETURNS jsonb
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'pg_catalog', 'public'
    AS $$
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
$$;


--
-- Name: end_job_driver_search(uuid); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.end_job_driver_search(p_job_id uuid) RETURNS jsonb
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'public', 'pg_temp'
    AS $$
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


--
-- Name: enforce_driver_job_market_v23(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.enforce_driver_job_market_v23() RETURNS trigger
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'pg_catalog', 'public'
    SET row_security TO 'off'
    AS $$
DECLARE j jsonb; p jsonb; driver_text text; field_name text;
BEGIN
 IF TG_TABLE_NAME='jobs' THEN
  IF TG_OP='UPDATE' AND NEW.status IN ('cancelled','canceled','expired','failed','requires_review') AND NEW.driver_id IS NOT DISTINCT FROM OLD.driver_id AND NEW.accepted_driver_id IS NOT DISTINCT FROM OLD.accepted_driver_id THEN RETURN NEW; END IF;
  j:=to_jsonb(NEW);
 ELSE
  SELECT to_jsonb(job) INTO j FROM public.jobs job WHERE job.id=(to_jsonb(NEW)->>'job_id')::uuid FOR UPDATE;
  IF j IS NULL THEN RAISE EXCEPTION USING ERRCODE='P0001',MESSAGE='DRIVER_MARKET_JOB_MISSING'; END IF;
 END IF;
 FOREACH field_name IN ARRAY TG_ARGV LOOP
  driver_text:=NULLIF(to_jsonb(NEW)->>field_name,'');
  IF driver_text IS NULL THEN CONTINUE; END IF;
  SELECT to_jsonb(profile) INTO p FROM public.profiles profile WHERE profile.id=driver_text::uuid;
  IF p IS NULL OR p->>'role' IS DISTINCT FROM 'driver' OR NOT public.driver_job_market_matches_v23(p,j) THEN
   RAISE EXCEPTION USING ERRCODE='P0001',MESSAGE='DRIVER_MARKET_MISMATCH';
  END IF;
 END LOOP;
 RETURN NEW;
END $$;


--
-- Name: enforce_errand_spending_budget(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.enforce_errand_spending_budget() RETURNS trigger
    LANGUAGE plpgsql
    SET search_path TO 'public'
    AS $$
DECLARE
    v_approved_extra NUMERIC := 0;
    v_approved_budget NUMERIC := 0;
BEGIN
    IF NEW.actual_spending IS NULL OR NEW.actual_spending IS NOT DISTINCT FROM OLD.actual_spending THEN
        RETURN NEW;
    END IF;

    IF NEW.actual_spending < 0 THEN
        RAISE EXCEPTION 'Item spending cannot be negative';
    END IF;

    SELECT CASE
        WHEN over_budget_status = 'approved'
        THEN COALESCE(requested_over_budget_amount, over_budget_amount, 0)
        ELSE 0
    END
    INTO v_approved_extra
    FROM public.errand_funding
    WHERE job_id = NEW.job_id;

    v_approved_budget := ROUND(
        (COALESCE(NEW.estimated_budget, 0) + COALESCE(v_approved_extra, 0))::NUMERIC,
        2
    );

    IF ROUND(NEW.actual_spending::NUMERIC, 2) > v_approved_budget THEN
        RAISE EXCEPTION 'Item spending exceeds approved budget. Maximum: %', v_approved_budget;
    END IF;

    NEW.actual_spending := ROUND(NEW.actual_spending::NUMERIC, 2);
    RETURN NEW;
END;
$$;


--
-- Name: enforce_gb_mot_acquisition(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.enforce_gb_mot_acquisition() RETURNS trigger
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'public'
    AS $$
DECLARE driver uuid; previous uuid;
BEGIN
 driver=(to_jsonb(NEW)->>TG_ARGV[0])::uuid;
 IF TG_OP='UPDATE' THEN previous=(to_jsonb(OLD)->>TG_ARGV[0])::uuid; END IF;
 IF driver IS NOT NULL AND driver IS DISTINCT FROM previous AND gb_driver_mot_blocked(driver) THEN
  RAISE EXCEPTION 'MOT_EXPIRED_OR_UNVERIFIED: A valid MOT is required to take new work.' USING ERRCODE='P0001';
 END IF;RETURN NEW;
END;$$;


--
-- Name: enforce_gb_mot_online(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.enforce_gb_mot_online() RETURNS trigger
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'public'
    AS $$
BEGIN
 IF (NEW.is_online OR NEW.is_available) AND gb_driver_mot_blocked(NEW.id) THEN
  RAISE EXCEPTION 'MOT_EXPIRED_OR_UNVERIFIED: Renew your MOT and recheck your registration before going online.' USING ERRCODE='P0001';
 END IF;RETURN NEW;
END;$$;


--
-- Name: enforce_job_acquisition_eligibility(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.enforce_job_acquisition_eligibility() RETURNS trigger
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'public', 'pg_temp'
    AS $$
DECLARE
    v_service TEXT;
    v_result  RECORD;
BEGIN
    -- Release to unowned: always allowed.
    IF NEW.driver_id IS NULL THEN
        RETURN NEW;
    END IF;

    -- Same-driver re-assertion (e.g. completion re-writing the same owner):
    -- not an acquisition, always allowed.
    IF TG_OP = 'UPDATE' AND NEW.driver_id = OLD.driver_id THEN
        RETURN NEW;
    END IF;

    -- Genuine acquisition OR reassignment: the INCOMING driver must be eligible
    -- for the canonical service of this job.
    v_service := public.job_canonical_service(NEW.id);

    SELECT * INTO v_result
      FROM public.driver_service_eligibility(NEW.driver_id, v_service, now());

    IF v_result.eligible IS NOT TRUE THEN
        -- Codes only. Never document URLs, admin notes, reviewer identity or
        -- checklist prose: those must not travel through a database error.
        RAISE EXCEPTION 'Driver is not eligible for this service'
            USING ERRCODE    = 'MB002',
                  CONSTRAINT = 'enforce_job_acquisition_eligibility',
                  DETAIL     = array_to_string(
                                   COALESCE(v_result.blocking_codes, ARRAY[]::TEXT[]), ',');
    END IF;

    RETURN NEW;
END;
$$;


--
-- Name: enforce_job_payment_eligibility(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.enforce_job_payment_eligibility() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
BEGIN
    IF NEW.driver_id IS NOT NULL
       AND OLD.driver_id IS DISTINCT FROM NEW.driver_id
       AND NEW.status IN ('assigned', 'accepted') THEN
        IF NEW.payment_status NOT IN (
            'paid', 'wallet_funded', 'authorized', 'requires_capture', 'succeeded', 'captured'
        ) THEN
            RAISE EXCEPTION 'Job is not payment-eligible for driver acquisition'
                USING ERRCODE = 'MB003',
                      DETAIL = 'payment_eligibility';
        END IF;
    END IF;
    RETURN NEW;
END;
$$;


--
-- Name: enforce_profiles_ownership_guard(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.enforce_profiles_ownership_guard() RETURNS trigger
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'public', 'pg_temp'
    AS $$
DECLARE
    v_role TEXT := auth.role();
    v_uid  UUID := auth.uid();
BEGIN
    -- Trusted server writes (service_role) and no-JWT paths bypass.
    IF v_role IS NULL OR v_role = 'service_role' THEN
        RETURN COALESCE(NEW, OLD);
    END IF;

    -- Only authenticated clients are subject to ownership enforcement.
    IF v_role <> 'authenticated' THEN
        RETURN COALESCE(NEW, OLD);
    END IF;

    -- Fail closed: an authenticated caller must have a resolvable identity.
    IF v_uid IS NULL THEN
        RAISE EXCEPTION 'Authenticated profile write requires a caller identity.'
            USING ERRCODE = '42501', CONSTRAINT = 'trg_profiles_ownership_guard';
    END IF;

    IF TG_OP = 'INSERT' THEN
        IF NEW.id IS DISTINCT FROM v_uid THEN
            RAISE EXCEPTION 'Authenticated users can only insert their own profile.'
                USING ERRCODE = '42501', CONSTRAINT = 'trg_profiles_ownership_guard';
        END IF;
        RETURN NEW;
    ELSIF TG_OP = 'UPDATE' THEN
        IF OLD.id IS DISTINCT FROM v_uid THEN
            RAISE EXCEPTION 'Authenticated users can only update their own profile.'
                USING ERRCODE = '42501', CONSTRAINT = 'trg_profiles_ownership_guard';
        END IF;
        RETURN NEW;
    ELSIF TG_OP = 'DELETE' THEN
        IF OLD.id IS DISTINCT FROM v_uid THEN
            RAISE EXCEPTION 'Authenticated users can only delete their own profile.'
                USING ERRCODE = '42501', CONSTRAINT = 'trg_profiles_ownership_guard';
        END IF;
        RETURN OLD;
    END IF;

    RETURN COALESCE(NEW, OLD);
END;
$$;


--
-- Name: enforce_registration_authority_guard(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.enforce_registration_authority_guard() RETURNS trigger
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'public', 'pg_temp'
    AS $$
DECLARE
  v_role TEXT := auth.role();
BEGIN
  -- Trusted server writes (service_role) and no-JWT paths bypass.
  IF v_role IS NULL OR v_role = 'service_role' THEN
    RETURN COALESCE(NEW, OLD);
  END IF;

  IF NEW.registration_activated_at IS DISTINCT FROM OLD.registration_activated_at
     OR NEW.registration_country_code IS DISTINCT FROM OLD.registration_country_code
     OR NEW.registration_market_city IS DISTINCT FROM OLD.registration_market_city THEN
    RAISE EXCEPTION 'Registration eligibility is server-authoritative and cannot be written directly.'
      USING ERRCODE = '42501', CONSTRAINT = 'trg_registration_authority_guard';
  END IF;

  RETURN NEW;
END;
$$;


--
-- Name: enforce_ride_cash_credit_v1e(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.enforce_ride_cash_credit_v1e() RETURNS trigger
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'pg_catalog', 'public'
    AS $$
DECLARE h public.driver_cash_credit_holds_v1e%ROWTYPE; driver uuid; slug text;
BEGIN
 SELECT * INTO h FROM public.driver_cash_credit_holds_v1e WHERE job_id=NEW.id;
 IF FOUND THEN
  IF NOT public.cash_credit_service_writer_v1e() THEN RAISE EXCEPTION 'Cash transitions require the server role' USING ERRCODE='CE002'; END IF;
  IF NEW.status IS NULL THEN RAISE EXCEPTION 'Cash booking status missing' USING ERRCODE='CE006'; END IF;
  IF NEW.status IN ('cancelled','canceled','expired','failed','no_driver_found') THEN
   IF h.status='settled' THEN RAISE EXCEPTION 'Settled cash ride requires refund review' USING ERRCODE='CE005'; END IF;
   IF h.status='held' THEN PERFORM public.resolve_cash_job_credit_v1e(NEW.id,'released'); END IF;
   RETURN NEW;
  END IF;
  IF h.status='released' OR (h.status='settled' AND NEW.status NOT IN ('completed','delivered','settled')) THEN RAISE EXCEPTION 'Resolved cash ride cannot reopen' USING ERRCODE='CE005'; END IF;
  IF NEW.driver_id IS NOT NULL AND NEW.accepted_driver_id IS NOT NULL AND NEW.driver_id<>NEW.accepted_driver_id THEN RAISE EXCEPTION 'Conflicting accepted drivers' USING ERRCODE='CE005'; END IF;
  IF NEW.metadata->>'cash_collection_mode' IS DISTINCT FROM 'full_customer_charge' OR NEW.payment_intent_id IS NOT NULL THEN RAISE EXCEPTION 'Cash custody/payment mode changed' USING ERRCODE='CE005'; END IF;
  IF NEW.payment_method IS DISTINCT FROM 'cash' OR NEW.fare_breakdown IS DISTINCT FROM h.fare_snapshot
     OR NEW.tenant_id IS DISTINCT FROM h.tenant_id OR NEW.currency_code IS DISTINCT FROM h.currency_code
     OR NEW.country_code IS DISTINCT FROM h.country_code OR coalesce(NEW.driver_id,NEW.accepted_driver_id) IS DISTINCT FROM h.driver_id THEN
   RAISE EXCEPTION 'Cash reservation requires explicit reconciliation before changing terms' USING ERRCODE='CE005'; END IF;
  IF NEW.status IN ('completed','delivered','settled') AND h.status='held' THEN PERFORM public.resolve_cash_job_credit_v1e(NEW.id,'settled'); END IF;
  RETURN NEW;
 END IF;
 IF NOT public.driver_cash_credit_enabled_v1e() OR NEW.payment_method IS DISTINCT FROM 'cash' THEN RETURN NEW; END IF;
 SELECT st.slug INTO slug FROM public.service_types st WHERE st.id=NEW.service_type_id;
 IF slug IS DISTINCT FROM 'ride' THEN RETURN NEW; END IF;
 IF NOT public.cash_credit_service_writer_v1e() THEN RAISE EXCEPTION 'Cash acceptance requires the server role' USING ERRCODE='CE002'; END IF;
 driver:=coalesce(NEW.driver_id,NEW.accepted_driver_id);
 IF driver IS NOT NULL AND NEW.status IN ('assigned','accepted','heading_to_pickup','driver_en_route','arrived','in_progress','completed','delivered','settled') THEN
  PERFORM public.reserve_cash_job_credit_v1e(NEW.id,driver);
 END IF;
 RETURN NEW;
END $$;


--
-- Name: enforce_verified_driver_identity_guard(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.enforce_verified_driver_identity_guard() RETURNS trigger
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'public', 'pg_temp'
    AS $$
DECLARE
    v_role     TEXT := auth.role();
    v_verified BOOLEAN;
BEGIN
    -- Trusted server writes (service_role) and any no-JWT path bypass.
    IF v_role IS NULL OR v_role = 'service_role' THEN
        RETURN NEW;
    END IF;

    -- Non-driver rows (customers, etc.) are unaffected.
    IF OLD.role IS DISTINCT FROM 'driver' THEN
        RETURN NEW;
    END IF;

    -- Exact verified-driver predicate (see header comment).
    v_verified := (OLD.is_verified = true)
        OR (lower(COALESCE(NULLIF(OLD.driver_review_status, ''),
                           NULLIF(OLD.verification_status, ''), '')) = 'approved');

    IF NOT v_verified THEN
        RETURN NEW;
    END IF;

    IF NEW.full_name IS DISTINCT FROM OLD.full_name THEN
        RAISE EXCEPTION 'A verified driver cannot change their legal name directly.'
            USING ERRCODE = '42501', CONSTRAINT = 'trg_verified_driver_identity_guard';
    END IF;
    IF NEW.date_of_birth IS DISTINCT FROM OLD.date_of_birth THEN
        RAISE EXCEPTION 'A verified driver cannot change their date of birth directly.'
            USING ERRCODE = '42501', CONSTRAINT = 'trg_verified_driver_identity_guard';
    END IF;
    IF NEW.country_code IS DISTINCT FROM OLD.country_code THEN
        RAISE EXCEPTION 'A verified driver cannot change their country directly.'
            USING ERRCODE = '42501', CONSTRAINT = 'trg_verified_driver_identity_guard';
    END IF;

    RETURN NEW;
END;
$$;


--
-- Name: ensure_customer_wallet_v1h(uuid); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.ensure_customer_wallet_v1h(p_user_id uuid) RETURNS jsonb
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'pg_catalog', 'public'
    AS $_$
DECLARE p public.profiles%ROWTYPE; w public.wallets%ROWTYPE; market jsonb; n integer; v_country text; v_city text;
 v_currency text; was_created boolean:=false;
BEGIN
 IF NOT public.customer_wallet_setup_enabled_v1h() THEN
  RAISE EXCEPTION 'Customer wallet setup disabled' USING ERRCODE='WH004'; END IF;
 IF p_user_id IS NULL THEN RAISE EXCEPTION 'Customer identity required' USING ERRCODE='WH001'; END IF;
 SELECT * INTO p FROM public.profiles WHERE id=p_user_id FOR SHARE;
 IF NOT FOUND OR p.role IS DISTINCT FROM 'customer' OR p.tenant_id IS NULL
 OR p.registration_activated_at IS NULL OR p.registration_activated_at>now() THEN
  RAISE EXCEPTION 'Customer registration is not ready' USING ERRCODE='WH001'; END IF;
 v_country:=p.registration_country_code;
 v_city:=nullif(lower(regexp_replace(btrim(coalesce(p.registration_market_city,'')),'\s+',' ','g')),'');
 IF v_country IS NULL OR v_country !~ '^[A-Z]{2}$' THEN
  RAISE EXCEPTION 'Validated registration country required' USING ERRCODE='WH001'; END IF;
 -- Config writes are rare; this short shared lock freezes selection against concurrent currency edits.
 LOCK TABLE public.market_availability IN SHARE MODE;
 SELECT count(*) INTO n FROM public.market_availability m
 WHERE m.country_code=v_country AND to_jsonb(m)->>'enabled'='true'
 AND nullif(btrim(to_jsonb(m)->>'zone_id'),'') IS NULL
 AND nullif(lower(regexp_replace(btrim(coalesce(to_jsonb(m)->>'market_city','')),'\s+',' ','g')),'') IS NOT DISTINCT FROM v_city
 AND (nullif(to_jsonb(m)->>'valid_from','') IS NULL OR (to_jsonb(m)->>'valid_from')::timestamptz<=now())
 AND (nullif(to_jsonb(m)->>'valid_until','') IS NULL OR (to_jsonb(m)->>'valid_until')::timestamptz>now());
 IF n=0 THEN v_city:=NULL; END IF;
 SELECT count(*) INTO n FROM public.market_availability m
 WHERE m.country_code=v_country AND to_jsonb(m)->>'enabled'='true'
 AND nullif(btrim(to_jsonb(m)->>'zone_id'),'') IS NULL
 AND nullif(lower(regexp_replace(btrim(coalesce(to_jsonb(m)->>'market_city','')),'\s+',' ','g')),'') IS NOT DISTINCT FROM v_city
 AND (nullif(to_jsonb(m)->>'valid_from','') IS NULL OR (to_jsonb(m)->>'valid_from')::timestamptz<=now())
 AND (nullif(to_jsonb(m)->>'valid_until','') IS NULL OR (to_jsonb(m)->>'valid_until')::timestamptz>now());
 IF n<>1 THEN RAISE EXCEPTION 'Customer market unavailable or ambiguous' USING ERRCODE='WH002'; END IF;
 SELECT to_jsonb(m) INTO STRICT market FROM public.market_availability m
 WHERE m.country_code=v_country AND to_jsonb(m)->>'enabled'='true'
 AND nullif(btrim(to_jsonb(m)->>'zone_id'),'') IS NULL
 AND nullif(lower(regexp_replace(btrim(coalesce(to_jsonb(m)->>'market_city','')),'\s+',' ','g')),'') IS NOT DISTINCT FROM v_city
 AND (nullif(to_jsonb(m)->>'valid_from','') IS NULL OR (to_jsonb(m)->>'valid_from')::timestamptz<=now())
 AND (nullif(to_jsonb(m)->>'valid_until','') IS NULL OR (to_jsonb(m)->>'valid_until')::timestamptz>now());
 v_currency:=market->>'supported_currency';
 IF market->>'launch_status' IS DISTINCT FROM 'live' OR market->>'customer_app_enabled' IS DISTINCT FROM 'true'
 OR v_currency IS NULL OR v_currency !~ '^[A-Z]{3}$' THEN
  RAISE EXCEPTION 'Customer market unavailable' USING ERRCODE='WH002'; END IF;
 PERFORM pg_advisory_xact_lock(hashtextextended('customer-wallet-v1h:'||p_user_id::text,0));
 SELECT * INTO w FROM public.wallets WHERE user_id=p_user_id FOR UPDATE;
 IF NOT FOUND THEN
  INSERT INTO public.wallets(user_id,currency_code,available_balance,reserved_balance)
   VALUES(p_user_id,v_currency,0,0) ON CONFLICT(user_id) DO NOTHING RETURNING * INTO w;
  was_created:=FOUND;
  IF NOT was_created THEN SELECT * INTO STRICT w FROM public.wallets WHERE user_id=p_user_id FOR UPDATE; END IF;
 END IF;
 -- Even an old zero GBP wallet is preserved; one-user/one-wallet uniqueness is not bypassed.
 RETURN jsonb_build_object('status',CASE WHEN was_created THEN 'created' ELSE 'existing' END,
  'country',v_country,'currency',v_currency,'currencyMatchesMarket',w.currency_code=v_currency,
  'wallet',to_jsonb(w)||jsonb_build_object('available_balance',w.available_balance::text,'reserved_balance',w.reserved_balance::text));
END $_$;


--
-- Name: expire_gb_mot_online(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.expire_gb_mot_online() RETURNS void
    LANGUAGE sql SECURITY DEFINER
    SET search_path TO 'public'
    AS $$
 UPDATE profiles SET is_online=false,is_available=false WHERE (is_online OR is_available) AND gb_driver_mot_blocked(id);
$$;


--
-- Name: expire_unpaid_fare_agreement(uuid); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.expire_unpaid_fare_agreement(p_session_id uuid) RETURNS boolean
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'public'
    AS $$
DECLARE
  v_session public.marketplace_negotiation_sessions;
  v_job public.jobs;
  v_deadline TIMESTAMPTZ;
  v_lease INTEGER;
  v_payment TEXT;
BEGIN
  IF p_session_id IS NULL THEN
    RETURN FALSE;
  END IF;

  SELECT * INTO v_session
  FROM public.marketplace_negotiation_sessions
  WHERE id = p_session_id
  FOR UPDATE;

  IF NOT FOUND THEN
    RETURN FALSE;
  END IF;

  -- Only an unpaid, agreed negotiation can lapse here.
  IF v_session.status <> 'fare_agreed' THEN
    RETURN FALSE;
  END IF;

  v_deadline := COALESCE(v_session.payment_deadline, v_session.expires_at);
  IF v_deadline IS NULL OR v_deadline > now() THEN
    RETURN FALSE;
  END IF;

  SELECT * INTO v_job FROM public.jobs WHERE id = v_session.job_id;
  IF NOT FOUND THEN
    RETURN FALSE;
  END IF;

  -- NEVER release money already taken.
  v_payment := LOWER(COALESCE(v_job.payment_status, 'pending'));
  IF v_payment IN ('authorized', 'requires_capture', 'succeeded', 'captured', 'paid', 'wallet_funded') THEN
    RETURN FALSE;
  END IF;

  -- OVERALL marketplace deadline passed -> terminalise, do NOT recycle.
  IF v_job.expires_at IS NOT NULL AND v_job.expires_at <= now() THEN
    UPDATE public.marketplace_negotiation_sessions
    SET status = 'expired',
        active_driver_id = NULL,
        driver_counter_offer = NULL,
        agreed_fare = NULL,
        payment_deadline = NULL,
        updated_at = now()
    WHERE id = v_session.id;

    UPDATE public.jobs
    SET status = 'expired',
        agreed_fare = NULL,
        driver_id = NULL,
        updated_at = now()
    WHERE id = v_session.job_id
      AND status IN ('fare_agreed', 'pending_fare_confirmation', 'negotiating', 'open');

    INSERT INTO public.marketplace_negotiation_events (
      session_id, job_id, proposed_by, proposed_by_role,
      event_type, message, round_number, created_at
    ) VALUES (
      v_session.id, v_session.job_id, v_session.customer_id, 'customer',
      'session_expired', 'Payment window closed after the request deadline', v_session.round_count, now()
    );

    RETURN TRUE;
  END IF;

  -- Request still live -> invalidate the agreement and return the SAME request to
  -- the discoverable pool with the customer's proposal retained.
  v_lease := COALESCE(
    (public.get_marketplace_setting('hybrid_negotiation', v_job.tenant_id)->>'timeoutSeconds')::INTEGER,
    120
  );

  UPDATE public.marketplace_negotiation_sessions
  SET status = 'released',
      active_driver_id = NULL,
      driver_counter_offer = NULL,
      agreed_fare = NULL,
      payment_deadline = NULL,
      claimed_at = NULL,
      attempt_count = attempt_count + 1,
      expires_at = public.negotiation_lease_expiry(v_session.job_id, v_lease),
      updated_at = now()
  WHERE id = v_session.id
  RETURNING * INTO v_session;

  UPDATE public.jobs
  SET status = 'pending_fare_confirmation',
      agreed_fare = NULL,
      driver_id = NULL,
      updated_at = now()
  WHERE id = v_session.job_id
    AND status = 'fare_agreed';

  INSERT INTO public.marketplace_negotiation_events (
    session_id, job_id, proposed_by, proposed_by_role,
    event_type, message, round_number, created_at
  ) VALUES (
    v_session.id, v_session.job_id, v_session.customer_id, 'customer',
    'session_released', 'Payment window expired; agreement released', v_session.round_count, now()
  );

  -- Re-assert the retained customer proposal so the canonical turn is the
  -- customer's again for the next eligible driver.
  IF v_session.customer_offer IS NOT NULL AND v_session.customer_offer > 0 THEN
    INSERT INTO public.marketplace_negotiation_events (
      session_id, job_id, proposed_by, proposed_by_role,
      event_type, amount, round_number, created_at
    ) VALUES (
      v_session.id, v_session.job_id, v_session.customer_id, 'customer',
      'customer_offer', v_session.customer_offer, v_session.round_count, now()
    );
  END IF;

  RETURN TRUE;
END;
$$;


--
-- Name: fence_driver_payment_setup(uuid, uuid, text, text, text); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.fence_driver_payment_setup(p_id uuid, p_token uuid, p_bank text, p_last4 text, p_fingerprint text) RETURNS boolean
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'public', 'pg_temp'
    AS $_$
BEGIN
 IF p_bank !~ '^\d{3,6}$' OR p_last4 !~ '^\d{4}$' OR p_fingerprint !~ '^[a-f0-9]{64}$' THEN RETURN false;END IF;
 UPDATE public.driver_payment_accounts a SET submission_attempted_at=now(),bank_code=p_bank,last4=p_last4,fingerprint=p_fingerprint,updated_at=now()
 WHERE a.id=p_id AND a.setup_token=p_token AND a.state='in_progress' AND a.submission_attempted_at IS NULL
 AND EXISTS(SELECT 1 FROM public.driver_payout_markets m JOIN public.profiles p ON p.id=a.driver_id
 WHERE m.country_code=a.country_code AND m.currency_code=a.currency_code AND m.provider=a.provider AND m.provider IN('flutterwave','paystack')
 AND m.enabled AND m.merchant_approved AND m.adapter_ready AND m.merchant_mode='test'
 AND m.capability_verified_at IS NOT NULL AND m.capability_evidence_ref IS NOT NULL
 AND m.merchant_account_ref=a.merchant_account_ref AND m.sandbox_driver_id=a.driver_id AND m.sandbox_tenant_id=a.tenant_id
 AND a.driver_id='318e6be9-9164-41fa-bb0c-c5ccd3526585' AND a.tenant_id='d0e8e8e8-e8e8-e8e8-e8e8-d0e8e8e8e8e8'
 AND p.role='driver' AND p.tenant_id=a.tenant_id AND p.registration_activated_at IS NOT NULL
 AND coalesce(p.registration_country_code,p.country_code)='NG' AND a.country_code='NG' AND a.currency_code='NGN');
 RETURN FOUND;
END $_$;


--
-- Name: fetch_hybrid_opportunities(uuid); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.fetch_hybrid_opportunities(p_driver_id uuid) RETURNS TABLE(session_id uuid, job_id uuid, customer_id uuid, suggested_fare numeric, customer_offer numeric, distance_km numeric, eta_seconds integer, service_name text, service_slug text, pickup_address text, dropoff_address text)
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'public'
    AS $_$
BEGIN
  IF auth.uid() IS NOT NULL AND auth.uid() <> p_driver_id THEN
    RAISE EXCEPTION 'You can only fetch your own opportunities';
  END IF;

  -- 360: lapsed unpaid agreements release back to the market (or terminalise).
  PERFORM public.expire_unpaid_fare_agreement(s.id)
  FROM public.marketplace_negotiation_sessions s
  WHERE s.status = 'fare_agreed'
    AND COALESCE(s.payment_deadline, s.expires_at) IS NOT NULL
    AND COALESCE(s.payment_deadline, s.expires_at) <= now();

  -- 340: lapsed claimed leases release back to the market.
  PERFORM public.release_stale_negotiation_lease(s.id)
  FROM public.marketplace_negotiation_sessions s
  WHERE s.active_driver_id IS NOT NULL
    AND s.status IN ('open', 'driver_claimed', 'negotiating')
    AND s.expires_at IS NOT NULL
    AND s.expires_at <= now();

  RETURN QUERY
  SELECT
    s.id AS session_id,
    s.job_id,
    s.customer_id,
    s.suggested_fare,
    s.customer_offer,
    CASE
      WHEN BTRIM(j.metadata->>'distance_km') ~ '^[0-9]+(\.[0-9]+)?$'
      THEN (BTRIM(j.metadata->>'distance_km'))::NUMERIC
      ELSE NULL
    END AS distance_km,
    CASE
      WHEN BTRIM(j.metadata->>'duration_seconds') ~ '^[0-9]+(\.[0-9]+)?$'
      THEN LEAST(2147483647::NUMERIC, ROUND((BTRIM(j.metadata->>'duration_seconds'))::NUMERIC))::INTEGER
      ELSE NULL
    END AS eta_seconds,
    COALESCE(st.name, 'Request') AS service_name,
    COALESCE(st.slug, '') AS service_slug,
    j.pickup_address,
    j.dropoff_address
  FROM public.marketplace_negotiation_sessions s
  JOIN public.jobs j ON j.id = s.job_id
  LEFT JOIN public.service_types st ON st.id = j.service_type_id
  WHERE s.status IN ('open', 'released')
    AND s.active_driver_id IS NULL
    -- THE GUARD (370): the underlying job must still be genuinely negotiable.
    -- This is the SAME allowlist every negotiation action already enforces, so
    -- discovery can never surface a card the actions would reject.
    AND j.status IN ('pending_fare_confirmation', 'negotiating', 'open')
    AND public.driver_vehicle_can_accept_job(s.job_id, p_driver_id)
    AND s.expires_at > now()
    AND NOT EXISTS (
      SELECT 1 FROM public.driver_job_declines d
      WHERE d.driver_id = p_driver_id AND d.job_id = s.job_id
    );
END;
$_$;


--
-- Name: finalize_agreed_fare_aliases(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.finalize_agreed_fare_aliases() RETURNS trigger
    LANGUAGE plpgsql
    SET search_path TO 'public', 'pg_temp'
    AS $$
DECLARE b jsonb; charge numeric; payout numeric; fee numeric; commission numeric;
BEGIN
 b:=NEW.fare_breakdown;
 IF b->>'policyVersion' IS DISTINCT FROM 'fare-split-v1' THEN RETURN NEW; END IF;
 charge:=(b->>'customerCharge')::numeric; payout:=(b->>'driverEntitlement')::numeric;
 fee:=(b->>'platformFeeAmount')::numeric; commission:=(b->>'driverCommissionAmount')::numeric;
 IF charge IS NULL OR payout IS NULL OR fee IS NULL OR commission IS NULL
 OR charge::text IN ('NaN','Infinity','-Infinity') OR payout::text IN ('NaN','Infinity','-Infinity')
 OR fee::text IN ('NaN','Infinity','-Infinity') OR commission::text IN ('NaN','Infinity','-Infinity')
 OR charge<=0 OR payout<=0 OR fee<0 OR commission<0 OR charge<>payout+fee+commission
 OR (NEW.agreed_fare IS NOT NULL AND charge<>round(NEW.agreed_fare,2)) THEN
   RAISE EXCEPTION 'Agreed fare settlement snapshot requires reconciliation';
 END IF;
 NEW.fare_breakdown:=b||jsonb_build_object('customerServiceTotal',charge,'driverPayout',payout,
   'driverNetEarnings',payout,'commissionAmount',commission,'commissionFee',commission,
   'grossRevenue',fee+commission);
 RETURN NEW;
END $$;


--
-- Name: finalize_job_no_show(uuid, uuid, text, boolean); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.finalize_job_no_show(p_job_id uuid, p_driver_id uuid, p_reason text, p_contact_attempted boolean DEFAULT false) RETURNS public.jobs
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'public'
    AS $$
DECLARE
  v_job public.jobs;
BEGIN
  SELECT * INTO v_job FROM public.jobs WHERE id = p_job_id FOR UPDATE;
  IF NOT FOUND THEN RETURN NULL; END IF;
  IF v_job.driver_id IS DISTINCT FROM p_driver_id THEN RETURN NULL; END IF;
  IF v_job.status <> 'arrived' THEN RETURN NULL; END IF;                       -- still waiting at pickup
  IF v_job.no_show_grace_until IS NULL OR v_job.no_show_grace_until > now() THEN RETURN NULL; END IF; -- grace not elapsed
  IF v_job.fare_breakdown IS NULL OR v_job.fare_breakdown->>'noShowPolicyVersion' IS NULL THEN RETURN NULL; END IF; -- undisclosed

  UPDATE public.jobs SET
    status = 'cancelled',
    no_show_status = 'pending',
    no_show_reason = left(coalesce(p_reason, 'Customer no-show'), 500),
    no_show_contact_attempted_at = CASE WHEN p_contact_attempted THEN now() ELSE no_show_contact_attempted_at END,
    updated_at = now()
  WHERE id = p_job_id
  RETURNING * INTO v_job;

  RETURN v_job;
END;
$$;


--
-- Name: finalize_job_payment(uuid, text, text, text, numeric, boolean, timestamp with time zone, timestamp with time zone, integer, bigint, text); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.finalize_job_payment(p_job_id uuid, p_payment_intent_id text, p_payment_status text, p_job_status text, p_expected_service_fare numeric DEFAULT NULL::numeric, p_require_unowned boolean DEFAULT false, p_dispatch_started_at timestamp with time zone DEFAULT NULL::timestamp with time zone, p_driver_search_expires_at timestamp with time zone DEFAULT NULL::timestamp with time zone, p_dispatch_attempts integer DEFAULT 0, p_intent_amount_minor bigint DEFAULT NULL::bigint, p_currency text DEFAULT NULL::text) RETURNS text
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'public'
    AS $$
DECLARE
  v_job public.jobs;
  v_session public.marketplace_negotiation_sessions;
  v_status TEXT;
  v_deadline TIMESTAMPTZ;
  v_item_budget NUMERIC;
  v_expected_minor NUMERIC;
BEGIN
  IF p_job_id IS NULL THEN
    RETURN 'job_not_found';
  END IF;

  -- DETERMINISTIC LOCK ORDER: job, then session. Every authority in this
  -- migration takes them in this order, so no deadlock is possible.
  SELECT * INTO v_job FROM public.jobs WHERE id = p_job_id FOR UPDATE;
  IF NOT FOUND THEN
    RETURN 'job_not_found';
  END IF;

  -- IDEMPOTENCY FIRST. A repeat of an already-successful finalization must be
  -- reported as such (NOT as a lost agreement) — otherwise a legitimate retry or
  -- duplicate webhook would be misread as a conflict and would wrongly enter the
  -- Stripe compensation path for an already-paid booking. Terminal/expired/
  -- cancelled agreements still have payment_status='pending', so they fall
  -- through to the agreement checks below.
  IF LOWER(COALESCE(v_job.payment_status, '')) <> 'pending' THEN
    RETURN 'already_finalized';
  END IF;

  SELECT * INTO v_session
  FROM public.marketplace_negotiation_sessions
  WHERE job_id = p_job_id
  ORDER BY created_at DESC NULLS LAST
  LIMIT 1
  FOR UPDATE;

  IF FOUND THEN
    -- NEGOTIATED: the fare agreement must STILL be authoritative. This is the
    -- check the old finalizers were missing.
    IF v_session.status IS DISTINCT FROM 'fare_agreed' THEN
      RETURN 'agreement_lost';
    END IF;

    -- The JOB must still be the live negotiated agreement — not released back to
    -- the pool, superseded, cancelled or expired.
    IF LOWER(COALESCE(v_job.status, '')) <> 'fare_agreed' THEN
      RETURN 'agreement_lost';
    END IF;

    IF v_session.agreed_fare IS NULL OR v_session.agreed_fare <= 0 THEN
      RETURN 'agreement_lost';
    END IF;

    IF v_job.agreed_fare IS NULL THEN
      RETURN 'agreement_lost';
    END IF;

    -- AUTHORITATIVE DEADLINE. Effective deadline = persisted payment_deadline,
    -- falling back to expires_at for agreements accepted BEFORE 360 started
    -- writing payment_deadline (310 set expires_at = now() + 300s). It must
    -- EXIST and must NOT have elapsed.
    v_deadline := COALESCE(v_session.payment_deadline, v_session.expires_at);
    IF v_deadline IS NULL THEN
      RETURN 'agreement_lost';
    END IF;
    IF v_deadline <= now() THEN
      RETURN 'agreement_expired';
    END IF;

    IF p_expected_service_fare IS NOT NULL
       AND ROUND(p_expected_service_fare, 2) IS DISTINCT FROM ROUND(v_session.agreed_fare, 2) THEN
      RETURN 'agreed_fare_mismatch';
    END IF;

    IF v_job.driver_id IS DISTINCT FROM v_session.active_driver_id THEN
      RETURN 'driver_mismatch';
    END IF;

    -- AUTHORITATIVE AMOUNT. For a negotiated job the customer charge is exactly
    -- agreed_fare + item budget. The item budget is READ from its persisted home
    -- (public.errand_funding is a TABLE, not a job column) using the same
    -- precedence the client uses; NO pricing/fee formula is duplicated here — this
    -- only proves the intent amount against the persisted authority, which is what
    -- stops a stale £9.06 quote from finalising a £9.00 agreement.
    IF p_intent_amount_minor IS NOT NULL THEN
      SELECT COALESCE(NULLIF(ef.amount_reserved, 0), NULLIF(ef.item_budget, 0), 0)
        INTO v_item_budget
        FROM public.errand_funding ef
       WHERE ef.job_id = p_job_id
       LIMIT 1;

      v_item_budget := COALESCE(v_item_budget, 0);
      v_expected_minor := ROUND((v_session.agreed_fare + v_item_budget) * 100);
      IF v_expected_minor IS DISTINCT FROM p_intent_amount_minor THEN
        RETURN 'amount_mismatch';
      END IF;
    END IF;
  ELSE
    -- NON-NEGOTIATED: preserve the pre-existing semantics exactly. The webhook
    -- only advances an UNPAID, UNOWNED job; /confirm may advance a locked-driver
    -- (assigned) job.
    IF p_require_unowned AND v_job.driver_id IS NOT NULL THEN
      RETURN 'driver_mismatch';
    END IF;
  END IF;

  -- CURRENCY: the money must be in the job's own currency.
  IF p_currency IS NOT NULL
     AND LOWER(p_currency) IS DISTINCT FROM LOWER(COALESCE(v_job.currency_code, 'gbp')) THEN
    RETURN 'currency_mismatch';
  END IF;

  v_status := LOWER(COALESCE(v_job.status, ''));
  IF v_status IN ('cancelled', 'canceled', 'expired', 'completed', 'settled') THEN
    RETURN 'job_terminal';
  END IF;

  IF p_payment_intent_id IS NOT NULL
     AND v_job.payment_intent_id IS NOT NULL
     AND v_job.payment_intent_id IS DISTINCT FROM p_payment_intent_id THEN
    RETURN 'intent_mismatch';
  END IF;

  UPDATE public.jobs
  SET payment_status = p_payment_status,
      status = p_job_status,
      dispatch_started_at = p_dispatch_started_at,
      driver_search_expires_at = p_driver_search_expires_at,
      dispatch_attempts = COALESCE(p_dispatch_attempts, 0),
      no_driver_reason = NULL,
      updated_at = now()
  WHERE id = p_job_id;

  RETURN 'finalized';
END;
$$;


--
-- Name: finalize_wallet_topup(numeric, text, text, uuid); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.finalize_wallet_topup(p_amount numeric, p_description text, p_payment_intent_id text, p_user_id uuid) RETURNS jsonb
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'public', 'pg_temp'
    AS $$
declare
  v_wallet_id uuid;
  v_tx_id uuid;
  v_balance_before_available numeric(12,2);
  v_balance_after_available numeric(12,2);
begin
  -- Find wallet
  select id, available_balance
  into v_wallet_id, v_balance_before_available
  from public.wallets
  where user_id = p_user_id
  limit 1;

  -- Create wallet if missing
  if v_wallet_id is null then
    insert into public.wallets (
      user_id,
      available_balance,
      reserved_balance,
      currency_code
    )
    values (
      p_user_id,
      0.00,
      0.00,
      'GBP'
    )
    returning id, available_balance
    into v_wallet_id, v_balance_before_available;
  end if;

  -- Prevent duplicate processing
  if exists (
    select 1
    from public.wallet_transactions
    where payment_intent_id = p_payment_intent_id
       or stripe_payment_intent_id = p_payment_intent_id
  ) then
    return jsonb_build_object(
      'success', true,
      'message', 'Top-up already finalized',
      'walletId', v_wallet_id,
      'paymentIntentId', p_payment_intent_id
    );
  end if;

  -- Update wallet balance
  v_balance_after_available := coalesce(v_balance_before_available, 0.00) + p_amount;

  update public.wallets
  set
    available_balance = v_balance_after_available,
    updated_at = now()
  where id = v_wallet_id;

  -- Record wallet transaction
  insert into public.wallet_transactions (
    wallet_id,
    user_id,
    transaction_type,
    amount,
    balance_before_available,
    balance_after_available,
    balance_before_reserved,
    balance_after_reserved,
    metadata,
    created_at,
    stripe_payment_intent_id,
    payment_intent_id,
    description
  )
  values (
    v_wallet_id,
    p_user_id,
    'topup',
    p_amount,
    v_balance_before_available,
    v_balance_after_available,
    0.00,
    0.00,
    jsonb_build_object(
      'source', 'stripe',
      'kind', 'wallet_topup'
    ),
    now(),
    p_payment_intent_id,
    p_payment_intent_id,
    coalesce(p_description, 'Wallet top-up')
  )
  returning id into v_tx_id;

  return jsonb_build_object(
    'success', true,
    'walletId', v_wallet_id,
    'transactionId', v_tx_id,
    'paymentIntentId', p_payment_intent_id,
    'amount', p_amount,
    'balanceBefore', v_balance_before_available,
    'balanceAfter', v_balance_after_available
  );
end;
$$;


--
-- Name: finalize_wallet_topup_legacy_incompatible(uuid, numeric, text, text); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.finalize_wallet_topup_legacy_incompatible(p_user_id uuid, p_amount numeric, p_payment_intent_id text, p_description text DEFAULT 'Wallet top-up'::text) RETURNS boolean
    LANGUAGE plpgsql
    AS $_$
DECLARE
  already_exists BOOLEAN;
  v_wallet_id UUID;
  v_tx_type_col TEXT;
  v_has_wallet_id BOOLEAN;
  v_has_stripe_payment_intent_id BOOLEAN;
  v_amount NUMERIC := ROUND(COALESCE(p_amount, 0)::NUMERIC, 2);
BEGIN
  IF v_amount <= 0 THEN
    RAISE EXCEPTION 'Wallet top-up amount must be greater than zero';
  END IF;

  SELECT CASE
    WHEN EXISTS (
      SELECT 1 FROM information_schema.columns
      WHERE table_schema = 'public'
        AND table_name = 'wallet_transactions'
        AND column_name = 'transaction_type'
    ) THEN 'transaction_type'
    ELSE 'type'
  END INTO v_tx_type_col;

  SELECT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public'
      AND table_name = 'wallet_transactions'
      AND column_name = 'wallet_id'
  ) INTO v_has_wallet_id;

  SELECT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public'
      AND table_name = 'wallet_transactions'
      AND column_name = 'stripe_payment_intent_id'
  ) INTO v_has_stripe_payment_intent_id;

  IF v_has_stripe_payment_intent_id THEN
    EXECUTE
      'SELECT EXISTS (
         SELECT 1
         FROM wallet_transactions
         WHERE payment_intent_id = $1 OR stripe_payment_intent_id = $1
       )'
    INTO already_exists
    USING p_payment_intent_id;
  ELSE
    SELECT EXISTS (
      SELECT 1 FROM wallet_transactions WHERE payment_intent_id = p_payment_intent_id
    ) INTO already_exists;
  END IF;

  IF already_exists THEN
    RETURN FALSE;
  END IF;

  INSERT INTO wallets (user_id, balance, available_balance)
  VALUES (p_user_id, v_amount, v_amount)
  ON CONFLICT (user_id) DO UPDATE
  SET balance = COALESCE(wallets.balance, 0) + v_amount,
      available_balance = COALESCE(wallets.available_balance, 0) + v_amount,
      updated_at = NOW();

  SELECT id
  INTO v_wallet_id
  FROM wallets
  WHERE user_id = p_user_id;

  IF v_has_wallet_id AND v_has_stripe_payment_intent_id THEN
    EXECUTE format(
      'INSERT INTO wallet_transactions (wallet_id, user_id, amount, %I, payment_intent_id, stripe_payment_intent_id, description)
       VALUES ($1, $2, $3, $4, $5, $6, $7)',
      v_tx_type_col
    )
    USING v_wallet_id, p_user_id, v_amount, 'topup', p_payment_intent_id, p_payment_intent_id, p_description;
  ELSIF v_has_wallet_id THEN
    EXECUTE format(
      'INSERT INTO wallet_transactions (wallet_id, user_id, amount, %I, payment_intent_id, description)
       VALUES ($1, $2, $3, $4, $5, $6)',
      v_tx_type_col
    )
    USING v_wallet_id, p_user_id, v_amount, 'topup', p_payment_intent_id, p_description;
  ELSIF v_has_stripe_payment_intent_id THEN
    EXECUTE format(
      'INSERT INTO wallet_transactions (user_id, amount, %I, payment_intent_id, stripe_payment_intent_id, description)
       VALUES ($1, $2, $3, $4, $5, $6)',
      v_tx_type_col
    )
    USING p_user_id, v_amount, 'topup', p_payment_intent_id, p_payment_intent_id, p_description;
  ELSE
    EXECUTE format(
      'INSERT INTO wallet_transactions (user_id, amount, %I, payment_intent_id, description)
       VALUES ($1, $2, $3, $4, $5)',
      v_tx_type_col
    )
    USING p_user_id, v_amount, 'topup', p_payment_intent_id, p_description;
  END IF;

  RETURN TRUE;
END;
$_$;


--
-- Name: finish_admin_message_email(bigint, uuid, boolean, text); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.finish_admin_message_email(p_entry bigint, p_token uuid, p_sent boolean, p_error text DEFAULT NULL::text) RETURNS boolean
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'public'
    AS $$
BEGIN
 UPDATE public.admin_message_email_outbox SET status=CASE WHEN p_sent THEN 'sent' ELSE 'pending' END,
 sent_at=CASE WHEN p_sent THEN now() ELSE sent_at END,lease_token=NULL,lease_until=NULL,
 retry_at=now()+make_interval(secs=>LEAST(3600,60*power(2,LEAST(attempts,6))::integer)),last_error=CASE WHEN p_sent THEN NULL ELSE left(p_error,100) END
 WHERE entry_id=p_entry AND lease_token=p_token AND status='pending'; RETURN FOUND;
END; $$;


--
-- Name: finish_kora_sandbox_booking_checkout(uuid, uuid, text, text, text); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.finish_kora_sandbox_booking_checkout(p_job uuid, p_user uuid, p_account text, p_state text, p_url text) RETURNS jsonb
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'public', 'pg_temp'
    AS $$
DECLARE b public.kora_sandbox_booking_payments;
BEGIN
 SELECT * INTO b FROM public.kora_sandbox_booking_payments WHERE job_id=p_job FOR UPDATE;
 IF NOT FOUND OR b.user_id IS DISTINCT FROM p_user OR b.merchant_account_ref IS DISTINCT FROM p_account
 OR p_state NOT IN ('submitted','unknown') OR p_state IS NULL THEN RAISE EXCEPTION 'Original checkout binding required'; END IF;
 IF b.state IN ('started','submitted','unknown') AND b.refund_state='none' THEN
   IF p_state='submitted' AND (p_url IS NULL OR p_url !~ '^https://(test-checkout[.]korapay[.]com|checkout[.]korapay[.]com)/') THEN
     RAISE EXCEPTION 'Trusted checkout URL required';
   END IF;
   UPDATE public.kora_sandbox_booking_payments SET state=p_state,checkout_url=p_url WHERE job_id=p_job RETURNING * INTO b;
 END IF;
 RETURN to_jsonb(b);
END $$;


--
-- Name: finish_kora_sandbox_booking_refund(uuid, uuid, text, text); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.finish_kora_sandbox_booking_refund(p_job uuid, p_user uuid, p_account text, p_state text) RETURNS jsonb
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'public', 'pg_temp'
    AS $$
DECLARE b public.kora_sandbox_booking_payments;
BEGIN
 SELECT * INTO b FROM public.kora_sandbox_booking_payments WHERE job_id=p_job FOR UPDATE;
 IF NOT FOUND OR b.user_id IS DISTINCT FROM p_user OR b.merchant_account_ref IS DISTINCT FROM p_account
 OR b.refund_reference IS NULL OR p_state IS NULL OR p_state NOT IN ('processing','unknown','success','failed') THEN
   RAISE EXCEPTION 'Original refund binding required'; END IF;
 IF b.refund_state IN ('success','failed') THEN RETURN to_jsonb(b); END IF;
 UPDATE public.kora_sandbox_booking_payments SET refund_state=p_state,
 state=CASE WHEN p_state='success' THEN 'refunded' ELSE 'requires_refund' END WHERE job_id=p_job RETURNING * INTO b;
 RETURN to_jsonb(b);
END $$;


--
-- Name: finish_queued_job_payout(uuid, uuid, text); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.finish_queued_job_payout(p_job_id uuid, p_token uuid, p_transfer_id text) RETURNS boolean
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'public', 'pg_temp'
    AS $$
DECLARE q public.job_payout_queue%ROWTYPE; j public.jobs%ROWTYPE;
BEGIN
 SELECT * INTO STRICT j FROM public.jobs WHERE id=p_job_id FOR UPDATE;
 SELECT * INTO STRICT q FROM public.job_payout_queue WHERE job_id=p_job_id FOR UPDATE;
 IF q.status='paid' THEN RETURN q.transfer_id=p_transfer_id; END IF;
 IF q.token IS DISTINCT FROM p_token OR q.status NOT IN ('processing','reconcile') THEN RETURN false; END IF;
 IF p_transfer_id IS NULL OR p_transfer_id NOT LIKE 'tr_%' THEN RAISE EXCEPTION 'Genuine transfer ID required'; END IF;
 PERFORM public.record_job_settlement(p_job_id,q.driver_id,(q.terms->>'total')::numeric,(q.terms->>'payout')::numeric,
   (q.terms->>'platformFee')::numeric,(q.terms->>'commission')::numeric,(q.terms->>'commissionRate')::numeric,
   p_transfer_id,upper(q.currency),q.terms->>'country',true);
 UPDATE public.jobs SET metadata=coalesce(metadata,'{}'::jsonb)||jsonb_build_object('driver_payout_pending',false) WHERE id=p_job_id;
 UPDATE public.job_payout_queue SET status='paid',transfer_id=p_transfer_id,lease_until=NULL,last_error=NULL,updated_at=now() WHERE job_id=p_job_id;
 RETURN true;
END $$;


--
-- Name: freeze_driver_payment_submission(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.freeze_driver_payment_submission() RETURNS trigger
    LANGUAGE plpgsql
    SET search_path TO 'public', 'pg_temp'
    AS $$
BEGIN
 IF OLD.submission_attempted_at IS NOT NULL AND
 (NEW.submission_attempted_at,NEW.setup_token,NEW.bank_code,NEW.last4,NEW.fingerprint) IS DISTINCT FROM
 (OLD.submission_attempted_at,OLD.setup_token,OLD.bank_code,OLD.last4,OLD.fingerprint) THEN
  RAISE EXCEPTION 'Submitted setup terms are immutable; reconciliation only';
 END IF;
 IF OLD.beneficiary_id IS NOT NULL AND NEW.beneficiary_id IS DISTINCT FROM OLD.beneficiary_id THEN
  RAISE EXCEPTION 'Candidate identity is immutable';
 END IF;
 RETURN NEW;
END $$;


--
-- Name: freeze_subscription_driver_commission(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.freeze_subscription_driver_commission() RETURNS trigger
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'public', 'pg_temp'
    AS $$
DECLARE b jsonb; policy jsonb; subscribed boolean; standard_amount numeric; standard_rate numeric;
 base numeric; fee numeric; charge numeric; commission numeric; entitlement numeric;
BEGIN
 IF NEW.driver_id IS NULL THEN RETURN NEW; END IF;
 IF TG_OP='UPDATE' AND NEW.driver_id IS NOT DISTINCT FROM OLD.driver_id THEN RETURN NEW; END IF;
 b:=NEW.fare_breakdown;
 policy:=b->'driverCommissionPolicy';
 IF policy->>'version' IS DISTINCT FROM 'subscription-commission-v1' THEN RETURN NEW; END IF;
 IF b->>'policyVersion' IS DISTINCT FROM 'fare-split-v1' THEN RAISE EXCEPTION 'Frozen fare split requires reconciliation'; END IF;
 charge:=(b->>'customerCharge')::numeric;
 fee:=(b->>'platformFeeAmount')::numeric;
 base:=(b->>'driverBase')::numeric;
 standard_amount:=(policy->>'standardCommissionAmount')::numeric;
 standard_rate:=(policy->>'standardCommissionPercent')::numeric;
 IF charge IS NULL OR fee IS NULL OR base IS NULL OR standard_amount IS NULL OR standard_rate IS NULL
 OR charge::text IN ('NaN','Infinity','-Infinity') OR fee::text IN ('NaN','Infinity','-Infinity')
 OR base::text IN ('NaN','Infinity','-Infinity') OR standard_amount::text IN ('NaN','Infinity','-Infinity')
 OR standard_rate::text IN ('NaN','Infinity','-Infinity') OR charge<=0 OR fee<0 OR base<=0
 OR standard_amount<0 OR standard_amount>=base OR standard_rate<0 OR standard_rate>=100
 OR abs(charge-fee-base)>0.000001 THEN RAISE EXCEPTION 'Invalid frozen commission terms'; END IF;
 -- Backend subscription records, never a client-supplied pricing_plan label.
 SELECT EXISTS(SELECT 1 FROM subscriptions s JOIN profiles p ON p.id=NEW.driver_id
 WHERE s.user_id=p.id AND s.tenant_id IS NOT DISTINCT FROM p.tenant_id
 AND s.status='active' AND s.stripe_subscription_id IS NOT NULL
 AND (s.current_period_end IS NULL OR s.current_period_end>now())) INTO subscribed;
 commission:=CASE WHEN subscribed THEN 0 ELSE standard_amount END;
 entitlement:=base-commission;
 b:=b||jsonb_build_object('driverCommissionAmount',commission,'commissionFee',commission,
  'commissionAmount',commission,'commissionPercent',CASE WHEN subscribed THEN 0 ELSE standard_rate END,
  'driverEntitlement',entitlement,'driverNetEarnings',entitlement,'grossRevenue',fee+commission,'isPro',subscribed,
  'driverCommissionPolicy',policy||jsonb_build_object('frozen',true,'driverId',NEW.driver_id,
    'subscriptionActive',subscribed,'frozenAt',now()));
 NEW.fare_breakdown:=b;
 NEW.driver_payout:=entitlement;
 NEW.commission_fee:=commission;
 NEW.commission_rate_used:=CASE WHEN subscribed THEN 0 ELSE standard_rate END;
 NEW.pricing_plan_used:=CASE WHEN subscribed THEN 'pro' ELSE 'starter' END;
 RETURN NEW;
END;$$;


--
-- Name: gb_driver_mot_blocked(uuid); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.gb_driver_mot_blocked(p_driver uuid) RETURNS boolean
    LANGUAGE sql STABLE SECURITY DEFINER
    SET search_path TO 'public'
    AS $$
 SELECT EXISTS(SELECT 1 FROM profiles p JOIN vehicles v ON v.user_id=p.id JOIN driver_vehicle_mot_checks m ON m.vehicle_id=v.id
 WHERE p.id=p_driver AND upper(p.country_code)='GB' AND lower(v.type) NOT IN ('motorcycle','bicycle','bike')
 AND m.registration=upper(regexp_replace(v.license_plate,'\s','','g'))
 AND (m.status IN ('expired','dangerous_failure','unknown') OR m.expires_on < (now() AT TIME ZONE 'Europe/London')::date));
$$;


--
-- Name: get_customer_wallet_sandbox_v1l(uuid, uuid); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.get_customer_wallet_sandbox_v1l(p_owner uuid, p_id uuid) RETURNS jsonb
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'pg_catalog', 'public'
    AS $$ BEGIN
 IF NOT EXISTS(SELECT 1 FROM public.customer_wallet_sandbox_attempts_v1l WHERE id=p_id AND owner_id=p_owner) THEN RAISE EXCEPTION 'Sandbox attempt unavailable' USING ERRCODE='BL001';END IF;
 RETURN public.sandbox_attempt_json_v1l(p_id);
END $$;


--
-- Name: get_least_recently_assigned_driver(uuid, uuid); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.get_least_recently_assigned_driver(p_city_id uuid, p_tenant_id uuid) RETURNS uuid
    LANGUAGE plpgsql SECURITY DEFINER
    AS $$
DECLARE
    v_driver_id UUID;
BEGIN
    SELECT p.id INTO v_driver_id
    FROM profiles p
    JOIN tenant_users tu ON tu.user_id = p.id
    WHERE tu.tenant_id = p_tenant_id 
      AND tu.role = 'driver'
      AND p.is_online = true 
      AND p.is_available = true
      AND EXISTS (
          SELECT 1 FROM driver_locations dl 
          WHERE dl.driver_id = p.id AND dl.city_id = p_city_id
      )
    ORDER BY p.last_active_at ASC
    LIMIT 1;
    
    RETURN v_driver_id;
END;
$$;


--
-- Name: get_marketplace_commission(text, text, text, uuid); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.get_marketplace_commission(p_service_type_slug text, p_city_zone text, p_driver_tier text, p_tenant_id uuid DEFAULT NULL::uuid) RETURNS numeric
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'public'
    AS $$
DECLARE
  base_commission NUMERIC(8,4);
  override_commission NUMERIC(8,4);
BEGIN
  SELECT COALESCE((value->>'percent')::NUMERIC, 10.00)
  INTO base_commission
  FROM public.marketplace_settings
  WHERE (tenant_id IS NULL OR tenant_id = p_tenant_id)
    AND key = 'commission'
  ORDER BY tenant_id NULLS LAST
  LIMIT 1;

  SELECT commission_percent
  INTO override_commission
  FROM public.marketplace_commission_overrides
  WHERE is_active = true
    AND (tenant_id IS NULL OR tenant_id = p_tenant_id)
    AND (service_type_slug IS NULL OR service_type_slug = p_service_type_slug)
    AND (city_zone IS NULL OR city_zone = p_city_zone)
    AND (driver_tier IS NULL OR driver_tier = p_driver_tier)
    AND (starts_at IS NULL OR starts_at <= now())
    AND (ends_at IS NULL OR ends_at >= now())
  ORDER BY
    (CASE WHEN service_type_slug IS NOT NULL THEN 1 ELSE 0 END) +
    (CASE WHEN city_zone IS NOT NULL THEN 1 ELSE 0 END) +
    (CASE WHEN driver_tier IS NOT NULL THEN 1 ELSE 0 END) DESC
  LIMIT 1;

  RETURN COALESCE(override_commission, base_commission, 10.00);
END;
$$;


--
-- Name: get_marketplace_setting(text, uuid); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.get_marketplace_setting(p_key text, p_tenant_id uuid DEFAULT NULL::uuid) RETURNS jsonb
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'public'
    AS $$
DECLARE
  result JSONB;
BEGIN
  SELECT value
  INTO result
  FROM public.marketplace_settings
  WHERE key = p_key
    AND (tenant_id IS NULL OR tenant_id = p_tenant_id)
  ORDER BY tenant_id NULLS LAST
  LIMIT 1;

  RETURN COALESCE(result, '{}'::jsonb);
END;
$$;


--
-- Name: get_my_tenant_id(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.get_my_tenant_id() RETURNS uuid
    LANGUAGE sql STABLE SECURITY DEFINER
    AS $$
  SELECT tenant_id FROM tenant_users WHERE user_id = auth.uid() LIMIT 1;
$$;


--
-- Name: guard_booking_payment_margin(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.guard_booking_payment_margin() RETURNS trigger
    LANGUAGE plpgsql
    SET search_path TO 'public', 'pg_temp'
    AS $$
DECLARE policy jsonb; charge numeric; driver_amount numeric; budget numeric; cost numeric; contribution numeric; original numeric; fee numeric; rate numeric;
BEGIN
 policy:=OLD.fare_breakdown->'paymentMargin'->'policy';
 IF policy IS NULL THEN RETURN NEW; END IF; -- Existing agreed bookings retain their original terms.
 IF NEW.agreed_fare IS DISTINCT FROM OLD.agreed_fare AND NEW.agreed_fare IS NOT NULL THEN
   original:=coalesce(OLD.total_price,OLD.price);
   IF original IS NULL OR original<=0 OR NEW.agreed_fare<=0 THEN RAISE EXCEPTION 'Invalid agreed fare'; END IF;
   charge:=NEW.agreed_fare;
   fee:=round(coalesce((OLD.fare_breakdown->>'platformFeeAmount')::numeric,OLD.platform_fee,0)*charge/original,2);
   rate:=coalesce(OLD.commission_rate_used,(OLD.fare_breakdown->>'commissionPercent')::numeric,0);
   driver_amount:=CASE WHEN OLD.fare_breakdown->'driverCommissionPolicy'->>'version'='subscription-commission-v1' THEN round(charge-fee,2) ELSE round(charge-fee-round((charge-fee)*rate/100,2),2) END;
 ELSIF NEW.fare_breakdown IS DISTINCT FROM OLD.fare_breakdown THEN
   IF NEW.fare_breakdown->'paymentMargin'->'policy' IS DISTINCT FROM policy THEN RAISE EXCEPTION 'Frozen payment cost policy cannot change'; END IF;
   charge:=(NEW.fare_breakdown->>'customerCharge')::numeric;
   driver_amount:=CASE WHEN NEW.fare_breakdown->'driverCommissionPolicy'->>'version'='subscription-commission-v1' THEN (NEW.fare_breakdown->>'driverBase')::numeric ELSE (NEW.fare_breakdown->>'driverEntitlement')::numeric END;
 ELSE RETURN NEW;
 END IF;
 budget:=coalesce((NEW.fare_breakdown->>'shoppingBudget')::numeric,0);
 IF charge IS NULL OR driver_amount IS NULL OR charge::text='NaN' OR driver_amount::text='NaN' OR driver_amount<0 OR budget<0 THEN RAISE EXCEPTION 'Invalid protected fare'; END IF;
 cost:=ceil(((charge+budget)*(policy->>'paymentPercent')::numeric/100+(policy->>'paymentFixed')::numeric)*100)/100;
 contribution:=round(charge-driver_amount-cost-(policy->>'operatingAllowance')::numeric,2);
 IF contribution IS NULL OR contribution<(policy->>'minimumContribution')::numeric THEN RAISE EXCEPTION 'Agreed fare is below the protected booking minimum'; END IF;
 RETURN NEW;
END $$;


--
-- Name: guard_cash_credit_hold_v1e(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.guard_cash_credit_hold_v1e() RETURNS trigger
    LANGUAGE plpgsql
    SET search_path TO 'pg_catalog', 'public'
    AS $$
BEGIN
 IF TG_OP='DELETE' THEN RAISE EXCEPTION 'Cash credit history cannot be deleted' USING ERRCODE='CE005'; END IF;
 IF (to_jsonb(NEW)-ARRAY['status','resolution_event_id','resolved_at']) IS DISTINCT FROM (to_jsonb(OLD)-ARRAY['status','resolution_event_id','resolved_at'])
 OR OLD.status<>'held' OR NEW.status NOT IN ('released','settled') THEN
  RAISE EXCEPTION 'Cash credit terms/history are frozen' USING ERRCODE='CE005'; END IF;
 RETURN NEW;
END $$;


--
-- Name: guard_customer_wallet_market_v1h(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.guard_customer_wallet_market_v1h() RETURNS trigger
    LANGUAGE plpgsql
    SET search_path TO 'pg_catalog', 'public'
    AS $$
DECLARE actor text:=current_setting('role',true); who uuid;
BEGIN
 IF actor IN ('service_role','postgres','supabase_admin','supabase_auth_admin') OR (coalesce(actor,'none')='none' AND session_user IN ('postgres','supabase_admin','supabase_auth_admin')) THEN
  IF TG_OP='TRUNCATE' THEN RETURN NULL; ELSIF TG_OP='DELETE' THEN RETURN OLD; ELSE RETURN NEW; END IF;
 END IF;
 IF actor IS DISTINCT FROM 'authenticated' OR TG_OP IN ('INSERT','DELETE','TRUNCATE') THEN
  RAISE EXCEPTION 'Profile lifecycle is server-managed' USING ERRCODE='WH005'; END IF;
 who:=auth.uid();
 IF who IS NULL OR OLD.id IS DISTINCT FROM who OR NEW.id IS DISTINCT FROM OLD.id
 OR NEW.tenant_id IS DISTINCT FROM OLD.tenant_id
 OR NEW.registration_country_code IS DISTINCT FROM OLD.registration_country_code
 OR NEW.registration_market_city IS DISTINCT FROM OLD.registration_market_city
 OR NEW.registration_activated_at IS DISTINCT FROM OLD.registration_activated_at THEN
  RAISE EXCEPTION 'Registered wallet market is server-managed' USING ERRCODE='WH005'; END IF;
 IF NEW.role IS DISTINCT FROM OLD.role AND NOT coalesce((
   coalesce(OLD.role,'customer')='customer' AND NEW.role IN ('customer','driver')),false) THEN
  RAISE EXCEPTION 'Profile role change requires server review' USING ERRCODE='WH005'; END IF;
 RETURN NEW;
END $$;


--
-- Name: guard_driver_payment_account_identity(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.guard_driver_payment_account_identity() RETURNS trigger
    LANGUAGE plpgsql
    SET search_path TO 'public', 'pg_temp'
    AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'Retain payment account history';
  END IF;
  IF (NEW.id, NEW.driver_id, NEW.tenant_id, NEW.country_code, NEW.currency_code, NEW.provider, NEW.merchant_account_ref)
     IS DISTINCT FROM
     (OLD.id, OLD.driver_id, OLD.tenant_id, OLD.country_code, OLD.currency_code, OLD.provider, OLD.merchant_account_ref)
     OR (OLD.state = 'completed' AND (NEW.beneficiary_id, NEW.bank_code, NEW.last4, NEW.fingerprint, NEW.state)
         IS DISTINCT FROM (OLD.beneficiary_id, OLD.bank_code, OLD.last4, OLD.fingerprint, OLD.state))
  THEN
    RAISE EXCEPTION 'Frozen payment account identity cannot change';
  END IF;
  RETURN NEW;
END $$;


--
-- Name: guard_errand_budget_payment_margin(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.guard_errand_budget_payment_margin() RETURNS trigger
    LANGUAGE plpgsql
    SET search_path TO 'public', 'pg_temp'
    AS $$
DECLARE j public.jobs%ROWTYPE; policy jsonb; charge numeric; driver_amount numeric; budget numeric; cost numeric;
BEGIN
 SELECT * INTO STRICT j FROM public.jobs WHERE id=NEW.job_id;
 policy:=j.fare_breakdown->'paymentMargin'->'policy';
 IF policy IS NULL THEN RETURN NEW; END IF;
 charge:=(j.fare_breakdown->>'customerCharge')::numeric;
 driver_amount:=(j.fare_breakdown->>'driverEntitlement')::numeric;
 budget:=greatest(coalesce(NEW.item_budget,0),coalesce(NEW.amount_reserved,0)-charge);
 cost:=ceil(((charge+budget)*(policy->>'paymentPercent')::numeric/100+(policy->>'paymentFixed')::numeric)*100)/100;
 IF charge IS NULL OR driver_amount IS NULL OR round(charge-driver_amount-cost-(policy->>'operatingAllowance')::numeric,2)<(policy->>'minimumContribution')::numeric THEN
   RAISE EXCEPTION 'Additional shopping funding needs a new protected quote; agreed fare cannot change silently';
 END IF;
 RETURN NEW;
END $$;


--
-- Name: guard_market_payment_route_v23(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.guard_market_payment_route_v23() RETURNS trigger
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'pg_catalog', 'public'
    AS $$
BEGIN
 IF TG_OP='DELETE' THEN RAISE EXCEPTION 'Payment route history must be retained; retire a route instead'; END IF;
 IF TG_OP='INSERT' AND NOT EXISTS(SELECT 1 FROM public.market_availability m WHERE m.country_code=NEW.country_code AND m.supported_currency=NEW.currency_code)
  AND NOT EXISTS(SELECT 1 FROM public.configured_payment_countries_v23() c WHERE c.country_code=NEW.country_code AND c.currency_code=NEW.currency_code) THEN
  RAISE EXCEPTION 'Payment route must reference a saved country/currency or existing service market';
 END IF;
 IF TG_OP='UPDATE' THEN
  IF NEW.id IS DISTINCT FROM OLD.id OR NEW.country_code IS DISTINCT FROM OLD.country_code OR NEW.currency_code IS DISTINCT FROM OLD.currency_code
   OR NEW.method IS DISTINCT FROM OLD.method OR NEW.provider IS DISTINCT FROM OLD.provider
   OR (OLD.merchant_account_ref IS NOT NULL AND NEW.merchant_account_ref IS DISTINCT FROM OLD.merchant_account_ref)
  THEN RAISE EXCEPTION 'Route identity cannot change; retain the original route and add a new one'; END IF;
 END IF;
 NEW.updated_at:=clock_timestamp();RETURN NEW;
END
$$;


--
-- Name: guard_refund_pending_payout(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.guard_refund_pending_payout() RETURNS trigger
    LANGUAGE plpgsql
    SET search_path TO 'public', 'pg_temp'
    AS $$
BEGIN
 PERFORM 1 FROM public.jobs WHERE id=NEW.job_id FOR UPDATE;
 IF EXISTS(SELECT 1 FROM public.job_payout_queue WHERE job_id=NEW.job_id AND status<>'paid') THEN
   RAISE EXCEPTION 'Pending driver payout requires reconciliation before refund';
 END IF;
 RETURN NEW;
END $$;


--
-- Name: handle_new_user(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.handle_new_user() RETURNS trigger
    LANGUAGE plpgsql SECURITY DEFINER
    AS $$
DECLARE
  v_tenant_id UUID;
  v_full_name TEXT;
  v_registration_country TEXT;
  v_registration_city TEXT;
BEGIN
  SELECT id INTO v_tenant_id
  FROM public.tenants
  WHERE slug = 'movabi-global'
  LIMIT 1;

  v_full_name := COALESCE(new.raw_user_meta_data->>'full_name', 'User');

  -- UNTRUSTED pending context only: normalized, never authoritative.
  v_registration_country := NULLIF(upper(trim(COALESCE(new.raw_user_meta_data->>'registration_country_code', ''))), '');
  v_registration_city := NULLIF(trim(COALESCE(new.raw_user_meta_data->>'registration_market_city', '')), '');

  INSERT INTO public.profiles (
    id,
    tenant_id,
    full_name,
    role,
    onboarding_completed,
    country_code,
    registration_country_code,
    registration_market_city,
    registration_activated_at
  )
  VALUES (
    new.id,
    v_tenant_id,
    v_full_name,
    NULL,                 -- first-time role selection happens later
    false,
    NULL,                 -- never fabricate a country (no silent 'GB')
    v_registration_country,
    v_registration_city,
    NULL                  -- ALWAYS pending; metadata cannot self-activate
  );

  INSERT INTO public.tenant_users (tenant_id, user_id, role)
  VALUES (v_tenant_id, new.id, 'user');

  RETURN new;
END;
$$;


--
-- Name: initiate_wallet_topup(text, uuid, uuid, text, text, bigint, text, text, text, text); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.initiate_wallet_topup(p_attempt_key text, p_tenant_id uuid, p_owner_id uuid, p_country_code text, p_currency_code text, p_amount_minor bigint, p_destination_account_purpose text, p_payment_provider text, p_merchant_account_ref text, p_provider_idempotency_identity text) RETURNS uuid
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'pg_catalog', 'public'
    AS $_$
DECLARE
  v_id uuid; v_route public.market_payment_routes%ROWTYPE; v_n integer; v_max bigint;
BEGIN
  IF p_attempt_key IS NULL OR btrim(p_attempt_key) = '' OR length(p_attempt_key) > 200 THEN
    RAISE EXCEPTION 'Batch 1C: invalid attempt_key' USING ERRCODE = 'BP003';
  END IF;
  IF p_tenant_id IS NULL OR p_owner_id IS NULL THEN
    RAISE EXCEPTION 'Batch 1C: tenant_id and owner_id are required' USING ERRCODE = 'BP003';
  END IF;
  IF p_country_code IS NULL OR p_country_code !~ '^[A-Z]{2}$' OR p_currency_code IS NULL OR p_currency_code !~ '^[A-Z]{3}$' THEN
    RAISE EXCEPTION 'Batch 1C: invalid country/currency' USING ERRCODE = 'BP003';
  END IF;
  IF p_amount_minor IS NULL OR p_amount_minor <= 0 OR p_amount_minor > 9223372036854775807 THEN
    RAISE EXCEPTION 'Batch 1C: invalid amount' USING ERRCODE = 'BP003';
  END IF;
  IF p_destination_account_purpose IS NULL OR p_destination_account_purpose NOT IN ('customer_credit','driver_cash_credit') THEN
    RAISE EXCEPTION 'Batch 1C: destination account % is not an approved collectible destination', p_destination_account_purpose USING ERRCODE = 'BP008';
  END IF;
  IF p_payment_provider IS NULL OR p_payment_provider NOT IN ('stripe','kora') THEN
    RAISE EXCEPTION 'Batch 1C: unknown payment_provider %', p_payment_provider USING ERRCODE = 'BP004';
  END IF;
  IF p_merchant_account_ref IS NULL OR btrim(p_merchant_account_ref) = '' THEN
    RAISE EXCEPTION 'Batch 1C: merchant_account_ref is required' USING ERRCODE = 'BP004';
  END IF;
  IF p_provider_idempotency_identity IS NULL OR btrim(p_provider_idempotency_identity) = '' THEN
    RAISE EXCEPTION 'Batch 1C: provider_idempotency_identity is required' USING ERRCODE = 'BP004';
  END IF;
  IF NOT public.wallet_collection_enabled() THEN
    RAISE EXCEPTION 'Batch 1C: wallet collection is disabled (no approved usable destination)' USING ERRCODE = 'BP008';
  END IF;

  -- Market-specific limit is REQUIRED for each collectible currency.
  SELECT NULLIF((SELECT value FROM public.wallet_collection_config WHERE key='max_amount_minor_' || p_currency_code), '')::bigint INTO v_max;
  IF v_max IS NULL OR v_max <= 0 THEN
    RAISE EXCEPTION 'Batch 1C: no configured collection limit for %', p_currency_code USING ERRCODE = 'BP008';
  END IF;
  IF p_amount_minor > v_max THEN
    RAISE EXCEPTION 'Batch 1C: amount exceeds market limit for %', p_currency_code USING ERRCODE = 'BP008';
  END IF;

  IF NOT EXISTS (SELECT 1 FROM public.market_availability WHERE country_code=p_country_code AND upper(supported_currency)=p_currency_code) THEN
    RAISE EXCEPTION 'Batch 1C: unsupported country/currency pair' USING ERRCODE='BP008';
  END IF;

  -- Resolve exactly one eligible route.
  SELECT count(*) INTO v_n FROM public.market_payment_routes
  WHERE country_code = p_country_code AND currency_code = p_currency_code
    AND method = 'card' AND preferred AND enabled AND merchant_approved AND adapter_ready
    AND capabilities @> ARRAY['collect']::text[];
  IF v_n <> 1 THEN
    RAISE EXCEPTION 'Batch 1C: expected exactly one eligible collection route for %/%, found %', p_country_code, p_currency_code, v_n USING ERRCODE = 'BP008';
  END IF;
  SELECT * INTO v_route FROM public.market_payment_routes
  WHERE country_code = p_country_code AND currency_code = p_currency_code
    AND method = 'card' AND preferred AND enabled AND merchant_approved AND adapter_ready
    AND capabilities @> ARRAY['collect']::text[];
  IF v_route.provider IS DISTINCT FROM p_payment_provider OR v_route.merchant_account_ref IS DISTINCT FROM p_merchant_account_ref THEN
    RAISE EXCEPTION 'Batch 1C: requested provider/account does not match the eligible route' USING ERRCODE = 'BP008';
  END IF;

  -- Concurrent-safe replay: identical terms return the same attempt; a conflicting
  -- attempt_key reuse raises BP002 (never silently returns a mismatched row).
  INSERT INTO public.wallet_topup_attempts
    (attempt_key, tenant_id, owner_id, country_code, currency_code, amount_minor,
     destination_account_purpose, payment_provider, merchant_account_ref, provider_idempotency_identity)
  VALUES
    (p_attempt_key, p_tenant_id, p_owner_id, p_country_code, p_currency_code, p_amount_minor,
     p_destination_account_purpose, p_payment_provider, p_merchant_account_ref, p_provider_idempotency_identity)
  ON CONFLICT (attempt_key) DO NOTHING
  RETURNING id INTO v_id;

  IF v_id IS NULL THEN
    IF EXISTS (SELECT 1 FROM public.wallet_topup_attempts WHERE attempt_key = p_attempt_key
               AND tenant_id = p_tenant_id AND owner_id = p_owner_id
               AND country_code = p_country_code AND currency_code = p_currency_code
               AND amount_minor = p_amount_minor AND destination_account_purpose = p_destination_account_purpose
               AND payment_provider = p_payment_provider AND merchant_account_ref = p_merchant_account_ref
               AND provider_idempotency_identity = p_provider_idempotency_identity) THEN
      SELECT id INTO v_id FROM public.wallet_topup_attempts WHERE attempt_key = p_attempt_key;
    ELSE
      RAISE EXCEPTION 'Batch 1C: attempt_key % reused with different terms', p_attempt_key USING ERRCODE = 'BP002';
    END IF;
  END IF;
  RETURN v_id;
END
$_$;


--
-- Name: is_admin_user(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.is_admin_user() RETURNS boolean
    LANGUAGE sql SECURITY DEFINER
    SET search_path TO 'public'
    AS $$
  select exists (
    select 1
    from public.profiles
    where id = auth.uid()
    and role = 'admin'
  );
$$;


--
-- Name: is_tenant_admin(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.is_tenant_admin() RETURNS boolean
    LANGUAGE sql STABLE SECURITY DEFINER
    AS $$
  SELECT EXISTS (
    SELECT 1 FROM tenant_users 
    WHERE user_id = auth.uid() AND role = 'admin'
  );
$$;


--
-- Name: job_canonical_service(uuid); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.job_canonical_service(p_job_id uuid) RETURNS text
    LANGUAGE sql STABLE SECURITY DEFINER
    SET search_path TO 'public', 'pg_temp'
    AS $$
    SELECT public.canonical_driver_service(
        COALESCE(
            (SELECT COALESCE(st.slug::TEXT, st.name::TEXT)
               FROM public.service_types st
              WHERE st.id = j.service_type_id),
            j.metadata ->> 'service_slug',
            ''
        )
    )
    FROM public.jobs j
    WHERE j.id = p_job_id;
$$;


--
-- Name: job_chat_is_current_participant(uuid); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.job_chat_is_current_participant(p_job_id uuid) RETURNS boolean
    LANGUAGE sql STABLE SECURITY DEFINER
    SET search_path TO 'public', 'pg_temp'
    AS $$
 SELECT EXISTS(SELECT 1 FROM public.jobs j WHERE j.id=p_job_id AND auth.uid() IS NOT NULL
 AND (j.customer_id=auth.uid() OR coalesce(j.driver_id,j.accepted_driver_id)=auth.uid()));
$$;


--
-- Name: journey_fare_pilot_v23(uuid, uuid, uuid, text, text, jsonb, uuid, text); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.journey_fare_pilot_v23(p_actor uuid, p_job_id uuid, p_stop_id uuid, p_action text, p_source_digest text DEFAULT NULL::text, p_calculation jsonb DEFAULT NULL::jsonb, p_proposal_id uuid DEFAULT NULL::uuid, p_note text DEFAULT NULL::text) RETURNS jsonb
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'pg_catalog', 'public'
    AS $$
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
$$;


--
-- Name: journey_stop_pilot_v23(uuid, uuid, text, uuid, text, text); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.journey_stop_pilot_v23(p_actor uuid, p_job_id uuid, p_action text, p_request_id uuid DEFAULT NULL::uuid, p_reason text DEFAULT NULL::text, p_note text DEFAULT NULL::text) RETURNS jsonb
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'pg_catalog', 'public'
    AS $$
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
$$;


--
-- Name: kora_sandbox_booking_snapshot(uuid); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.kora_sandbox_booking_snapshot(p_job uuid) RETURNS jsonb
    LANGUAGE sql STABLE SECURITY DEFINER
    SET search_path TO 'public', 'pg_temp'
    AS $$
 SELECT jsonb_object_agg(k,coalesce(to_jsonb(j)->k,'null'::jsonb))
 FROM public.jobs j CROSS JOIN unnest(ARRAY['id','customer_id','status','country_code','currency_code',
 'service_type_id','payment_method','payment_status','payment_intent_id','driver_id','agreed_fare',
 'price','estimated_price','total_price','quote_id','fare_breakdown']) AS fields(k)
 WHERE j.id=p_job
$$;


--
-- Name: lock_marketplace_fare(uuid, uuid, numeric); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.lock_marketplace_fare(p_job_id uuid, p_driver_id uuid, p_amount numeric) RETURNS public.marketplace_negotiation_sessions
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'public', 'pg_temp'
    AS $$
DECLARE
  v_session    public.marketplace_negotiation_sessions;
  v_job        public.jobs;
  v_caller     UUID := auth.uid();
  v_constraint TEXT;
BEGIN
  -- 1. IDENTITY
  IF v_caller IS NOT NULL AND v_caller <> p_driver_id THEN
    RAISE EXCEPTION 'You can only lock a fare for your own session'
      USING ERRCODE = '42501', DETAIL = 'caller_mismatch';
  END IF;

  SELECT * INTO v_session
  FROM public.marketplace_negotiation_sessions
  WHERE job_id = p_job_id
  FOR UPDATE;

  IF NOT FOUND OR v_session.active_driver_id IS DISTINCT FROM p_driver_id THEN
    RAISE EXCEPTION 'Session not active for this driver'
      USING ERRCODE = '42501', DETAIL = 'session_not_active';
  END IF;

  -- 2. JOB LOCK + 3. STATUS + 4. OWNERSHIP
  SELECT * INTO v_job
  FROM public.jobs
  WHERE id = p_job_id
  FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Job not found'
      USING ERRCODE = 'P0002', DETAIL = 'job_not_found';
  END IF;

  IF v_job.status NOT IN ('pending_fare_confirmation', 'negotiating', 'pending', 'requested', 'searching') THEN
    RAISE EXCEPTION 'This job is no longer open for fare agreement'
      USING ERRCODE = '23514', DETAIL = 'job_not_negotiable';
  END IF;

  IF v_job.driver_id IS NOT NULL AND v_job.driver_id <> p_driver_id THEN
    RAISE EXCEPTION 'This job is already owned by another driver'
      USING ERRCODE = '23505', DETAIL = 'job_already_owned_by_other_driver';
  END IF;

  UPDATE public.marketplace_negotiation_sessions
  SET agreed_fare = p_amount,
      status = 'fare_agreed',
      expires_at = now() + interval '300 seconds',
      updated_at = now()
  WHERE job_id = p_job_id
  RETURNING * INTO v_session;

  BEGIN
    -- 5. FOUND
    UPDATE public.jobs
    SET agreed_fare = p_amount,
        status = 'fare_agreed',
        driver_id = p_driver_id,
        updated_at = now()
    WHERE id = p_job_id
      AND status IN ('pending_fare_confirmation', 'negotiating', 'pending', 'requested', 'searching')
      AND (driver_id IS NULL OR driver_id = p_driver_id)
    RETURNING * INTO v_job;

    IF NOT FOUND THEN
      RAISE EXCEPTION 'Fare was not locked for this job'
        USING ERRCODE = '23514', DETAIL = 'ownership_not_applied';
    END IF;
  EXCEPTION
    -- 6. MB001 (N12 busy) — unchanged meaning and mapping.
    WHEN unique_violation THEN
      GET STACKED DIAGNOSTICS v_constraint = CONSTRAINT_NAME;
      IF v_constraint = 'idx_jobs_one_active_per_driver' THEN
        RAISE EXCEPTION 'Driver already has an active job'
          USING ERRCODE = 'MB001',
                CONSTRAINT = 'idx_jobs_one_active_per_driver',
                DETAIL = 'driver_single_active_job';
      END IF;
      RAISE;
  END;

  INSERT INTO public.marketplace_negotiation_events
    (session_id, job_id, proposed_by, proposed_by_role, event_type, amount, round_number, created_at)
  VALUES
    (v_session.id, p_job_id, p_driver_id, 'driver', 'driver_accept', p_amount, v_session.round_count, now());

  RETURN v_session;
END;
$$;


--
-- Name: lookup_customer_wallet_sandbox_v1l(text); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.lookup_customer_wallet_sandbox_v1l(p_reference text) RETURNS jsonb
    LANGUAGE sql STABLE SECURITY DEFINER
    SET search_path TO 'pg_catalog', 'public'
    AS $$
 SELECT public.sandbox_attempt_json_v1l(id) FROM public.customer_wallet_sandbox_attempts_v1l WHERE reference=p_reference
$$;


--
-- Name: mark_enrolled_ride_start_v23(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.mark_enrolled_ride_start_v23() RETURNS trigger
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'pg_catalog', 'public'
    AS $$
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
$$;


--
-- Name: mark_job_arrived(uuid, uuid, integer); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.mark_job_arrived(p_job_id uuid, p_driver_id uuid, p_grace_minutes integer DEFAULT 5) RETURNS public.jobs
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'public'
    AS $$
DECLARE
  v_job public.jobs;
BEGIN
  SELECT * INTO v_job FROM public.jobs WHERE id = p_job_id FOR UPDATE;
  IF NOT FOUND THEN RETURN NULL; END IF;
  IF v_job.driver_id IS DISTINCT FROM p_driver_id THEN RETURN NULL; END IF;

  -- Idempotent: a repeated arrival returns the existing deadline unchanged.
  IF v_job.no_show_arrived_at IS NOT NULL THEN RETURN v_job; END IF;

  IF v_job.status NOT IN ('assigned','accepted','driver_arrived') THEN RETURN NULL; END IF;

  UPDATE public.jobs SET
    status = 'arrived',
    no_show_arrived_at = now(),
    no_show_grace_until = now() + interval '5 minutes',
    updated_at = now()
  WHERE id = p_job_id
  RETURNING * INTO v_job;

  RETURN v_job;
END;
$$;


--
-- Name: refund_operations; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.refund_operations (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    job_id uuid NOT NULL,
    operation_type text NOT NULL,
    amount_minor bigint NOT NULL,
    service_component_minor bigint DEFAULT 0 NOT NULL,
    budget_component_minor bigint DEFAULT 0 NOT NULL,
    purpose text,
    idempotency_key text NOT NULL,
    provider_id text,
    status text DEFAULT 'reserved'::text NOT NULL,
    error text,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT refund_operations_operation_type_check CHECK ((operation_type = ANY (ARRAY['refund'::text, 'reversal'::text]))),
    CONSTRAINT refund_operations_status_check CHECK ((status = ANY (ARRAY['reserved'::text, 'executed'::text, 'failed'::text, 'unknown'::text, 'released'::text])))
);


--
-- Name: mark_refund_operation(uuid, text, text, text); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.mark_refund_operation(p_operation_id uuid, p_provider_id text, p_status text, p_error text DEFAULT NULL::text) RETURNS public.refund_operations
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'public'
    AS $$
DECLARE
  v_op public.refund_operations;
BEGIN
  IF p_status NOT IN ('executed','failed','unknown') THEN RETURN NULL; END IF;
  UPDATE public.refund_operations SET
    provider_id = COALESCE(p_provider_id, provider_id),
    status = p_status,
    error = p_error,
    updated_at = now()
  WHERE id = p_operation_id AND status IN ('reserved','unknown')
  RETURNING * INTO v_op;
  RETURN v_op;
END;
$$;


--
-- Name: mark_reversal_operation(uuid, text, text, text); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.mark_reversal_operation(p_operation_id uuid, p_provider_id text, p_status text, p_error text DEFAULT NULL::text) RETURNS public.refund_operations
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'public'
    AS $$
DECLARE
  v_op public.refund_operations;
BEGIN
  IF p_status NOT IN ('executed','failed','unknown') THEN RETURN NULL; END IF;
  UPDATE public.refund_operations SET
    provider_id = COALESCE(p_provider_id, provider_id),
    status = p_status,
    error = p_error,
    updated_at = now()
  WHERE id = p_operation_id AND status IN ('reserved','unknown')
  RETURNING * INTO v_op;
  RETURN v_op;
END;
$$;


--
-- Name: mark_wallet_topup_failed(uuid, text); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.mark_wallet_topup_failed(p_attempt_id uuid, p_reason text) RETURNS void
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'pg_catalog', 'public'
    AS $$
DECLARE a public.wallet_topup_attempts%ROWTYPE;
BEGIN
  SELECT * INTO a FROM public.wallet_topup_attempts WHERE id = p_attempt_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Batch 1C: attempt not found' USING ERRCODE = 'BP003'; END IF;
  IF a.status IN ('credited','refunded') THEN
    RAISE EXCEPTION 'Batch 1C: credited/refunded attempt cannot be downgraded to failed' USING ERRCODE = 'BP008';
  END IF;
  UPDATE public.wallet_topup_attempts SET status='failed', failure_reason=COALESCE(p_reason,failure_reason) WHERE id=p_attempt_id;
END $$;


--
-- Name: mark_wallet_topup_refunded(uuid, text, text, text, text, bigint, text, text); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.mark_wallet_topup_refunded(p_attempt_id uuid, p_evidence_reference text, p_verified_provider_reference text, p_verified_merchant_account_ref text, p_verified_currency text, p_verified_amount_minor bigint, p_final_status text, p_reason text) RETURNS uuid
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'pg_catalog', 'public'
    AS $$
DECLARE
  a public.wallet_topup_attempts%ROWTYPE; v_reversal uuid;
BEGIN
  SELECT * INTO a FROM public.wallet_topup_attempts WHERE id = p_attempt_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Batch 1C: attempt not found' USING ERRCODE = 'BP003'; END IF;
  IF p_evidence_reference IS NULL OR btrim(p_evidence_reference) = '' THEN
    RAISE EXCEPTION 'Batch 1C: refund/chargeback evidence reference is required' USING ERRCODE = 'BP004';
  END IF;
  IF p_final_status IS NULL OR p_final_status NOT IN ('refunded','reversed') THEN
    RAISE EXCEPTION 'Batch 1C: refund final status % is not confirmed', p_final_status USING ERRCODE = 'BP008';
  END IF;
  IF a.status = 'refunded' THEN
    -- Replay: validate ALL evidence terms before returning the existing reversal.
    IF a.refund_evidence_reference IS DISTINCT FROM p_evidence_reference
       OR a.provider_reference IS DISTINCT FROM p_verified_provider_reference
       OR a.merchant_account_ref IS DISTINCT FROM p_verified_merchant_account_ref
       OR a.currency_code IS DISTINCT FROM p_verified_currency
       OR a.amount_minor IS DISTINCT FROM p_verified_amount_minor THEN
      RAISE EXCEPTION 'Batch 1C: replay refund terms do not match' USING ERRCODE = 'BP002';
    END IF;
    SELECT e.id INTO v_reversal FROM public.wallet_business_events e
    WHERE e.event_key = 'wallet-topup:' || a.id::text || ':refund';
    RETURN v_reversal;
  END IF;
  IF a.status <> 'credited' OR a.credited_event_id IS NULL THEN
    RAISE EXCEPTION 'Batch 1C: only a credited attempt can be refunded' USING ERRCODE = 'BP008';
  END IF;
  -- Evidence must match provider, merchant, original payment, currency, full amount.
  IF a.provider_reference IS DISTINCT FROM p_verified_provider_reference
     OR a.merchant_account_ref IS DISTINCT FROM p_verified_merchant_account_ref
     OR a.currency_code IS DISTINCT FROM p_verified_currency THEN
    RAISE EXCEPTION 'Batch 1C: refund evidence does not match the original payment' USING ERRCODE = 'BP008';
  END IF;
  IF p_verified_amount_minor IS DISTINCT FROM a.amount_minor THEN
    RAISE EXCEPTION 'Batch 1C: partial refunds are unsupported (evidence %, attempt %)', p_verified_amount_minor, a.amount_minor USING ERRCODE = 'BP008';
  END IF;
  v_reversal := public.post_wallet_reversal('wallet-topup:' || a.id::text, 'wallet-topup:' || a.id::text || ':refund');
  UPDATE public.wallet_topup_attempts SET status='refunded', refund_evidence_reference=p_evidence_reference, failure_reason=COALESCE(p_reason,failure_reason) WHERE id=p_attempt_id;
  RETURN v_reversal;
END $$;


--
-- Name: mark_wallet_topup_uncertain(uuid, text); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.mark_wallet_topup_uncertain(p_attempt_id uuid, p_reason text) RETURNS void
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'pg_catalog', 'public'
    AS $$
DECLARE a public.wallet_topup_attempts%ROWTYPE;
BEGIN
  SELECT * INTO a FROM public.wallet_topup_attempts WHERE id = p_attempt_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Batch 1C: attempt not found' USING ERRCODE = 'BP003'; END IF;
  IF a.status IN ('credited','refunded') THEN
    RAISE EXCEPTION 'Batch 1C: credited/refunded attempt cannot be downgraded to uncertain' USING ERRCODE = 'BP008';
  END IF;
  UPDATE public.wallet_topup_attempts SET status='uncertain', failure_reason=COALESCE(p_reason,failure_reason) WHERE id=p_attempt_id;
END $$;


--
-- Name: negotiation_lease_expiry(uuid, integer); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.negotiation_lease_expiry(p_job_id uuid, p_seconds integer) RETURNS timestamp with time zone
    LANGUAGE plpgsql STABLE SECURITY DEFINER
    SET search_path TO 'public'
    AS $$
DECLARE
  v_lease INTERVAL;
  v_deadline TIMESTAMPTZ;
BEGIN
  v_lease := make_interval(secs => GREATEST(COALESCE(p_seconds, 1), 1));

  SELECT expires_at INTO v_deadline
  FROM public.jobs
  WHERE id = p_job_id;

  IF v_deadline IS NULL THEN
    RETURN now() + v_lease;
  END IF;

  RETURN LEAST(now() + v_lease, v_deadline);
END;
$$;


--
-- Name: negotiation_live_proposal_role(uuid); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.negotiation_live_proposal_role(p_session_id uuid) RETURNS text
    LANGUAGE sql STABLE SECURITY DEFINER
    SET search_path TO 'public'
    AS $$
  SELECT e.proposed_by_role
  FROM public.marketplace_negotiation_events e
  WHERE e.session_id = p_session_id
    AND e.event_type IN ('customer_offer', 'driver_counter')
  ORDER BY e.created_at DESC, e.id DESC
  LIMIT 1;
$$;


--
-- Name: notify_admins_account_closure_requested(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.notify_admins_account_closure_requested() RETURNS trigger
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'public'
    AS $$
DECLARE
    v_display_name TEXT;
    v_route TEXT;
BEGIN
    IF NEW.account_status = 'closure_requested'
       AND COALESCE(OLD.account_status, 'active') <> 'closure_requested' THEN
        v_display_name := COALESCE(
            NULLIF(to_jsonb(NEW)->>'full_name', ''),
            NULLIF(to_jsonb(NEW)->>'email', ''),
            NULLIF(to_jsonb(NEW)->>'phone', ''),
            NEW.id::TEXT
        );

        v_route := CASE
            WHEN COALESCE(to_jsonb(NEW)->>'role', '') = 'driver' THEN '/admin/drivers'
            ELSE '/admin/users'
        END;

        INSERT INTO public.notifications (
            user_id,
            title,
            body,
            type,
            route,
            metadata,
            data
        )
        SELECT
            admin_profile.id,
            'Account closure requested',
            v_display_name || ' requested account closure',
            'account_closure_requested',
            v_route,
            jsonb_build_object(
                'profile_id', NEW.id,
                'role', to_jsonb(NEW)->>'role',
                'account_status', NEW.account_status
            ),
            jsonb_build_object(
                'profile_id', NEW.id,
                'role', to_jsonb(NEW)->>'role',
                'account_status', NEW.account_status
            )
        FROM public.profiles admin_profile
        WHERE admin_profile.role = 'admin';
    END IF;

    RETURN NEW;
END;
$$;


--
-- Name: on_errand_funding_change(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.on_errand_funding_change() RETURNS trigger
    LANGUAGE plpgsql SECURITY DEFINER
    AS $$
DECLARE
    v_customer_id UUID;
    v_driver_id UUID;
    v_job_id UUID;
BEGIN
    v_customer_id := NEW.customer_id;
    v_job_id := NEW.job_id;

    SELECT driver_id
    INTO v_driver_id
    FROM public.jobs
    WHERE id = v_job_id;

    -- Over-budget requested -> notify customer
    IF OLD.over_budget_status IS DISTINCT FROM NEW.over_budget_status THEN
        IF NEW.over_budget_status = 'requested' THEN
            INSERT INTO public.notifications (user_id, title, body, type, metadata)
            VALUES (
                v_customer_id,
                'Budget Increase Requested',
                'Your driver has requested an additional £' || COALESCE(NEW.over_budget_amount, 0)::TEXT || ' for your errand.',
                'booking',
                jsonb_build_object(
                    'jobId', v_job_id,
                    'type', 'over_budget_requested',
                    'overBudgetAmount', COALESCE(NEW.over_budget_amount, 0)
                )
            );

        ELSIF NEW.over_budget_status = 'approved' THEN
            IF v_driver_id IS NOT NULL THEN
                INSERT INTO public.notifications (user_id, title, body, type, metadata)
                VALUES (
                    v_driver_id,
                    'Budget Increase Approved',
                    'The customer has approved your budget increase request.',
                    'booking',
                    jsonb_build_object(
                        'jobId', v_job_id,
                        'type', 'over_budget_approved',
                        'overBudgetAmount', COALESCE(NEW.over_budget_amount, 0)
                    )
                );
            END IF;

        ELSIF NEW.over_budget_status = 'rejected' THEN
            IF v_driver_id IS NOT NULL THEN
                INSERT INTO public.notifications (user_id, title, body, type, metadata)
                VALUES (
                    v_driver_id,
                    'Budget Increase Rejected',
                    'The customer has rejected your budget increase request.',
                    'booking',
                    jsonb_build_object(
                        'jobId', v_job_id,
                        'type', 'over_budget_rejected',
                        'overBudgetAmount', COALESCE(NEW.over_budget_amount, 0)
                    )
                );
            END IF;
        END IF;
    END IF;

    -- Reserved/funded notification to customer
    IF OLD.status IS DISTINCT FROM NEW.status AND NEW.status IN ('reserved', 'funded') THEN
        INSERT INTO public.notifications (user_id, title, body, type, metadata)
        VALUES (
            v_customer_id,
            'Errand Funded',
            'Your errand has been funded successfully and is ready for driver assignment.',
            'wallet',
            jsonb_build_object(
                'jobId', v_job_id,
                'type', 'errand_funded',
                'amountReserved', COALESCE(NEW.amount_reserved, 0)
            )
        );
    END IF;

    -- Settled/refund notification to customer
    IF OLD.status IS DISTINCT FROM NEW.status AND NEW.status = 'settled' THEN
        INSERT INTO public.notifications (user_id, title, body, type, metadata)
        VALUES (
            v_customer_id,
            'Errand Funds Settled',
            'Your errand funds have been settled. Any unused budget has been returned to your wallet.',
            'wallet',
            jsonb_build_object(
                'jobId', v_job_id,
                'type', 'errand_settled',
                'refundAmount', COALESCE(NEW.refund_amount, 0)
            )
        );
    END IF;

    RETURN NEW;
END;
$$;


--
-- Name: on_errand_spending_update(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.on_errand_spending_update() RETURNS trigger
    LANGUAGE plpgsql SECURITY DEFINER
    AS $$
BEGIN
    -- Future hook: audit log / notifications
    RETURN NEW;
END;
$$;


--
-- Name: on_new_job_message(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.on_new_job_message() RETURNS trigger
    LANGUAGE plpgsql SECURITY DEFINER
    AS $$
BEGIN
    INSERT INTO public.notifications (user_id, title, body, type, metadata)
    VALUES (
        NEW.receiver_id,
        'New Message',
        'You have a new message regarding your booking.',
        'chat',
        jsonb_build_object(
            'jobId', NEW.job_id,
            'senderId', NEW.sender_id,
            'type', 'job_message'
        )
    );

    RETURN NEW;
END;
$$;


--
-- Name: pay_job_from_wallet(uuid, uuid, numeric, text, uuid); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.pay_job_from_wallet(p_job_id uuid, p_customer_id uuid, p_amount numeric, p_currency_code text DEFAULT 'GBP'::text, p_tenant_id uuid DEFAULT NULL::uuid) RETURNS jsonb
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'public', 'pg_temp'
    AS $$
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


--
-- Name: post_wallet_event(text, text, uuid, uuid, text, jsonb, text, text, text, uuid); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.post_wallet_event(p_event_key text, p_operation text, p_tenant_id uuid, p_owner_id uuid, p_currency_code text, p_entries jsonb, p_payment_provider text DEFAULT NULL::text, p_merchant_account_ref text DEFAULT NULL::text, p_provider_reference text DEFAULT NULL::text, p_reverses_event_id uuid DEFAULT NULL::uuid) RETURNS uuid
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'pg_catalog', 'public'
    AS $$
DECLARE
  v_event_id uuid;
  v_account_id uuid;
  v_sum numeric := 0;
  v_entries jsonb;
  v_expected jsonb;
  v_original public.wallet_business_events%ROWTYPE;
  v_constraint_name text;
  entry record;
  leg jsonb;
BEGIN
  -- Input validation (BP003).
  IF p_event_key IS NULL OR btrim(p_event_key) = '' OR length(p_event_key) > 200 THEN
    RAISE EXCEPTION 'Batch 1B: invalid event_key' USING ERRCODE = 'BP003';
  END IF;
  IF p_operation IS NULL OR btrim(p_operation) = '' OR length(p_operation) > 64 THEN
    RAISE EXCEPTION 'Batch 1B: invalid operation' USING ERRCODE = 'BP003';
  END IF;
  IF p_tenant_id IS NULL OR p_owner_id IS NULL THEN
    RAISE EXCEPTION 'Batch 1B: tenant_id and owner_id are required' USING ERRCODE = 'BP003';
  END IF;
  IF public.wallet_currency_minor_exponent(p_currency_code) IS NULL THEN
    RAISE EXCEPTION 'Batch 1B: invalid currency format %', p_currency_code USING ERRCODE = 'BP003';
  END IF;
  -- Canonical supported-currency authority (no divergent list).
  IF NOT EXISTS (SELECT 1 FROM public.market_availability WHERE upper(supported_currency) = p_currency_code) THEN
    RAISE EXCEPTION 'Batch 1B: unsupported currency %', p_currency_code USING ERRCODE = 'BP003';
  END IF;
  IF p_entries IS NULL OR jsonb_typeof(p_entries) <> 'array'
     OR jsonb_array_length(p_entries) < 2 OR jsonb_array_length(p_entries) > 20 THEN
    RAISE EXCEPTION 'Batch 1B: entries must be an array of 2..20 legs' USING ERRCODE = 'BP003';
  END IF;

  -- Provider identity (BP004).
  IF p_payment_provider IS NOT NULL THEN
    IF p_payment_provider NOT IN ('stripe','kora','fincra') THEN
      RAISE EXCEPTION 'Batch 1B: unknown payment_provider %', p_payment_provider USING ERRCODE = 'BP004';
    END IF;
    IF p_merchant_account_ref IS NULL OR btrim(p_merchant_account_ref) = ''
       OR p_provider_reference IS NULL OR btrim(p_provider_reference) = '' THEN
      RAISE EXCEPTION 'Batch 1B: external event requires merchant_account_ref and provider_reference' USING ERRCODE = 'BP004';
    END IF;
  ELSIF p_merchant_account_ref IS NOT NULL OR p_provider_reference IS NOT NULL THEN
    RAISE EXCEPTION 'Batch 1B: internal event must not carry merchant/provider identity' USING ERRCODE = 'BP004';
  END IF;

  -- Per-leg validation (BP003): exact keys, valid purpose, whole-number, reversible range, nonzero.
  FOR entry IN SELECT e.value AS leg FROM jsonb_array_elements(p_entries) WITH ORDINALITY AS e(value, ord) LOOP
    leg := entry.leg;
    IF (SELECT array_agg(k ORDER BY k) FROM jsonb_object_keys(leg) AS k)
       IS DISTINCT FROM ARRAY['accountPurpose','amountMinor'] THEN
      RAISE EXCEPTION 'Batch 1B: leg has unexpected fields' USING ERRCODE = 'BP003';
    END IF;
    IF leg->>'accountPurpose' IS NULL OR btrim(leg->>'accountPurpose') = ''
       OR length(leg->>'accountPurpose') > 64 THEN
      RAISE EXCEPTION 'Batch 1B: invalid accountPurpose' USING ERRCODE = 'BP003';
    END IF;
    IF jsonb_typeof(leg->'amountMinor') <> 'number' THEN
      RAISE EXCEPTION 'Batch 1B: amountMinor must be a number' USING ERRCODE = 'BP003';
    END IF;
    IF (leg->>'amountMinor')::numeric <> round((leg->>'amountMinor')::numeric) THEN
      RAISE EXCEPTION 'Batch 1B: amountMinor must be a whole number' USING ERRCODE = 'BP003';
    END IF;
    IF (leg->>'amountMinor')::numeric NOT BETWEEN -9223372036854775807::numeric AND 9223372036854775807::numeric THEN
      RAISE EXCEPTION 'Batch 1B: amountMinor out of reversible bigint range' USING ERRCODE = 'BP003';
    END IF;
    IF (leg->>'amountMinor')::bigint = 0 THEN
      RAISE EXCEPTION 'Batch 1B: amountMinor must be non-zero' USING ERRCODE = 'BP003';
    END IF;
  END LOOP;

  -- Server-side canonicalization: merge duplicate account purposes (sum), sort
  -- by purpose, drop zero nets. Deterministic for storage, comparison, locking.
  SELECT jsonb_agg(jsonb_build_object('accountPurpose', purpose, 'amountMinor', total) ORDER BY purpose)
  INTO v_entries
  FROM (
    SELECT e.value->>'accountPurpose' AS purpose, sum((e.value->>'amountMinor')::bigint) AS total
    FROM jsonb_array_elements(p_entries) AS e(value)
    GROUP BY e.value->>'accountPurpose'
    HAVING sum((e.value->>'amountMinor')::bigint) <> 0
  ) g;

  IF v_entries IS NULL OR jsonb_array_length(v_entries) < 2 THEN
    RAISE EXCEPTION 'Batch 1B: canonicalized entries require at least 2 non-zero legs' USING ERRCODE = 'BP003';
  END IF;

  -- Post-canonicalization range validation: a merged total can overflow the
  -- reversible bigint range even when each individual leg is valid.
  IF EXISTS (
    SELECT 1 FROM jsonb_array_elements(v_entries) e
    WHERE (e.value->>'amountMinor')::numeric NOT BETWEEN -9223372036854775807::numeric AND 9223372036854775807::numeric
  ) THEN
    RAISE EXCEPTION 'Batch 1B: merged amountMinor out of reversible bigint range' USING ERRCODE = 'BP003';
  END IF;

  SELECT COALESCE(sum((e->>'amountMinor')::numeric), 0) INTO v_sum FROM jsonb_array_elements(v_entries) e;
  IF v_sum <> 0 THEN
    RAISE EXCEPTION 'Batch 1B: unbalanced event % (net=%)', p_event_key, v_sum USING ERRCODE = 'BP001';
  END IF;

  -- Replay (BP002) BEFORE reversal check so a same-key reversal retry is idempotent.
  SELECT id INTO v_event_id FROM public.wallet_business_events WHERE event_key = p_event_key;
  IF FOUND THEN
    IF NOT EXISTS (
      SELECT 1 FROM public.wallet_business_events
      WHERE id = v_event_id
        AND operation = p_operation
        AND tenant_id = p_tenant_id AND owner_id = p_owner_id
        AND currency_code = p_currency_code
        AND payment_provider IS NOT DISTINCT FROM p_payment_provider
        AND merchant_account_ref IS NOT DISTINCT FROM p_merchant_account_ref
        AND provider_reference IS NOT DISTINCT FROM p_provider_reference
        AND entries = v_entries
        AND reverses_event_id IS NOT DISTINCT FROM p_reverses_event_id
    ) THEN
      RAISE EXCEPTION 'Batch 1B: event_key % reused with different terms', p_event_key USING ERRCODE = 'BP002';
    END IF;
    RETURN v_event_id;
  END IF;

  -- Controlled reversal (BP005).
  IF p_reverses_event_id IS NOT NULL THEN
    SELECT * INTO v_original FROM public.wallet_business_events WHERE id = p_reverses_event_id;
    IF NOT FOUND THEN
      RAISE EXCEPTION 'Batch 1B: reversal original event not found' USING ERRCODE = 'BP005';
    END IF;
    IF v_original.tenant_id <> p_tenant_id OR v_original.owner_id <> p_owner_id
       OR v_original.currency_code <> p_currency_code THEN
      RAISE EXCEPTION 'Batch 1B: reversal scope mismatch' USING ERRCODE = 'BP005';
    END IF;
    IF EXISTS (SELECT 1 FROM public.wallet_business_events WHERE reverses_event_id = p_reverses_event_id) THEN
      RAISE EXCEPTION 'Batch 1B: event already reversed' USING ERRCODE = 'BP005';
    END IF;
    SELECT jsonb_agg(jsonb_build_object('accountPurpose', a.balance_purpose, 'amountMinor', -m.amount_minor)
                     ORDER BY a.balance_purpose)
    INTO v_expected
    FROM public.wallet_movements m
    JOIN public.wallet_accounts a ON a.id = m.account_id
    WHERE m.event_id = p_reverses_event_id;
    IF v_entries IS DISTINCT FROM v_expected THEN
      RAISE EXCEPTION 'Batch 1B: reversal legs do not exactly negate the original' USING ERRCODE = 'BP005';
    END IF;
  END IF;

  -- Insert the event; distinguish event-key vs reversal-uniqueness conflicts.
  BEGIN
    INSERT INTO public.wallet_business_events
      (event_key, operation, payment_provider, merchant_account_ref, provider_reference,
       tenant_id, owner_id, currency_code, entries, reverses_event_id)
    VALUES
      (p_event_key, p_operation, p_payment_provider, p_merchant_account_ref, p_provider_reference,
       p_tenant_id, p_owner_id, p_currency_code, v_entries, p_reverses_event_id)
    RETURNING id INTO v_event_id;
  EXCEPTION WHEN unique_violation THEN
    GET STACKED DIAGNOSTICS v_constraint_name = CONSTRAINT_NAME;
    IF v_constraint_name = 'wallet_business_events_event_key_key' THEN
      SELECT id INTO v_event_id FROM public.wallet_business_events WHERE event_key = p_event_key;
      IF NOT EXISTS (
        SELECT 1 FROM public.wallet_business_events
        WHERE id = v_event_id
          AND operation = p_operation
          AND tenant_id = p_tenant_id AND owner_id = p_owner_id
          AND currency_code = p_currency_code
          AND payment_provider IS NOT DISTINCT FROM p_payment_provider
          AND merchant_account_ref IS NOT DISTINCT FROM p_merchant_account_ref
          AND provider_reference IS NOT DISTINCT FROM p_provider_reference
          AND entries = v_entries
          AND reverses_event_id IS NOT DISTINCT FROM p_reverses_event_id
      ) THEN
        RAISE EXCEPTION 'Batch 1B: event_key % reused with different terms', p_event_key USING ERRCODE = 'BP002';
      END IF;
      RETURN v_event_id;
    ELSIF v_constraint_name = 'wallet_business_events_reversal_unique' THEN
      RAISE EXCEPTION 'Batch 1B: event already reversed' USING ERRCODE = 'BP005';
    ELSE
      RAISE;
    END IF;
  END;

  -- Post the canonical legs (sorted; accounts locked in deterministic order).
  FOR entry IN SELECT e.value AS leg, e.ord AS seq FROM jsonb_array_elements(v_entries) WITH ORDINALITY AS e(value, ord) LOOP
    INSERT INTO public.wallet_accounts (tenant_id, owner_id, currency_code, balance_purpose)
    VALUES (p_tenant_id, p_owner_id, p_currency_code, entry.leg->>'accountPurpose')
    ON CONFLICT (tenant_id, owner_id, currency_code, balance_purpose) DO NOTHING;
    SELECT id INTO v_account_id FROM public.wallet_accounts
    WHERE tenant_id = p_tenant_id AND owner_id = p_owner_id
      AND currency_code = p_currency_code AND balance_purpose = entry.leg->>'accountPurpose'
    FOR UPDATE;

    INSERT INTO public.wallet_movements (event_id, account_id, amount_minor, entry_seq)
    VALUES (v_event_id, v_account_id, (entry.leg->>'amountMinor')::bigint, entry.seq::smallint);
  END LOOP;

  RETURN v_event_id;
END
$$;


--
-- Name: post_wallet_reversal(text, text); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.post_wallet_reversal(p_original_event_key text, p_event_key text) RETURNS uuid
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'pg_catalog', 'public'
    AS $$
DECLARE
  v_original public.wallet_business_events%ROWTYPE;
  v_legs jsonb;
BEGIN
  SELECT * INTO STRICT v_original FROM public.wallet_business_events WHERE event_key = p_original_event_key;

  SELECT jsonb_agg(jsonb_build_object('accountPurpose', a.balance_purpose, 'amountMinor', -m.amount_minor)
                   ORDER BY a.balance_purpose)
  INTO v_legs
  FROM public.wallet_movements m
  JOIN public.wallet_accounts a ON a.id = m.account_id
  WHERE m.event_id = v_original.id;

  RETURN public.post_wallet_event(
    p_event_key, 'reversal', v_original.tenant_id, v_original.owner_id, v_original.currency_code,
    v_legs, NULL, NULL, NULL, v_original.id);
END
$$;


--
-- Name: prepare_customer_wallet_sandbox_v1l(uuid, uuid, bigint, text, text); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.prepare_customer_wallet_sandbox_v1l(p_owner uuid, p_key uuid, p_amount bigint, p_merchant text, p_fingerprint text) RETURNS jsonb
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'pg_catalog', 'public'
    AS $_$
DECLARE p public.profiles%ROWTYPE;c public.customer_wallet_sandbox_cohort_v1l%ROWTYPE;a public.customer_wallet_sandbox_attempts_v1l%ROWTYPE;
 id_new uuid:=gen_random_uuid();city text;n integer;market jsonb; BEGIN
 IF coalesce((SELECT value='true' FROM public.wallet_collection_config WHERE key='customer_wallet_sandbox_enabled'),false) IS DISTINCT FROM true THEN RAISE EXCEPTION 'Sandbox API disabled' USING ERRCODE='BL004';END IF;
 IF p_owner IS NULL OR p_key IS NULL OR p_amount IS NULL OR p_amount<=0 OR p_merchant IS NULL OR length(btrim(p_merchant)) NOT BETWEEN 1 AND 200 OR p_fingerprint IS NULL OR p_fingerprint!~'^[0-9a-f]{64}$' THEN RAISE EXCEPTION 'Invalid sandbox input' USING ERRCODE='BL002';END IF;
 SELECT * INTO p FROM public.profiles WHERE id=p_owner FOR SHARE;
 IF NOT FOUND OR p.role IS DISTINCT FROM 'customer' OR p.tenant_id IS NULL OR p.registration_activated_at IS NULL OR p.registration_activated_at>now() THEN RAISE EXCEPTION 'Customer registration required' USING ERRCODE='BL001';END IF;
 SELECT * INTO c FROM public.customer_wallet_sandbox_cohort_v1l WHERE owner_id=p_owner FOR SHARE;
 IF NOT FOUND OR NOT c.enabled OR c.tenant_id<>p.tenant_id OR c.country_code IS DISTINCT FROM p.registration_country_code OR p_amount>c.max_amount_minor OR c.minor_exponent IS DISTINCT FROM public.wallet_currency_minor_exponent(c.currency_code) THEN RAISE EXCEPTION 'Approved sandbox cohort required' USING ERRCODE='BL004';END IF;
 IF NOT EXISTS(SELECT 1 FROM public.wallets WHERE user_id=p_owner AND currency_code=c.currency_code) THEN RAISE EXCEPTION 'Matching existing wallet required' USING ERRCODE='BL004';END IF;
 LOCK TABLE public.market_availability IN SHARE MODE;
 city:=nullif(lower(regexp_replace(btrim(coalesce(p.registration_market_city,'')),'\s+',' ','g')),'');
SELECT count(*) INTO n FROM public.market_availability m WHERE m.country_code=c.country_code AND to_jsonb(m)->>'enabled'='true' AND nullif(btrim(to_jsonb(m)->>'zone_id'),'') IS NULL
 AND nullif(lower(regexp_replace(btrim(coalesce(to_jsonb(m)->>'market_city','')),'\s+',' ','g')),'') IS NOT DISTINCT FROM city
 AND (nullif(to_jsonb(m)->>'valid_from','') IS NULL OR (to_jsonb(m)->>'valid_from')::timestamptz<=now())
 AND (nullif(to_jsonb(m)->>'valid_until','') IS NULL OR (to_jsonb(m)->>'valid_until')::timestamptz>now());
 IF n=0 THEN city:=NULL;END IF;
SELECT count(*) INTO n FROM public.market_availability m WHERE m.country_code=c.country_code AND to_jsonb(m)->>'enabled'='true' AND nullif(btrim(to_jsonb(m)->>'zone_id'),'') IS NULL
 AND nullif(lower(regexp_replace(btrim(coalesce(to_jsonb(m)->>'market_city','')),'\s+',' ','g')),'') IS NOT DISTINCT FROM city
 AND (nullif(to_jsonb(m)->>'valid_from','') IS NULL OR (to_jsonb(m)->>'valid_from')::timestamptz<=now())
 AND (nullif(to_jsonb(m)->>'valid_until','') IS NULL OR (to_jsonb(m)->>'valid_until')::timestamptz>now());
 IF n<>1 THEN RAISE EXCEPTION 'Sandbox market unavailable' USING ERRCODE='BL004';END IF;
SELECT to_jsonb(m) INTO STRICT market FROM public.market_availability m WHERE m.country_code=c.country_code AND to_jsonb(m)->>'enabled'='true' AND nullif(btrim(to_jsonb(m)->>'zone_id'),'') IS NULL
 AND nullif(lower(regexp_replace(btrim(coalesce(to_jsonb(m)->>'market_city','')),'\s+',' ','g')),'') IS NOT DISTINCT FROM city
 AND (nullif(to_jsonb(m)->>'valid_from','') IS NULL OR (to_jsonb(m)->>'valid_from')::timestamptz<=now())
 AND (nullif(to_jsonb(m)->>'valid_until','') IS NULL OR (to_jsonb(m)->>'valid_until')::timestamptz>now());
 IF market->>'supported_currency' IS DISTINCT FROM c.currency_code OR market->>'launch_status' IS DISTINCT FROM 'live' OR market->>'customer_app_enabled' IS DISTINCT FROM 'true' THEN RAISE EXCEPTION 'Sandbox market unavailable' USING ERRCODE='BL004';END IF;
 INSERT INTO public.customer_wallet_sandbox_attempts_v1l(id,owner_id,tenant_id,idempotency_key,reference,credential_fingerprint,merchant_account_ref,country_code,currency_code,minor_exponent,amount_minor)
 VALUES(id_new,p_owner,p.tenant_id,p_key,'vaydu_test_'||replace(id_new::text,'-',''),p_fingerprint,p_merchant,c.country_code,c.currency_code,c.minor_exponent,p_amount)
 ON CONFLICT(owner_id,idempotency_key) DO NOTHING;
 SELECT * INTO STRICT a FROM public.customer_wallet_sandbox_attempts_v1l WHERE owner_id=p_owner AND idempotency_key=p_key FOR UPDATE;
 IF (a.tenant_id,a.country_code,a.currency_code,a.minor_exponent,a.amount_minor,a.merchant_account_ref,a.credential_fingerprint)
 IS DISTINCT FROM (p.tenant_id,c.country_code,c.currency_code,c.minor_exponent,p_amount,p_merchant,p_fingerprint) THEN RAISE EXCEPTION 'Sandbox replay terms conflict' USING ERRCODE='BL003';END IF;
 RETURN public.sandbox_attempt_json_v1l(a.id);
END $_$;


--
-- Name: process_payout_batch(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.process_payout_batch() RETURNS uuid
    LANGUAGE plpgsql
    AS $$
DECLARE
  v_batch_id UUID := gen_random_uuid();
BEGIN
  INSERT INTO payout_batches (id, status, created_at)
  VALUES (v_batch_id, 'processing', NOW());

  UPDATE driver_earnings
  SET status = 'paid',
      payout_batch_id = v_batch_id,
      paid_out_at = NOW()
  WHERE status = 'payable';

  UPDATE payout_batches
  SET status = 'completed',
      processed_at = NOW(),
      total_amount = COALESCE((SELECT SUM(net_amount) FROM driver_earnings WHERE payout_batch_id = v_batch_id), 0)
  WHERE id = v_batch_id;

  RETURN v_batch_id;
END;
$$;


--
-- Name: protect_driver_operating_market_v23(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.protect_driver_operating_market_v23() RETURNS trigger
    LANGUAGE plpgsql
    SET search_path TO 'pg_catalog', 'public'
    AS $$
BEGIN
 IF auth.role() IN ('anon','authenticated') AND (
   (OLD.role='driver' AND (
     OLD.registration_country_code IS DISTINCT FROM NEW.registration_country_code OR OLD.country_code IS DISTINCT FROM NEW.country_code
     OR OLD.tenant_id IS DISTINCT FROM NEW.tenant_id OR OLD.role IS DISTINCT FROM NEW.role))
   OR (NEW.role IN ('admin','super_admin') AND OLD.role IS DISTINCT FROM NEW.role)
   OR OLD.registration_activated_at IS DISTINCT FROM NEW.registration_activated_at
   OR to_jsonb(OLD)->>'stripe_account_id' IS DISTINCT FROM to_jsonb(NEW)->>'stripe_account_id'
   OR to_jsonb(OLD)->>'stripe_connect_account_id' IS DISTINCT FROM to_jsonb(NEW)->>'stripe_connect_account_id'
   OR to_jsonb(OLD)->>'stripe_connected_account_id' IS DISTINCT FROM to_jsonb(NEW)->>'stripe_connected_account_id'
   OR to_jsonb(OLD)->>'stripe_connect_id' IS DISTINCT FROM to_jsonb(NEW)->>'stripe_connect_id'
   OR to_jsonb(OLD)->>'stripe_connect_status' IS DISTINCT FROM to_jsonb(NEW)->>'stripe_connect_status'
   OR to_jsonb(OLD)->>'charges_enabled' IS DISTINCT FROM to_jsonb(NEW)->>'charges_enabled'
   OR to_jsonb(OLD)->>'payouts_enabled' IS DISTINCT FROM to_jsonb(NEW)->>'payouts_enabled') THEN
  RAISE EXCEPTION USING ERRCODE='P0001',MESSAGE='DRIVER_MARKET_CHANGE_REQUIRES_REVIEW';
 END IF;
 RETURN NEW;
END $$;


--
-- Name: queue_admin_message_notification(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.queue_admin_message_notification() RETURNS trigger
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'public'
    AS $$
DECLARE e bigint; t uuid;
BEGIN
 IF COALESCE(NEW.metadata->>'action',NEW.data->>'action','') IN ('admin_message','admin_driver_message')
    AND (auth.role()='service_role' OR session_user IN ('postgres','supabase_admin')) THEN
  IF NEW.metadata ? 'entry_id' THEN
   SELECT m.id,m.thread_id INTO e,t FROM public.admin_message_entries m JOIN public.admin_message_threads th ON th.id=m.thread_id
   WHERE m.id=(NEW.metadata->>'entry_id')::bigint AND m.thread_id=(NEW.metadata->>'thread_id')::uuid AND th.user_id=NEW.user_id AND m.direction='admin';
   IF NOT FOUND THEN RAISE EXCEPTION 'Reply entry unavailable'; END IF;
   UPDATE public.admin_message_entries SET notification_id=NEW.id WHERE id=e;
   INSERT INTO public.admin_message_email_outbox(entry_id,user_id) VALUES(e,NEW.user_id) ON CONFLICT DO NOTHING;
  ELSE PERFORM public.seed_admin_message_thread(NEW.id,true); END IF;
 END IF;
 RETURN NEW;
END; $$;


--
-- Name: recommended_country_payment_provider_v23(text, text); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.recommended_country_payment_provider_v23(p_country text, p_currency text) RETURNS text
    LANGUAGE sql IMMUTABLE
    SET search_path TO 'pg_catalog'
    AS $_$
 SELECT CASE
 WHEN p_country IN('NG','GH','KE','ZA','TZ','EG','CM','CI','SN') AND p_currency=ANY(ARRAY['NGN','KES','GHS','ZAR','XOF','XAF','EGP','TZS','USD','GBP']::text[]) THEN 'kora'
 WHEN p_country ~ '^[A-Z]{2}$' AND p_currency=ANY(ARRAY['USD','AED','AFN','ALL','AMD','ANG','AOA','ARS','AUD','AWG','AZN','BAM','BBD','BDT','BIF','BMD','BND','BOB','BRL','BSD','BWP','BYN','BZD','CAD','CDF','CHF','CLP','CNY','COP','CRC','CVE','CZK','DJF','DKK','DOP','DZD','EGP','ETB','EUR','FJD','FKP','GBP','GEL','GIP','GMD','GNF','GTQ','GYD','HKD','HNL','HTG','HUF','IDR','ILS','INR','ISK','JMD','JPY','KES','KGS','KHR','KMF','KRW','KYD','KZT','LAK','LBP','LKR','LRD','LSL','MAD','MDL','MGA','MKD','MMK','MNT','MOP','MUR','MVR','MWK','MXN','MYR','MZN','NAD','NGN','NIO','NOK','NPR','NZD','PAB','PEN','PGK','PHP','PKR','PLN','PYG','QAR','RON','RSD','RUB','RWF','SAR','SBD','SCR','SEK','SGD','SHP','SLE','SOS','SRD','STD','SZL','THB','TJS','TOP','TRY','TTD','TWD','TZS','UAH','UGX','UYU','UZS','VND','VUV','WST','XAF','XCD','XCG','XOF','XPF','YER','ZAR','ZMW']::text[]) THEN 'stripe'
 ELSE NULL END
$_$;


--
-- Name: reconcile_wallet_topup(uuid, text); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.reconcile_wallet_topup(p_attempt_id uuid, p_evidence_key text) RETURNS uuid
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'pg_catalog', 'public'
    AS $$
DECLARE v public.wallet_topup_verifications%ROWTYPE;
BEGIN
  SELECT * INTO v FROM public.wallet_topup_verifications WHERE attempt_id = p_attempt_id AND evidence_key = p_evidence_key;
  IF NOT FOUND THEN RAISE EXCEPTION 'Batch 1C: verification evidence not found' USING ERRCODE = 'BP003'; END IF;
  RETURN public.confirm_wallet_topup(p_attempt_id, v.provider_reference, v.merchant_account_ref, v.currency_code, v.amount_minor, v.final_status);
END
$$;


--
-- Name: record_customer_wallet_sandbox_v1l(uuid, uuid, text, text, text, text, bigint, text); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.record_customer_wallet_sandbox_v1l(p_owner uuid, p_id uuid, p_fingerprint text, p_status text, p_reference text, p_currency text, p_amount bigint, p_checkout text) RETURNS jsonb
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'pg_catalog', 'public'
    AS $$
DECLARE a public.customer_wallet_sandbox_attempts_v1l%ROWTYPE; BEGIN
 SELECT * INTO a FROM public.customer_wallet_sandbox_attempts_v1l WHERE id=p_id AND owner_id=p_owner FOR UPDATE;
 IF NOT FOUND OR (a.credential_fingerprint,a.reference,a.currency_code,a.amount_minor) IS DISTINCT FROM (p_fingerprint,p_reference,p_currency,p_amount) THEN RAISE EXCEPTION 'Sandbox evidence mismatch' USING ERRCODE='BL005';END IF;
 IF p_status IS NULL OR p_status NOT IN ('provider_pending','uncertain','verified_test_only','failed') THEN RAISE EXCEPTION 'Invalid sandbox status' USING ERRCODE='BL002';END IF;
 IF a.status IN ('verified_test_only','failed') THEN RETURN public.sandbox_attempt_json_v1l(p_id);END IF;
 IF a.status='initiated' THEN RAISE EXCEPTION 'Sandbox submission not claimed' USING ERRCODE='BL005';END IF;
 IF p_checkout IS NOT NULL AND p_checkout!~'^https://(test-checkout[.]korapay[.]com|checkout[.]korapay[.]com)/' THEN RAISE EXCEPTION 'Invalid sandbox checkout' USING ERRCODE='BL005';END IF;
 UPDATE public.customer_wallet_sandbox_attempts_v1l SET status=p_status,checkout_url=coalesce(p_checkout,checkout_url),updated_at=now() WHERE id=p_id;
 RETURN public.sandbox_attempt_json_v1l(p_id);
END $$;


--
-- Name: record_gb_vehicle_mot(uuid, text, text, date, timestamp with time zone); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.record_gb_vehicle_mot(p_vehicle_id uuid, p_registration text, p_status text, p_expiry date, p_checked_at timestamp with time zone) RETURNS void
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'public'
    AS $$
DECLARE driver uuid;
BEGIN
 SELECT v.user_id INTO driver FROM vehicles v JOIN profiles p ON p.id=v.user_id
 WHERE v.id=p_vehicle_id AND upper(p.country_code)='GB' AND lower(v.type) NOT IN ('motorcycle','bicycle','bike')
 AND upper(regexp_replace(v.license_plate,'\s','','g'))=p_registration FOR UPDATE OF v;
 IF driver IS NULL THEN RETURN; END IF;
 INSERT INTO driver_vehicle_mot_checks VALUES(p_vehicle_id,p_registration,p_status,p_expiry,p_checked_at)
 ON CONFLICT(vehicle_id) DO UPDATE SET registration=EXCLUDED.registration,
 status=CASE WHEN EXCLUDED.status='unknown' AND driver_vehicle_mot_checks.registration=EXCLUDED.registration AND driver_vehicle_mot_checks.status IN ('expired','dangerous_failure') THEN driver_vehicle_mot_checks.status ELSE EXCLUDED.status END,
 expires_on=EXCLUDED.expires_on,checked_at=EXCLUDED.checked_at
 WHERE EXCLUDED.checked_at>driver_vehicle_mot_checks.checked_at;
 IF gb_driver_mot_blocked(driver) THEN UPDATE profiles SET is_online=false,is_available=false WHERE id=driver; END IF;
END;$$;


--
-- Name: record_issuing_authorization_request(text, text, numeric, text, jsonb); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.record_issuing_authorization_request(p_card text, p_authorization text, p_amount numeric, p_currency text, p_event jsonb) RETURNS jsonb
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'public', 'pg_temp'
    AS $$
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


--
-- Name: record_issuing_transaction(text, text, text, numeric, text, text, jsonb); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.record_issuing_transaction(p_id text, p_authorization text, p_card text, p_amount numeric, p_currency text, p_type text, p_event jsonb) RETURNS void
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'public', 'pg_temp'
    AS $$
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


--
-- Name: record_job_settlement(uuid, uuid, numeric, numeric, numeric, numeric, numeric, text, text, text, boolean); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.record_job_settlement(p_job_id uuid, p_driver_id uuid, p_total_price numeric, p_driver_payout numeric, p_platform_fee numeric, p_commission_fee numeric, p_commission_rate numeric, p_stripe_transfer_id text, p_currency_code text, p_country_code text, p_was_already_completed boolean) RETURNS SETOF public.jobs
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'public'
    AS $$
BEGIN
  RETURN QUERY
  UPDATE public.jobs SET
    status = CASE WHEN p_was_already_completed THEN status ELSE 'completed' END,
    payment_status = 'paid',
    driver_id = p_driver_id,
    price = p_total_price,
    total_price = p_total_price,
    driver_payout = p_driver_payout,
    platform_fee = p_platform_fee,
    commission_fee = p_commission_fee,
    commission_rate_used = p_commission_rate,
    stripe_transfer_id = p_stripe_transfer_id,
    stripe_transfer_status = 'succeeded',
    settlement_status = 'transferred',
    transferred_at = COALESCE(transferred_at, now()),
    completed_at = CASE WHEN p_was_already_completed THEN completed_at ELSE COALESCE(completed_at, now()) END,
    updated_at = now()
  WHERE id = p_job_id
  RETURNING *;

  INSERT INTO public.driver_earnings
    (driver_id, job_id, amount, platform_fee, gross_amount, status, currency_code, country_code, stripe_transfer_id, settled_at)
  VALUES
    (p_driver_id, p_job_id, p_driver_payout, p_platform_fee, p_total_price, 'paid', p_currency_code, p_country_code, p_stripe_transfer_id, now())
  ON CONFLICT (job_id) DO UPDATE SET
    driver_id = EXCLUDED.driver_id,
    amount = EXCLUDED.amount,
    platform_fee = EXCLUDED.platform_fee,
    gross_amount = EXCLUDED.gross_amount,
    status = 'paid',
    currency_code = EXCLUDED.currency_code,
    country_code = EXCLUDED.country_code,
    stripe_transfer_id = EXCLUDED.stripe_transfer_id,
    settled_at = now();
END;
$$;


--
-- Name: record_no_show_settlement(uuid, uuid, bigint, bigint, bigint, text, text); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.record_no_show_settlement(p_job_id uuid, p_driver_id uuid, p_amount_minor bigint, p_platform_share_minor bigint, p_fee_minor bigint, p_currency text, p_stripe_transfer_id text) RETURNS SETOF public.jobs
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'public'
    AS $$
BEGIN
  RETURN QUERY
  UPDATE public.jobs SET
    settlement_status = 'transferred',
    settlement_purpose = 'no_show_compensation',
    stripe_transfer_id = p_stripe_transfer_id,
    stripe_transfer_status = 'succeeded',
    transferred_at = COALESCE(transferred_at, now()),
    updated_at = now()
  WHERE id = p_job_id AND status = 'cancelled'
  RETURNING *;

  INSERT INTO public.driver_earnings
    (driver_id, job_id, amount, platform_fee, gross_amount, status, currency_code, country_code, stripe_transfer_id, settled_at, settlement_purpose)
  VALUES
    (p_driver_id, p_job_id, p_amount_minor / 100.0, p_platform_share_minor / 100.0, p_fee_minor / 100.0,
     'paid', p_currency, 'GB', p_stripe_transfer_id, now(), 'no_show_compensation')
  ON CONFLICT (job_id) DO UPDATE SET
    amount = EXCLUDED.amount,
    platform_fee = EXCLUDED.platform_fee,
    gross_amount = EXCLUDED.gross_amount,
    status = 'paid',
    stripe_transfer_id = EXCLUDED.stripe_transfer_id,
    settlement_purpose = EXCLUDED.settlement_purpose,
    settled_at = now();
END;
$$;


--
-- Name: record_wallet_topup_provider_reference(uuid, text); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.record_wallet_topup_provider_reference(p_attempt_id uuid, p_provider_reference text) RETURNS boolean
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'pg_catalog', 'public'
    AS $$
DECLARE a public.wallet_topup_attempts%ROWTYPE;
BEGIN
  SELECT * INTO a FROM public.wallet_topup_attempts WHERE id = p_attempt_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Batch 1C: attempt not found' USING ERRCODE = 'BP003'; END IF;
  IF p_provider_reference IS NULL OR btrim(p_provider_reference) = '' THEN
    RAISE EXCEPTION 'Batch 1C: provider_reference is required' USING ERRCODE = 'BP004';
  END IF;
  IF a.provider_reference IS NOT NULL THEN
    IF a.provider_reference = p_provider_reference THEN RETURN true; END IF;
    RAISE EXCEPTION 'Batch 1C: provider reference already bound; never switch providers' USING ERRCODE = 'BP008';
  END IF;
  IF a.status NOT IN ('initiated','submitting','uncertain') THEN
    RAISE EXCEPTION 'Batch 1C: attempt is not awaiting provider reference' USING ERRCODE = 'BP008';
  END IF;
  UPDATE public.wallet_topup_attempts SET provider_reference = p_provider_reference, status = 'provider_pending'
  WHERE id = p_attempt_id;
  RETURN true;
END
$$;


--
-- Name: record_wallet_topup_verification(uuid, text, text, text, text, bigint, text); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.record_wallet_topup_verification(p_attempt_id uuid, p_evidence_key text, p_provider_reference text, p_merchant_account_ref text, p_currency_code text, p_amount_minor bigint, p_final_status text) RETURNS boolean
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'pg_catalog', 'public'
    AS $$
BEGIN
  IF p_evidence_key IS NULL OR btrim(p_evidence_key) = '' THEN
    RAISE EXCEPTION 'Batch 1C: evidence_key is required' USING ERRCODE = 'BP004';
  END IF;
  IF p_final_status IS NULL OR p_final_status NOT IN ('succeeded','completed','failed','pending','unknown') THEN
    RAISE EXCEPTION 'Batch 1C: invalid final status %', p_final_status USING ERRCODE = 'BP008';
  END IF;
  PERFORM pg_advisory_xact_lock(hashtextextended('wallet-topup-evidence:' || p_evidence_key, 0));
  -- Idempotent only for identical evidence; conflicting reuse is rejected.
  IF EXISTS (SELECT 1 FROM public.wallet_topup_verifications WHERE evidence_key = p_evidence_key) THEN
    IF EXISTS (SELECT 1 FROM public.wallet_topup_verifications WHERE evidence_key = p_evidence_key
               AND attempt_id = p_attempt_id AND provider_reference IS NOT DISTINCT FROM p_provider_reference
               AND merchant_account_ref IS NOT DISTINCT FROM p_merchant_account_ref
               AND currency_code IS NOT DISTINCT FROM p_currency_code
               AND amount_minor IS NOT DISTINCT FROM p_amount_minor
               AND final_status = p_final_status) THEN
      RETURN true;
    END IF;
    RAISE EXCEPTION 'Batch 1C: evidence_key % reused with conflicting evidence', p_evidence_key USING ERRCODE = 'BP002';
  END IF;
  INSERT INTO public.wallet_topup_verifications
    (attempt_id, evidence_key, provider_reference, merchant_account_ref, currency_code, amount_minor, final_status)
  VALUES
    (p_attempt_id, p_evidence_key, p_provider_reference, p_merchant_account_ref, p_currency_code, p_amount_minor, p_final_status);
  RETURN true;
END
$$;


--
-- Name: reject_errand_over_budget(uuid); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.reject_errand_over_budget(p_job_id uuid) RETURNS boolean
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'public', 'pg_temp'
    AS $$
DECLARE j public.jobs%ROWTYPE;
BEGIN
 SELECT * INTO STRICT j FROM public.jobs WHERE id=p_job_id FOR UPDATE;
 IF auth.uid() IS DISTINCT FROM j.customer_id AND coalesce(auth.role(),'')<>'service_role' AND session_user NOT IN ('postgres','supabase_admin') THEN RAISE EXCEPTION 'Only the customer can reject a budget increase'; END IF;
 IF j.status IN ('cancelled','canceled','expired','failed','no_driver_found','completed','settled','delivered') THEN RAISE EXCEPTION 'Booking is no longer active'; END IF;
 UPDATE public.errand_funding SET status='reserved',over_budget_status='rejected',requested_over_budget_amount=0,updated_at=now() WHERE job_id=j.id AND status='over_budget_requested';
 RETURN TRUE;
END $$;


--
-- Name: release_job_refund(uuid, bigint); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.release_job_refund(p_job_id uuid, p_amount_minor bigint) RETURNS void
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'public'
    AS $$
BEGIN
  UPDATE public.jobs
  SET total_refunded_minor = GREATEST(0, total_refunded_minor - p_amount_minor)
  WHERE id = p_job_id;
END;
$$;


--
-- Name: release_job_reversal(uuid, bigint); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.release_job_reversal(p_job_id uuid, p_amount_minor bigint) RETURNS void
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'public'
    AS $$
BEGIN
  UPDATE public.jobs
  SET total_reversed_minor = GREATEST(0, total_reversed_minor - p_amount_minor)
  WHERE id = p_job_id;
END;
$$;


--
-- Name: release_job_wallet_reservation(uuid, text); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.release_job_wallet_reservation(p_job_id uuid, p_reason text DEFAULT 'Wallet reservation released'::text) RETURNS jsonb
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'public', 'pg_temp'
    AS $$
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


--
-- Name: release_marketplace_negotiation(uuid, uuid, text); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.release_marketplace_negotiation(p_job_id uuid, p_driver_id uuid, p_reason text) RETURNS public.marketplace_negotiation_sessions
    LANGUAGE plpgsql SECURITY DEFINER
    AS $$
DECLARE
  v_session public.marketplace_negotiation_sessions;
BEGIN
  -- Release closure: a non-service_role caller must act for themselves and may
  -- not spoof a system release.
  IF auth.uid() IS NOT NULL THEN
    IF auth.uid() <> p_driver_id THEN
      RAISE EXCEPTION 'You can only release your own negotiation session';
    END IF;
    IF p_reason = 'system' THEN
      RAISE EXCEPTION 'System release requires service role';
    END IF;
  END IF;

  SELECT * INTO v_session
  FROM public.marketplace_negotiation_sessions
  WHERE job_id = p_job_id
  FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'No negotiation session found';
  END IF;

  IF v_session.active_driver_id IS DISTINCT FROM p_driver_id AND p_reason <> 'system' THEN
    RAISE EXCEPTION 'Only active driver or system can release session';
  END IF;

  UPDATE public.marketplace_negotiation_sessions
  SET active_driver_id = NULL,
      status = 'released',
      attempt_count = attempt_count + 1,
      driver_counter_offer = NULL,
      updated_at = now()
  WHERE job_id = p_job_id
  RETURNING * INTO v_session;

  INSERT INTO public.driver_job_declines (driver_id, job_id, reason)
  VALUES (p_driver_id, p_job_id, p_reason)
  ON CONFLICT (driver_id, job_id) DO NOTHING;

  INSERT INTO public.marketplace_negotiation_events
    (session_id, job_id, proposed_by, proposed_by_role, event_type, message, round_number, created_at)
  VALUES
    (v_session.id, p_job_id, p_driver_id, 'driver', 'session_released', p_reason, v_session.round_count, now());

  RETURN v_session;
END;
$$;


--
-- Name: release_refund_operation(uuid); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.release_refund_operation(p_operation_id uuid) RETURNS public.refund_operations
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'public'
    AS $$
DECLARE
  v_op public.refund_operations;
BEGIN
  SELECT * INTO v_op FROM public.refund_operations WHERE id = p_operation_id FOR UPDATE;
  IF NOT FOUND THEN RETURN NULL; END IF;
  IF v_op.status IN ('released','executed') THEN RETURN v_op; END IF;

  UPDATE public.jobs SET
    total_refunded_minor         = GREATEST(0, total_refunded_minor - v_op.amount_minor),
    total_budget_refunded_minor  = GREATEST(0, total_budget_refunded_minor - v_op.budget_component_minor),
    total_service_refunded_minor = GREATEST(0, total_service_refunded_minor - v_op.service_component_minor)
  WHERE id = v_op.job_id;

  UPDATE public.refund_operations SET status = 'released', updated_at = now()
  WHERE id = p_operation_id RETURNING * INTO v_op;
  RETURN v_op;
END;
$$;


--
-- Name: release_reversal_operation(uuid); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.release_reversal_operation(p_operation_id uuid) RETURNS public.refund_operations
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'public'
    AS $$
DECLARE
  v_op public.refund_operations;
BEGIN
  SELECT * INTO v_op FROM public.refund_operations WHERE id = p_operation_id FOR UPDATE;
  IF NOT FOUND THEN RETURN NULL; END IF;
  IF v_op.status IN ('released','executed') THEN RETURN v_op; END IF;

  UPDATE public.jobs SET
    total_reversed_minor = GREATEST(0, total_reversed_minor - v_op.amount_minor)
  WHERE id = v_op.job_id;

  UPDATE public.refund_operations SET status = 'released', updated_at = now()
  WHERE id = p_operation_id RETURNING * INTO v_op;
  RETURN v_op;
END;
$$;


--
-- Name: release_stale_negotiation_lease(uuid); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.release_stale_negotiation_lease(p_session_id uuid) RETURNS boolean
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'public'
    AS $$
DECLARE
  v_session public.marketplace_negotiation_sessions;
  v_job public.jobs;
  v_lease INTEGER;
  v_max_attempts INTEGER;
  v_driver UUID;
BEGIN
  IF p_session_id IS NULL THEN
    RETURN FALSE;
  END IF;

  SELECT * INTO v_session
  FROM public.marketplace_negotiation_sessions
  WHERE id = p_session_id
  FOR UPDATE;

  IF NOT FOUND THEN
    RETURN FALSE;
  END IF;

  -- Only a CLAIMED, still-live lease can go stale.
  IF v_session.active_driver_id IS NULL THEN
    RETURN FALSE;
  END IF;
  IF v_session.status NOT IN ('open', 'driver_claimed', 'negotiating') THEN
    RETURN FALSE;
  END IF;
  IF v_session.expires_at IS NULL OR v_session.expires_at > now() THEN
    RETURN FALSE;
  END IF;

  SELECT * INTO v_job FROM public.jobs WHERE id = v_session.job_id;
  IF NOT FOUND THEN
    RETURN FALSE;
  END IF;

  -- OVERALL marketplace deadline must still be valid: the request must still be
  -- negotiating. Once the job is terminal, an expired attempt is NOT recycled.
  IF v_job.status NOT IN ('pending_fare_confirmation', 'negotiating', 'open') THEN
    RETURN FALSE;
  END IF;
  IF v_job.expires_at IS NOT NULL AND v_job.expires_at <= now() THEN
    RETURN FALSE;
  END IF;

  v_max_attempts := COALESCE(
    (public.get_marketplace_setting('hybrid_negotiation', v_job.tenant_id)->>'maxDriverAttempts')::INTEGER,
    5
  );
  IF v_session.attempt_count >= v_max_attempts THEN
    RETURN FALSE;
  END IF;

  v_lease := COALESCE(
    (public.get_marketplace_setting('hybrid_negotiation', v_job.tenant_id)->>'timeoutSeconds')::INTEGER,
    120
  );

  v_driver := v_session.active_driver_id;

  UPDATE public.marketplace_negotiation_sessions
  SET status = 'released',
      active_driver_id = NULL,             -- A loses authority
      driver_counter_offer = NULL,         -- stale A counter is NOT actionable
      claimed_at = NULL,
      attempt_count = attempt_count + 1,   -- existing release convention
      expires_at = public.negotiation_lease_expiry(v_session.job_id, v_lease),
      updated_at = now()
      -- customer_offer is INTENTIONALLY retained: the next eligible driver must
      -- answer the customer's CURRENT proposal.
  WHERE id = v_session.id;

  INSERT INTO public.marketplace_negotiation_events (
    session_id, job_id, proposed_by, proposed_by_role,
    event_type, message, round_number, created_at
  ) VALUES (
    v_session.id, v_session.job_id, v_driver, 'driver',
    'session_released', 'Driver lease expired', v_session.round_count, now()
  );

  -- TURN RECONCILIATION (required): the event ledger still holds the expired
  -- driver's `driver_counter` as the latest FARE event, so the canonical turn
  -- would keep pointing at the driver even though driver_counter_offer is now
  -- NULL — which made the next driver's counter fail with "There is no customer
  -- offer awaiting a response". Re-assert the RETAINED customer proposal so the
  -- live fare proposal is unambiguously the customer's again (phase becomes
  -- waiting_for_driver while unclaimed, driver_turn once the next driver claims).
  IF v_session.customer_offer IS NOT NULL AND v_session.customer_offer > 0 THEN
    INSERT INTO public.marketplace_negotiation_events (
      session_id, job_id, proposed_by, proposed_by_role,
      event_type, amount, round_number, created_at
    ) VALUES (
      v_session.id, v_session.job_id, v_session.customer_id, 'customer',
      'customer_offer', v_session.customer_offer, v_session.round_count, now()
    );
  END IF;

  RETURN TRUE;
END;
$$;


--
-- Name: request_errand_over_budget(uuid, numeric, text); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.request_errand_over_budget(p_job_id uuid, p_amount numeric, p_reason text DEFAULT NULL::text) RETURNS boolean
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'public', 'pg_temp'
    AS $$
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


--
-- Name: reserve_cash_job_credit_v1e(uuid, uuid); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.reserve_cash_job_credit_v1e(p_job_id uuid, p_driver_id uuid) RETURNS uuid
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'pg_catalog', 'public'
    AS $$
DECLARE j public.jobs%ROWTYPE; enrol public.driver_cash_credit_enrolments_v1e%ROWTYPE; p jsonb; terms jsonb; balance jsonb; h public.driver_cash_credit_holds_v1e%ROWTYPE; v_id uuid; event uuid; need bigint; driver uuid;
BEGIN
 IF NOT public.driver_cash_credit_enabled_v1e() THEN RAISE EXCEPTION 'Cash credit pilot disabled' USING ERRCODE='CE001'; END IF;
 SELECT * INTO STRICT j FROM public.jobs WHERE id=p_job_id FOR UPDATE;
 driver:=coalesce(j.driver_id,j.accepted_driver_id);
 IF driver IS DISTINCT FROM p_driver_id OR p_driver_id IS NULL OR (j.driver_id IS NOT NULL AND j.accepted_driver_id IS NOT NULL AND j.driver_id<>j.accepted_driver_id)
 OR j.payment_method IS DISTINCT FROM 'cash' OR j.status IS NULL OR j.status NOT IN ('assigned','accepted','heading_to_pickup','driver_en_route','arrived','in_progress','completed','delivered','settled') THEN
  RAISE EXCEPTION 'Cash booking/driver is not eligible' USING ERRCODE='CE002'; END IF;
 IF NOT EXISTS(SELECT 1 FROM public.service_types WHERE id=j.service_type_id AND slug='ride') THEN
  RAISE EXCEPTION 'Cash credit pilot supports Ride only' USING ERRCODE='CE002'; END IF;
 PERFORM public.driver_cash_credit_lock_v1e(j.tenant_id,p_driver_id,j.currency_code);
 SELECT to_jsonb(x) INTO p FROM public.profiles x WHERE id=p_driver_id;
 SELECT * INTO enrol FROM public.driver_cash_credit_enrolments_v1e WHERE tenant_id=j.tenant_id AND driver_id=p_driver_id AND country_code=j.country_code AND currency_code=j.currency_code FOR SHARE;
 IF p IS NULL OR p->>'role' IS DISTINCT FROM 'driver' OR NULLIF(p->>'registration_activated_at','') IS NULL
 OR NOT public.driver_job_market_matches_v23(p,to_jsonb(j))
 OR NOT EXISTS(SELECT 1 FROM public.market_availability m WHERE m.country_code=j.country_code AND upper(m.supported_currency)=j.currency_code)
 OR enrol.driver_id IS NULL OR NOT enrol.enabled OR enrol.consented_at>now() THEN
  RAISE EXCEPTION 'Driver cash credit is not approved for this tenant/market' USING ERRCODE='CE002'; END IF;
 terms:=public.cash_credit_terms_v1e(j.fare_breakdown,j.currency_code);need:=(terms->>'required')::bigint;
 IF j.fare_breakdown ? 'driverCommissionPolicy' AND j.fare_breakdown->'driverCommissionPolicy'->>'driverId' IS DISTINCT FROM p_driver_id::text THEN
  RAISE EXCEPTION 'Frozen commission belongs to another driver' USING ERRCODE='CE003'; END IF;
 IF j.agreed_fare IS NOT NULL AND public.cash_credit_minor_v1e(to_jsonb(j.agreed_fare),j.currency_code)<>(terms->>'charge')::bigint THEN
  RAISE EXCEPTION 'Agreed fare does not match frozen cash terms' USING ERRCODE='CE003'; END IF;
 SELECT * INTO h FROM public.driver_cash_credit_holds_v1e WHERE job_id=j.id FOR UPDATE;
 IF FOUND THEN
  IF h.driver_id<>p_driver_id OR h.tenant_id<>j.tenant_id OR h.currency_code<>j.currency_code OR h.country_code<>j.country_code OR h.fare_snapshot IS DISTINCT FROM j.fare_breakdown OR h.status='released' THEN
   RAISE EXCEPTION 'Cash reservation replay terms changed' USING ERRCODE='CE005'; END IF;
  RETURN h.id;
 END IF;
 IF j.metadata->>'cash_collection_mode' IS DISTINCT FROM 'full_customer_charge' OR j.payment_intent_id IS NOT NULL OR j.payment_status IS NULL OR j.payment_status NOT IN ('pending','cash_due','cash_pending') THEN
  RAISE EXCEPTION 'Explicit full-cash custody and no digital payment required' USING ERRCODE='CE002'; END IF;
 IF j.status IN ('completed','delivered','settled') THEN RAISE EXCEPTION 'Cannot create a new cash hold after completion' USING ERRCODE='CE006'; END IF;
 balance:=public.driver_cash_credit_balance_v1e(j.tenant_id,p_driver_id,j.currency_code);
 IF NOT (balance->>'consistent')::boolean OR (balance->>'deficitMinor')::numeric>0 THEN RAISE EXCEPTION 'Cash credit requires reconciliation' USING ERRCODE='CE006'; END IF;
 IF (balance->>'availableMinor')::numeric<need THEN RAISE EXCEPTION 'Top up driver cash credit before accepting this cash ride' USING ERRCODE='CE004'; END IF;
 v_id:=gen_random_uuid();
 IF need>0 THEN
  event:=public.post_wallet_event('cash-hold:'||v_id::text,'cash_credit_reserve',j.tenant_id,p_driver_id,j.currency_code,
   jsonb_build_array(jsonb_build_object('accountPurpose','driver_cash_credit','amountMinor',-need),jsonb_build_object('accountPurpose','driver_cash_credit_reserved','amountMinor',need)));
 END IF;
 INSERT INTO public.driver_cash_credit_holds_v1e(id,job_id,tenant_id,driver_id,country_code,currency_code,fare_snapshot,enrolment_terms_version,enrolment_consented_at,customer_charge_minor,commission_minor,platform_fee_minor,driver_entitlement_minor,required_credit_minor,reserve_event_id)
 VALUES(v_id,j.id,j.tenant_id,p_driver_id,j.country_code,j.currency_code,j.fare_breakdown,enrol.terms_version,enrol.consented_at,(terms->>'charge')::bigint,(terms->>'commission')::bigint,(terms->>'fee')::bigint,(terms->>'net')::bigint,need,event);
 RETURN v_id;
END $$;


--
-- Name: reserve_errand_funds(uuid, uuid, numeric, numeric); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.reserve_errand_funds(p_job_id uuid, p_customer_id uuid, p_item_budget numeric, p_service_estimate numeric) RETURNS boolean
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'public', 'pg_temp'
    AS $$
DECLARE j public.jobs%ROWTYPE;
BEGIN
 SELECT * INTO STRICT j FROM public.jobs WHERE id=p_job_id;
 PERFORM public.pay_job_from_wallet(p_job_id,p_customer_id,p_item_budget+p_service_estimate,j.currency_code,j.tenant_id);
 RETURN true;
END $$;


--
-- Name: reserve_job_issuing_budget(uuid, numeric, numeric, text); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.reserve_job_issuing_budget(p_job uuid, p_budget numeric, p_available numeric, p_currency text) RETURNS void
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'public', 'pg_temp'
    AS $$
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


--
-- Name: reserve_job_refund(uuid, bigint, bigint); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.reserve_job_refund(p_job_id uuid, p_amount_minor bigint, p_captured_minor bigint) RETURNS boolean
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'public'
    AS $$
DECLARE
  v_current bigint;
BEGIN
  SELECT total_refunded_minor INTO v_current FROM public.jobs WHERE id = p_job_id FOR UPDATE;
  IF NOT FOUND THEN RETURN false; END IF;
  IF p_amount_minor <= 0 OR (v_current + p_amount_minor) > p_captured_minor THEN RETURN false; END IF;
  UPDATE public.jobs SET total_refunded_minor = v_current + p_amount_minor WHERE id = p_job_id;
  RETURN true;
END;
$$;


--
-- Name: reserve_job_reversal(uuid, bigint, bigint); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.reserve_job_reversal(p_job_id uuid, p_amount_minor bigint, p_transfer_minor bigint) RETURNS boolean
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'public'
    AS $$
DECLARE
  v_current bigint;
BEGIN
  SELECT total_reversed_minor INTO v_current FROM public.jobs WHERE id = p_job_id FOR UPDATE;
  IF NOT FOUND THEN RETURN false; END IF;
  IF p_amount_minor <= 0 OR (v_current + p_amount_minor) > p_transfer_minor THEN RETURN false; END IF;
  UPDATE public.jobs SET total_reversed_minor = v_current + p_amount_minor WHERE id = p_job_id;
  RETURN true;
END;
$$;


--
-- Name: reserve_kora_sandbox_booking(jsonb); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.reserve_kora_sandbox_booking(p_row jsonb) RETURNS jsonb
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'public', 'pg_temp'
    AS $$
DECLARE j public.jobs; e public.kora_sandbox_booking_enrolments; b public.kora_sandbox_booking_payments;
 job uuid:=(p_row->>'job_id')::uuid; owner_id uuid:=(p_row->>'user_id')::uuid; amount bigint:=(p_row->>'amount_minor')::bigint;
BEGIN
 SELECT * INTO j FROM public.jobs WHERE id=job FOR UPDATE;
 IF NOT FOUND OR j.customer_id IS DISTINCT FROM owner_id THEN RAISE EXCEPTION 'Booking owner mismatch'; END IF;
 SELECT * INTO e FROM public.kora_sandbox_booking_enrolments WHERE job_id=job FOR SHARE;
 IF NOT FOUND OR NOT e.active OR e.user_id IS DISTINCT FROM owner_id THEN RAISE EXCEPTION 'Sandbox booking not enrolled'; END IF;
 IF j.status IS DISTINCT FROM 'completed' OR to_jsonb(j)->>'country_code' IS DISTINCT FROM 'NG'
 OR to_jsonb(j)->>'currency_code' IS DISTINCT FROM 'NGN'
 OR coalesce(to_jsonb(j)->>'payment_intent_id','')<>'' OR to_jsonb(j)->>'payment_method'='wallet'
 OR coalesce(j.payment_status,'') NOT IN ('pending','unpaid')
 OR NOT EXISTS(SELECT 1 FROM public.service_types WHERE id=j.service_type_id AND slug='ride')
 OR EXISTS(SELECT 1 FROM public.driver_earnings WHERE job_id=job)
 OR EXISTS(SELECT 1 FROM public.job_payout_queue WHERE job_id=job)
 OR EXISTS(SELECT 1 FROM public.job_payment_bindings WHERE job_id=job) THEN
   RAISE EXCEPTION 'Completed unpaid isolated ride required';
 END IF;
 IF public.kora_sandbox_booking_snapshot(job) IS DISTINCT FROM p_row->'booking_snapshot'
 OR p_row->>'currency' IS DISTINCT FROM 'NGN'
 OR to_jsonb(j)->'fare_breakdown'->>'policyVersion' IS DISTINCT FROM 'fare-split-v1'
 OR amount<10000 OR amount>9007199254740991
 OR (to_jsonb(j)->'fare_breakdown'->>'customerCharge')::numeric*100 IS DISTINCT FROM amount::numeric THEN
   RAISE EXCEPTION 'Frozen booking terms differ';
 END IF;
 SELECT * INTO b FROM public.kora_sandbox_booking_payments WHERE job_id=job FOR UPDATE;
 IF FOUND THEN
   IF b.user_id IS DISTINCT FROM owner_id OR b.reference IS DISTINCT FROM p_row->>'reference'
   OR b.merchant_account_ref IS DISTINCT FROM p_row->>'merchant_account_ref'
   OR b.amount_minor IS DISTINCT FROM amount OR b.booking_snapshot IS DISTINCT FROM p_row->'booking_snapshot' THEN
     RAISE EXCEPTION 'Original sandbox payment binding required';
   END IF;
   RETURN jsonb_build_object('created',false,'payment',to_jsonb(b));
 END IF;
 INSERT INTO public.kora_sandbox_booking_payments(job_id,user_id,reference,merchant_account_ref,currency,amount_minor,booking_snapshot)
 VALUES(job,owner_id,p_row->>'reference',p_row->>'merchant_account_ref','NGN',amount,p_row->'booking_snapshot') RETURNING * INTO b;
 RETURN jsonb_build_object('created',true,'payment',to_jsonb(b));
END $$;


--
-- Name: reserve_refund_operation(uuid, bigint, bigint, bigint, text, text); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.reserve_refund_operation(p_job_id uuid, p_amount_minor bigint, p_captured_minor bigint, p_service_fare_minor bigint, p_idempotency_key text, p_purpose text DEFAULT NULL::text) RETURNS public.refund_operations
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'public'
    AS $$
DECLARE
  v_job public.jobs;
  v_budget_remaining bigint;
  v_service_remaining bigint;
  v_budget_component bigint;
  v_service_component bigint;
  v_op public.refund_operations;
BEGIN
  SELECT * INTO v_job FROM public.jobs WHERE id = p_job_id FOR UPDATE;
  IF NOT FOUND THEN RETURN NULL; END IF;

  -- Idempotent resume: a repeat of the same key returns the SAME operation.
  SELECT * INTO v_op FROM public.refund_operations
    WHERE job_id = p_job_id AND operation_type = 'refund' AND idempotency_key = p_idempotency_key
      AND status IN ('reserved','executed','unknown')
    LIMIT 1;
  IF FOUND THEN RETURN v_op; END IF;

  v_budget_remaining  := GREATEST(0, (p_captured_minor - p_service_fare_minor) - COALESCE(v_job.total_budget_refunded_minor, 0));
  v_service_remaining := GREATEST(0, p_service_fare_minor - COALESCE(v_job.total_service_refunded_minor, 0));

  -- Budget is refunded first, then the service fare.
  v_budget_component  := LEAST(p_amount_minor, v_budget_remaining);
  v_service_component := p_amount_minor - v_budget_component;

  IF p_amount_minor <= 0 THEN RETURN NULL; END IF;
  IF v_service_component > v_service_remaining THEN RETURN NULL; END IF;
  IF p_amount_minor > (v_budget_remaining + v_service_remaining) THEN RETURN NULL; END IF;

  UPDATE public.jobs SET
    total_refunded_minor         = COALESCE(total_refunded_minor, 0) + p_amount_minor,
    total_budget_refunded_minor  = COALESCE(total_budget_refunded_minor, 0) + v_budget_component,
    total_service_refunded_minor = COALESCE(total_service_refunded_minor, 0) + v_service_component
  WHERE id = p_job_id;

  INSERT INTO public.refund_operations
    (job_id, operation_type, amount_minor, service_component_minor, budget_component_minor, purpose, idempotency_key, status)
  VALUES
    (p_job_id, 'refund', p_amount_minor, v_service_component, v_budget_component, p_purpose, p_idempotency_key, 'reserved')
  RETURNING * INTO v_op;

  RETURN v_op;
END;
$$;


--
-- Name: reserve_reversal_operation(uuid, bigint, bigint, text, text); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.reserve_reversal_operation(p_job_id uuid, p_amount_minor bigint, p_transfer_minor bigint, p_idempotency_key text, p_purpose text DEFAULT NULL::text) RETURNS public.refund_operations
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'public'
    AS $$
DECLARE
  v_job public.jobs;
  v_op public.refund_operations;
BEGIN
  SELECT * INTO v_job FROM public.jobs WHERE id = p_job_id FOR UPDATE;
  IF NOT FOUND THEN RETURN NULL; END IF;

  SELECT * INTO v_op FROM public.refund_operations
    WHERE job_id = p_job_id AND operation_type = 'reversal' AND idempotency_key = p_idempotency_key
      AND status IN ('reserved','executed','unknown')
    LIMIT 1;
  IF FOUND THEN RETURN v_op; END IF;

  IF p_amount_minor <= 0 THEN RETURN NULL; END IF;
  IF (COALESCE(v_job.total_reversed_minor, 0) + p_amount_minor) > p_transfer_minor THEN RETURN NULL; END IF;

  UPDATE public.jobs SET
    total_reversed_minor = COALESCE(total_reversed_minor, 0) + p_amount_minor
  WHERE id = p_job_id;

  INSERT INTO public.refund_operations
    (job_id, operation_type, amount_minor, service_component_minor, budget_component_minor, purpose, idempotency_key, status)
  VALUES
    (p_job_id, 'reversal', p_amount_minor, p_amount_minor, 0, p_purpose, p_idempotency_key, 'reserved')
  RETURNING * INTO v_op;

  RETURN v_op;
END;
$$;


--
-- Name: resolve_cash_job_credit_v1e(uuid, text); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.resolve_cash_job_credit_v1e(p_job_id uuid, p_outcome text) RETURNS uuid
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'pg_catalog', 'public'
    AS $$
DECLARE j public.jobs%ROWTYPE; h public.driver_cash_credit_holds_v1e%ROWTYPE; event uuid; reserved numeric;
BEGIN
 SELECT * INTO STRICT j FROM public.jobs WHERE id=p_job_id FOR UPDATE;
 SELECT * INTO h FROM public.driver_cash_credit_holds_v1e WHERE job_id=p_job_id FOR UPDATE;
 IF NOT FOUND THEN RAISE EXCEPTION 'Cash hold missing' USING ERRCODE='CE006'; END IF;
 PERFORM public.driver_cash_credit_lock_v1e(h.tenant_id,h.driver_id,h.currency_code);
 IF p_outcome IS NULL OR p_outcome NOT IN ('released','settled') THEN RAISE EXCEPTION 'Invalid cash resolution' USING ERRCODE='CE003'; END IF;
 IF p_outcome='released' AND (j.status IS NULL OR j.status NOT IN ('cancelled','canceled','expired','failed','no_driver_found')) THEN RAISE EXCEPTION 'Only cancelled/failed cash rides release credit' USING ERRCODE='CE006'; END IF;
 IF p_outcome='settled' AND (j.status IS NULL OR j.status NOT IN ('completed','delivered','settled') OR coalesce(j.driver_id,j.accepted_driver_id) IS DISTINCT FROM h.driver_id OR j.payment_method IS DISTINCT FROM 'cash' OR j.fare_breakdown IS DISTINCT FROM h.fare_snapshot OR j.tenant_id<>h.tenant_id OR j.currency_code<>h.currency_code OR j.country_code<>h.country_code) THEN
  RAISE EXCEPTION 'Cash completion terms/state mismatch' USING ERRCODE='CE006'; END IF;
 IF h.status=p_outcome THEN RETURN h.id; END IF;
 IF h.status<>'held' THEN RAISE EXCEPTION 'Cash hold already resolved differently' USING ERRCODE='CE005'; END IF;
 SELECT coalesce(sum(m.amount_minor::numeric),0) INTO reserved FROM public.wallet_accounts a JOIN public.wallet_movements m ON m.account_id=a.id
 WHERE a.tenant_id=h.tenant_id AND a.owner_id=h.driver_id AND a.currency_code=h.currency_code AND a.balance_purpose='driver_cash_credit_reserved';
 IF reserved IS DISTINCT FROM (SELECT coalesce(sum(required_credit_minor::numeric),0) FROM public.driver_cash_credit_holds_v1e WHERE tenant_id=h.tenant_id AND driver_id=h.driver_id AND currency_code=h.currency_code AND status='held') OR reserved<h.required_credit_minor THEN RAISE EXCEPTION 'Cash reserved ledger requires reconciliation' USING ERRCODE='CE006'; END IF;
 IF h.required_credit_minor>0 THEN
  IF p_outcome='released' THEN event:=public.post_wallet_reversal('cash-hold:'||h.id::text,'cash-hold:'||h.id::text||':release');
  ELSE event:=public.post_wallet_event('cash-hold:'||h.id::text||':settle','cash_credit_settle',h.tenant_id,h.driver_id,h.currency_code,
    jsonb_build_array(jsonb_build_object('accountPurpose','driver_cash_credit_reserved','amountMinor',-h.required_credit_minor),jsonb_build_object('accountPurpose','cash_fee_clearing','amountMinor',h.required_credit_minor)));
  END IF;
 END IF;
 UPDATE public.driver_cash_credit_holds_v1e SET status=p_outcome,resolution_event_id=event,resolved_at=now() WHERE id=h.id;
 RETURN h.id;
END $$;


--
-- Name: safe_iso_date(text); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.safe_iso_date(p_raw text) RETURNS date
    LANGUAGE plpgsql IMMUTABLE
    SET search_path TO 'public', 'pg_temp'
    AS $_$
DECLARE
    v_raw TEXT;
BEGIN
    v_raw := NULLIF(BTRIM(COALESCE(p_raw, '')), '');
    IF v_raw IS NULL OR v_raw !~ '^\d{4}-\d{2}-\d{2}$' THEN
        RETURN NULL;
    END IF;
    BEGIN
        RETURN v_raw::DATE;
    EXCEPTION WHEN others THEN
        RETURN NULL;
    END;
END;
$_$;


--
-- Name: sandbox_attempt_guard_v1l(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.sandbox_attempt_guard_v1l() RETURNS trigger
    LANGUAGE plpgsql
    SET search_path TO 'pg_catalog', 'public'
    AS $$ BEGIN
 IF TG_OP='DELETE' THEN RAISE EXCEPTION 'Sandbox history protected' USING ERRCODE='BL006';END IF;
 IF (NEW.id,NEW.owner_id,NEW.tenant_id,NEW.idempotency_key,NEW.reference,NEW.provider,NEW.mode,NEW.credential_fingerprint,NEW.merchant_account_ref,NEW.country_code,NEW.currency_code,NEW.minor_exponent,NEW.amount_minor,NEW.created_at)
 IS DISTINCT FROM (OLD.id,OLD.owner_id,OLD.tenant_id,OLD.idempotency_key,OLD.reference,OLD.provider,OLD.mode,OLD.credential_fingerprint,OLD.merchant_account_ref,OLD.country_code,OLD.currency_code,OLD.minor_exponent,OLD.amount_minor,OLD.created_at) THEN RAISE EXCEPTION 'Sandbox terms frozen' USING ERRCODE='BL006';END IF;
 IF OLD.status IN ('verified_test_only','failed') AND NEW.status IS DISTINCT FROM OLD.status THEN RAISE EXCEPTION 'Terminal sandbox status protected' USING ERRCODE='BL006';END IF;
 RETURN NEW;
END $$;


--
-- Name: sandbox_attempt_json_v1l(uuid); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.sandbox_attempt_json_v1l(p_id uuid) RETURNS jsonb
    LANGUAGE sql STABLE SECURITY DEFINER
    SET search_path TO 'pg_catalog', 'public'
    AS $$
 SELECT to_jsonb(a)||jsonb_build_object('amount_minor',a.amount_minor::text) FROM public.customer_wallet_sandbox_attempts_v1l a WHERE id=p_id
$$;


--
-- Name: seed_admin_message_thread(uuid, boolean); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.seed_admin_message_thread(p_notification uuid, p_queue boolean DEFAULT false) RETURNS uuid
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'public'
    AS $$
DECLARE n public.notifications; t uuid; e bigint; tenant uuid; admin_id uuid;
BEGIN
 SELECT * INTO n FROM public.notifications WHERE id=p_notification FOR UPDATE;
 IF NOT FOUND OR COALESCE(n.metadata->>'action',n.data->>'action','') NOT IN ('admin_message','admin_driver_message') THEN
  RAISE EXCEPTION 'Message unavailable';
 END IF;
 SELECT thread_id INTO t FROM public.admin_message_entries WHERE notification_id=n.id;
 IF FOUND THEN RETURN t; END IF;
 SELECT tenant_id INTO tenant FROM public.profiles WHERE id=n.user_id;
 SELECT id INTO admin_id FROM public.profiles WHERE id=COALESCE(n.metadata->>'admin_sender_id',n.data->>'admin_sender_id')::uuid AND role='admin';
 INSERT INTO public.admin_message_threads(id,user_id,tenant_id,assigned_admin_id,subject,created_at,updated_at)
 VALUES(n.id,n.user_id,tenant,admin_id,left(n.title,200),n.created_at,n.created_at) ON CONFLICT(id) DO NOTHING;
 INSERT INTO public.admin_message_entries(thread_id,sender_id,direction,body,notification_id,created_at)
 VALUES(n.id,admin_id,'admin',left(n.body,2000),n.id,n.created_at) RETURNING id INTO e;
 IF n.is_read THEN UPDATE public.admin_message_entries SET read_at=n.created_at WHERE id=e; END IF;
 IF p_queue THEN INSERT INTO public.admin_message_email_outbox(entry_id,user_id) VALUES(e,n.user_id) ON CONFLICT DO NOTHING; END IF;
 RETURN n.id;
END; $$;


--
-- Name: send_chat_push_notification(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.send_chat_push_notification() RETURNS trigger
    LANGUAGE plpgsql SECURITY DEFINER
    AS $$
DECLARE
    recipient_id UUID;
    booking_row RECORD;
    function_url TEXT := 'https://movabi-supabase.apps.evolsolution.com/functions/v1/send-push-notification';
BEGIN
    SELECT *
    INTO booking_row
    FROM public.bookings
    WHERE id = NEW.job_id;

    IF booking_row IS NULL THEN
        RETURN NEW;
    END IF;

    IF NEW.sender_id = booking_row.driver_id THEN
        recipient_id := booking_row.customer_id;
    ELSE
        recipient_id := booking_row.driver_id;
    END IF;

    IF recipient_id IS NOT NULL AND recipient_id <> NEW.sender_id THEN
        PERFORM net.http_post(
            url := function_url,
            headers := jsonb_build_object(
                'Content-Type', 'application/json'
            ),
            body := jsonb_build_object(
                'recipientUserId', recipient_id,
                'type', 'new_chat_message',
                'jobId', NEW.job_id,
                'title', 'New message',
                'body', LEFT(COALESCE(NEW.message, 'You have a new message'), 100)
            )
        );
    END IF;

    RETURN NEW;
EXCEPTION WHEN OTHERS THEN
    RAISE WARNING 'send_chat_push_notification failed: %', SQLERRM;
    RETURN NEW;
END;
$$;


--
-- Name: send_job_message(uuid, uuid, text, text); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.send_job_message(p_job_id uuid, p_receiver_id uuid, p_message text, p_message_type text DEFAULT 'text'::text) RETURNS auth.job_messages
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'public'
    SET row_security TO 'off'
    AS $$
DECLARE
  v_sender_id UUID := auth.uid();
  v_job RECORD;
  v_message job_messages;
BEGIN
  IF v_sender_id IS NULL THEN
    RAISE EXCEPTION 'Not authenticated';
  END IF;

  IF NULLIF(TRIM(COALESCE(p_message, '')), '') IS NULL THEN
    RAISE EXCEPTION 'Message cannot be empty';
  END IF;

  SELECT *
  INTO v_job
  FROM jobs
  WHERE id = p_job_id
    AND v_sender_id IN (customer_id, driver_id)
    AND p_receiver_id IN (customer_id, driver_id);

  IF v_job IS NULL THEN
    RAISE EXCEPTION 'You can only message participants on this job';
  END IF;

  INSERT INTO job_messages (
    tenant_id,
    job_id,
    sender_id,
    receiver_id,
    message,
    message_type
  )
  VALUES (
    NULLIF(to_jsonb(v_job)->>'tenant_id', '')::UUID,
    p_job_id,
    v_sender_id,
    p_receiver_id,
    TRIM(p_message),
    COALESCE(NULLIF(p_message_type, ''), 'text')
  )
  RETURNING * INTO v_message;

  RETURN v_message;
END;
$$;


--
-- Name: serialize_cash_credit_ledger_v1e(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.serialize_cash_credit_ledger_v1e() RETURNS trigger
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'pg_catalog', 'public'
    AS $$
BEGIN PERFORM public.driver_cash_credit_lock_v1e(NEW.tenant_id,NEW.owner_id,NEW.currency_code); RETURN NEW; END $$;


--
-- Name: set_pricing_config_updated_at(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.set_pricing_config_updated_at() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
begin
  new.updated_at = now();
  return new;
end;
$$;


--
-- Name: set_updated_at(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.set_updated_at() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
BEGIN
  NEW.updated_at := now();
  RETURN NEW;
END;
$$;


--
-- Name: settle_errand_funds(uuid); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.settle_errand_funds(p_booking_id uuid) RETURNS void
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'public', 'pg_temp'
    AS $$
DECLARE j public.jobs%ROWTYPE; fare numeric;
BEGIN
 SELECT * INTO STRICT j FROM public.jobs WHERE id=p_booking_id;
 SELECT (metadata->>'service_fare')::numeric INTO fare FROM public.wallet_transactions WHERE job_id=j.id AND user_id=j.customer_id AND transaction_type='reservation' AND metadata ? 'service_fare' ORDER BY created_at,id LIMIT 1;
 fare:=coalesce(fare,j.total_price,j.price);
 PERFORM public.settle_job_wallet_reservation(p_booking_id,fare);
END $$;


--
-- Name: settle_job_wallet_reservation(uuid, numeric); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.settle_job_wallet_reservation(p_job_id uuid, p_amount numeric) RETURNS jsonb
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'public', 'pg_temp'
    AS $$
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


--
-- Name: job_budget_authorizations; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.job_budget_authorizations (
    id uuid NOT NULL,
    job_id uuid NOT NULL,
    old_intent_id text NOT NULL,
    new_intent_id text,
    total_budget numeric NOT NULL,
    status text DEFAULT 'created'::text NOT NULL,
    cleanup_done boolean DEFAULT false NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT job_budget_authorizations_status_check CHECK ((status = ANY (ARRAY['created'::text, 'approved'::text, 'abandoned'::text]))),
    CONSTRAINT job_budget_authorizations_total_budget_check CHECK ((total_budget > (0)::numeric))
);


--
-- Name: shopping_authorizations_pending_cleanup(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.shopping_authorizations_pending_cleanup() RETURNS SETOF public.job_budget_authorizations
    LANGUAGE sql SECURITY DEFINER
    SET search_path TO 'public', 'pg_temp'
    AS $$
 SELECT a.* FROM public.job_budget_authorizations a JOIN public.jobs j ON j.id=a.job_id
 JOIN public.errand_funding f ON f.job_id=a.job_id WHERE NOT a.cleanup_done
 AND (a.status='approved' OR j.status IN ('completed','settled','cancelled','canceled','expired','failed')
 OR f.over_budget_status='rejected' OR f.metadata->>'budget_request_id' IS DISTINCT FROM a.id::text)
 ORDER BY a.created_at LIMIT 50
$$;


--
-- Name: sync_agreed_fare_snapshot(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.sync_agreed_fare_snapshot() RETURNS trigger
    LANGUAGE plpgsql
    SET search_path TO 'public', 'pg_temp'
    AS $$
DECLARE b jsonb; policy jsonb; charge numeric; original numeric; fee numeric;
 base numeric; rate numeric; commission numeric; payout numeric; budget numeric;
 previous_base numeric;
BEGIN
 IF NEW.agreed_fare IS NULL THEN RETURN NEW; END IF;
 b:=OLD.fare_breakdown;
 IF b->>'policyVersion' IS DISTINCT FROM 'fare-split-v1' THEN
   RAISE EXCEPTION 'Agreed fare requires a verified financial snapshot';
 END IF;
 charge:=round(NEW.agreed_fare,2); original:=(b->>'customerCharge')::numeric;
 IF charge IS NULL OR original IS NULL OR charge::text IN ('NaN','Infinity','-Infinity')
 OR original::text IN ('NaN','Infinity','-Infinity') OR charge<=0 OR original<=0 THEN
   RAISE EXCEPTION 'Invalid agreed fare snapshot';
 END IF;
 IF NEW.agreed_fare IS NOT DISTINCT FROM OLD.agreed_fare AND charge=original THEN RETURN NEW; END IF;
 IF OLD.payment_status IN ('paid','captured','wallet_funded')
 OR OLD.status IN ('completed','settled','cancelled') OR OLD.stripe_transfer_id IS NOT NULL
 OR OLD.settlement_status IN ('claimed','unknown','transferred','reversed') THEN
   RAISE EXCEPTION 'Settled or funded fare requires explicit reconciliation';
 END IF;
 IF NEW.agreed_fare IS DISTINCT FROM OLD.agreed_fare AND OLD.payment_status='authorized' THEN
   RAISE EXCEPTION 'Existing authorization must be reconciled before re-agreement';
 END IF;
 fee:=round((b->>'platformFeeAmount')::numeric*charge/original,2);
 base:=charge-fee; rate:=(b->>'commissionPercent')::numeric;
 budget:=coalesce((b->>'shoppingBudget')::numeric,0);
 IF fee IS NULL OR rate IS NULL OR fee::text IN ('NaN','Infinity','-Infinity')
 OR rate::text IN ('NaN','Infinity','-Infinity') OR budget::text IN ('NaN','Infinity','-Infinity')
 OR fee<0 OR base<=0 OR rate<0 OR rate>=100 OR budget<0 THEN
   RAISE EXCEPTION 'Invalid frozen fee or commission basis';
 END IF;
 commission:=round(base*rate/100,2); payout:=base-commission;
 policy:=b->'driverCommissionPolicy';
 IF policy->>'version'='subscription-commission-v1' THEN
   previous_base:=(b->>'driverBase')::numeric;
   IF previous_base IS NULL OR previous_base<=0 OR previous_base::text IN ('NaN','Infinity','-Infinity') THEN
     RAISE EXCEPTION 'Invalid frozen standard commission basis';
   END IF;
   policy:=policy||jsonb_build_object('standardCommissionAmount',
     round((policy->>'standardCommissionAmount')::numeric*base/previous_base,2));
   b:=b||jsonb_build_object('driverCommissionPolicy',policy);
 END IF;
 b:=b||jsonb_build_object('customerCharge',charge,'customerServiceTotal',charge,
   'total',charge,'serviceFare',charge,'totalAuthorisation',charge+budget,
   'platformFeeAmount',fee,'platformFee',fee,'baseServiceFare',base,
   'serviceFareBeforePlatformFee',base,'driverBase',base,'driverGrossEarnings',base,
   'driverCommissionAmount',commission,'commissionFee',commission,'commissionAmount',commission,
   'driverEntitlement',payout,'driverPayout',payout,'driverNetEarnings',payout,
   'grossRevenue',fee+commission,'reconciliationValid',true);
 NEW.fare_breakdown:=b;
 NEW.price:=charge; NEW.total_price:=charge; NEW.estimated_price:=charge;
 NEW.platform_fee:=fee; NEW.driver_payout:=payout;
 NEW.commission_fee:=commission; NEW.commission_rate_used:=rate;
 RETURN NEW;
END $$;


--
-- Name: sync_configured_country_payment_routes_v23(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.sync_configured_country_payment_routes_v23() RETURNS integer
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'pg_catalog', 'public'
    AS $$
DECLARE added integer;
BEGIN
 PERFORM pg_advisory_xact_lock(hashtext('vaydu-country-provider-sync-v23'));
 INSERT INTO public.market_payment_routes(country_code,currency_code,method,provider,merchant_account_ref)
 SELECT c.country_code,c.currency_code,'card',p.provider,CASE WHEN p.provider='stripe' THEN 'stripe-platform' ELSE NULL END
 FROM public.configured_payment_countries_v23() c
 CROSS JOIN LATERAL(SELECT public.recommended_country_payment_provider_v23(c.country_code,c.currency_code) AS provider) p
 WHERE p.provider IS NOT NULL
 ON CONFLICT(country_code,currency_code,method) WHERE preferred DO NOTHING;
 GET DIAGNOSTICS added=ROW_COUNT;
 RETURN added;
END
$$;


--
-- Name: sync_country_settings_payment_routes_v23(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.sync_country_settings_payment_routes_v23() RETURNS trigger
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'pg_catalog', 'public'
    AS $$
BEGIN
 IF coalesce(NEW.key,NEW.config_key)='countries' THEN PERFORM public.sync_configured_country_payment_routes_v23(); END IF;
 RETURN NEW;
END
$$;


--
-- Name: sync_job_issuing_spend(uuid, boolean); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.sync_job_issuing_spend(p_job uuid, p_finalize boolean DEFAULT false) RETURNS jsonb
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'public', 'pg_temp'
    AS $$
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


--
-- Name: sync_job_prices(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.sync_job_prices() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
DECLARE
  chosen_price numeric;
BEGIN
  chosen_price := COALESCE(
    NULLIF(NEW.total_price, 0),
    NULLIF(NEW.estimated_price, 0),
    NULLIF(NEW.price, 0),
    0
  );

  NEW.price := chosen_price;
  NEW.total_price := chosen_price;
  NEW.estimated_price := chosen_price;

  NEW.currency_code := COALESCE(NEW.currency_code, 'GBP');
  NEW.currency_symbol := COALESCE(NEW.currency_symbol, '£');
  NEW.country_code := COALESCE(NEW.country_code, 'GB');

  RETURN NEW;
END;
$$;


--
-- Name: sync_system_configs_columns(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.sync_system_configs_columns() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
begin
  new.config_key := coalesce(new.config_key, new.key);
  new.key := coalesce(new.key, new.config_key);

  new.config_value := coalesce(new.config_value, new.value);
  new.value := coalesce(new.value, new.config_value);

  new.updated_at := now();

  return new;
end;
$$;


--
-- Name: touch_app_presence(uuid); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.touch_app_presence(p_session uuid) RETURNS void
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'public'
    AS $$
DECLARE actor uuid:=auth.uid();
BEGIN
 IF actor IS NULL OR p_session IS NULL THEN RAISE EXCEPTION 'Authentication required' USING ERRCODE='42501'; END IF;
 IF NOT EXISTS(SELECT 1 FROM profiles WHERE id=actor) THEN RETURN; END IF;
 INSERT INTO app_presence_sessions VALUES(actor,p_session,clock_timestamp())
 ON CONFLICT(user_id,session_id) DO UPDATE SET seen_at=EXCLUDED.seen_at;
 DELETE FROM app_presence_sessions WHERE user_id=actor AND seen_at<now()-interval '1 day';
END;$$;


--
-- Name: trg_guard_direct_arrival(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.trg_guard_direct_arrival() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
BEGIN
  IF NEW.status IN ('arrived','driver_arrived')
     AND NEW.no_show_arrived_at IS NULL
     AND OLD.no_show_arrived_at IS NULL
     AND NEW.fare_breakdown IS NOT NULL
     AND NEW.fare_breakdown->>'noShowPolicyVersion' IS NOT NULL THEN
    RAISE EXCEPTION 'Arrival must be recorded through mark_job_arrived (server-authoritative).';
  END IF;
  RETURN NEW;
END;
$$;


--
-- Name: update_driver_locations_updated_at(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.update_driver_locations_updated_at() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
BEGIN
    NEW.updated_at = NOW();
    RETURN NEW;
END;
$$;


--
-- Name: update_errand_funding_updated_at(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.update_errand_funding_updated_at() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
BEGIN
  NEW.updated_at = NOW();
  RETURN NEW;
END;
$$;


--
-- Name: update_jobs_updated_at(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.update_jobs_updated_at() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
BEGIN
    NEW.updated_at = NOW();
    RETURN NEW;
END;
$$;


--
-- Name: update_updated_at_column(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.update_updated_at_column() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$$;


--
-- Name: update_wallets_updated_at(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.update_wallets_updated_at() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
BEGIN
  NEW.updated_at = NOW();
  RETURN NEW;
END;
$$;


--
-- Name: user_owns_job(uuid); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.user_owns_job(p_job_id uuid) RETURNS boolean
    LANGUAGE plpgsql STABLE SECURITY DEFINER
    SET search_path TO 'public'
    AS $$
BEGIN
  RETURN EXISTS (
    SELECT 1
    FROM public.jobs
    WHERE jobs.id = p_job_id
      AND jobs.customer_id = auth.uid()
  );
END;
$$;


--
-- Name: validate_wallet_integrity(uuid); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.validate_wallet_integrity(p_user_id uuid) RETURNS TABLE(is_valid boolean, message text)
    LANGUAGE plpgsql SECURITY DEFINER
    AS $$
DECLARE
    v_available DECIMAL(12,2);
    v_reserved DECIMAL(12,2);
BEGIN
    SELECT available_balance, reserved_balance
    INTO v_available, v_reserved
    FROM public.wallets
    WHERE user_id = p_user_id;

    IF NOT FOUND THEN
        RETURN QUERY SELECT FALSE, 'Wallet not found'::TEXT;
    ELSIF v_available < 0 THEN
        RETURN QUERY SELECT FALSE, 'Available balance is negative'::TEXT;
    ELSIF v_reserved < 0 THEN
        RETURN QUERY SELECT FALSE, 'Reserved balance is negative'::TEXT;
    ELSIF (v_available + v_reserved) < 0 THEN
        RETURN QUERY SELECT FALSE, 'Negative total balance'::TEXT;
    ELSE
        RETURN QUERY SELECT TRUE, 'Wallet is healthy'::TEXT;
    END IF;
END;
$$;


--
-- Name: wallet_collection_enabled(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.wallet_collection_enabled() RETURNS boolean
    LANGUAGE sql STABLE
    SET search_path TO 'pg_catalog', 'public'
    AS $$ SELECT COALESCE((SELECT value = 'true' FROM public.wallet_collection_config WHERE key='enabled'), false) $$;


--
-- Name: wallet_currency_minor_exponent(text); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.wallet_currency_minor_exponent(p_currency_code text) RETURNS integer
    LANGUAGE sql IMMUTABLE
    SET search_path TO 'pg_catalog'
    AS $_$ SELECT CASE
  WHEN p_currency_code IN ('BIF','CLP','DJF','GNF','JPY','KMF','KRW','MGA','PYG','RWF','UGX','VND','VUV','XAF','XOF','XPF') THEN 0
  WHEN p_currency_code IN ('BHD','IQD','JOD','KWD','LYD','OMR','TND') THEN 3
  WHEN p_currency_code ~ '^[A-Z]{3}$' THEN 2
  ELSE NULL END $_$;


--
-- Name: wallet_ledger_append_only(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.wallet_ledger_append_only() RETURNS trigger
    LANGUAGE plpgsql
    SET search_path TO 'pg_catalog', 'public'
    AS $$
BEGIN
  RAISE EXCEPTION 'Batch 1B: % is append-only', TG_TABLE_NAME USING ERRCODE = 'BP006';
END $$;


--
-- Name: wallet_topup_attempt_freeze(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.wallet_topup_attempt_freeze() RETURNS trigger
    LANGUAGE plpgsql
    SET search_path TO 'pg_catalog', 'public'
    AS $$
BEGIN
  IF NEW.attempt_key IS DISTINCT FROM OLD.attempt_key
     OR NEW.tenant_id IS DISTINCT FROM OLD.tenant_id
     OR NEW.owner_id IS DISTINCT FROM OLD.owner_id
     OR NEW.country_code IS DISTINCT FROM OLD.country_code
     OR NEW.currency_code IS DISTINCT FROM OLD.currency_code
     OR NEW.amount_minor IS DISTINCT FROM OLD.amount_minor
     OR NEW.destination_account_purpose IS DISTINCT FROM OLD.destination_account_purpose
     OR NEW.payment_provider IS DISTINCT FROM OLD.payment_provider
     OR NEW.merchant_account_ref IS DISTINCT FROM OLD.merchant_account_ref
     OR NEW.provider_idempotency_identity IS DISTINCT FROM OLD.provider_idempotency_identity THEN
    RAISE EXCEPTION 'Batch 1C: top-up attempt terms are frozen' USING ERRCODE = 'BP007';
  END IF;
  NEW.updated_at := now();
  RETURN NEW;
END
$$;


--
-- Name: admin_message_email_outbox; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.admin_message_email_outbox (
    entry_id bigint NOT NULL,
    user_id uuid NOT NULL,
    status text DEFAULT 'pending'::text NOT NULL,
    attempts integer DEFAULT 0 NOT NULL,
    retry_at timestamp with time zone DEFAULT now() NOT NULL,
    lease_token uuid,
    lease_until timestamp with time zone,
    sent_at timestamp with time zone,
    last_error text,
    CONSTRAINT admin_message_email_outbox_status_check CHECK ((status = ANY (ARRAY['pending'::text, 'sent'::text])))
);


--
-- Name: admin_message_entries; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.admin_message_entries (
    id bigint NOT NULL,
    thread_id uuid NOT NULL,
    sender_id uuid,
    direction text NOT NULL,
    body text NOT NULL,
    request_id uuid,
    notification_id uuid,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    read_at timestamp with time zone,
    CONSTRAINT admin_message_entries_body_check CHECK (((length(body) >= 1) AND (length(body) <= 2000))),
    CONSTRAINT admin_message_entries_direction_check CHECK ((direction = ANY (ARRAY['admin'::text, 'user'::text])))
);


--
-- Name: admin_message_entries_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

ALTER TABLE public.admin_message_entries ALTER COLUMN id ADD GENERATED ALWAYS AS IDENTITY (
    SEQUENCE NAME public.admin_message_entries_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1
);


--
-- Name: admin_message_threads; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.admin_message_threads (
    id uuid NOT NULL,
    user_id uuid NOT NULL,
    tenant_id uuid,
    assigned_admin_id uuid,
    subject text NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: ai_pricing_audits; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.ai_pricing_audits (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    job_id uuid,
    country_code text NOT NULL,
    currency_code text NOT NULL,
    service_slug text NOT NULL,
    zone_id text,
    input_snapshot jsonb DEFAULT '{}'::jsonb NOT NULL,
    rule_price_minor integer DEFAULT 0 NOT NULL,
    recommended_price_minor integer DEFAULT 0 NOT NULL,
    final_price_minor integer DEFAULT 0 NOT NULL,
    guardrails jsonb DEFAULT '{}'::jsonb NOT NULL,
    confidence numeric(5,4) DEFAULT 0 NOT NULL,
    reasons jsonb DEFAULT '[]'::jsonb NOT NULL,
    model_version text NOT NULL,
    configuration_version integer DEFAULT 1 NOT NULL,
    shadow_mode boolean DEFAULT true NOT NULL,
    fallback_used boolean DEFAULT false NOT NULL,
    fallback_reason text,
    created_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: app_features; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.app_features (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    feature_name text NOT NULL,
    is_enabled boolean DEFAULT false,
    metadata jsonb DEFAULT '{}'::jsonb,
    updated_at timestamp with time zone DEFAULT now()
);


--
-- Name: app_presence_sessions; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.app_presence_sessions (
    user_id uuid NOT NULL,
    session_id uuid NOT NULL,
    seen_at timestamp with time zone NOT NULL
);


--
-- Name: audit_logs; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.audit_logs (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    user_id uuid,
    action text NOT NULL,
    entity_type text,
    entity_id uuid,
    metadata jsonb,
    created_at timestamp with time zone DEFAULT now()
);


--
-- Name: booking_status_history; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.booking_status_history (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    job_id uuid NOT NULL,
    status text NOT NULL,
    changed_by uuid,
    notes text,
    created_at timestamp with time zone DEFAULT now()
);


--
-- Name: cities; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.cities (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    name text NOT NULL,
    country text NOT NULL,
    lat double precision NOT NULL,
    lng double precision NOT NULL,
    radius_km integer DEFAULT 50 NOT NULL,
    created_at timestamp with time zone DEFAULT now(),
    is_active boolean DEFAULT true
);


--
-- Name: competitor_fare_benchmarks; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.competitor_fare_benchmarks (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    competitor_profile_id uuid NOT NULL,
    distance_km numeric(12,3),
    duration_minutes numeric(12,3),
    route_origin_label character varying(255),
    route_destination_label character varying(255),
    observed_fare numeric(12,2) NOT NULL,
    currency character varying(3) NOT NULL,
    fare_type character varying(40) DEFAULT 'typical'::character varying NOT NULL,
    observed_at timestamp with time zone DEFAULT now() NOT NULL,
    expires_at timestamp with time zone,
    confidence_score numeric(5,2) DEFAULT 100 NOT NULL,
    source_reference text,
    notes text,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT competitor_fare_benchmarks_confidence_score_check CHECK (((confidence_score >= (0)::numeric) AND (confidence_score <= (100)::numeric))),
    CONSTRAINT competitor_fare_benchmarks_fare_type_check CHECK (((fare_type)::text = ANY (ARRAY[('minimum'::character varying)::text, ('typical'::character varying)::text, ('peak'::character varying)::text, ('off_peak'::character varying)::text, ('airport'::character varying)::text, ('manual_index'::character varying)::text])))
);


--
-- Name: competitor_profiles; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.competitor_profiles (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    country_code character varying(2) NOT NULL,
    market_city character varying(120),
    competitor_name character varying(120) NOT NULL,
    competitor_slug character varying(120) NOT NULL,
    service_type character varying(80) DEFAULT 'ride'::character varying NOT NULL,
    vehicle_class character varying(80),
    enabled boolean DEFAULT true NOT NULL,
    display_order integer DEFAULT 0 NOT NULL,
    source_type character varying(30) DEFAULT 'manual'::character varying NOT NULL,
    notes text,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT competitor_profiles_source_type_check CHECK (((source_type)::text = ANY (ARRAY[('manual'::character varying)::text, ('partner'::character varying)::text, ('research'::character varying)::text, ('api'::character varying)::text])))
);


--
-- Name: market_payment_routes; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.market_payment_routes (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    country_code character varying(2) NOT NULL,
    currency_code character varying(3) NOT NULL,
    method text NOT NULL,
    provider text NOT NULL,
    merchant_account_ref text,
    preferred boolean DEFAULT true NOT NULL,
    enabled boolean DEFAULT false NOT NULL,
    merchant_approved boolean DEFAULT false NOT NULL,
    adapter_ready boolean DEFAULT false NOT NULL,
    payout_approved boolean DEFAULT false NOT NULL,
    capabilities text[] DEFAULT '{}'::text[] NOT NULL,
    created_at timestamp with time zone DEFAULT clock_timestamp() NOT NULL,
    updated_at timestamp with time zone DEFAULT clock_timestamp() NOT NULL,
    CONSTRAINT market_payment_routes_capabilities_check CHECK (((capabilities <@ ARRAY['authorise'::text, 'capture'::text, 'release'::text, 'refund'::text, 'retrieve'::text, 'payout'::text, 'collect'::text]) AND (array_position(capabilities, NULL::text) IS NULL))),
    CONSTRAINT market_payment_routes_check CHECK (((NOT enabled) OR (merchant_approved AND adapter_ready AND (merchant_account_ref IS NOT NULL) AND (cardinality(capabilities) > 0)))),
    CONSTRAINT market_payment_routes_check1 CHECK (((provider <> ALL (ARRAY['kora'::text, 'fincra'::text])) OR ((NOT enabled) AND (NOT adapter_ready) AND (NOT payout_approved) AND (cardinality(capabilities) = 0)))),
    CONSTRAINT market_payment_routes_country_code_check CHECK (((country_code)::text ~ '^[A-Z]{2}$'::text)),
    CONSTRAINT market_payment_routes_currency_code_check CHECK (((currency_code)::text ~ '^[A-Z]{3}$'::text)),
    CONSTRAINT market_payment_routes_merchant_account_ref_check CHECK (((merchant_account_ref IS NULL) OR ((length(btrim(merchant_account_ref)) > 0) AND (merchant_account_ref = btrim(merchant_account_ref))))),
    CONSTRAINT market_payment_routes_method_check CHECK ((method = ANY (ARRAY['card'::text, 'bank_transfer'::text, 'mobile_money'::text]))),
    CONSTRAINT market_payment_routes_provider_check CHECK ((provider = ANY (ARRAY['stripe'::text, 'kora'::text, 'fincra'::text])))
);


--
-- Name: country_payment_assignments_v23; Type: VIEW; Schema: public; Owner: -
--

CREATE VIEW public.country_payment_assignments_v23 AS
 SELECT c.country_code,
    c.currency_code,
    r.provider,
    (r.id IS NOT NULL) AS assigned,
    COALESCE(r.enabled, false) AS enabled,
    COALESCE(r.merchant_approved, false) AS merchant_approved,
    COALESCE(r.adapter_ready, false) AS adapter_ready
   FROM (public.configured_payment_countries_v23() c(country_code, currency_code)
     LEFT JOIN public.market_payment_routes r ON ((((r.country_code)::text = c.country_code) AND ((r.currency_code)::text = c.currency_code) AND (r.method = 'card'::text) AND r.preferred)));


--
-- Name: customer_local_service_preferences; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.customer_local_service_preferences (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    customer_id uuid NOT NULL,
    country_code text DEFAULT 'GB'::text NOT NULL,
    service_slug text NOT NULL,
    category_slug text NOT NULL,
    provider_id uuid,
    external_place_id text,
    provider_name text NOT NULL,
    provider_address text,
    provider_logo_url text,
    latitude double precision,
    longitude double precision,
    use_count integer DEFAULT 1,
    last_used_at timestamp with time zone DEFAULT now(),
    is_favourite boolean DEFAULT false,
    created_at timestamp with time zone DEFAULT now(),
    updated_at timestamp with time zone DEFAULT now()
);


--
-- Name: customer_wallet_sandbox_attempts_v1l; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.customer_wallet_sandbox_attempts_v1l (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    owner_id uuid NOT NULL,
    tenant_id uuid NOT NULL,
    idempotency_key uuid NOT NULL,
    reference text NOT NULL,
    provider text DEFAULT 'kora'::text NOT NULL,
    mode text DEFAULT 'test'::text NOT NULL,
    credential_fingerprint text NOT NULL,
    merchant_account_ref text NOT NULL,
    country_code text NOT NULL,
    currency_code text NOT NULL,
    minor_exponent integer NOT NULL,
    amount_minor bigint NOT NULL,
    status text DEFAULT 'initiated'::text NOT NULL,
    checkout_url text,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT customer_wallet_sandbox_attempts_v1l_amount_minor_check CHECK ((amount_minor > 0)),
    CONSTRAINT customer_wallet_sandbox_attempts_v1l_merchant_account_ref_check CHECK (((length(btrim(merchant_account_ref)) >= 1) AND (length(btrim(merchant_account_ref)) <= 200))),
    CONSTRAINT customer_wallet_sandbox_attempts_v1l_minor_exponent_check CHECK (((minor_exponent >= 0) AND (minor_exponent <= 3))),
    CONSTRAINT customer_wallet_sandbox_attempts_v1l_mode_check CHECK ((mode = 'test'::text)),
    CONSTRAINT customer_wallet_sandbox_attempts_v1l_provider_check CHECK ((provider = 'kora'::text)),
    CONSTRAINT customer_wallet_sandbox_attempts_v1l_status_check CHECK ((status = ANY (ARRAY['initiated'::text, 'submitting'::text, 'provider_pending'::text, 'uncertain'::text, 'verified_test_only'::text, 'failed'::text]))),
    CONSTRAINT customer_wallet_sandbox_attempts_v_credential_fingerprint_check CHECK ((credential_fingerprint ~ '^[0-9a-f]{64}$'::text))
);


--
-- Name: customer_wallet_sandbox_cohort_v1l; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.customer_wallet_sandbox_cohort_v1l (
    owner_id uuid NOT NULL,
    tenant_id uuid NOT NULL,
    country_code text NOT NULL,
    currency_code text NOT NULL,
    minor_exponent integer NOT NULL,
    max_amount_minor bigint NOT NULL,
    enabled boolean DEFAULT false NOT NULL,
    CONSTRAINT customer_wallet_sandbox_cohort_v1l_country_code_check CHECK ((country_code ~ '^[A-Z]{2}$'::text)),
    CONSTRAINT customer_wallet_sandbox_cohort_v1l_currency_code_check CHECK ((currency_code ~ '^[A-Z]{3}$'::text)),
    CONSTRAINT customer_wallet_sandbox_cohort_v1l_max_amount_minor_check CHECK ((max_amount_minor > 0)),
    CONSTRAINT customer_wallet_sandbox_cohort_v1l_minor_exponent_check CHECK (((minor_exponent >= 0) AND (minor_exponent <= 3)))
);


--
-- Name: delivery_details; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.delivery_details (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    job_id uuid NOT NULL,
    recipient_name text NOT NULL,
    recipient_phone text NOT NULL,
    package_description text,
    package_weight text,
    is_fragile boolean DEFAULT false,
    created_at timestamp with time zone DEFAULT now(),
    updated_at timestamp with time zone DEFAULT now(),
    item_description text,
    notes text
);


--
-- Name: device_push_tokens; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.device_push_tokens (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    user_id uuid NOT NULL,
    token text NOT NULL,
    platform text NOT NULL,
    enabled boolean DEFAULT true NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    provider text DEFAULT 'capacitor'::text NOT NULL,
    subscription_id text,
    external_id text,
    last_seen_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT device_push_tokens_platform_check CHECK ((platform = ANY (ARRAY['ios'::text, 'android'::text, 'web'::text])))
);


--
-- Name: dispatch_logs; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.dispatch_logs (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    job_id uuid NOT NULL,
    driver_id uuid,
    distance double precision,
    accepted boolean DEFAULT false,
    created_at timestamp with time zone DEFAULT now()
);


--
-- Name: driver_accounts; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.driver_accounts (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    user_id uuid NOT NULL,
    tenant_id uuid NOT NULL,
    stripe_account_id text NOT NULL,
    charges_enabled boolean DEFAULT false,
    payouts_enabled boolean DEFAULT false,
    created_at timestamp with time zone DEFAULT now(),
    updated_at timestamp with time zone DEFAULT now(),
    onboarding_status text DEFAULT 'not_started'::text,
    onboarding_complete boolean DEFAULT false,
    CONSTRAINT driver_accounts_onboarding_status_check CHECK ((onboarding_status = ANY (ARRAY['not_started'::text, 'pending'::text, 'restricted'::text, 'enabled'::text])))
);


--
-- Name: driver_bids; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.driver_bids (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    job_id uuid NOT NULL,
    driver_id uuid NOT NULL,
    bid_amount numeric(12,2) NOT NULL,
    message text,
    status text DEFAULT 'pending'::text NOT NULL,
    is_counter_offer boolean DEFAULT false NOT NULL,
    counter_to_bid_id uuid,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    expires_at timestamp with time zone,
    CONSTRAINT driver_bids_status_check CHECK ((status = ANY (ARRAY['pending'::text, 'accepted'::text, 'rejected'::text, 'expired'::text, 'withdrawn'::text])))
);


--
-- Name: driver_cash_credit_config_v1e; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.driver_cash_credit_config_v1e (
    key text NOT NULL,
    enabled boolean NOT NULL
);


--
-- Name: driver_cash_credit_enrolments_v1e; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.driver_cash_credit_enrolments_v1e (
    tenant_id uuid NOT NULL,
    driver_id uuid NOT NULL,
    country_code text NOT NULL,
    currency_code text NOT NULL,
    terms_version text NOT NULL,
    consented_at timestamp with time zone NOT NULL,
    enabled boolean DEFAULT false NOT NULL,
    CONSTRAINT driver_cash_credit_enrolments_v1e_country_code_check CHECK ((country_code ~ '^[A-Z]{2}$'::text)),
    CONSTRAINT driver_cash_credit_enrolments_v1e_currency_code_check CHECK ((currency_code ~ '^[A-Z]{3}$'::text)),
    CONSTRAINT driver_cash_credit_enrolments_v1e_terms_version_check CHECK (((length(btrim(terms_version)) >= 1) AND (length(btrim(terms_version)) <= 100)))
);


--
-- Name: driver_cash_credit_holds_v1e; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.driver_cash_credit_holds_v1e (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    job_id uuid NOT NULL,
    tenant_id uuid NOT NULL,
    driver_id uuid NOT NULL,
    country_code text NOT NULL,
    currency_code text NOT NULL,
    fare_snapshot jsonb NOT NULL,
    enrolment_terms_version text NOT NULL,
    enrolment_consented_at timestamp with time zone NOT NULL,
    customer_charge_minor bigint NOT NULL,
    commission_minor bigint NOT NULL,
    platform_fee_minor bigint NOT NULL,
    driver_entitlement_minor bigint NOT NULL,
    required_credit_minor bigint NOT NULL,
    status text DEFAULT 'held'::text NOT NULL,
    reserve_event_id uuid,
    resolution_event_id uuid,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    resolved_at timestamp with time zone,
    CONSTRAINT driver_cash_credit_holds_v1e_check CHECK (((required_credit_minor)::numeric = ((commission_minor)::numeric + (platform_fee_minor)::numeric))),
    CONSTRAINT driver_cash_credit_holds_v1e_check1 CHECK (((customer_charge_minor)::numeric = ((driver_entitlement_minor)::numeric + (required_credit_minor)::numeric))),
    CONSTRAINT driver_cash_credit_holds_v1e_check2 CHECK ((((required_credit_minor = 0) AND (reserve_event_id IS NULL)) OR ((required_credit_minor > 0) AND (reserve_event_id IS NOT NULL)))),
    CONSTRAINT driver_cash_credit_holds_v1e_commission_minor_check CHECK ((commission_minor >= 0)),
    CONSTRAINT driver_cash_credit_holds_v1e_customer_charge_minor_check CHECK ((customer_charge_minor > 0)),
    CONSTRAINT driver_cash_credit_holds_v1e_driver_entitlement_minor_check CHECK ((driver_entitlement_minor > 0)),
    CONSTRAINT driver_cash_credit_holds_v1e_platform_fee_minor_check CHECK ((platform_fee_minor >= 0)),
    CONSTRAINT driver_cash_credit_holds_v1e_required_credit_minor_check CHECK ((required_credit_minor >= 0)),
    CONSTRAINT driver_cash_credit_holds_v1e_status_check CHECK ((status = ANY (ARRAY['held'::text, 'released'::text, 'settled'::text])))
);


--
-- Name: driver_earnings; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.driver_earnings (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    driver_id uuid NOT NULL,
    job_id uuid NOT NULL,
    amount numeric(10,2) NOT NULL,
    status text DEFAULT 'pending'::text NOT NULL,
    created_at timestamp with time zone DEFAULT now(),
    currency_code text DEFAULT 'GBP'::text NOT NULL,
    country_code text DEFAULT 'GB'::text NOT NULL,
    stripe_transfer_id text,
    platform_fee numeric(10,2) DEFAULT 0,
    gross_amount numeric(10,2) DEFAULT 0,
    settled_at timestamp with time zone,
    settlement_purpose text DEFAULT 'job_earnings'::text NOT NULL,
    CONSTRAINT driver_earnings_status_check CHECK ((status = ANY (ARRAY['pending'::text, 'paid'::text, 'failed'::text])))
);


--
-- Name: driver_issuing_cardholders; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.driver_issuing_cardholders (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    driver_id uuid NOT NULL,
    tenant_id uuid,
    stripe_cardholder_id text NOT NULL,
    status text DEFAULT 'active'::text NOT NULL,
    metadata jsonb DEFAULT '{}'::jsonb,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: driver_issuing_cards; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.driver_issuing_cards (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    driver_id uuid NOT NULL,
    tenant_id uuid,
    stripe_cardholder_id text NOT NULL,
    stripe_card_id text NOT NULL,
    card_type text DEFAULT 'physical'::text NOT NULL,
    currency_code text DEFAULT 'GBP'::text NOT NULL,
    last4 text,
    status text DEFAULT 'active'::text NOT NULL,
    metadata jsonb DEFAULT '{}'::jsonb,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: driver_job_declines; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.driver_job_declines (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    driver_id uuid NOT NULL,
    job_id uuid NOT NULL,
    reason text,
    created_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: driver_locations; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.driver_locations (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    driver_id uuid NOT NULL,
    tenant_id uuid NOT NULL,
    lat double precision NOT NULL,
    lng double precision NOT NULL,
    heading double precision,
    speed double precision,
    updated_at timestamp with time zone DEFAULT now(),
    city_id uuid
);


--
-- Name: driver_onboarding_notifications; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.driver_onboarding_notifications (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    event_key character varying(180) NOT NULL,
    driver_id uuid NOT NULL,
    event_type character varying(80) NOT NULL,
    payload jsonb DEFAULT '{}'::jsonb NOT NULL,
    status character varying(20) DEFAULT 'pending'::character varying NOT NULL,
    attempt_count integer DEFAULT 0 NOT NULL,
    last_error text,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    sent_at timestamp with time zone,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT driver_onboarding_notifications_status_check CHECK (((status)::text = ANY (ARRAY[('pending'::character varying)::text, ('processing'::character varying)::text, ('sent'::character varying)::text, ('failed'::character varying)::text])))
);


--
-- Name: driver_onboarding_requests; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.driver_onboarding_requests (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    driver_id uuid NOT NULL,
    requirement_code character varying(100) NOT NULL,
    item character varying(160) NOT NULL,
    public_message text NOT NULL,
    private_admin_note text,
    status character varying(20) DEFAULT 'pending'::character varying NOT NULL,
    sent_at timestamp with time zone DEFAULT now() NOT NULL,
    resolved_at timestamp with time zone,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    request_type character varying(50),
    permission_consumed_at timestamp with time zone,
    CONSTRAINT driver_onboarding_requests_status_check CHECK (((status)::text = ANY (ARRAY[('pending'::character varying)::text, ('rejected'::character varying)::text, ('approved'::character varying)::text])))
);


--
-- Name: driver_payout_markets; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.driver_payout_markets (
    country_code text NOT NULL,
    currency_code text NOT NULL,
    provider text NOT NULL,
    merchant_account_ref text,
    enabled boolean DEFAULT false NOT NULL,
    merchant_approved boolean DEFAULT false NOT NULL,
    adapter_ready boolean DEFAULT false NOT NULL,
    capability_verified_at timestamp with time zone,
    capability_evidence_ref text,
    merchant_mode text DEFAULT 'test'::text NOT NULL,
    sandbox_driver_id uuid,
    sandbox_tenant_id uuid,
    CONSTRAINT driver_payout_markets_check CHECK (((NOT enabled) OR (merchant_approved AND adapter_ready AND (merchant_account_ref IS NOT NULL) AND (capability_verified_at IS NOT NULL) AND (capability_evidence_ref IS NOT NULL) AND (sandbox_driver_id IS NOT NULL) AND (sandbox_tenant_id IS NOT NULL)))),
    CONSTRAINT driver_payout_markets_merchant_mode_check CHECK ((merchant_mode = 'test'::text)),
    CONSTRAINT driver_payout_markets_ng_scope_check CHECK (((provider <> ALL (ARRAY['flutterwave'::text, 'paystack'::text])) OR (NOT enabled) OR ((country_code = 'NG'::text) AND (currency_code = 'NGN'::text)))),
    CONSTRAINT driver_payout_markets_provider_check CHECK ((provider = ANY (ARRAY['stripe'::text, 'flutterwave'::text, 'kora'::text, 'fincra'::text, 'paystack'::text])))
);


--
-- Name: driver_requirement_audit; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.driver_requirement_audit (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    driver_id uuid NOT NULL,
    event_type character varying(50) NOT NULL,
    selected_services jsonb DEFAULT '[]'::jsonb NOT NULL,
    requirement_codes jsonb DEFAULT '[]'::jsonb NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    actor_id uuid,
    metadata jsonb DEFAULT '{}'::jsonb NOT NULL
);


--
-- Name: driver_subscriptions; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.driver_subscriptions (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    driver_id uuid NOT NULL,
    plan_id uuid,
    plan_code text,
    status text DEFAULT 'inactive'::text NOT NULL,
    current_period_start timestamp with time zone,
    current_period_end timestamp with time zone,
    stripe_subscription_id text,
    stripe_customer_id text,
    cancel_at_period_end boolean DEFAULT false,
    metadata jsonb DEFAULT '{}'::jsonb,
    created_at timestamp with time zone DEFAULT now(),
    updated_at timestamp with time zone DEFAULT now()
);


--
-- Name: driver_vehicle_mot_checks; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.driver_vehicle_mot_checks (
    vehicle_id uuid NOT NULL,
    registration text NOT NULL,
    status text NOT NULL,
    expires_on date,
    checked_at timestamp with time zone NOT NULL,
    CONSTRAINT driver_vehicle_mot_checks_status_check CHECK ((status = ANY (ARRAY['valid'::text, 'expired'::text, 'dangerous_failure'::text, 'unknown'::text])))
);


--
-- Name: email_logs; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.email_logs (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    user_id uuid,
    job_id uuid,
    email_type text NOT NULL,
    status text NOT NULL,
    error text,
    created_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: errand_details; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.errand_details (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    job_id uuid NOT NULL,
    items_list jsonb DEFAULT '[]'::jsonb NOT NULL,
    estimated_budget numeric,
    store_name text,
    store_address text,
    created_at timestamp with time zone DEFAULT now(),
    updated_at timestamp with time zone DEFAULT now(),
    delivery_instructions text,
    customer_phone text,
    recipient_phone text,
    recipient_name text,
    substitution_rule text,
    actual_spending numeric(12,2),
    spending_notes text,
    receipt_url text
);


--
-- Name: errand_funding; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.errand_funding (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    job_id uuid NOT NULL,
    customer_id uuid NOT NULL,
    item_budget numeric(12,2) DEFAULT 0.00 NOT NULL,
    service_estimate numeric(12,2) DEFAULT 0.00 NOT NULL,
    amount_reserved numeric(12,2) DEFAULT 0.00 NOT NULL,
    actual_item_spend numeric(12,2) DEFAULT 0.00 NOT NULL,
    refund_amount numeric(12,2) DEFAULT 0.00 NOT NULL,
    status text DEFAULT 'pending'::text NOT NULL,
    metadata jsonb DEFAULT '{}'::jsonb,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    over_budget_status text DEFAULT 'none'::text,
    over_budget_amount numeric(12,2) DEFAULT 0.00,
    receipt_url text,
    settlement_data jsonb DEFAULT '{}'::jsonb,
    requested_over_budget_amount numeric DEFAULT 0,
    over_budget_reason text,
    CONSTRAINT chk_errand_funding_actual_item_spend_non_negative CHECK ((actual_item_spend >= (0)::numeric)),
    CONSTRAINT chk_errand_funding_amount_reserved_non_negative CHECK ((amount_reserved >= (0)::numeric)),
    CONSTRAINT chk_errand_funding_item_budget_non_negative CHECK ((item_budget >= (0)::numeric)),
    CONSTRAINT chk_errand_funding_refund_amount_non_negative CHECK ((refund_amount >= (0)::numeric)),
    CONSTRAINT chk_errand_funding_service_estimate_non_negative CHECK ((service_estimate >= (0)::numeric)),
    CONSTRAINT chk_errand_funding_status CHECK ((status = ANY (ARRAY['pending'::text, 'reserved'::text, 'funded'::text, 'in_progress'::text, 'over_budget_requested'::text, 'over_budget_approved'::text, 'completed'::text, 'settled'::text, 'refunded'::text, 'cancelled'::text]))),
    CONSTRAINT errand_funding_actual_item_spend_check CHECK ((actual_item_spend >= (0)::numeric)),
    CONSTRAINT errand_funding_amount_reserved_check CHECK ((amount_reserved >= (0)::numeric)),
    CONSTRAINT errand_funding_over_budget_amount_check CHECK ((over_budget_amount >= (0)::numeric)),
    CONSTRAINT errand_funding_over_budget_amount_non_negative_check CHECK ((over_budget_amount >= (0)::numeric)),
    CONSTRAINT errand_funding_over_budget_status_check CHECK ((over_budget_status = ANY (ARRAY['none'::text, 'requested'::text, 'approved'::text, 'rejected'::text])))
);


--
-- Name: events; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.events (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    type text NOT NULL,
    payload jsonb NOT NULL,
    tenant_id uuid,
    user_id uuid,
    created_at timestamp with time zone DEFAULT now()
);


--
-- Name: fare_negotiations; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.fare_negotiations (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    job_id uuid NOT NULL,
    proposed_by uuid NOT NULL,
    proposed_by_role text NOT NULL,
    amount numeric(12,2) NOT NULL,
    message text,
    status text DEFAULT 'pending'::text NOT NULL,
    counter_to_negotiation_id uuid,
    round_number integer DEFAULT 1 NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    expires_at timestamp with time zone,
    CONSTRAINT fare_negotiations_proposed_by_role_check CHECK ((proposed_by_role = ANY (ARRAY['customer'::text, 'driver'::text, 'system'::text]))),
    CONSTRAINT fare_negotiations_status_check CHECK ((status = ANY (ARRAY['pending'::text, 'accepted'::text, 'rejected'::text, 'countered'::text, 'expired'::text])))
);


--
-- Name: fixed_fare_bands_raw; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.fixed_fare_bands_raw (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    tenant_id uuid,
    country_code text DEFAULT 'GB'::text NOT NULL,
    currency_code text DEFAULT 'GBP'::text NOT NULL,
    city_id uuid,
    service_type text NOT NULL,
    from_km numeric(10,2) DEFAULT 0,
    to_km numeric(10,2) NOT NULL,
    fare numeric(12,2) NOT NULL,
    created_at timestamp with time zone DEFAULT now(),
    updated_at timestamp with time zone DEFAULT now(),
    flat_rate numeric(12,2),
    min_distance_km numeric,
    max_distance_km numeric,
    service_type_id uuid,
    is_active boolean DEFAULT true,
    priority integer DEFAULT 100,
    effective_from timestamp with time zone,
    effective_to timestamp with time zone
);


--
-- Name: fixed_fare_bands; Type: VIEW; Schema: public; Owner: -
--

CREATE VIEW public.fixed_fare_bands AS
 SELECT fixed_fare_bands_raw.id,
    fixed_fare_bands_raw.tenant_id,
    fixed_fare_bands_raw.city_id,
    fixed_fare_bands_raw.country_code,
    fixed_fare_bands_raw.currency_code,
    fixed_fare_bands_raw.service_type,
    fixed_fare_bands_raw.service_type_id,
    fixed_fare_bands_raw.from_km,
    fixed_fare_bands_raw.to_km,
    COALESCE(fixed_fare_bands_raw.min_distance_km, fixed_fare_bands_raw.from_km) AS min_distance_km,
    COALESCE(fixed_fare_bands_raw.max_distance_km, fixed_fare_bands_raw.to_km) AS max_distance_km,
    fixed_fare_bands_raw.fare,
    fixed_fare_bands_raw.flat_rate,
    COALESCE(fixed_fare_bands_raw.is_active, true) AS is_active,
    COALESCE(fixed_fare_bands_raw.priority, 100) AS priority,
    fixed_fare_bands_raw.effective_from,
    fixed_fare_bands_raw.effective_to,
    fixed_fare_bands_raw.created_at,
    fixed_fare_bands_raw.updated_at
   FROM public.fixed_fare_bands_raw;


--
-- Name: gb_mot_night_runs; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.gb_mot_night_runs (
    day date NOT NULL,
    lease_until timestamp with time zone NOT NULL,
    completed boolean DEFAULT false NOT NULL
);


--
-- Name: job_completion_secrets; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.job_completion_secrets (
    job_id uuid NOT NULL,
    completion_pin text NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: job_events; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.job_events (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    job_id uuid NOT NULL,
    event_type text NOT NULL,
    actor_id uuid,
    actor_role text,
    metadata jsonb DEFAULT '{}'::jsonb NOT NULL,
    notes text,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    marketplace_event_type text,
    negotiation_id uuid,
    bid_id uuid
);


--
-- Name: TABLE job_events; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON TABLE public.job_events IS 'Audit log for job lifecycle events including payment, dispatch, and status changes.';


--
-- Name: job_issuing_authorizations; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.job_issuing_authorizations (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    stripe_authorization_id text NOT NULL,
    job_id uuid,
    driver_id uuid,
    stripe_card_id text,
    amount numeric DEFAULT 0 NOT NULL,
    currency_code text DEFAULT 'GBP'::text NOT NULL,
    approved boolean DEFAULT false NOT NULL,
    merchant_name text,
    merchant_category text,
    status text,
    raw_event jsonb DEFAULT '{}'::jsonb,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: job_issuing_reserves; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.job_issuing_reserves (
    job_id uuid NOT NULL,
    currency text NOT NULL,
    amount_remaining numeric NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT job_issuing_reserves_amount_remaining_check CHECK ((amount_remaining >= (0)::numeric))
);


--
-- Name: job_issuing_spend_controls; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.job_issuing_spend_controls (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    job_id uuid NOT NULL,
    driver_id uuid NOT NULL,
    customer_id uuid NOT NULL,
    tenant_id uuid,
    stripe_card_id text NOT NULL,
    amount_limit numeric DEFAULT 0 NOT NULL,
    amount_authorized numeric DEFAULT 0 NOT NULL,
    amount_captured numeric DEFAULT 0 NOT NULL,
    currency_code text DEFAULT 'GBP'::text NOT NULL,
    status text DEFAULT 'pending'::text NOT NULL,
    metadata jsonb DEFAULT '{}'::jsonb,
    activated_at timestamp with time zone,
    deactivated_at timestamp with time zone,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: job_issuing_transactions; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.job_issuing_transactions (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    stripe_transaction_id text NOT NULL,
    stripe_authorization_id text,
    job_id uuid,
    driver_id uuid,
    stripe_card_id text,
    amount numeric DEFAULT 0 NOT NULL,
    currency_code text DEFAULT 'GBP'::text NOT NULL,
    merchant_name text,
    status text,
    raw_event jsonb DEFAULT '{}'::jsonb,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: job_locations; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.job_locations (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    job_id uuid NOT NULL,
    driver_id uuid NOT NULL,
    lat double precision NOT NULL,
    lng double precision NOT NULL,
    created_at timestamp with time zone DEFAULT now()
);


--
-- Name: job_messages; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.job_messages (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    tenant_id uuid NOT NULL,
    job_id uuid NOT NULL,
    sender_id uuid NOT NULL,
    receiver_id uuid NOT NULL,
    message text NOT NULL,
    message_type text NOT NULL,
    read_at timestamp with time zone,
    created_at timestamp with time zone DEFAULT now(),
    CONSTRAINT job_messages_message_type_check CHECK ((message_type = ANY (ARRAY['quick'::text, 'text'::text, 'system'::text])))
);


--
-- Name: job_payment_bindings; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.job_payment_bindings (
    job_id uuid NOT NULL,
    provider text NOT NULL,
    merchant_account_ref text NOT NULL,
    country text NOT NULL,
    currency text NOT NULL,
    payment_reference text NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT job_payment_bindings_country_check CHECK ((country ~ '^[A-Z]{2}$'::text)),
    CONSTRAINT job_payment_bindings_currency_check CHECK ((currency ~ '^[A-Z]{3}$'::text)),
    CONSTRAINT job_payment_bindings_provider_check CHECK ((provider = ANY (ARRAY['stripe'::text, 'kora'::text, 'fincra'::text, 'flutterwave'::text, 'paystack'::text])))
);


--
-- Name: job_queue; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.job_queue (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    job_id uuid NOT NULL,
    tenant_id uuid NOT NULL,
    city_id uuid,
    status text DEFAULT 'waiting'::text NOT NULL,
    created_at timestamp with time zone DEFAULT now(),
    expires_at timestamp with time zone NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT job_queue_status_check CHECK ((status = ANY (ARRAY['waiting'::text, 'broadcasting'::text, 'assigned'::text, 'expired'::text, 'ignored'::text])))
);


--
-- Name: job_service_details; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.job_service_details (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    job_id uuid NOT NULL,
    service_type_slug text,
    passenger_count integer,
    items_list jsonb,
    estimated_budget numeric,
    move_size text,
    helper_count integer,
    has_elevator boolean,
    notes text,
    created_at timestamp with time zone DEFAULT now()
);


--
-- Name: journey_evidence_v23; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.journey_evidence_v23 (
    id bigint NOT NULL,
    job_id uuid NOT NULL,
    driver_id uuid NOT NULL,
    tenant_id uuid NOT NULL,
    latitude double precision NOT NULL,
    longitude double precision NOT NULL,
    accuracy_metres double precision NOT NULL,
    sampled_at timestamp with time zone NOT NULL,
    received_at timestamp with time zone DEFAULT clock_timestamp() NOT NULL,
    booking_phase text NOT NULL,
    CONSTRAINT journey_evidence_v23_accuracy_metres_check CHECK (((accuracy_metres >= (0)::double precision) AND (accuracy_metres <= (100)::double precision))),
    CONSTRAINT journey_evidence_v23_latitude_check CHECK (((latitude >= ('-90'::integer)::double precision) AND (latitude <= (90)::double precision))),
    CONSTRAINT journey_evidence_v23_longitude_check CHECK (((longitude >= ('-180'::integer)::double precision) AND (longitude <= (180)::double precision)))
);


--
-- Name: TABLE journey_evidence_v23; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON TABLE public.journey_evidence_v23 IS 'Restricted driver-reported GPS samples received through authenticated journey ingestion. Not independent proof of travel and not a payable-distance ledger.';


--
-- Name: journey_evidence_v23_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

ALTER TABLE public.journey_evidence_v23 ALTER COLUMN id ADD GENERATED ALWAYS AS IDENTITY (
    SEQUENCE NAME public.journey_evidence_v23_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1
);


--
-- Name: journey_fare_enrolments_v23; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.journey_fare_enrolments_v23 (
    job_id uuid NOT NULL,
    customer_id uuid NOT NULL,
    driver_id uuid NOT NULL,
    valid_until timestamp with time zone NOT NULL,
    created_at timestamp with time zone DEFAULT clock_timestamp() NOT NULL,
    CONSTRAINT journey_fare_enrolments_v23_check CHECK ((customer_id <> driver_id))
);


--
-- Name: journey_fare_events_v23; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.journey_fare_events_v23 (
    id bigint NOT NULL,
    proposal_id uuid NOT NULL,
    actor_id uuid NOT NULL,
    event_type text NOT NULL,
    created_at timestamp with time zone DEFAULT clock_timestamp() NOT NULL,
    CONSTRAINT journey_fare_events_v23_event_type_check CHECK ((event_type = ANY (ARRAY['proposed'::text, 'accepted'::text, 'rejected'::text])))
);


--
-- Name: journey_fare_events_v23_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

ALTER TABLE public.journey_fare_events_v23 ALTER COLUMN id ADD GENERATED ALWAYS AS IDENTITY (
    SEQUENCE NAME public.journey_fare_events_v23_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1
);


--
-- Name: journey_fare_proposals_v23; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.journey_fare_proposals_v23 (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    stop_id uuid NOT NULL,
    source_digest text NOT NULL,
    calculation jsonb NOT NULL,
    state text DEFAULT 'proposed'::text NOT NULL,
    customer_accepted_at timestamp with time zone,
    driver_accepted_at timestamp with time zone,
    rejected_by uuid,
    rejection_note text,
    created_at timestamp with time zone DEFAULT clock_timestamp() NOT NULL,
    expires_at timestamp with time zone DEFAULT (clock_timestamp() + '00:15:00'::interval) NOT NULL,
    CONSTRAINT journey_fare_proposals_v23_state_check CHECK ((state = ANY (ARRAY['proposed'::text, 'agreed'::text, 'rejected'::text])))
);


--
-- Name: journey_start_markers_v23; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.journey_start_markers_v23 (
    job_id uuid NOT NULL,
    customer_id uuid NOT NULL,
    driver_id uuid NOT NULL,
    started_at timestamp with time zone NOT NULL,
    booking_snapshot jsonb NOT NULL
);


--
-- Name: journey_stop_events_v23; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.journey_stop_events_v23 (
    id bigint NOT NULL,
    request_id uuid NOT NULL,
    actor_id uuid NOT NULL,
    event_type text NOT NULL,
    note text DEFAULT ''::text NOT NULL,
    created_at timestamp with time zone DEFAULT clock_timestamp() NOT NULL,
    CONSTRAINT journey_stop_events_v23_event_type_check CHECK ((event_type = ANY (ARRAY['requested'::text, 'confirmed'::text, 'disputed'::text]))),
    CONSTRAINT journey_stop_events_v23_note_check CHECK ((length(note) <= 1000))
);


--
-- Name: journey_stop_events_v23_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

ALTER TABLE public.journey_stop_events_v23 ALTER COLUMN id ADD GENERATED ALWAYS AS IDENTITY (
    SEQUENCE NAME public.journey_stop_events_v23_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1
);


--
-- Name: journey_stop_requests_v23; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.journey_stop_requests_v23 (
    id uuid NOT NULL,
    job_id uuid NOT NULL,
    customer_id uuid NOT NULL,
    driver_id uuid NOT NULL,
    requested_by uuid NOT NULL,
    reason text NOT NULL,
    note text DEFAULT ''::text NOT NULL,
    state text NOT NULL,
    customer_confirmed_at timestamp with time zone,
    driver_confirmed_at timestamp with time zone,
    location_snapshot jsonb,
    support_reference uuid NOT NULL,
    created_at timestamp with time zone DEFAULT clock_timestamp() NOT NULL,
    expires_at timestamp with time zone DEFAULT (clock_timestamp() + '00:15:00'::interval) NOT NULL,
    updated_at timestamp with time zone DEFAULT clock_timestamp() NOT NULL,
    CONSTRAINT journey_stop_requests_v23_check CHECK ((customer_id <> driver_id)),
    CONSTRAINT journey_stop_requests_v23_check1 CHECK (((requested_by = customer_id) OR (requested_by = driver_id))),
    CONSTRAINT journey_stop_requests_v23_note_check CHECK ((length(note) <= 1000)),
    CONSTRAINT journey_stop_requests_v23_reason_check CHECK ((reason = ANY (ARRAY['breakdown'::text, 'safety'::text, 'medical'::text, 'other'::text]))),
    CONSTRAINT journey_stop_requests_v23_state_check CHECK ((state = ANY (ARRAY['awaiting_other'::text, 'stop_agreed'::text, 'disputed'::text])))
);


--
-- Name: TABLE journey_stop_requests_v23; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON TABLE public.journey_stop_requests_v23 IS 'Early-stop confirmation pilot only. Stop agreement is not fare consent, booking completion, capture, refund or payout authority.';


--
-- Name: kora_sandbox_booking_enrolments; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.kora_sandbox_booking_enrolments (
    job_id uuid NOT NULL,
    user_id uuid NOT NULL,
    active boolean DEFAULT false NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: kora_sandbox_booking_payments; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.kora_sandbox_booking_payments (
    job_id uuid NOT NULL,
    user_id uuid NOT NULL,
    reference text NOT NULL,
    merchant_account_ref text NOT NULL,
    currency text NOT NULL,
    amount_minor bigint NOT NULL,
    booking_snapshot jsonb NOT NULL,
    state text DEFAULT 'started'::text NOT NULL,
    checkout_url text,
    refund_reference text,
    refund_state text DEFAULT 'none'::text NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT kora_sandbox_booking_payments_amount_minor_check CHECK (((amount_minor >= 10000) AND (amount_minor <= '9007199254740991'::bigint))),
    CONSTRAINT kora_sandbox_booking_payments_booking_snapshot_check CHECK ((jsonb_typeof(booking_snapshot) = 'object'::text)),
    CONSTRAINT kora_sandbox_booking_payments_check CHECK ((((refund_state = 'none'::text) AND (refund_reference IS NULL)) OR ((refund_state <> 'none'::text) AND (refund_reference IS NOT NULL)))),
    CONSTRAINT kora_sandbox_booking_payments_currency_check CHECK ((currency = 'NGN'::text)),
    CONSTRAINT kora_sandbox_booking_payments_merchant_account_ref_check CHECK ((length(merchant_account_ref) > 0)),
    CONSTRAINT kora_sandbox_booking_payments_reference_check CHECK ((reference ~ '^vaydu-book-[a-f0-9]{32}$'::text)),
    CONSTRAINT kora_sandbox_booking_payments_refund_reference_check CHECK ((refund_reference ~ '^vaydu-refund-[a-f0-9]{32}$'::text)),
    CONSTRAINT kora_sandbox_booking_payments_refund_state_check CHECK ((refund_state = ANY (ARRAY['none'::text, 'started'::text, 'processing'::text, 'unknown'::text, 'success'::text, 'failed'::text]))),
    CONSTRAINT kora_sandbox_booking_payments_state_check CHECK ((state = ANY (ARRAY['started'::text, 'submitted'::text, 'unknown'::text, 'verified'::text, 'requires_refund'::text, 'refunded'::text])))
);


--
-- Name: kora_sandbox_sessions; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.kora_sandbox_sessions (
    reference text NOT NULL,
    user_id uuid NOT NULL,
    merchant_account_ref text NOT NULL,
    currency text DEFAULT 'NGN'::text NOT NULL,
    amount_minor integer DEFAULT 10000 NOT NULL,
    state text DEFAULT 'started'::text NOT NULL,
    checkout_url text,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT kora_sandbox_sessions_amount_minor_check CHECK ((amount_minor = 10000)),
    CONSTRAINT kora_sandbox_sessions_currency_check CHECK ((currency = 'NGN'::text)),
    CONSTRAINT kora_sandbox_sessions_merchant_account_ref_check CHECK ((length(merchant_account_ref) > 0)),
    CONSTRAINT kora_sandbox_sessions_reference_check CHECK ((reference ~ '^vaydu-(test-[a-f0-9]{32}|kora-test-[a-f0-9]{64})$'::text)),
    CONSTRAINT kora_sandbox_sessions_state_check CHECK ((state = ANY (ARRAY['started'::text, 'submitted'::text, 'unknown'::text, 'verified'::text])))
);


--
-- Name: local_place_search_cache; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.local_place_search_cache (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    country_code text NOT NULL,
    service_slug text NOT NULL,
    category_slug text NOT NULL,
    search_text text DEFAULT ''::text,
    latitude_bucket text NOT NULL,
    longitude_bucket text NOT NULL,
    radius_km numeric DEFAULT 10 NOT NULL,
    result jsonb DEFAULT '[]'::jsonb NOT NULL,
    source text DEFAULT 'cache'::text,
    expires_at timestamp with time zone NOT NULL,
    created_at timestamp with time zone DEFAULT now(),
    updated_at timestamp with time zone DEFAULT now()
);


--
-- Name: local_service_categories; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.local_service_categories (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    country_code text NOT NULL,
    service_slug text NOT NULL,
    category_slug text NOT NULL,
    category_name text NOT NULL,
    category_description text,
    icon text,
    search_keywords text[] DEFAULT '{}'::text[],
    default_search_radius_km numeric DEFAULT 10,
    allow_custom_provider boolean DEFAULT true,
    display_order integer DEFAULT 0,
    enabled boolean DEFAULT true,
    created_at timestamp with time zone DEFAULT now(),
    updated_at timestamp with time zone DEFAULT now(),
    provider_types text[] DEFAULT '{}'::text[],
    fallback_keywords text[] DEFAULT '{}'::text[]
);


--
-- Name: local_service_providers; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.local_service_providers (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    country_code text NOT NULL,
    category_id uuid,
    provider_name text NOT NULL,
    provider_slug text NOT NULL,
    provider_description text,
    logo_url text,
    official_website text,
    search_keywords text[] DEFAULT '{}'::text[],
    address text,
    latitude double precision,
    longitude double precision,
    external_place_id text,
    source text DEFAULT 'admin'::text,
    verified boolean DEFAULT false,
    enabled boolean DEFAULT true,
    display_order integer DEFAULT 0,
    created_at timestamp with time zone DEFAULT now(),
    updated_at timestamp with time zone DEFAULT now()
);


--
-- Name: market_availability; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.market_availability (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    country_code character varying(2) NOT NULL,
    market_city character varying(120),
    zone_id uuid,
    launch_status character varying(30) NOT NULL,
    customer_app_enabled boolean DEFAULT false NOT NULL,
    customer_registration_enabled boolean DEFAULT false NOT NULL,
    driver_registration_enabled boolean DEFAULT false NOT NULL,
    driver_online_enabled boolean DEFAULT false NOT NULL,
    quote_enabled boolean DEFAULT false NOT NULL,
    booking_enabled boolean DEFAULT false NOT NULL,
    payment_enabled boolean DEFAULT false NOT NULL,
    waiting_list_enabled boolean DEFAULT true NOT NULL,
    supported_currency character varying(3),
    timezone character varying(80),
    unavailable_title character varying(160),
    unavailable_message text,
    valid_from timestamp with time zone,
    valid_until timestamp with time zone,
    enabled boolean DEFAULT false NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT market_availability_launch_status_check CHECK (((launch_status)::text = ANY (ARRAY[('disabled'::character varying)::text, ('coming_soon'::character varying)::text, ('driver_onboarding'::character varying)::text, ('customer_beta'::character varying)::text, ('live'::character varying)::text, ('paused'::character varying)::text])))
);


--
-- Name: market_availability_audit; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.market_availability_audit (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    country_code character varying(2),
    market_city character varying(120),
    zone_id uuid,
    capability character varying(40) NOT NULL,
    allowed boolean NOT NULL,
    launch_status character varying(30),
    resolution_level character varying(20) NOT NULL,
    endpoint character varying(160),
    error_code character varying(50),
    created_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: market_payment_route_audit; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.market_payment_route_audit (
    id bigint NOT NULL,
    route_id uuid NOT NULL,
    actor text NOT NULL,
    old_values jsonb,
    new_values jsonb NOT NULL,
    changed_at timestamp with time zone DEFAULT clock_timestamp() NOT NULL
);


--
-- Name: market_payment_route_audit_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

ALTER TABLE public.market_payment_route_audit ALTER COLUMN id ADD GENERATED ALWAYS AS IDENTITY (
    SEQUENCE NAME public.market_payment_route_audit_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1
);


--
-- Name: market_price_snapshots; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.market_price_snapshots (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    country_code character varying(2) NOT NULL,
    market_city character varying(120),
    service_type character varying(80) NOT NULL,
    vehicle_class character varying(80),
    distance_km numeric(12,3),
    duration_minutes numeric(12,3),
    competitor_count integer DEFAULT 0 NOT NULL,
    lowest_competitor_fare numeric(12,2),
    average_competitor_fare numeric(12,2),
    median_competitor_fare numeric(12,2),
    highest_competitor_fare numeric(12,2),
    currency character varying(3) NOT NULL,
    calculated_at timestamp with time zone DEFAULT now() NOT NULL,
    expires_at timestamp with time zone,
    benchmark_ids uuid[],
    created_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: market_pricing_strategies; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.market_pricing_strategies (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    country_code character varying(2) NOT NULL,
    market_city character varying(120),
    zone_id uuid,
    service_type character varying(80) NOT NULL,
    vehicle_class character varying(80),
    strategy character varying(30) DEFAULT 'manual'::character varying NOT NULL,
    target_difference_percent numeric(8,4) DEFAULT 0 NOT NULL,
    minimum_driver_hourly_rate numeric(12,2),
    minimum_driver_per_km numeric(12,4),
    minimum_driver_payout numeric(12,2),
    minimum_platform_margin_percent numeric(8,4) DEFAULT 0 NOT NULL,
    minimum_platform_revenue numeric(12,2) DEFAULT 0 NOT NULL,
    maximum_customer_discount_percent numeric(8,4) DEFAULT 15 NOT NULL,
    maximum_market_adjustment_percent numeric(8,4) DEFAULT 20 NOT NULL,
    currency character varying(3) NOT NULL,
    enabled boolean DEFAULT false NOT NULL,
    valid_from timestamp with time zone,
    valid_until timestamp with time zone,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    minimum_launch_target_fare numeric(12,2),
    commission_percent numeric(8,4),
    normal_demand_multiplier numeric(8,4),
    busy_multiplier numeric(8,4),
    maximum_surge_multiplier numeric(8,4),
    CONSTRAINT market_pricing_strategies_strategy_check CHECK (((strategy)::text = ANY (ARRAY[('manual'::character varying)::text, ('match_market'::character varying)::text, ('beat_market'::character varying)::text, ('premium'::character varying)::text, ('lowest_sustainable'::character varying)::text])))
);


--
-- Name: COLUMN market_pricing_strategies.minimum_launch_target_fare; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.market_pricing_strategies.minimum_launch_target_fare IS 'Optional market/country/service-specific minimum suggested launch fare. Sustainability floors always take precedence.';


--
-- Name: market_waiting_list; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.market_waiting_list (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    email text NOT NULL,
    country_code character varying(2) NOT NULL,
    market_city character varying(120),
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: marketplace_commission_overrides; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.marketplace_commission_overrides (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    tenant_id uuid,
    service_type_slug text,
    city_zone text,
    driver_tier text,
    promotion_period_id text,
    commission_percent numeric(8,4) NOT NULL,
    platform_fee_percent numeric(8,4) DEFAULT 0 NOT NULL,
    is_active boolean DEFAULT true NOT NULL,
    starts_at timestamp with time zone,
    ends_at timestamp with time zone,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: marketplace_negotiation_events; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.marketplace_negotiation_events (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    session_id uuid NOT NULL,
    job_id uuid NOT NULL,
    proposed_by uuid NOT NULL,
    proposed_by_role text NOT NULL,
    event_type text NOT NULL,
    amount numeric(12,2),
    message text,
    round_number integer DEFAULT 0 NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT marketplace_negotiation_events_event_type_check CHECK ((event_type = ANY (ARRAY['customer_offer'::text, 'driver_counter'::text, 'customer_accept'::text, 'driver_accept'::text, 'customer_decline'::text, 'driver_decline'::text, 'session_claimed'::text, 'session_released'::text, 'session_expired'::text, 'payment_completed'::text]))),
    CONSTRAINT marketplace_negotiation_events_proposed_by_role_check CHECK ((proposed_by_role = ANY (ARRAY['customer'::text, 'driver'::text, 'system'::text])))
);


--
-- Name: marketplace_settings; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.marketplace_settings (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    tenant_id uuid,
    key text NOT NULL,
    value jsonb DEFAULT '{}'::jsonb NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: notifications; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.notifications (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    user_id uuid NOT NULL,
    title text NOT NULL,
    body text NOT NULL,
    type text DEFAULT 'system'::text NOT NULL,
    is_read boolean DEFAULT false NOT NULL,
    metadata jsonb DEFAULT '{}'::jsonb NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    route text,
    data jsonb DEFAULT '{}'::jsonb NOT NULL,
    read_at timestamp with time zone
);


--
-- Name: profiles; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.profiles (
    id uuid NOT NULL,
    tenant_id uuid,
    full_name text,
    phone text,
    role text DEFAULT 'customer'::text,
    stripe_customer_id text,
    stripe_account_id text,
    is_online boolean DEFAULT false,
    is_available boolean DEFAULT true,
    last_active_at timestamp with time zone DEFAULT now(),
    currency_code text DEFAULT 'GBP'::text NOT NULL,
    country_code text,
    created_at timestamp with time zone DEFAULT now(),
    updated_at timestamp with time zone DEFAULT now(),
    subscription_status text DEFAULT 'inactive'::text,
    pricing_plan text DEFAULT 'starter'::text,
    commission_rate numeric(5,2) DEFAULT 15.00,
    onboarding_completed boolean DEFAULT false,
    account_status text DEFAULT 'active'::text,
    moderation_reason text,
    moderated_at timestamp with time zone,
    completion_rate numeric DEFAULT 1.0,
    cancellation_rate numeric DEFAULT 0.0,
    lat numeric,
    lng numeric,
    driver_license_url text,
    insurance_url text,
    verification_status text DEFAULT 'draft'::text,
    verification_notes text,
    verification_items text[],
    verified_at timestamp without time zone,
    council_license_number text,
    council_name text,
    taxi_badge_number text,
    taxi_license_expiry date,
    stripe_connect_status text DEFAULT 'not_started'::text,
    vehicle_check_status text DEFAULT 'not_checked'::text,
    mot_check_status text DEFAULT 'not_checked'::text,
    insurance_check_status text DEFAULT 'manual_required'::text,
    council_check_status text DEFAULT 'manual_required'::text,
    verification_blockers jsonb DEFAULT '[]'::jsonb,
    manual_verification_notes text,
    testing_approval_override boolean DEFAULT false,
    is_verified boolean DEFAULT false,
    rating numeric DEFAULT 0,
    driver_rating numeric DEFAULT 0,
    review_count integer DEFAULT 0,
    account_closure_requested_at timestamp with time zone,
    account_closure_reason text,
    avatar_url text,
    charges_enabled boolean DEFAULT false,
    payouts_enabled boolean DEFAULT false,
    movabi_pay_card_preference text DEFAULT 'virtual'::text,
    movabi_pay_physical_card_status text DEFAULT 'not_requested'::text,
    movabi_pay_physical_card_received_at timestamp with time zone,
    compliance_status text DEFAULT 'draft'::text,
    accepted_terms_at timestamp with time zone,
    accepted_privacy_at timestamp with time zone,
    accepted_driver_agreement_at timestamp with time zone,
    date_of_birth date,
    current_address text,
    address_line1 text,
    home_address text,
    email_verified boolean DEFAULT false,
    email_confirmed_at timestamp with time zone,
    phone_verified boolean DEFAULT false,
    phone_verified_at timestamp with time zone,
    phone_verification_supported boolean DEFAULT false,
    profile_photo_status text DEFAULT 'missing'::text,
    live_selfie_url text,
    live_selfie_status text DEFAULT 'missing'::text,
    driver_license_status text DEFAULT 'missing'::text,
    driver_license_expiry date,
    insurance_status text DEFAULT 'missing'::text,
    insurance_expiry date,
    right_to_work_url text,
    right_to_work_share_code text,
    right_to_work_status text DEFAULT 'missing'::text,
    private_hire_driver_license_url text,
    private_hire_driver_license_status text DEFAULT 'missing'::text,
    private_hire_vehicle_license_url text,
    private_hire_vehicle_license_status text DEFAULT 'missing'::text,
    private_hire_insurance_url text,
    private_hire_insurance_status text DEFAULT 'missing'::text,
    council_license_authority text,
    council_license_expiry date,
    vehicle_license_url text,
    vehicle_license_status text DEFAULT 'missing'::text,
    vehicle_license_expiry date,
    mot_url text,
    mot_status text DEFAULT 'missing'::text,
    mot_expiry date,
    background_check_status text DEFAULT 'missing'::text,
    operator_compliance_status text DEFAULT 'missing'::text,
    courier_insurance_url text,
    courier_insurance_status text DEFAULT 'missing'::text,
    courier_insurance_expiry date,
    goods_in_transit_insurance_url text,
    goods_in_transit_insurance_status text DEFAULT 'missing'::text,
    goods_in_transit_insurance_expiry date,
    public_liability_insurance_url text,
    public_liability_insurance_status text DEFAULT 'missing'::text,
    public_liability_insurance_expiry date,
    moving_insurance_url text,
    moving_insurance_status text DEFAULT 'missing'::text,
    moving_insurance_expiry date,
    helper_labour_declaration boolean DEFAULT false,
    driver_review_status text,
    driver_review_notes text,
    driver_review_blockers jsonb,
    driver_review_sent_at timestamp with time zone,
    driver_review_sent_by uuid,
    driver_review_history jsonb,
    closure_requested_at timestamp with time zone,
    closed_at timestamp with time zone,
    closure_reason text,
    closure_notes text,
    reinstated_at timestamp with time zone,
    reinstated_by uuid,
    reinstatement_notes text,
    registration_activated_at timestamp with time zone,
    registration_country_code text,
    registration_market_city text,
    CONSTRAINT profiles_pricing_plan_check CHECK ((pricing_plan = ANY (ARRAY['starter'::text, 'pro'::text])))
);


--
-- Name: COLUMN profiles.registration_activated_at; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.profiles.registration_activated_at IS 'Server-authoritative registration-market activation. NULL = authenticated but registration-pending. Only the Movabi server (or this migration''s grandfathering) may set it.';


--
-- Name: COLUMN profiles.registration_country_code; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.profiles.registration_country_code IS 'Normalized ISO2 registration country that PASSED market capability validation.';


--
-- Name: COLUMN profiles.registration_market_city; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.profiles.registration_market_city IS 'Normalized registration market city that PASSED market capability validation.';


--
-- Name: operations_metrics; Type: VIEW; Schema: public; Owner: -
--

CREATE VIEW public.operations_metrics AS
 SELECT jobs.tenant_id,
    count(*) FILTER (WHERE (jobs.status = ANY (ARRAY['accepted'::text, 'in_progress'::text]))) AS active_jobs_count,
    sum(jobs.price) FILTER (WHERE ((jobs.status = 'completed'::text) AND (jobs.created_at >= CURRENT_DATE))) AS revenue_today,
    ( SELECT count(*) AS count
           FROM public.profiles
          WHERE ((profiles.is_online = true) AND (profiles.tenant_id = jobs.tenant_id))) AS online_drivers_count
   FROM public.jobs
  GROUP BY jobs.tenant_id;


--
-- Name: operations_metrics_v2; Type: VIEW; Schema: public; Owner: -
--

CREATE VIEW public.operations_metrics_v2 AS
 SELECT jobs.tenant_id,
    count(*) FILTER (WHERE (jobs.status = ANY (ARRAY['accepted'::text, 'in_progress'::text]))) AS active_jobs_count,
    sum(jobs.price) FILTER (WHERE ((jobs.status = 'completed'::text) AND (jobs.created_at >= CURRENT_DATE))) AS revenue_today,
    sum(jobs.platform_fee) FILTER (WHERE ((jobs.status = 'completed'::text) AND (jobs.created_at >= CURRENT_DATE))) AS platform_earnings_today,
    count(*) FILTER (WHERE (jobs.pricing_plan_used = 'pro'::text)) AS pro_jobs_count,
    count(*) FILTER (WHERE (jobs.pricing_plan_used = 'starter'::text)) AS starter_jobs_count,
    ( SELECT count(*) AS count
           FROM public.profiles
          WHERE ((profiles.is_online = true) AND (profiles.tenant_id = jobs.tenant_id))) AS online_drivers_count
   FROM public.jobs
  GROUP BY jobs.tenant_id;


--
-- Name: operations_metrics_v3; Type: VIEW; Schema: public; Owner: -
--

CREATE VIEW public.operations_metrics_v3 AS
 SELECT jobs.tenant_id,
    count(*) FILTER (WHERE (jobs.status = ANY (ARRAY['accepted'::text, 'in_progress'::text]))) AS active_jobs_count,
    sum(jobs.price) FILTER (WHERE ((jobs.status = 'completed'::text) AND (jobs.created_at >= CURRENT_DATE))) AS revenue_today,
    sum(jobs.platform_fee) FILTER (WHERE ((jobs.status = 'completed'::text) AND (jobs.created_at >= CURRENT_DATE))) AS platform_earnings_today,
    sum(jobs.driver_payout) FILTER (WHERE ((jobs.status = 'completed'::text) AND (jobs.created_at >= CURRENT_DATE))) AS driver_payouts_today,
    count(*) FILTER (WHERE (jobs.pricing_plan_used = 'pro'::text)) AS pro_jobs_count,
    count(*) FILTER (WHERE (jobs.pricing_plan_used = 'starter'::text)) AS starter_jobs_count,
    ( SELECT count(*) AS count
           FROM public.profiles p
          WHERE ((p.role = 'driver'::text) AND (p.is_online = true) AND (p.tenant_id = jobs.tenant_id) AND (EXISTS ( SELECT 1
                   FROM public.app_presence_sessions s
                  WHERE ((s.user_id = p.id) AND (s.seen_at > (now() - '00:02:00'::interval))))))) AS online_drivers_count,
    ( SELECT count(*) AS count
           FROM public.profiles
          WHERE ((profiles.pricing_plan = 'pro'::text) AND (profiles.tenant_id = jobs.tenant_id))) AS total_pro_drivers
   FROM public.jobs
  GROUP BY jobs.tenant_id;


--
-- Name: payment_card_consents; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.payment_card_consents (
    job_id uuid NOT NULL,
    user_id uuid NOT NULL,
    provider text NOT NULL,
    merchant_account_ref text NOT NULL,
    version text NOT NULL,
    accepted_at timestamp with time zone NOT NULL
);


--
-- Name: payment_checkout_attempts; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.payment_checkout_attempts (
    reference text NOT NULL,
    request jsonb NOT NULL,
    state text DEFAULT 'started'::text NOT NULL,
    checkout_url text,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT payment_checkout_attempts_state_check CHECK ((state = ANY (ARRAY['started'::text, 'submitted'::text, 'unknown'::text])))
);


--
-- Name: payment_customers; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.payment_customers (
    user_id uuid NOT NULL,
    provider text NOT NULL,
    merchant_account_ref text NOT NULL,
    customer_reference text NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT payment_customers_provider_check CHECK ((provider = ANY (ARRAY['stripe'::text, 'kora'::text, 'fincra'::text, 'flutterwave'::text, 'paystack'::text])))
);


--
-- Name: payout_batches; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.payout_batches (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    total_amount numeric DEFAULT 0,
    status text DEFAULT 'processing'::text,
    created_at timestamp with time zone DEFAULT now(),
    processed_at timestamp with time zone
);


--
-- Name: pricing_calendar_events; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.pricing_calendar_events (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    country_code text NOT NULL,
    region_code text,
    zone_id text,
    event_type text NOT NULL,
    title text NOT NULL,
    starts_at timestamp with time zone NOT NULL,
    ends_at timestamp with time zone NOT NULL,
    expected_demand_impact numeric(8,4) DEFAULT 0 NOT NULL,
    expected_supply_impact numeric(8,4) DEFAULT 0 NOT NULL,
    source text,
    is_active boolean DEFAULT true NOT NULL,
    metadata jsonb DEFAULT '{}'::jsonb NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: pricing_config; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.pricing_config (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    service_type text NOT NULL,
    base_fare numeric(10,2) NOT NULL,
    per_km numeric(10,2) NOT NULL,
    per_min numeric(10,2) NOT NULL,
    service_fee numeric(10,2) NOT NULL,
    minimum_fare numeric(10,2) NOT NULL,
    currency_code text DEFAULT 'GBP'::text NOT NULL,
    is_active boolean DEFAULT true NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    free_included_items integer DEFAULT 1,
    extra_item_fee numeric DEFAULT 0.75,
    large_shopping_surcharge numeric DEFAULT 0,
    large_shopping_threshold numeric DEFAULT 100,
    peak_multiplier numeric DEFAULT 1,
    weather_multiplier numeric DEFAULT 1,
    country_code text,
    market_city text,
    zone_id text,
    currency_symbol text,
    locale text,
    distance_unit text DEFAULT 'km'::text,
    included_task_minutes numeric(10,2) DEFAULT 0 NOT NULL,
    per_additional_task_minute numeric(10,2) DEFAULT 0 NOT NULL,
    ride_xl_surcharge numeric(10,2) DEFAULT 0 NOT NULL,
    ride_minibus_surcharge numeric(10,2) DEFAULT 0 NOT NULL,
    delivery_medium_package_surcharge numeric(10,2) DEFAULT 0 NOT NULL,
    delivery_large_package_surcharge numeric(10,2) DEFAULT 0 NOT NULL,
    car_vehicle_surcharge numeric(10,2) DEFAULT 0 NOT NULL,
    small_van_surcharge numeric(10,2) DEFAULT 0 NOT NULL,
    large_van_surcharge numeric(10,2) DEFAULT 0 NOT NULL,
    errand_car_surcharge numeric(10,2) DEFAULT 0 NOT NULL,
    errand_van_surcharge numeric(10,2) DEFAULT 0 NOT NULL,
    move_medium_multiplier numeric(8,4) DEFAULT 1 NOT NULL,
    move_large_multiplier numeric(8,4) DEFAULT 1 NOT NULL,
    move_full_house_multiplier numeric(8,4) DEFAULT 1 NOT NULL,
    helper_surcharge numeric(10,2) DEFAULT 0 NOT NULL,
    stairs_surcharge numeric(10,2) DEFAULT 0 NOT NULL,
    packing_surcharge numeric(10,2) DEFAULT 0 NOT NULL,
    fragile_items_surcharge numeric(10,2) DEFAULT 0 NOT NULL,
    CONSTRAINT pricing_config_base_fare_check CHECK ((base_fare >= (0)::numeric)),
    CONSTRAINT pricing_config_minimum_fare_check CHECK ((minimum_fare >= (0)::numeric)),
    CONSTRAINT pricing_config_per_km_check CHECK ((per_km >= (0)::numeric)),
    CONSTRAINT pricing_config_per_min_check CHECK ((per_min >= (0)::numeric)),
    CONSTRAINT pricing_config_service_fee_check CHECK ((service_fee >= (0)::numeric)),
    CONSTRAINT pricing_config_service_type_check CHECK ((service_type = ANY (ARRAY['ride'::text, 'errand'::text, 'delivery'::text, 'van-moving'::text]))),
    CONSTRAINT service_type_check CHECK ((service_type = ANY (ARRAY['ride'::text, 'errand'::text, 'delivery'::text, 'van-moving'::text])))
);


--
-- Name: pricing_conversion_rules; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.pricing_conversion_rules (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    base_country_code text NOT NULL,
    target_country_code text NOT NULL,
    base_currency_code text NOT NULL,
    target_currency_code text NOT NULL,
    service_type text NOT NULL,
    exchange_rate numeric NOT NULL,
    pricing_multiplier numeric DEFAULT 1.0 NOT NULL,
    minimum_fare_multiplier numeric DEFAULT 1.0 NOT NULL,
    rounding_increment numeric DEFAULT 0.01 NOT NULL,
    is_active boolean DEFAULT true NOT NULL,
    effective_from timestamp with time zone,
    effective_to timestamp with time zone,
    priority integer DEFAULT 100 NOT NULL,
    metadata jsonb,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    service_type_slug text
);


--
-- Name: pricing_markets; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.pricing_markets (
    country_code text NOT NULL,
    currency_code text NOT NULL,
    timezone text NOT NULL,
    distance_unit text NOT NULL,
    tax_inclusive_display boolean DEFAULT true NOT NULL,
    tax_rate numeric(8,4) DEFAULT 0 NOT NULL,
    default_language text,
    rounding_rule jsonb DEFAULT '{}'::jsonb NOT NULL,
    minimum_charge_unit_minor integer DEFAULT 1 NOT NULL,
    pricing_model text DEFAULT 'rules_shadow'::text NOT NULL,
    market_enabled boolean DEFAULT false NOT NULL,
    ai_pricing_enabled boolean DEFAULT false NOT NULL,
    shadow_mode_enabled boolean DEFAULT true NOT NULL,
    experimentation_enabled boolean DEFAULT false NOT NULL,
    emergency_pricing_disabled boolean DEFAULT false NOT NULL,
    confidence_threshold numeric(5,4) DEFAULT 0.75 NOT NULL,
    model_version text DEFAULT 'global-pricing-v1'::text NOT NULL,
    configuration_version integer DEFAULT 1 NOT NULL,
    metadata jsonb DEFAULT '{}'::jsonb NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT pricing_markets_distance_unit_check CHECK ((distance_unit = ANY (ARRAY['km'::text, 'mi'::text])))
);


--
-- Name: pricing_rules_raw; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.pricing_rules_raw (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    tenant_id uuid,
    country_code text DEFAULT 'GB'::text NOT NULL,
    currency_code text DEFAULT 'GBP'::text NOT NULL,
    service_type text NOT NULL,
    base_fee numeric(12,2) DEFAULT 0,
    per_km_fee numeric(12,2) DEFAULT 0,
    per_minute_fee numeric(12,2) DEFAULT 0,
    minimum_fare numeric(12,2) DEFAULT 0,
    created_at timestamp with time zone DEFAULT now(),
    updated_at timestamp with time zone DEFAULT now(),
    service_type_id uuid,
    is_active boolean DEFAULT true,
    base_fare numeric,
    per_km_rate numeric,
    per_minute_rate numeric,
    city_id uuid,
    is_promo boolean DEFAULT false,
    promo_ends_at timestamp with time zone,
    effective_from timestamp with time zone,
    effective_to timestamp with time zone,
    priority integer DEFAULT 100
);


--
-- Name: pricing_rules; Type: VIEW; Schema: public; Owner: -
--

CREATE VIEW public.pricing_rules AS
 SELECT pricing_rules_raw.id,
    pricing_rules_raw.tenant_id,
    pricing_rules_raw.city_id,
    pricing_rules_raw.country_code,
    pricing_rules_raw.currency_code,
    pricing_rules_raw.service_type,
    pricing_rules_raw.service_type_id,
    pricing_rules_raw.base_fee,
    pricing_rules_raw.per_km_fee,
    pricing_rules_raw.per_minute_fee,
    pricing_rules_raw.minimum_fare,
    COALESCE(pricing_rules_raw.base_fare, pricing_rules_raw.base_fee) AS base_fare,
    COALESCE(pricing_rules_raw.per_km_rate, pricing_rules_raw.per_km_fee) AS per_km_rate,
    COALESCE(pricing_rules_raw.per_minute_rate, pricing_rules_raw.per_minute_fee) AS per_minute_rate,
    COALESCE(pricing_rules_raw.is_active, true) AS is_active,
    COALESCE(pricing_rules_raw.is_promo, false) AS is_promo,
    pricing_rules_raw.promo_ends_at,
    pricing_rules_raw.effective_from,
    pricing_rules_raw.effective_to,
    COALESCE(pricing_rules_raw.priority, 100) AS priority,
    pricing_rules_raw.created_at,
    pricing_rules_raw.updated_at
   FROM public.pricing_rules_raw;


--
-- Name: pricing_waiting_rules; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.pricing_waiting_rules (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    country_code text NOT NULL,
    zone_id text,
    service_slug text NOT NULL,
    free_waiting_minutes integer DEFAULT 0 NOT NULL,
    airport_free_waiting_minutes integer DEFAULT 0 NOT NULL,
    accessibility_free_waiting_minutes integer DEFAULT 0 NOT NULL,
    per_minute_charge_minor integer DEFAULT 0 NOT NULL,
    maximum_charge_minor integer DEFAULT 0 NOT NULL,
    cancellation_threshold_minutes integer,
    partial_minute_rounding text DEFAULT 'ceil'::text NOT NULL,
    is_active boolean DEFAULT true NOT NULL,
    metadata jsonb DEFAULT '{}'::jsonb NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: pricing_zones; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.pricing_zones (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    country_code text NOT NULL,
    city_id uuid,
    city_name text,
    zone_id text NOT NULL,
    polygon jsonb,
    base_cost_index numeric(10,4) DEFAULT 1 NOT NULL,
    congestion_index numeric(10,4) DEFAULT 1 NOT NULL,
    purchasing_power_index numeric(10,4) DEFAULT 1 NOT NULL,
    driver_cost_index numeric(10,4) DEFAULT 1 NOT NULL,
    fuel_cost_index numeric(10,4) DEFAULT 1 NOT NULL,
    insurance_cost_index numeric(10,4) DEFAULT 1 NOT NULL,
    regulatory_fee_minor integer DEFAULT 0 NOT NULL,
    airport_fee_minor integer DEFAULT 0 NOT NULL,
    max_surge_multiplier numeric(6,3) DEFAULT 1 NOT NULL,
    minimum_driver_earnings_minor integer DEFAULT 0 NOT NULL,
    enabled_services text[],
    priority integer DEFAULT 100 NOT NULL,
    is_active boolean DEFAULT true NOT NULL,
    metadata jsonb DEFAULT '{}'::jsonb NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: provider_brand_assets; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.provider_brand_assets (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    provider_id uuid,
    external_place_id text,
    provider_name text NOT NULL,
    country_code text DEFAULT 'GB'::text NOT NULL,
    official_domain text,
    logo_url text,
    favicon_url text,
    source text DEFAULT 'admin'::text,
    verified boolean DEFAULT false,
    confidence numeric DEFAULT 0,
    last_checked_at timestamp with time zone,
    created_at timestamp with time zone DEFAULT now(),
    updated_at timestamp with time zone DEFAULT now()
);


--
-- Name: quote_market_adjustments; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.quote_market_adjustments (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    job_id uuid,
    booking_id uuid,
    quote_reference character varying(150),
    strategy_id uuid,
    market_snapshot_id uuid,
    base_service_fare numeric(12,2) NOT NULL,
    market_reference_fare numeric(12,2),
    requested_difference_percent numeric(8,4),
    requested_target_fare numeric(12,2),
    driver_protection_floor numeric(12,2),
    platform_margin_floor numeric(12,2),
    applied_market_adjustment numeric(12,2) DEFAULT 0 NOT NULL,
    adjusted_service_fare numeric(12,2) NOT NULL,
    platform_fee_amount numeric(12,2) DEFAULT 0 NOT NULL,
    customer_total numeric(12,2) NOT NULL,
    driver_commission_amount numeric(12,2) DEFAULT 0 NOT NULL,
    driver_payout numeric(12,2) NOT NULL,
    currency character varying(3) NOT NULL,
    feature_enabled boolean DEFAULT false NOT NULL,
    adjustment_applied boolean DEFAULT false NOT NULL,
    fallback_reason character varying(255),
    calculation_version character varying(40) DEFAULT 'market-v1'::character varying NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    original_service_fare numeric(12,2),
    original_customer_total numeric(12,2),
    minimum_sustainable_fare numeric(12,2),
    suggested_final_fare numeric(12,2),
    returned_customer_fare numeric(12,2),
    benchmark_used boolean DEFAULT false NOT NULL,
    internal_signals_used boolean DEFAULT false NOT NULL,
    strategy_version character varying(40),
    service_type text,
    vehicle_class text,
    platform_revenue numeric(12,2),
    service_specific_surcharges jsonb,
    shadow_mode boolean,
    country_code text,
    market_city text,
    zone_id text,
    protected_fare_snapshot jsonb
);


--
-- Name: COLUMN quote_market_adjustments.country_code; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.quote_market_adjustments.country_code IS 'Provenance recorded at quote time. TEXT to match the live production shape added during the emergency repair (see migration header).';


--
-- Name: COLUMN quote_market_adjustments.market_city; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.quote_market_adjustments.market_city IS 'Provenance recorded at quote time. TEXT to match the live production shape (see migration header).';


--
-- Name: COLUMN quote_market_adjustments.zone_id; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.quote_market_adjustments.zone_id IS 'Provenance recorded at quote time. TEXT to match the live production shape (see migration header).';


--
-- Name: ratings; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.ratings (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    job_id uuid NOT NULL,
    customer_id uuid NOT NULL,
    score integer NOT NULL,
    comment text,
    created_at timestamp with time zone DEFAULT now(),
    booking_id uuid,
    driver_id uuid,
    CONSTRAINT ratings_score_check CHECK (((score >= 1) AND (score <= 5)))
);


--
-- Name: regional_pricing_rules; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.regional_pricing_rules (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    country_code text DEFAULT 'GB'::text NOT NULL,
    currency_code text DEFAULT 'GBP'::text NOT NULL,
    currency_symbol text DEFAULT '£'::text NOT NULL,
    service_slug text NOT NULL,
    pricing_plan text DEFAULT 'starter'::text NOT NULL,
    base_fare numeric DEFAULT 0 NOT NULL,
    price_per_km numeric DEFAULT 0 NOT NULL,
    price_per_minute numeric DEFAULT 0 NOT NULL,
    minimum_fare numeric DEFAULT 0 NOT NULL,
    platform_commission_percent numeric DEFAULT 15 NOT NULL,
    cancellation_fee numeric DEFAULT 0 NOT NULL,
    tax_percent numeric DEFAULT 0 NOT NULL,
    is_active boolean DEFAULT true NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: ride_details; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.ride_details (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    job_id uuid NOT NULL,
    passenger_count integer NOT NULL,
    vehicle_type text,
    special_requirements text,
    created_at timestamp with time zone DEFAULT now(),
    updated_at timestamp with time zone DEFAULT now(),
    notes text
);


--
-- Name: schema_migrations; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.schema_migrations (
    version character varying(14) NOT NULL
);


--
-- Name: service_market_rules; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.service_market_rules (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    country_code text NOT NULL,
    zone_id text,
    service_slug text NOT NULL,
    vehicle_class text,
    base_fare_minor integer DEFAULT 0 NOT NULL,
    per_distance_unit_minor integer DEFAULT 0 NOT NULL,
    per_minute_minor integer DEFAULT 0 NOT NULL,
    minimum_fare_minor integer DEFAULT 0 NOT NULL,
    booking_fee_minor integer DEFAULT 0 NOT NULL,
    cancellation_fee_minor integer DEFAULT 0 NOT NULL,
    waiting_fee_per_minute_minor integer DEFAULT 0 NOT NULL,
    maximum_fare_minor integer,
    maximum_surge_multiplier numeric(6,3) DEFAULT 1 NOT NULL,
    commission_percent numeric(8,4) DEFAULT 0 NOT NULL,
    tax_treatment text DEFAULT 'market'::text NOT NULL,
    toll_treatment text DEFAULT 'actual'::text NOT NULL,
    payment_rules jsonb DEFAULT '{}'::jsonb NOT NULL,
    ai_pricing_enabled boolean DEFAULT false NOT NULL,
    surge_enabled boolean DEFAULT false NOT NULL,
    is_active boolean DEFAULT true NOT NULL,
    metadata jsonb DEFAULT '{}'::jsonb NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: service_types; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.service_types (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    slug text NOT NULL,
    name text NOT NULL,
    description text,
    icon text,
    base_price numeric(10,2) DEFAULT 0.00,
    is_active boolean DEFAULT true NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    price_per_km numeric DEFAULT 0,
    currency_code text DEFAULT 'GBP'::text,
    currency_symbol text DEFAULT '£'::text
);


--
-- Name: stripe_events; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.stripe_events (
    id text NOT NULL,
    type text,
    status text DEFAULT 'received'::text,
    error_message text,
    processed_at timestamp with time zone,
    created_at timestamp with time zone DEFAULT now()
);


--
-- Name: subscription_plans; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.subscription_plans (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    plan_code text,
    country_code text DEFAULT 'GB'::text NOT NULL,
    currency_code text NOT NULL,
    stripe_price_id text DEFAULT 'manual'::text NOT NULL,
    amount numeric(10,2) DEFAULT 0 NOT NULL,
    "interval" text DEFAULT 'month'::text NOT NULL,
    display_name text DEFAULT 'Subscription Plan'::text NOT NULL,
    features jsonb DEFAULT '[]'::jsonb,
    is_active boolean DEFAULT true,
    created_at timestamp with time zone DEFAULT now(),
    updated_at timestamp with time zone DEFAULT now(),
    description text,
    price numeric DEFAULT 0,
    currency_symbol text DEFAULT '£'::text,
    name text
);


--
-- Name: subscriptions; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.subscriptions (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    tenant_id uuid NOT NULL,
    user_id uuid NOT NULL,
    stripe_customer_id text,
    stripe_subscription_id text,
    stripe_price_id text,
    status text NOT NULL,
    current_period_start timestamp with time zone,
    current_period_end timestamp with time zone,
    cancel_at_period_end boolean DEFAULT false,
    created_at timestamp with time zone DEFAULT now(),
    updated_at timestamp with time zone DEFAULT now(),
    currency_code text DEFAULT 'GBP'::text NOT NULL,
    country_code text DEFAULT 'GB'::text NOT NULL,
    billing_currency_code text,
    billing_country_code text,
    billing_interval text,
    billing_amount_display text
);


--
-- Name: system_config; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.system_config (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    key text NOT NULL,
    value jsonb NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: system_configs; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.system_configs (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    config_key text,
    config_value jsonb,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    key text NOT NULL,
    value jsonb DEFAULT '{}'::jsonb
);


--
-- Name: tenant_users; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.tenant_users (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    tenant_id uuid NOT NULL,
    user_id uuid NOT NULL,
    role text NOT NULL,
    created_at timestamp with time zone DEFAULT now(),
    CONSTRAINT tenant_users_role_check CHECK ((role = ANY (ARRAY['admin'::text, 'driver'::text, 'user'::text])))
);


--
-- Name: tenants; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.tenants (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    name text NOT NULL,
    slug text NOT NULL,
    created_at timestamp with time zone DEFAULT now()
);


--
-- Name: van_details; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.van_details (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    job_id uuid NOT NULL,
    helper_count integer DEFAULT 0,
    floor_number integer,
    has_elevator boolean,
    items_description text,
    created_at timestamp with time zone DEFAULT now(),
    updated_at timestamp with time zone DEFAULT now(),
    notes text,
    stairs_involved boolean DEFAULT false,
    fragile_items boolean DEFAULT false,
    packing_assistance boolean DEFAULT false
);


--
-- Name: vehicles; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.vehicles (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    user_id uuid NOT NULL,
    make text NOT NULL,
    model text NOT NULL,
    year integer NOT NULL,
    license_plate text NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    dvla_make text,
    dvla_colour text,
    dvla_tax_status text,
    dvla_mot_status text,
    mot_expiry_date date,
    vehicle_verified boolean DEFAULT false,
    last_vehicle_check_at timestamp with time zone,
    type text DEFAULT 'car'::text,
    capacity text DEFAULT 'standard'::text,
    is_verified boolean DEFAULT false,
    driver_id uuid,
    color text,
    service_eligibility jsonb
);


--
-- Name: wallet_accounts; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.wallet_accounts (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    tenant_id uuid NOT NULL,
    owner_id uuid NOT NULL,
    currency_code text NOT NULL,
    balance_purpose text NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT wallet_accounts_currency_code_check CHECK ((currency_code ~ '^[A-Z]{3}$'::text))
);


--
-- Name: wallet_business_events; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.wallet_business_events (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    event_key text NOT NULL,
    operation text NOT NULL,
    payment_provider text,
    merchant_account_ref text,
    provider_reference text,
    tenant_id uuid NOT NULL,
    owner_id uuid NOT NULL,
    currency_code text NOT NULL,
    entries jsonb NOT NULL,
    reverses_event_id uuid,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT wallet_business_events_currency_code_check CHECK ((currency_code ~ '^[A-Z]{3}$'::text)),
    CONSTRAINT wallet_business_events_payment_provider_check CHECK (((payment_provider IS NULL) OR (payment_provider = ANY (ARRAY['stripe'::text, 'kora'::text, 'fincra'::text]))))
);


--
-- Name: wallet_collection_config; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.wallet_collection_config (
    key text NOT NULL,
    value text NOT NULL
);


--
-- Name: wallet_movements; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.wallet_movements (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    event_id uuid NOT NULL,
    account_id uuid NOT NULL,
    amount_minor bigint NOT NULL,
    entry_seq smallint DEFAULT 1 NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT wallet_movements_amount_minor_check CHECK ((amount_minor <> 0))
);


--
-- Name: wallet_reconciliation_projection; Type: VIEW; Schema: public; Owner: -
--

CREATE VIEW public.wallet_reconciliation_projection AS
 SELECT a.tenant_id,
    a.owner_id,
    a.currency_code,
    a.balance_purpose,
    COALESCE(sum(m.amount_minor), (0)::numeric) AS diagnostic_balance_minor,
    count(m.id) AS movement_count
   FROM (public.wallet_accounts a
     LEFT JOIN public.wallet_movements m ON ((m.account_id = a.id)))
  GROUP BY a.tenant_id, a.owner_id, a.currency_code, a.balance_purpose;


--
-- Name: VIEW wallet_reconciliation_projection; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON VIEW public.wallet_reconciliation_projection IS 'DIAGNOSTIC ONLY. Sums signed movements per isolated account. NOT a spendable balance; never feed it into payment or payout authority.';


--
-- Name: wallet_topup_attempts; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.wallet_topup_attempts (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    attempt_key text NOT NULL,
    tenant_id uuid NOT NULL,
    owner_id uuid NOT NULL,
    country_code text NOT NULL,
    currency_code text NOT NULL,
    amount_minor bigint NOT NULL,
    destination_account_purpose text NOT NULL,
    payment_provider text NOT NULL,
    merchant_account_ref text NOT NULL,
    provider_idempotency_identity text NOT NULL,
    status text DEFAULT 'initiated'::text NOT NULL,
    provider_reference text,
    failure_reason text,
    credited_event_id uuid,
    refund_evidence_reference text,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT wallet_topup_attempts_amount_minor_check CHECK ((amount_minor > 0)),
    CONSTRAINT wallet_topup_attempts_currency_code_check CHECK ((currency_code ~ '^[A-Z]{3}$'::text)),
    CONSTRAINT wallet_topup_attempts_payment_provider_check CHECK ((payment_provider = ANY (ARRAY['stripe'::text, 'kora'::text]))),
    CONSTRAINT wallet_topup_attempts_status_check CHECK ((status = ANY (ARRAY['initiated'::text, 'submitting'::text, 'provider_pending'::text, 'confirmed'::text, 'credited'::text, 'failed'::text, 'uncertain'::text, 'refunded'::text])))
);


--
-- Name: wallet_topup_verifications; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.wallet_topup_verifications (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    attempt_id uuid NOT NULL,
    evidence_key text NOT NULL,
    provider_reference text,
    merchant_account_ref text,
    currency_code text,
    amount_minor bigint,
    final_status text NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: wallet_transactions; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.wallet_transactions (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    wallet_id uuid NOT NULL,
    user_id uuid NOT NULL,
    job_id uuid,
    transaction_type text NOT NULL,
    amount numeric(12,2) NOT NULL,
    balance_before_available numeric(12,2),
    balance_after_available numeric(12,2),
    balance_before_reserved numeric(12,2),
    balance_after_reserved numeric(12,2),
    metadata jsonb DEFAULT '{}'::jsonb,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    stripe_payment_intent_id text,
    payment_intent_id text,
    description text,
    tenant_id uuid,
    currency_code text,
    amount_minor bigint,
    balance_purpose text,
    payment_provider text,
    merchant_account_ref text,
    provider_reference text,
    event_key text,
    CONSTRAINT chk_topup_requires_stripe CHECK (((transaction_type <> 'topup'::text) OR (stripe_payment_intent_id IS NOT NULL))),
    CONSTRAINT chk_wallet_transaction_amount_non_negative CHECK ((amount >= (0)::numeric)),
    CONSTRAINT chk_wallet_transaction_type CHECK ((transaction_type = ANY (ARRAY['topup'::text, 'reservation'::text, 'release'::text, 'settlement'::text, 'refund'::text, 'adjustment'::text])))
);


--
-- Name: COLUMN wallet_transactions.tenant_id; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.wallet_transactions.tenant_id IS 'Tenant isolation tag (mirrors jobs.tenant_id). NULL = unresolved/legacy provenance.';


--
-- Name: COLUMN wallet_transactions.currency_code; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.wallet_transactions.currency_code IS 'Exact ISO-4217 currency of the entry. NULL = unresolved/legacy provenance; never inferred.';


--
-- Name: COLUMN wallet_transactions.amount_minor; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.wallet_transactions.amount_minor IS 'Exact integer minor units (bigint) = amount * 10^exp(currency_code), exp in {0,2,3}. NULL unless the conversion is exact; never rounded, never inferred.';


--
-- Name: COLUMN wallet_transactions.balance_purpose; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.wallet_transactions.balance_purpose IS 'Account/purpose dimension (customer_credit, driver_cash_credit, promotional_credit, commission, bonus, compensation, earnings_payable). NULL = unresolved/legacy. No constraint yet; taxonomy finalised in a later batch.';


--
-- Name: COLUMN wallet_transactions.payment_provider; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.wallet_transactions.payment_provider IS 'Canonical provider id (stripe | kora | fincra). NULL = unresolved/legacy provenance: this does not by itself prove the entry was an internal-only movement.';


--
-- Name: COLUMN wallet_transactions.merchant_account_ref; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.wallet_transactions.merchant_account_ref IS 'Merchant-account scope from market_payment_routes. NULL = unresolved/legacy provenance; not proof of an internal-only movement.';


--
-- Name: COLUMN wallet_transactions.provider_reference; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.wallet_transactions.provider_reference IS 'External provider reference (Stripe PaymentIntent id, Kora checkout/transaction reference). NULL = unresolved/legacy provenance.';


--
-- Name: COLUMN wallet_transactions.event_key; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.wallet_transactions.event_key IS 'Provider-scoped idempotency key. Format and durable, coordinated identities are defined in a later batch (no per-retry sequence). Partial unique index deduplicates non-NULL keys only.';


--
-- Name: CONSTRAINT chk_topup_requires_stripe ON wallet_transactions; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON CONSTRAINT chk_topup_requires_stripe ON public.wallet_transactions IS 'Legacy Stripe-only top-up guard (historical rows preserved). Batch 1C credits the Batch 1B ledger via post_wallet_event and does not write wallet_transactions; do not require stripe_payment_intent_id for new provider-neutral credits.';


--
-- Name: wallets; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.wallets (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    user_id uuid NOT NULL,
    available_balance numeric(12,2) DEFAULT 0.00 NOT NULL,
    reserved_balance numeric(12,2) DEFAULT 0.00 NOT NULL,
    currency_code text DEFAULT 'GBP'::text NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT chk_wallet_available_balance_non_negative CHECK ((available_balance >= (0)::numeric)),
    CONSTRAINT chk_wallet_reserved_balance_non_negative CHECK ((reserved_balance >= (0)::numeric)),
    CONSTRAINT wallets_available_balance_check CHECK ((available_balance >= (0)::numeric)),
    CONSTRAINT wallets_reserved_balance_check CHECK ((reserved_balance >= (0)::numeric))
);


--
-- Name: admin_message_email_outbox admin_message_email_outbox_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.admin_message_email_outbox
    ADD CONSTRAINT admin_message_email_outbox_pkey PRIMARY KEY (entry_id);


--
-- Name: admin_message_entries admin_message_entries_notification_id_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.admin_message_entries
    ADD CONSTRAINT admin_message_entries_notification_id_key UNIQUE (notification_id);


--
-- Name: admin_message_entries admin_message_entries_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.admin_message_entries
    ADD CONSTRAINT admin_message_entries_pkey PRIMARY KEY (id);


--
-- Name: admin_message_entries admin_message_entries_thread_id_sender_id_request_id_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.admin_message_entries
    ADD CONSTRAINT admin_message_entries_thread_id_sender_id_request_id_key UNIQUE (thread_id, sender_id, request_id);


--
-- Name: admin_message_threads admin_message_threads_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.admin_message_threads
    ADD CONSTRAINT admin_message_threads_pkey PRIMARY KEY (id);


--
-- Name: ai_pricing_audits ai_pricing_audits_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.ai_pricing_audits
    ADD CONSTRAINT ai_pricing_audits_pkey PRIMARY KEY (id);


--
-- Name: app_features app_features_feature_name_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.app_features
    ADD CONSTRAINT app_features_feature_name_key UNIQUE (feature_name);


--
-- Name: app_features app_features_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.app_features
    ADD CONSTRAINT app_features_pkey PRIMARY KEY (id);


--
-- Name: app_presence_sessions app_presence_sessions_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.app_presence_sessions
    ADD CONSTRAINT app_presence_sessions_pkey PRIMARY KEY (user_id, session_id);


--
-- Name: audit_logs audit_logs_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.audit_logs
    ADD CONSTRAINT audit_logs_pkey PRIMARY KEY (id);


--
-- Name: booking_status_history booking_status_history_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.booking_status_history
    ADD CONSTRAINT booking_status_history_pkey PRIMARY KEY (id);


--
-- Name: booking_support_requests booking_support_requests_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.booking_support_requests
    ADD CONSTRAINT booking_support_requests_pkey PRIMARY KEY (id);


--
-- Name: booking_support_requests booking_support_requests_user_id_request_id_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.booking_support_requests
    ADD CONSTRAINT booking_support_requests_user_id_request_id_key UNIQUE (user_id, request_id);


--
-- Name: cities cities_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.cities
    ADD CONSTRAINT cities_pkey PRIMARY KEY (id);


--
-- Name: competitor_fare_benchmarks competitor_fare_benchmarks_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.competitor_fare_benchmarks
    ADD CONSTRAINT competitor_fare_benchmarks_pkey PRIMARY KEY (id);


--
-- Name: competitor_profiles competitor_profiles_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.competitor_profiles
    ADD CONSTRAINT competitor_profiles_pkey PRIMARY KEY (id);


--
-- Name: customer_local_service_preferences customer_local_service_preferences_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.customer_local_service_preferences
    ADD CONSTRAINT customer_local_service_preferences_pkey PRIMARY KEY (id);


--
-- Name: customer_wallet_sandbox_attempts_v1l customer_wallet_sandbox_attempts_v1l_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.customer_wallet_sandbox_attempts_v1l
    ADD CONSTRAINT customer_wallet_sandbox_attempts_v1l_pkey PRIMARY KEY (id);


--
-- Name: customer_wallet_sandbox_attempts_v1l customer_wallet_sandbox_attempts_v1l_reference_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.customer_wallet_sandbox_attempts_v1l
    ADD CONSTRAINT customer_wallet_sandbox_attempts_v1l_reference_key UNIQUE (reference);


--
-- Name: customer_wallet_sandbox_attempts_v1l customer_wallet_sandbox_attempts_v_owner_id_idempotency_key_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.customer_wallet_sandbox_attempts_v1l
    ADD CONSTRAINT customer_wallet_sandbox_attempts_v_owner_id_idempotency_key_key UNIQUE (owner_id, idempotency_key);


--
-- Name: customer_wallet_sandbox_cohort_v1l customer_wallet_sandbox_cohort_v1l_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.customer_wallet_sandbox_cohort_v1l
    ADD CONSTRAINT customer_wallet_sandbox_cohort_v1l_pkey PRIMARY KEY (owner_id);


--
-- Name: delivery_details delivery_details_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.delivery_details
    ADD CONSTRAINT delivery_details_pkey PRIMARY KEY (id);


--
-- Name: device_push_tokens device_push_tokens_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.device_push_tokens
    ADD CONSTRAINT device_push_tokens_pkey PRIMARY KEY (id);


--
-- Name: device_push_tokens device_push_tokens_token_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.device_push_tokens
    ADD CONSTRAINT device_push_tokens_token_key UNIQUE (token);


--
-- Name: dispatch_logs dispatch_logs_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.dispatch_logs
    ADD CONSTRAINT dispatch_logs_pkey PRIMARY KEY (id);


--
-- Name: driver_accounts driver_accounts_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.driver_accounts
    ADD CONSTRAINT driver_accounts_pkey PRIMARY KEY (id);


--
-- Name: driver_accounts driver_accounts_stripe_account_id_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.driver_accounts
    ADD CONSTRAINT driver_accounts_stripe_account_id_key UNIQUE (stripe_account_id);


--
-- Name: driver_bids driver_bids_job_id_driver_id_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.driver_bids
    ADD CONSTRAINT driver_bids_job_id_driver_id_key UNIQUE (job_id, driver_id);


--
-- Name: driver_bids driver_bids_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.driver_bids
    ADD CONSTRAINT driver_bids_pkey PRIMARY KEY (id);


--
-- Name: driver_cash_credit_config_v1e driver_cash_credit_config_v1e_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.driver_cash_credit_config_v1e
    ADD CONSTRAINT driver_cash_credit_config_v1e_pkey PRIMARY KEY (key);


--
-- Name: driver_cash_credit_enrolments_v1e driver_cash_credit_enrolments_v1e_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.driver_cash_credit_enrolments_v1e
    ADD CONSTRAINT driver_cash_credit_enrolments_v1e_pkey PRIMARY KEY (tenant_id, driver_id, country_code, currency_code);


--
-- Name: driver_cash_credit_holds_v1e driver_cash_credit_holds_v1e_job_id_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.driver_cash_credit_holds_v1e
    ADD CONSTRAINT driver_cash_credit_holds_v1e_job_id_key UNIQUE (job_id);


--
-- Name: driver_cash_credit_holds_v1e driver_cash_credit_holds_v1e_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.driver_cash_credit_holds_v1e
    ADD CONSTRAINT driver_cash_credit_holds_v1e_pkey PRIMARY KEY (id);


--
-- Name: driver_cash_credit_holds_v1e driver_cash_credit_holds_v1e_reserve_event_id_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.driver_cash_credit_holds_v1e
    ADD CONSTRAINT driver_cash_credit_holds_v1e_reserve_event_id_key UNIQUE (reserve_event_id);


--
-- Name: driver_cash_credit_holds_v1e driver_cash_credit_holds_v1e_resolution_event_id_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.driver_cash_credit_holds_v1e
    ADD CONSTRAINT driver_cash_credit_holds_v1e_resolution_event_id_key UNIQUE (resolution_event_id);


--
-- Name: driver_earnings driver_earnings_job_id_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.driver_earnings
    ADD CONSTRAINT driver_earnings_job_id_key UNIQUE (job_id);


--
-- Name: driver_earnings driver_earnings_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.driver_earnings
    ADD CONSTRAINT driver_earnings_pkey PRIMARY KEY (id);


--
-- Name: driver_issuing_cardholders driver_issuing_cardholders_driver_id_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.driver_issuing_cardholders
    ADD CONSTRAINT driver_issuing_cardholders_driver_id_key UNIQUE (driver_id);


--
-- Name: driver_issuing_cardholders driver_issuing_cardholders_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.driver_issuing_cardholders
    ADD CONSTRAINT driver_issuing_cardholders_pkey PRIMARY KEY (id);


--
-- Name: driver_issuing_cardholders driver_issuing_cardholders_stripe_cardholder_id_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.driver_issuing_cardholders
    ADD CONSTRAINT driver_issuing_cardholders_stripe_cardholder_id_key UNIQUE (stripe_cardholder_id);


--
-- Name: driver_issuing_cards driver_issuing_cards_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.driver_issuing_cards
    ADD CONSTRAINT driver_issuing_cards_pkey PRIMARY KEY (id);


--
-- Name: driver_issuing_cards driver_issuing_cards_stripe_card_id_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.driver_issuing_cards
    ADD CONSTRAINT driver_issuing_cards_stripe_card_id_key UNIQUE (stripe_card_id);


--
-- Name: driver_job_declines driver_job_declines_driver_id_job_id_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.driver_job_declines
    ADD CONSTRAINT driver_job_declines_driver_id_job_id_key UNIQUE (driver_id, job_id);


--
-- Name: driver_job_declines driver_job_declines_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.driver_job_declines
    ADD CONSTRAINT driver_job_declines_pkey PRIMARY KEY (id);


--
-- Name: driver_locations driver_locations_driver_id_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.driver_locations
    ADD CONSTRAINT driver_locations_driver_id_key UNIQUE (driver_id);


--
-- Name: driver_locations driver_locations_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.driver_locations
    ADD CONSTRAINT driver_locations_pkey PRIMARY KEY (id);


--
-- Name: driver_onboarding_notifications driver_onboarding_notifications_event_key_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.driver_onboarding_notifications
    ADD CONSTRAINT driver_onboarding_notifications_event_key_key UNIQUE (event_key);


--
-- Name: driver_onboarding_notifications driver_onboarding_notifications_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.driver_onboarding_notifications
    ADD CONSTRAINT driver_onboarding_notifications_pkey PRIMARY KEY (id);


--
-- Name: driver_onboarding_requests driver_onboarding_requests_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.driver_onboarding_requests
    ADD CONSTRAINT driver_onboarding_requests_pkey PRIMARY KEY (id);


--
-- Name: driver_payment_accounts driver_payment_accounts_driver_id_tenant_id_country_code_cu_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.driver_payment_accounts
    ADD CONSTRAINT driver_payment_accounts_driver_id_tenant_id_country_code_cu_key UNIQUE (driver_id, tenant_id, country_code, currency_code, merchant_account_ref);


--
-- Name: driver_payment_accounts driver_payment_accounts_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.driver_payment_accounts
    ADD CONSTRAINT driver_payment_accounts_pkey PRIMARY KEY (id);


--
-- Name: driver_payout_markets driver_payout_markets_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.driver_payout_markets
    ADD CONSTRAINT driver_payout_markets_pkey PRIMARY KEY (country_code, currency_code);


--
-- Name: driver_requirement_audit driver_requirement_audit_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.driver_requirement_audit
    ADD CONSTRAINT driver_requirement_audit_pkey PRIMARY KEY (id);


--
-- Name: driver_subscriptions driver_subscriptions_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.driver_subscriptions
    ADD CONSTRAINT driver_subscriptions_pkey PRIMARY KEY (id);


--
-- Name: driver_vehicle_mot_checks driver_vehicle_mot_checks_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.driver_vehicle_mot_checks
    ADD CONSTRAINT driver_vehicle_mot_checks_pkey PRIMARY KEY (vehicle_id);


--
-- Name: email_logs email_logs_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.email_logs
    ADD CONSTRAINT email_logs_pkey PRIMARY KEY (id);


--
-- Name: errand_details errand_details_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.errand_details
    ADD CONSTRAINT errand_details_pkey PRIMARY KEY (id);


--
-- Name: errand_funding errand_funding_job_id_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.errand_funding
    ADD CONSTRAINT errand_funding_job_id_key UNIQUE (job_id);


--
-- Name: errand_funding errand_funding_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.errand_funding
    ADD CONSTRAINT errand_funding_pkey PRIMARY KEY (id);


--
-- Name: events events_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.events
    ADD CONSTRAINT events_pkey PRIMARY KEY (id);


--
-- Name: fare_negotiations fare_negotiations_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.fare_negotiations
    ADD CONSTRAINT fare_negotiations_pkey PRIMARY KEY (id);


--
-- Name: fixed_fare_bands_raw fixed_fare_bands_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.fixed_fare_bands_raw
    ADD CONSTRAINT fixed_fare_bands_pkey PRIMARY KEY (id);


--
-- Name: gb_mot_night_runs gb_mot_night_runs_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.gb_mot_night_runs
    ADD CONSTRAINT gb_mot_night_runs_pkey PRIMARY KEY (day);


--
-- Name: job_budget_authorizations job_budget_authorizations_new_intent_id_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.job_budget_authorizations
    ADD CONSTRAINT job_budget_authorizations_new_intent_id_key UNIQUE (new_intent_id);


--
-- Name: job_budget_authorizations job_budget_authorizations_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.job_budget_authorizations
    ADD CONSTRAINT job_budget_authorizations_pkey PRIMARY KEY (id);


--
-- Name: job_completion_secrets job_completion_secrets_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.job_completion_secrets
    ADD CONSTRAINT job_completion_secrets_pkey PRIMARY KEY (job_id);


--
-- Name: job_events job_events_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.job_events
    ADD CONSTRAINT job_events_pkey PRIMARY KEY (id);


--
-- Name: job_issuing_authorizations job_issuing_authorizations_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.job_issuing_authorizations
    ADD CONSTRAINT job_issuing_authorizations_pkey PRIMARY KEY (id);


--
-- Name: job_issuing_authorizations job_issuing_authorizations_stripe_authorization_id_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.job_issuing_authorizations
    ADD CONSTRAINT job_issuing_authorizations_stripe_authorization_id_key UNIQUE (stripe_authorization_id);


--
-- Name: job_issuing_reserves job_issuing_reserves_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.job_issuing_reserves
    ADD CONSTRAINT job_issuing_reserves_pkey PRIMARY KEY (job_id);


--
-- Name: job_issuing_spend_controls job_issuing_spend_controls_job_id_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.job_issuing_spend_controls
    ADD CONSTRAINT job_issuing_spend_controls_job_id_key UNIQUE (job_id);


--
-- Name: job_issuing_spend_controls job_issuing_spend_controls_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.job_issuing_spend_controls
    ADD CONSTRAINT job_issuing_spend_controls_pkey PRIMARY KEY (id);


--
-- Name: job_issuing_transactions job_issuing_transactions_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.job_issuing_transactions
    ADD CONSTRAINT job_issuing_transactions_pkey PRIMARY KEY (id);


--
-- Name: job_issuing_transactions job_issuing_transactions_stripe_transaction_id_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.job_issuing_transactions
    ADD CONSTRAINT job_issuing_transactions_stripe_transaction_id_key UNIQUE (stripe_transaction_id);


--
-- Name: job_locations job_locations_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.job_locations
    ADD CONSTRAINT job_locations_pkey PRIMARY KEY (id);


--
-- Name: job_messages job_messages_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.job_messages
    ADD CONSTRAINT job_messages_pkey PRIMARY KEY (id);


--
-- Name: job_payment_bindings job_payment_bindings_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.job_payment_bindings
    ADD CONSTRAINT job_payment_bindings_pkey PRIMARY KEY (job_id);


--
-- Name: job_payment_bindings job_payment_bindings_provider_merchant_account_ref_payment__key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.job_payment_bindings
    ADD CONSTRAINT job_payment_bindings_provider_merchant_account_ref_payment__key UNIQUE (provider, merchant_account_ref, payment_reference);


--
-- Name: job_payout_queue job_payout_queue_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.job_payout_queue
    ADD CONSTRAINT job_payout_queue_pkey PRIMARY KEY (job_id);


--
-- Name: job_queue job_queue_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.job_queue
    ADD CONSTRAINT job_queue_pkey PRIMARY KEY (id);


--
-- Name: job_service_details job_service_details_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.job_service_details
    ADD CONSTRAINT job_service_details_pkey PRIMARY KEY (id);


--
-- Name: jobs jobs_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.jobs
    ADD CONSTRAINT jobs_pkey PRIMARY KEY (id);


--
-- Name: journey_evidence_v23 journey_evidence_v23_job_id_sampled_at_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.journey_evidence_v23
    ADD CONSTRAINT journey_evidence_v23_job_id_sampled_at_key UNIQUE (job_id, sampled_at);


--
-- Name: journey_evidence_v23 journey_evidence_v23_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.journey_evidence_v23
    ADD CONSTRAINT journey_evidence_v23_pkey PRIMARY KEY (id);


--
-- Name: journey_fare_enrolments_v23 journey_fare_enrolments_v23_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.journey_fare_enrolments_v23
    ADD CONSTRAINT journey_fare_enrolments_v23_pkey PRIMARY KEY (job_id);


--
-- Name: journey_fare_events_v23 journey_fare_events_v23_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.journey_fare_events_v23
    ADD CONSTRAINT journey_fare_events_v23_pkey PRIMARY KEY (id);


--
-- Name: journey_fare_proposals_v23 journey_fare_proposals_v23_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.journey_fare_proposals_v23
    ADD CONSTRAINT journey_fare_proposals_v23_pkey PRIMARY KEY (id);


--
-- Name: journey_fare_proposals_v23 journey_fare_proposals_v23_stop_id_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.journey_fare_proposals_v23
    ADD CONSTRAINT journey_fare_proposals_v23_stop_id_key UNIQUE (stop_id);


--
-- Name: journey_start_markers_v23 journey_start_markers_v23_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.journey_start_markers_v23
    ADD CONSTRAINT journey_start_markers_v23_pkey PRIMARY KEY (job_id);


--
-- Name: journey_stop_events_v23 journey_stop_events_v23_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.journey_stop_events_v23
    ADD CONSTRAINT journey_stop_events_v23_pkey PRIMARY KEY (id);


--
-- Name: journey_stop_requests_v23 journey_stop_requests_v23_job_id_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.journey_stop_requests_v23
    ADD CONSTRAINT journey_stop_requests_v23_job_id_key UNIQUE (job_id);


--
-- Name: journey_stop_requests_v23 journey_stop_requests_v23_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.journey_stop_requests_v23
    ADD CONSTRAINT journey_stop_requests_v23_pkey PRIMARY KEY (id);


--
-- Name: kora_sandbox_booking_enrolments kora_sandbox_booking_enrolments_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.kora_sandbox_booking_enrolments
    ADD CONSTRAINT kora_sandbox_booking_enrolments_pkey PRIMARY KEY (job_id);


--
-- Name: kora_sandbox_booking_payments kora_sandbox_booking_payments_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.kora_sandbox_booking_payments
    ADD CONSTRAINT kora_sandbox_booking_payments_pkey PRIMARY KEY (job_id);


--
-- Name: kora_sandbox_booking_payments kora_sandbox_booking_payments_reference_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.kora_sandbox_booking_payments
    ADD CONSTRAINT kora_sandbox_booking_payments_reference_key UNIQUE (reference);


--
-- Name: kora_sandbox_booking_payments kora_sandbox_booking_payments_refund_reference_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.kora_sandbox_booking_payments
    ADD CONSTRAINT kora_sandbox_booking_payments_refund_reference_key UNIQUE (refund_reference);


--
-- Name: kora_sandbox_sessions kora_sandbox_sessions_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.kora_sandbox_sessions
    ADD CONSTRAINT kora_sandbox_sessions_pkey PRIMARY KEY (reference);


--
-- Name: local_place_search_cache local_place_search_cache_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.local_place_search_cache
    ADD CONSTRAINT local_place_search_cache_pkey PRIMARY KEY (id);


--
-- Name: local_service_categories local_service_categories_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.local_service_categories
    ADD CONSTRAINT local_service_categories_pkey PRIMARY KEY (id);


--
-- Name: local_service_categories local_service_categories_unique_slug; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.local_service_categories
    ADD CONSTRAINT local_service_categories_unique_slug UNIQUE (country_code, service_slug, category_slug);


--
-- Name: local_service_providers local_service_providers_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.local_service_providers
    ADD CONSTRAINT local_service_providers_pkey PRIMARY KEY (id);


--
-- Name: local_service_providers local_service_providers_unique_slug; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.local_service_providers
    ADD CONSTRAINT local_service_providers_unique_slug UNIQUE (country_code, category_id, provider_slug);


--
-- Name: market_availability_audit market_availability_audit_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.market_availability_audit
    ADD CONSTRAINT market_availability_audit_pkey PRIMARY KEY (id);


--
-- Name: market_availability market_availability_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.market_availability
    ADD CONSTRAINT market_availability_pkey PRIMARY KEY (id);


--
-- Name: market_payment_route_audit market_payment_route_audit_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.market_payment_route_audit
    ADD CONSTRAINT market_payment_route_audit_pkey PRIMARY KEY (id);


--
-- Name: market_payment_routes market_payment_routes_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.market_payment_routes
    ADD CONSTRAINT market_payment_routes_pkey PRIMARY KEY (id);


--
-- Name: market_price_snapshots market_price_snapshots_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.market_price_snapshots
    ADD CONSTRAINT market_price_snapshots_pkey PRIMARY KEY (id);


--
-- Name: market_pricing_strategies market_pricing_strategies_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.market_pricing_strategies
    ADD CONSTRAINT market_pricing_strategies_pkey PRIMARY KEY (id);


--
-- Name: market_waiting_list market_waiting_list_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.market_waiting_list
    ADD CONSTRAINT market_waiting_list_pkey PRIMARY KEY (id);


--
-- Name: marketplace_commission_overrides marketplace_commission_overri_tenant_id_service_type_slug_c_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.marketplace_commission_overrides
    ADD CONSTRAINT marketplace_commission_overri_tenant_id_service_type_slug_c_key UNIQUE NULLS NOT DISTINCT (tenant_id, service_type_slug, city_zone, driver_tier, promotion_period_id);


--
-- Name: marketplace_commission_overrides marketplace_commission_overrides_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.marketplace_commission_overrides
    ADD CONSTRAINT marketplace_commission_overrides_pkey PRIMARY KEY (id);


--
-- Name: marketplace_negotiation_events marketplace_negotiation_events_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.marketplace_negotiation_events
    ADD CONSTRAINT marketplace_negotiation_events_pkey PRIMARY KEY (id);


--
-- Name: marketplace_negotiation_sessions marketplace_negotiation_sessions_job_id_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.marketplace_negotiation_sessions
    ADD CONSTRAINT marketplace_negotiation_sessions_job_id_key UNIQUE (job_id);


--
-- Name: marketplace_negotiation_sessions marketplace_negotiation_sessions_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.marketplace_negotiation_sessions
    ADD CONSTRAINT marketplace_negotiation_sessions_pkey PRIMARY KEY (id);


--
-- Name: marketplace_settings marketplace_settings_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.marketplace_settings
    ADD CONSTRAINT marketplace_settings_pkey PRIMARY KEY (id);


--
-- Name: marketplace_settings marketplace_settings_tenant_id_key_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.marketplace_settings
    ADD CONSTRAINT marketplace_settings_tenant_id_key_key UNIQUE (tenant_id, key);


--
-- Name: notifications notifications_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.notifications
    ADD CONSTRAINT notifications_pkey PRIMARY KEY (id);


--
-- Name: payment_card_consents payment_card_consents_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.payment_card_consents
    ADD CONSTRAINT payment_card_consents_pkey PRIMARY KEY (job_id);


--
-- Name: payment_checkout_attempts payment_checkout_attempts_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.payment_checkout_attempts
    ADD CONSTRAINT payment_checkout_attempts_pkey PRIMARY KEY (reference);


--
-- Name: payment_customers payment_customers_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.payment_customers
    ADD CONSTRAINT payment_customers_pkey PRIMARY KEY (user_id, provider, merchant_account_ref);


--
-- Name: payment_customers payment_customers_provider_merchant_account_ref_customer_re_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.payment_customers
    ADD CONSTRAINT payment_customers_provider_merchant_account_ref_customer_re_key UNIQUE (provider, merchant_account_ref, customer_reference);


--
-- Name: payout_batches payout_batches_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.payout_batches
    ADD CONSTRAINT payout_batches_pkey PRIMARY KEY (id);


--
-- Name: pricing_calendar_events pricing_calendar_events_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.pricing_calendar_events
    ADD CONSTRAINT pricing_calendar_events_pkey PRIMARY KEY (id);


--
-- Name: pricing_config pricing_config_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.pricing_config
    ADD CONSTRAINT pricing_config_pkey PRIMARY KEY (id);


--
-- Name: pricing_conversion_rules pricing_conversion_rules_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.pricing_conversion_rules
    ADD CONSTRAINT pricing_conversion_rules_pkey PRIMARY KEY (id);


--
-- Name: pricing_markets pricing_markets_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.pricing_markets
    ADD CONSTRAINT pricing_markets_pkey PRIMARY KEY (country_code);


--
-- Name: pricing_rules_raw pricing_rules_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.pricing_rules_raw
    ADD CONSTRAINT pricing_rules_pkey PRIMARY KEY (id);


--
-- Name: pricing_waiting_rules pricing_waiting_rules_country_code_zone_id_service_slug_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.pricing_waiting_rules
    ADD CONSTRAINT pricing_waiting_rules_country_code_zone_id_service_slug_key UNIQUE (country_code, zone_id, service_slug);


--
-- Name: pricing_waiting_rules pricing_waiting_rules_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.pricing_waiting_rules
    ADD CONSTRAINT pricing_waiting_rules_pkey PRIMARY KEY (id);


--
-- Name: pricing_zones pricing_zones_country_code_zone_id_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.pricing_zones
    ADD CONSTRAINT pricing_zones_country_code_zone_id_key UNIQUE (country_code, zone_id);


--
-- Name: pricing_zones pricing_zones_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.pricing_zones
    ADD CONSTRAINT pricing_zones_pkey PRIMARY KEY (id);


--
-- Name: profiles profiles_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.profiles
    ADD CONSTRAINT profiles_pkey PRIMARY KEY (id);


--
-- Name: provider_brand_assets provider_brand_assets_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.provider_brand_assets
    ADD CONSTRAINT provider_brand_assets_pkey PRIMARY KEY (id);


--
-- Name: quote_market_adjustments quote_market_adjustments_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.quote_market_adjustments
    ADD CONSTRAINT quote_market_adjustments_pkey PRIMARY KEY (id);


--
-- Name: ratings ratings_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.ratings
    ADD CONSTRAINT ratings_pkey PRIMARY KEY (id);


--
-- Name: refund_operations refund_operations_key_unique; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.refund_operations
    ADD CONSTRAINT refund_operations_key_unique UNIQUE (job_id, operation_type, idempotency_key);


--
-- Name: refund_operations refund_operations_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.refund_operations
    ADD CONSTRAINT refund_operations_pkey PRIMARY KEY (id);


--
-- Name: regional_pricing_rules regional_pricing_rules_country_code_service_slug_pricing_pl_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.regional_pricing_rules
    ADD CONSTRAINT regional_pricing_rules_country_code_service_slug_pricing_pl_key UNIQUE (country_code, service_slug, pricing_plan);


--
-- Name: regional_pricing_rules regional_pricing_rules_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.regional_pricing_rules
    ADD CONSTRAINT regional_pricing_rules_pkey PRIMARY KEY (id);


--
-- Name: ride_details ride_details_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.ride_details
    ADD CONSTRAINT ride_details_pkey PRIMARY KEY (id);


--
-- Name: schema_migrations schema_migrations_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.schema_migrations
    ADD CONSTRAINT schema_migrations_pkey PRIMARY KEY (version);


--
-- Name: service_market_rules service_market_rules_country_code_zone_id_service_slug_vehi_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.service_market_rules
    ADD CONSTRAINT service_market_rules_country_code_zone_id_service_slug_vehi_key UNIQUE (country_code, zone_id, service_slug, vehicle_class);


--
-- Name: service_market_rules service_market_rules_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.service_market_rules
    ADD CONSTRAINT service_market_rules_pkey PRIMARY KEY (id);


--
-- Name: service_types service_types_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.service_types
    ADD CONSTRAINT service_types_pkey PRIMARY KEY (id);


--
-- Name: service_types service_types_slug_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.service_types
    ADD CONSTRAINT service_types_slug_key UNIQUE (slug);


--
-- Name: stripe_events stripe_events_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.stripe_events
    ADD CONSTRAINT stripe_events_pkey PRIMARY KEY (id);


--
-- Name: subscription_plans subscription_plans_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.subscription_plans
    ADD CONSTRAINT subscription_plans_pkey PRIMARY KEY (id);


--
-- Name: subscription_plans subscription_plans_plan_code_country_code_currency_code_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.subscription_plans
    ADD CONSTRAINT subscription_plans_plan_code_country_code_currency_code_key UNIQUE (plan_code, country_code, currency_code);


--
-- Name: subscriptions subscriptions_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.subscriptions
    ADD CONSTRAINT subscriptions_pkey PRIMARY KEY (id);


--
-- Name: subscriptions subscriptions_stripe_subscription_id_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.subscriptions
    ADD CONSTRAINT subscriptions_stripe_subscription_id_key UNIQUE (stripe_subscription_id);


--
-- Name: system_config system_config_key_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.system_config
    ADD CONSTRAINT system_config_key_key UNIQUE (key);


--
-- Name: system_config system_config_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.system_config
    ADD CONSTRAINT system_config_pkey PRIMARY KEY (id);


--
-- Name: system_configs system_configs_config_key_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.system_configs
    ADD CONSTRAINT system_configs_config_key_key UNIQUE (config_key);


--
-- Name: system_configs system_configs_key_unique; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.system_configs
    ADD CONSTRAINT system_configs_key_unique UNIQUE (key);


--
-- Name: system_configs system_configs_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.system_configs
    ADD CONSTRAINT system_configs_pkey PRIMARY KEY (id);


--
-- Name: tenant_users tenant_users_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.tenant_users
    ADD CONSTRAINT tenant_users_pkey PRIMARY KEY (id);


--
-- Name: tenant_users tenant_users_tenant_id_user_id_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.tenant_users
    ADD CONSTRAINT tenant_users_tenant_id_user_id_key UNIQUE (tenant_id, user_id);


--
-- Name: tenants tenants_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.tenants
    ADD CONSTRAINT tenants_pkey PRIMARY KEY (id);


--
-- Name: tenants tenants_slug_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.tenants
    ADD CONSTRAINT tenants_slug_key UNIQUE (slug);


--
-- Name: wallet_transactions unique_payment_intent; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.wallet_transactions
    ADD CONSTRAINT unique_payment_intent UNIQUE (payment_intent_id);


--
-- Name: van_details van_details_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.van_details
    ADD CONSTRAINT van_details_pkey PRIMARY KEY (id);


--
-- Name: vehicles vehicles_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.vehicles
    ADD CONSTRAINT vehicles_pkey PRIMARY KEY (id);


--
-- Name: vehicles vehicles_user_id_unique; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.vehicles
    ADD CONSTRAINT vehicles_user_id_unique UNIQUE (user_id);


--
-- Name: wallet_accounts wallet_accounts_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.wallet_accounts
    ADD CONSTRAINT wallet_accounts_pkey PRIMARY KEY (id);


--
-- Name: wallet_accounts wallet_accounts_scope_unique; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.wallet_accounts
    ADD CONSTRAINT wallet_accounts_scope_unique UNIQUE NULLS NOT DISTINCT (tenant_id, owner_id, currency_code, balance_purpose);


--
-- Name: wallet_business_events wallet_business_events_event_key_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.wallet_business_events
    ADD CONSTRAINT wallet_business_events_event_key_key UNIQUE (event_key);


--
-- Name: wallet_business_events wallet_business_events_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.wallet_business_events
    ADD CONSTRAINT wallet_business_events_pkey PRIMARY KEY (id);


--
-- Name: wallet_collection_config wallet_collection_config_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.wallet_collection_config
    ADD CONSTRAINT wallet_collection_config_pkey PRIMARY KEY (key);


--
-- Name: wallet_movements wallet_movements_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.wallet_movements
    ADD CONSTRAINT wallet_movements_pkey PRIMARY KEY (id);


--
-- Name: wallet_topup_attempts wallet_topup_attempts_attempt_key_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.wallet_topup_attempts
    ADD CONSTRAINT wallet_topup_attempts_attempt_key_key UNIQUE (attempt_key);


--
-- Name: wallet_topup_attempts wallet_topup_attempts_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.wallet_topup_attempts
    ADD CONSTRAINT wallet_topup_attempts_pkey PRIMARY KEY (id);


--
-- Name: wallet_topup_verifications wallet_topup_verifications_evidence_key_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.wallet_topup_verifications
    ADD CONSTRAINT wallet_topup_verifications_evidence_key_key UNIQUE (evidence_key);


--
-- Name: wallet_topup_verifications wallet_topup_verifications_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.wallet_topup_verifications
    ADD CONSTRAINT wallet_topup_verifications_pkey PRIMARY KEY (id);


--
-- Name: wallet_transactions wallet_transactions_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.wallet_transactions
    ADD CONSTRAINT wallet_transactions_pkey PRIMARY KEY (id);


--
-- Name: wallets wallets_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.wallets
    ADD CONSTRAINT wallets_pkey PRIMARY KEY (id);


--
-- Name: wallets wallets_user_id_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.wallets
    ADD CONSTRAINT wallets_user_id_key UNIQUE (user_id);


--
-- Name: admin_message_email_due; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX admin_message_email_due ON public.admin_message_email_outbox USING btree (retry_at) WHERE (status = 'pending'::text);


--
-- Name: admin_message_entries_thread; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX admin_message_entries_thread ON public.admin_message_entries USING btree (thread_id, id);


--
-- Name: admin_message_thread_user; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX admin_message_thread_user ON public.admin_message_threads USING btree (user_id, updated_at DESC);


--
-- Name: app_presence_seen_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX app_presence_seen_idx ON public.app_presence_sessions USING btree (seen_at);


--
-- Name: booking_support_email_due; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX booking_support_email_due ON public.booking_support_requests USING btree (retry_at) WHERE (email_status <> 'sent'::text);


--
-- Name: booking_support_user_created; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX booking_support_user_created ON public.booking_support_requests USING btree (user_id, created_at);


--
-- Name: driver_cash_credit_holds_scope_v1e; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX driver_cash_credit_holds_scope_v1e ON public.driver_cash_credit_holds_v1e USING btree (tenant_id, driver_id, currency_code, status);


--
-- Name: driver_subscriptions_driver_active_unique; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX driver_subscriptions_driver_active_unique ON public.driver_subscriptions USING btree (driver_id) WHERE (status = ANY (ARRAY['active'::text, 'trialing'::text, 'past_due'::text]));


--
-- Name: driver_subscriptions_driver_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX driver_subscriptions_driver_idx ON public.driver_subscriptions USING btree (driver_id);


--
-- Name: driver_subscriptions_status_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX driver_subscriptions_status_idx ON public.driver_subscriptions USING btree (status);


--
-- Name: idx_ai_pricing_audits_market; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_ai_pricing_audits_market ON public.ai_pricing_audits USING btree (country_code, service_slug, created_at DESC);


--
-- Name: idx_cities_active; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_cities_active ON public.cities USING btree (is_active) WHERE (is_active = true);


--
-- Name: idx_commission_overrides_lookup; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_commission_overrides_lookup ON public.marketplace_commission_overrides USING btree (tenant_id, service_type_slug, city_zone, is_active, starts_at, ends_at);


--
-- Name: idx_competitor_fare_benchmarks_distance_km; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_competitor_fare_benchmarks_distance_km ON public.competitor_fare_benchmarks USING btree (distance_km);


--
-- Name: idx_competitor_fare_benchmarks_duration_minutes; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_competitor_fare_benchmarks_duration_minutes ON public.competitor_fare_benchmarks USING btree (duration_minutes);


--
-- Name: idx_competitor_fare_benchmarks_expires_at; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_competitor_fare_benchmarks_expires_at ON public.competitor_fare_benchmarks USING btree (expires_at);


--
-- Name: idx_competitor_fare_benchmarks_observed_at; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_competitor_fare_benchmarks_observed_at ON public.competitor_fare_benchmarks USING btree (observed_at);


--
-- Name: idx_competitor_fare_benchmarks_profile; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_competitor_fare_benchmarks_profile ON public.competitor_fare_benchmarks USING btree (competitor_profile_id);


--
-- Name: idx_competitor_profiles_city; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_competitor_profiles_city ON public.competitor_profiles USING btree (market_city);


--
-- Name: idx_competitor_profiles_country; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_competitor_profiles_country ON public.competitor_profiles USING btree (country_code);


--
-- Name: idx_competitor_profiles_enabled; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_competitor_profiles_enabled ON public.competitor_profiles USING btree (enabled);


--
-- Name: idx_competitor_profiles_unique_specificity; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX idx_competitor_profiles_unique_specificity ON public.competitor_profiles USING btree (country_code, COALESCE(market_city, ''::character varying), competitor_slug, service_type, COALESCE(vehicle_class, ''::character varying));


--
-- Name: idx_customer_local_service_preferences_customer; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_customer_local_service_preferences_customer ON public.customer_local_service_preferences USING btree (customer_id, last_used_at DESC);


--
-- Name: idx_customer_local_service_preferences_lookup; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_customer_local_service_preferences_lookup ON public.customer_local_service_preferences USING btree (customer_id, country_code, service_slug, category_slug);


--
-- Name: idx_device_push_tokens_user_enabled; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_device_push_tokens_user_enabled ON public.device_push_tokens USING btree (user_id, enabled);


--
-- Name: idx_device_push_tokens_user_provider_subscription; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX idx_device_push_tokens_user_provider_subscription ON public.device_push_tokens USING btree (user_id, provider, subscription_id) WHERE (subscription_id IS NOT NULL);


--
-- Name: idx_dispatch_logs_job_id; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_dispatch_logs_job_id ON public.dispatch_logs USING btree (job_id);


--
-- Name: idx_driver_accounts_onboarding_status; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_driver_accounts_onboarding_status ON public.driver_accounts USING btree (onboarding_status);


--
-- Name: idx_driver_accounts_tenant_id; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_driver_accounts_tenant_id ON public.driver_accounts USING btree (tenant_id);


--
-- Name: idx_driver_accounts_user_id; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_driver_accounts_user_id ON public.driver_accounts USING btree (user_id);


--
-- Name: idx_driver_bids_driver; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_driver_bids_driver ON public.driver_bids USING btree (driver_id, status, created_at);


--
-- Name: idx_driver_bids_job; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_driver_bids_job ON public.driver_bids USING btree (job_id, status, bid_amount, created_at);


--
-- Name: idx_driver_dob_correction_requests; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_driver_dob_correction_requests ON public.driver_onboarding_requests USING btree (driver_id, request_type, status);


--
-- Name: idx_driver_earnings_driver_id; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_driver_earnings_driver_id ON public.driver_earnings USING btree (driver_id);


--
-- Name: idx_driver_earnings_status; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_driver_earnings_status ON public.driver_earnings USING btree (status);


--
-- Name: idx_driver_issuing_cards_driver; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_driver_issuing_cards_driver ON public.driver_issuing_cards USING btree (driver_id, status);


--
-- Name: idx_driver_job_declines_driver; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_driver_job_declines_driver ON public.driver_job_declines USING btree (driver_id, created_at DESC);


--
-- Name: idx_driver_job_declines_job; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_driver_job_declines_job ON public.driver_job_declines USING btree (job_id, driver_id);


--
-- Name: idx_driver_locations_city_id; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_driver_locations_city_id ON public.driver_locations USING btree (city_id);


--
-- Name: idx_driver_locations_driver_id; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_driver_locations_driver_id ON public.driver_locations USING btree (driver_id);


--
-- Name: idx_driver_locations_tenant_id; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_driver_locations_tenant_id ON public.driver_locations USING btree (tenant_id);


--
-- Name: idx_driver_onboarding_notifications_delivery; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_driver_onboarding_notifications_delivery ON public.driver_onboarding_notifications USING btree (status, created_at);


--
-- Name: idx_driver_onboarding_requests_one_open; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX idx_driver_onboarding_requests_one_open ON public.driver_onboarding_requests USING btree (driver_id, requirement_code) WHERE ((status)::text = ANY (ARRAY[('pending'::character varying)::text, ('rejected'::character varying)::text]));


--
-- Name: idx_email_logs_created_at; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_email_logs_created_at ON public.email_logs USING btree (created_at DESC);


--
-- Name: idx_email_logs_job_id; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_email_logs_job_id ON public.email_logs USING btree (job_id);


--
-- Name: idx_email_logs_user_id; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_email_logs_user_id ON public.email_logs USING btree (user_id);


--
-- Name: idx_errand_funding_customer_id; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_errand_funding_customer_id ON public.errand_funding USING btree (customer_id);


--
-- Name: idx_errand_funding_job_id; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_errand_funding_job_id ON public.errand_funding USING btree (job_id);


--
-- Name: idx_errand_funding_settled_unique; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX idx_errand_funding_settled_unique ON public.errand_funding USING btree (job_id) WHERE (status = 'settled'::text);


--
-- Name: idx_errand_funding_status; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_errand_funding_status ON public.errand_funding USING btree (status);


--
-- Name: idx_events_created_at; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_events_created_at ON public.events USING btree (created_at);


--
-- Name: idx_events_type; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_events_type ON public.events USING btree (type);


--
-- Name: idx_fare_negotiations_job; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_fare_negotiations_job ON public.fare_negotiations USING btree (job_id, created_at DESC);


--
-- Name: idx_fixed_fare_bands_city_id; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_fixed_fare_bands_city_id ON public.fixed_fare_bands_raw USING btree (city_id);


--
-- Name: idx_fixed_fare_bands_country_code; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_fixed_fare_bands_country_code ON public.fixed_fare_bands_raw USING btree (country_code);


--
-- Name: idx_fixed_fare_bands_currency_code; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_fixed_fare_bands_currency_code ON public.fixed_fare_bands_raw USING btree (currency_code);


--
-- Name: idx_fixed_fare_bands_raw_active_distance; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_fixed_fare_bands_raw_active_distance ON public.fixed_fare_bands_raw USING btree (is_active, min_distance_km, max_distance_km);


--
-- Name: idx_fixed_fare_bands_raw_lookup_city; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_fixed_fare_bands_raw_lookup_city ON public.fixed_fare_bands_raw USING btree (city_id, country_code, currency_code, service_type);


--
-- Name: idx_fixed_fare_bands_raw_lookup_core; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_fixed_fare_bands_raw_lookup_core ON public.fixed_fare_bands_raw USING btree (country_code, currency_code, service_type);


--
-- Name: idx_fixed_fare_bands_raw_service_type_id; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_fixed_fare_bands_raw_service_type_id ON public.fixed_fare_bands_raw USING btree (service_type_id);


--
-- Name: idx_fixed_fare_bands_service_type; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_fixed_fare_bands_service_type ON public.fixed_fare_bands_raw USING btree (service_type);


--
-- Name: idx_fixed_fare_bands_tenant_id; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_fixed_fare_bands_tenant_id ON public.fixed_fare_bands_raw USING btree (tenant_id);


--
-- Name: idx_job_events_event_type; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_job_events_event_type ON public.job_events USING btree (event_type);


--
-- Name: idx_job_events_job_id; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_job_events_job_id ON public.job_events USING btree (job_id);


--
-- Name: idx_job_issuing_authorizations_job; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_job_issuing_authorizations_job ON public.job_issuing_authorizations USING btree (job_id, created_at);


--
-- Name: idx_job_issuing_spend_controls_card; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_job_issuing_spend_controls_card ON public.job_issuing_spend_controls USING btree (stripe_card_id, status);


--
-- Name: idx_job_issuing_spend_controls_driver; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_job_issuing_spend_controls_driver ON public.job_issuing_spend_controls USING btree (driver_id, status);


--
-- Name: idx_job_issuing_transactions_job; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_job_issuing_transactions_job ON public.job_issuing_transactions USING btree (job_id, created_at);


--
-- Name: idx_job_locations_job_id; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_job_locations_job_id ON public.job_locations USING btree (job_id);


--
-- Name: idx_job_messages_created_at; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_job_messages_created_at ON public.job_messages USING btree (created_at);


--
-- Name: idx_job_messages_job_created; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_job_messages_job_created ON public.job_messages USING btree (job_id, created_at);


--
-- Name: idx_job_messages_job_id; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_job_messages_job_id ON public.job_messages USING btree (job_id);


--
-- Name: idx_job_messages_receiver_id; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_job_messages_receiver_id ON public.job_messages USING btree (receiver_id);


--
-- Name: idx_job_messages_sender_id; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_job_messages_sender_id ON public.job_messages USING btree (sender_id);


--
-- Name: idx_job_messages_tenant_id; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_job_messages_tenant_id ON public.job_messages USING btree (tenant_id);


--
-- Name: idx_job_queue_city_id; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_job_queue_city_id ON public.job_queue USING btree (city_id);


--
-- Name: idx_job_queue_status; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_job_queue_status ON public.job_queue USING btree (status);


--
-- Name: idx_jobs_accepted_driver; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_jobs_accepted_driver ON public.jobs USING btree (accepted_driver_id) WHERE (accepted_driver_id IS NOT NULL);


--
-- Name: idx_jobs_available_driver_requests; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_jobs_available_driver_requests ON public.jobs USING btree (status, payment_status, driver_id, created_at DESC);


--
-- Name: idx_jobs_city_id; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_jobs_city_id ON public.jobs USING btree (city_id);


--
-- Name: idx_jobs_customer; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_jobs_customer ON public.jobs USING btree (customer_id);


--
-- Name: idx_jobs_customer_created; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_jobs_customer_created ON public.jobs USING btree (customer_id, created_at DESC);


--
-- Name: idx_jobs_customer_id; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_jobs_customer_id ON public.jobs USING btree (customer_id);


--
-- Name: idx_jobs_dispatch_visible; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_jobs_dispatch_visible ON public.jobs USING btree (status, driver_search_expires_at, created_at DESC);


--
-- Name: idx_jobs_driver; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_jobs_driver ON public.jobs USING btree (driver_id);


--
-- Name: idx_jobs_driver_created; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_jobs_driver_created ON public.jobs USING btree (driver_id, created_at DESC);


--
-- Name: idx_jobs_driver_dispatch; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_jobs_driver_dispatch ON public.jobs USING btree (status, payment_status, driver_id, driver_search_expires_at, created_at DESC);


--
-- Name: idx_jobs_driver_id; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_jobs_driver_id ON public.jobs USING btree (driver_id);


--
-- Name: idx_jobs_marketplace_drafts_expiry; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_jobs_marketplace_drafts_expiry ON public.jobs USING btree (status, expires_at) WHERE (is_draft = true);


--
-- Name: idx_jobs_one_active_per_driver; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX idx_jobs_one_active_per_driver ON public.jobs USING btree (driver_id) WHERE ((driver_id IS NOT NULL) AND (status = ANY (ARRAY['assigned'::text, 'accepted'::text, 'fare_agreed'::text, 'heading_to_pickup'::text, 'driver_en_route'::text, 'arrived'::text, 'driver_arrived'::text, 'arrived_at_store'::text, 'shopping_in_progress'::text, 'collected'::text, 'picked_up'::text, 'en_route_to_customer'::text, 'in_progress'::text, 'delivered'::text, 'over_budget_requested'::text, 'requires_review'::text])));


--
-- Name: idx_jobs_searching_expires; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_jobs_searching_expires ON public.jobs USING btree (driver_search_expires_at) WHERE (status = 'searching'::text);


--
-- Name: idx_jobs_service_type; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_jobs_service_type ON public.jobs USING btree (service_type_id) WHERE (service_type_id IS NOT NULL);


--
-- Name: idx_jobs_service_type_id; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_jobs_service_type_id ON public.jobs USING btree (service_type_id);


--
-- Name: idx_jobs_settlement_status; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_jobs_settlement_status ON public.jobs USING btree (settlement_status) WHERE (settlement_status = ANY (ARRAY['claimed'::text, 'unknown'::text]));


--
-- Name: idx_jobs_status; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_jobs_status ON public.jobs USING btree (status);


--
-- Name: idx_jobs_tenant_id; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_jobs_tenant_id ON public.jobs USING btree (tenant_id);


--
-- Name: idx_jobs_unique_quote_reference; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX idx_jobs_unique_quote_reference ON public.jobs USING btree (quote_id) WHERE (quote_id IS NOT NULL);


--
-- Name: idx_local_place_search_cache_expires; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_local_place_search_cache_expires ON public.local_place_search_cache USING btree (expires_at);


--
-- Name: idx_local_place_search_cache_lookup; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_local_place_search_cache_lookup ON public.local_place_search_cache USING btree (country_code, service_slug, category_slug, latitude_bucket, longitude_bucket, radius_km);


--
-- Name: idx_local_service_categories_country; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_local_service_categories_country ON public.local_service_categories USING btree (country_code);


--
-- Name: idx_local_service_categories_enabled; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_local_service_categories_enabled ON public.local_service_categories USING btree (enabled);


--
-- Name: idx_local_service_categories_order; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_local_service_categories_order ON public.local_service_categories USING btree (display_order);


--
-- Name: idx_local_service_categories_service; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_local_service_categories_service ON public.local_service_categories USING btree (service_slug);


--
-- Name: idx_local_service_providers_category; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_local_service_providers_category ON public.local_service_providers USING btree (category_id);


--
-- Name: idx_local_service_providers_country; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_local_service_providers_country ON public.local_service_providers USING btree (country_code);


--
-- Name: idx_local_service_providers_enabled; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_local_service_providers_enabled ON public.local_service_providers USING btree (enabled);


--
-- Name: idx_local_service_providers_order; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_local_service_providers_order ON public.local_service_providers USING btree (display_order);


--
-- Name: idx_market_availability_unique_scope; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX idx_market_availability_unique_scope ON public.market_availability USING btree (upper((country_code)::text), lower((COALESCE(market_city, ''::character varying))::text), COALESCE((zone_id)::text, ''::text));


--
-- Name: idx_market_price_snapshots_calculated_at; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_market_price_snapshots_calculated_at ON public.market_price_snapshots USING btree (calculated_at);


--
-- Name: idx_market_price_snapshots_country; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_market_price_snapshots_country ON public.market_price_snapshots USING btree (country_code);


--
-- Name: idx_market_price_snapshots_service; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_market_price_snapshots_service ON public.market_price_snapshots USING btree (service_type);


--
-- Name: idx_market_pricing_strategies_city; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_market_pricing_strategies_city ON public.market_pricing_strategies USING btree (market_city);


--
-- Name: idx_market_pricing_strategies_country; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_market_pricing_strategies_country ON public.market_pricing_strategies USING btree (country_code);


--
-- Name: idx_market_pricing_strategies_enabled; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_market_pricing_strategies_enabled ON public.market_pricing_strategies USING btree (enabled);


--
-- Name: idx_market_pricing_strategies_service; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_market_pricing_strategies_service ON public.market_pricing_strategies USING btree (service_type);


--
-- Name: idx_market_pricing_strategies_unique_specificity; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX idx_market_pricing_strategies_unique_specificity ON public.market_pricing_strategies USING btree (country_code, COALESCE(market_city, ''::character varying), COALESCE((zone_id)::text, ''::text), service_type, COALESCE(vehicle_class, ''::character varying));


--
-- Name: idx_market_pricing_strategies_vehicle; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_market_pricing_strategies_vehicle ON public.market_pricing_strategies USING btree (vehicle_class);


--
-- Name: idx_market_waiting_list_unique; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX idx_market_waiting_list_unique ON public.market_waiting_list USING btree (lower(email), upper((country_code)::text), lower((COALESCE(market_city, ''::character varying))::text));


--
-- Name: idx_marketplace_commission_overrides_lookup; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_marketplace_commission_overrides_lookup ON public.marketplace_commission_overrides USING btree (tenant_id, service_type_slug, city_zone, driver_tier, is_active, starts_at, ends_at);


--
-- Name: idx_marketplace_negotiation_events_session; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_marketplace_negotiation_events_session ON public.marketplace_negotiation_events USING btree (session_id, created_at DESC);


--
-- Name: idx_marketplace_negotiation_sessions_driver; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_marketplace_negotiation_sessions_driver ON public.marketplace_negotiation_sessions USING btree (active_driver_id, status);


--
-- Name: idx_marketplace_negotiation_sessions_job; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_marketplace_negotiation_sessions_job ON public.marketplace_negotiation_sessions USING btree (job_id, status);


--
-- Name: idx_marketplace_settings_global_key; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX idx_marketplace_settings_global_key ON public.marketplace_settings USING btree (key) WHERE (tenant_id IS NULL);


--
-- Name: idx_marketplace_settings_tenant_key; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX idx_marketplace_settings_tenant_key ON public.marketplace_settings USING btree (tenant_id, key) WHERE (tenant_id IS NOT NULL);


--
-- Name: idx_notifications_created_at; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_notifications_created_at ON public.notifications USING btree (created_at DESC);


--
-- Name: idx_notifications_is_read; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_notifications_is_read ON public.notifications USING btree (is_read);


--
-- Name: idx_notifications_user_created; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_notifications_user_created ON public.notifications USING btree (user_id, created_at DESC);


--
-- Name: idx_notifications_user_id; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_notifications_user_id ON public.notifications USING btree (user_id);


--
-- Name: idx_pricing_calendar_events_lookup; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_pricing_calendar_events_lookup ON public.pricing_calendar_events USING btree (country_code, region_code, starts_at, ends_at) WHERE (is_active = true);


--
-- Name: idx_pricing_config_market_service; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX idx_pricing_config_market_service ON public.pricing_config USING btree (COALESCE(country_code, 'GB'::text), COALESCE(NULLIF(btrim(market_city), ''::text), ''::text), COALESCE(NULLIF(btrim(zone_id), ''::text), ''::text), service_type);


--
-- Name: idx_pricing_conversion_rules_lookup; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_pricing_conversion_rules_lookup ON public.pricing_conversion_rules USING btree (target_country_code, target_currency_code, service_type, is_active);


--
-- Name: idx_pricing_conversion_slug; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_pricing_conversion_slug ON public.pricing_conversion_rules USING btree (target_country_code, target_currency_code, service_type_slug, is_active);


--
-- Name: idx_pricing_rules_country_code; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_pricing_rules_country_code ON public.pricing_rules_raw USING btree (country_code);


--
-- Name: idx_pricing_rules_currency_code; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_pricing_rules_currency_code ON public.pricing_rules_raw USING btree (currency_code);


--
-- Name: idx_pricing_rules_raw_lookup_city; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_pricing_rules_raw_lookup_city ON public.pricing_rules_raw USING btree (city_id, country_code, currency_code, service_type);


--
-- Name: idx_pricing_rules_raw_lookup_core; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_pricing_rules_raw_lookup_core ON public.pricing_rules_raw USING btree (country_code, currency_code, service_type);


--
-- Name: idx_pricing_rules_raw_promo_active; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_pricing_rules_raw_promo_active ON public.pricing_rules_raw USING btree (is_active, is_promo, promo_ends_at);


--
-- Name: idx_pricing_rules_raw_service_type_id; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_pricing_rules_raw_service_type_id ON public.pricing_rules_raw USING btree (service_type_id);


--
-- Name: idx_pricing_rules_service_type; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_pricing_rules_service_type ON public.pricing_rules_raw USING btree (service_type);


--
-- Name: idx_pricing_rules_tenant_id; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_pricing_rules_tenant_id ON public.pricing_rules_raw USING btree (tenant_id);


--
-- Name: idx_pricing_zones_country_active; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_pricing_zones_country_active ON public.pricing_zones USING btree (country_code, is_active, priority);


--
-- Name: idx_profiles_is_available; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_profiles_is_available ON public.profiles USING btree (is_available);


--
-- Name: idx_profiles_is_online; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_profiles_is_online ON public.profiles USING btree (is_online);


--
-- Name: idx_profiles_location; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_profiles_location ON public.profiles USING btree (lat, lng) WHERE (lat IS NOT NULL);


--
-- Name: idx_profiles_role; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_profiles_role ON public.profiles USING btree (role);


--
-- Name: idx_profiles_tenant_id; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_profiles_tenant_id ON public.profiles USING btree (tenant_id);


--
-- Name: idx_provider_brand_assets_domain; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_provider_brand_assets_domain ON public.provider_brand_assets USING btree (official_domain);


--
-- Name: idx_provider_brand_assets_external_place; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_provider_brand_assets_external_place ON public.provider_brand_assets USING btree (external_place_id);


--
-- Name: idx_provider_brand_assets_name_country; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_provider_brand_assets_name_country ON public.provider_brand_assets USING btree (lower(provider_name), country_code);


--
-- Name: idx_provider_brand_assets_provider; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_provider_brand_assets_provider ON public.provider_brand_assets USING btree (provider_id);


--
-- Name: idx_quote_market_adjustments_benchmark_used; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_quote_market_adjustments_benchmark_used ON public.quote_market_adjustments USING btree (benchmark_used);


--
-- Name: idx_quote_market_adjustments_booking; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_quote_market_adjustments_booking ON public.quote_market_adjustments USING btree (booking_id);


--
-- Name: idx_quote_market_adjustments_created_at; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_quote_market_adjustments_created_at ON public.quote_market_adjustments USING btree (created_at);


--
-- Name: idx_quote_market_adjustments_job; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_quote_market_adjustments_job ON public.quote_market_adjustments USING btree (job_id);


--
-- Name: idx_quote_market_adjustments_strategy; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_quote_market_adjustments_strategy ON public.quote_market_adjustments USING btree (strategy_id);


--
-- Name: idx_ratings_booking_customer; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX idx_ratings_booking_customer ON public.ratings USING btree (booking_id, customer_id) WHERE ((booking_id IS NOT NULL) AND (customer_id IS NOT NULL));


--
-- Name: idx_ratings_job_customer; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX idx_ratings_job_customer ON public.ratings USING btree (job_id, customer_id) WHERE ((job_id IS NOT NULL) AND (customer_id IS NOT NULL));


--
-- Name: idx_refund_operations_job; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_refund_operations_job ON public.refund_operations USING btree (job_id, operation_type, status);


--
-- Name: idx_service_market_rules_lookup; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_service_market_rules_lookup ON public.service_market_rules USING btree (country_code, service_slug, zone_id, is_active);


--
-- Name: idx_service_types_slug; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_service_types_slug ON public.service_types USING btree (slug);


--
-- Name: idx_subscriptions_stripe_subscription_id; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_subscriptions_stripe_subscription_id ON public.subscriptions USING btree (stripe_subscription_id);


--
-- Name: idx_subscriptions_tenant_id; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_subscriptions_tenant_id ON public.subscriptions USING btree (tenant_id);


--
-- Name: idx_subscriptions_tenant_id_v2; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_subscriptions_tenant_id_v2 ON public.subscriptions USING btree (tenant_id);


--
-- Name: idx_subscriptions_user_id; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_subscriptions_user_id ON public.subscriptions USING btree (user_id);


--
-- Name: idx_subscriptions_user_id_v2; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_subscriptions_user_id_v2 ON public.subscriptions USING btree (user_id);


--
-- Name: idx_tenant_users_tenant_id; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_tenant_users_tenant_id ON public.tenant_users USING btree (tenant_id);


--
-- Name: idx_tenant_users_user_id; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_tenant_users_user_id ON public.tenant_users USING btree (user_id);


--
-- Name: idx_wallet_transactions_job_id; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_wallet_transactions_job_id ON public.wallet_transactions USING btree (job_id);


--
-- Name: idx_wallet_transactions_topup_stripe_id; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX idx_wallet_transactions_topup_stripe_id ON public.wallet_transactions USING btree (stripe_payment_intent_id) WHERE ((transaction_type = 'topup'::text) AND (stripe_payment_intent_id IS NOT NULL));


--
-- Name: idx_wallet_transactions_user; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_wallet_transactions_user ON public.wallet_transactions USING btree (user_id);


--
-- Name: idx_wallet_transactions_user_id; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_wallet_transactions_user_id ON public.wallet_transactions USING btree (user_id);


--
-- Name: idx_wallet_transactions_wallet_id; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_wallet_transactions_wallet_id ON public.wallet_transactions USING btree (wallet_id);


--
-- Name: idx_wallet_user; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_wallet_user ON public.wallet_transactions USING btree (user_id);


--
-- Name: idx_wallets_user_id; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_wallets_user_id ON public.wallets USING btree (user_id);


--
-- Name: job_payout_queue_retry_at_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX job_payout_queue_retry_at_idx ON public.job_payout_queue USING btree (retry_at) WHERE (status = ANY (ARRAY['pending'::text, 'reconcile'::text, 'processing'::text]));


--
-- Name: journey_evidence_v23_job_time; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX journey_evidence_v23_job_time ON public.journey_evidence_v23 USING btree (job_id, sampled_at DESC);


--
-- Name: journey_evidence_v23_received; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX journey_evidence_v23_received ON public.journey_evidence_v23 USING btree (received_at);


--
-- Name: market_payment_routes_identity_unique; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX market_payment_routes_identity_unique ON public.market_payment_routes USING btree (country_code, currency_code, method, provider, merchant_account_ref) WHERE (merchant_account_ref IS NOT NULL);


--
-- Name: market_payment_routes_preferred_unique; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX market_payment_routes_preferred_unique ON public.market_payment_routes USING btree (country_code, currency_code, method) WHERE preferred;


--
-- Name: schema_migrations_version_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX schema_migrations_version_idx ON public.schema_migrations USING btree (version);


--
-- Name: wallet_business_events_owner_scope; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX wallet_business_events_owner_scope ON public.wallet_business_events USING btree (tenant_id, owner_id, currency_code);


--
-- Name: wallet_business_events_reversal_unique; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX wallet_business_events_reversal_unique ON public.wallet_business_events USING btree (reverses_event_id) WHERE (reverses_event_id IS NOT NULL);


--
-- Name: wallet_movements_account_id; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX wallet_movements_account_id ON public.wallet_movements USING btree (account_id);


--
-- Name: wallet_movements_event_id; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX wallet_movements_event_id ON public.wallet_movements USING btree (event_id);


--
-- Name: wallet_one_job_settlement; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX wallet_one_job_settlement ON public.wallet_transactions USING btree (job_id, user_id) WHERE ((transaction_type = 'settlement'::text) AND (job_id IS NOT NULL));


--
-- Name: wallet_topup_attempts_credit_unique; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX wallet_topup_attempts_credit_unique ON public.wallet_topup_attempts USING btree (credited_event_id) WHERE (credited_event_id IS NOT NULL);


--
-- Name: wallet_topup_attempts_owner; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX wallet_topup_attempts_owner ON public.wallet_topup_attempts USING btree (tenant_id, owner_id, currency_code);


--
-- Name: wallet_topup_attempts_provider_reference_unique; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX wallet_topup_attempts_provider_reference_unique ON public.wallet_topup_attempts USING btree (payment_provider, merchant_account_ref, provider_reference) WHERE (provider_reference IS NOT NULL);


--
-- Name: wallet_transactions_event_key_uniq; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX wallet_transactions_event_key_uniq ON public.wallet_transactions USING btree (event_key) WHERE (event_key IS NOT NULL);


--
-- Name: profiles a_guard_customer_wallet_market_v1h; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER a_guard_customer_wallet_market_v1h BEFORE INSERT OR DELETE OR UPDATE ON public.profiles FOR EACH ROW EXECUTE FUNCTION public.guard_customer_wallet_market_v1h();


--
-- Name: jobs a_sync_agreed_fare_snapshot; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER a_sync_agreed_fare_snapshot BEFORE UPDATE OF agreed_fare ON public.jobs FOR EACH ROW EXECUTE FUNCTION public.sync_agreed_fare_snapshot();


--
-- Name: market_payment_routes audit_market_payment_route_v23; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER audit_market_payment_route_v23 AFTER INSERT OR UPDATE ON public.market_payment_routes FOR EACH ROW EXECUTE FUNCTION public.audit_market_payment_route_v23();


--
-- Name: errand_details debug_errand_insert_trigger; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER debug_errand_insert_trigger BEFORE INSERT ON public.errand_details FOR EACH ROW EXECUTE FUNCTION auth.debug_errand_insert();


--
-- Name: jobs enforce_driver_market_jobs_v23; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER enforce_driver_market_jobs_v23 BEFORE INSERT OR UPDATE OF driver_id, accepted_driver_id, country_code, tenant_id, status, metadata ON public.jobs FOR EACH ROW EXECUTE FUNCTION public.enforce_driver_job_market_v23('driver_id', 'accepted_driver_id');


--
-- Name: marketplace_negotiation_sessions enforce_driver_market_negotiation_v23; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER enforce_driver_market_negotiation_v23 BEFORE INSERT OR UPDATE OF active_driver_id, job_id ON public.marketplace_negotiation_sessions FOR EACH ROW EXECUTE FUNCTION public.enforce_driver_job_market_v23('active_driver_id');


--
-- Name: jobs enforce_ride_cash_credit_v1e; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER enforce_ride_cash_credit_v1e AFTER INSERT OR UPDATE OF driver_id, accepted_driver_id, status, payment_method, payment_intent_id, metadata, fare_breakdown, tenant_id, country_code, currency_code ON public.jobs FOR EACH ROW EXECUTE FUNCTION public.enforce_ride_cash_credit_v1e();


--
-- Name: driver_payment_accounts freeze_driver_payment_submission; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER freeze_driver_payment_submission BEFORE UPDATE ON public.driver_payment_accounts FOR EACH ROW EXECUTE FUNCTION public.freeze_driver_payment_submission();


--
-- Name: jobs guard_booking_payment_margin; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER guard_booking_payment_margin BEFORE UPDATE OF agreed_fare, fare_breakdown ON public.jobs FOR EACH ROW EXECUTE FUNCTION public.guard_booking_payment_margin();


--
-- Name: driver_cash_credit_holds_v1e guard_cash_credit_hold_v1e; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER guard_cash_credit_hold_v1e BEFORE DELETE OR UPDATE ON public.driver_cash_credit_holds_v1e FOR EACH ROW EXECUTE FUNCTION public.guard_cash_credit_hold_v1e();


--
-- Name: driver_payment_accounts guard_driver_payment_account_identity; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER guard_driver_payment_account_identity BEFORE DELETE OR UPDATE ON public.driver_payment_accounts FOR EACH ROW EXECUTE FUNCTION public.guard_driver_payment_account_identity();


--
-- Name: errand_funding guard_errand_budget_payment_margin; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER guard_errand_budget_payment_margin BEFORE INSERT OR UPDATE OF item_budget, amount_reserved ON public.errand_funding FOR EACH ROW EXECUTE FUNCTION public.guard_errand_budget_payment_margin();


--
-- Name: market_payment_routes guard_market_payment_route_v23; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER guard_market_payment_route_v23 BEFORE INSERT OR DELETE OR UPDATE ON public.market_payment_routes FOR EACH ROW EXECUTE FUNCTION public.guard_market_payment_route_v23();


--
-- Name: profiles guard_profile_truncate_v1h; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER guard_profile_truncate_v1h BEFORE TRUNCATE ON public.profiles FOR EACH STATEMENT EXECUTE FUNCTION public.guard_customer_wallet_market_v1h();


--
-- Name: refund_operations guard_refund_pending_payout; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER guard_refund_pending_payout BEFORE INSERT ON public.refund_operations FOR EACH ROW EXECUTE FUNCTION public.guard_refund_pending_payout();


--
-- Name: jobs mark_enrolled_ride_start_v23; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER mark_enrolled_ride_start_v23 AFTER UPDATE OF status ON public.jobs FOR EACH ROW WHEN ((old.status IS DISTINCT FROM new.status)) EXECUTE FUNCTION public.mark_enrolled_ride_start_v23();


--
-- Name: errand_funding on_errand_funding_update; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER on_errand_funding_update AFTER UPDATE ON public.errand_funding FOR EACH ROW EXECUTE FUNCTION public.on_errand_funding_change();


--
-- Name: job_messages on_job_message_insert; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER on_job_message_insert AFTER INSERT ON public.job_messages FOR EACH ROW EXECUTE FUNCTION public.on_new_job_message();


--
-- Name: job_messages on_job_message_insert_send_push; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER on_job_message_insert_send_push AFTER INSERT ON public.job_messages FOR EACH ROW EXECUTE FUNCTION public.send_chat_push_notification();

ALTER TABLE public.job_messages DISABLE TRIGGER on_job_message_insert_send_push;


--
-- Name: profiles protect_driver_operating_market_v23; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER protect_driver_operating_market_v23 BEFORE UPDATE ON public.profiles FOR EACH ROW EXECUTE FUNCTION public.protect_driver_operating_market_v23();


--
-- Name: notifications queue_admin_message_email; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER queue_admin_message_email AFTER INSERT ON public.notifications FOR EACH ROW EXECUTE FUNCTION public.queue_admin_message_notification();


--
-- Name: customer_wallet_sandbox_attempts_v1l sandbox_attempt_guard_v1l; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER sandbox_attempt_guard_v1l BEFORE DELETE OR UPDATE ON public.customer_wallet_sandbox_attempts_v1l FOR EACH ROW EXECUTE FUNCTION public.sandbox_attempt_guard_v1l();


--
-- Name: wallet_business_events serialize_cash_credit_ledger_v1e; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER serialize_cash_credit_ledger_v1e BEFORE INSERT ON public.wallet_business_events FOR EACH ROW EXECUTE FUNCTION public.serialize_cash_credit_ledger_v1e();


--
-- Name: system_configs sync_country_settings_payment_routes_v23; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER sync_country_settings_payment_routes_v23 AFTER INSERT OR UPDATE ON public.system_configs FOR EACH ROW EXECUTE FUNCTION public.sync_country_settings_payment_routes_v23();


--
-- Name: system_configs sync_system_configs_columns_trigger; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER sync_system_configs_columns_trigger BEFORE INSERT OR UPDATE ON public.system_configs FOR EACH ROW EXECUTE FUNCTION public.sync_system_configs_columns();


--
-- Name: jobs tr_check_errand_completion_guard; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER tr_check_errand_completion_guard BEFORE UPDATE OF status ON public.jobs FOR EACH ROW EXECUTE FUNCTION public.check_errand_completion_guard();


--
-- Name: wallets tr_check_wallet_integrity; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER tr_check_wallet_integrity BEFORE UPDATE ON public.wallets FOR EACH ROW EXECUTE FUNCTION public.check_wallet_integrity();


--
-- Name: delivery_details tr_delivery_details_set_updated_at; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER tr_delivery_details_set_updated_at BEFORE UPDATE ON public.delivery_details FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();


--
-- Name: errand_details tr_errand_details_set_updated_at; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER tr_errand_details_set_updated_at BEFORE UPDATE ON public.errand_details FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();


--
-- Name: ride_details tr_ride_details_set_updated_at; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER tr_ride_details_set_updated_at BEFORE UPDATE ON public.ride_details FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();


--
-- Name: driver_accounts tr_update_driver_accounts_updated_at; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER tr_update_driver_accounts_updated_at BEFORE UPDATE ON public.driver_accounts FOR EACH ROW EXECUTE FUNCTION public.update_jobs_updated_at();


--
-- Name: driver_locations tr_update_driver_locations_updated_at; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER tr_update_driver_locations_updated_at BEFORE UPDATE ON public.driver_locations FOR EACH ROW EXECUTE FUNCTION public.update_driver_locations_updated_at();


--
-- Name: errand_funding tr_update_errand_funding_updated_at; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER tr_update_errand_funding_updated_at BEFORE UPDATE ON public.errand_funding FOR EACH ROW EXECUTE FUNCTION public.update_errand_funding_updated_at();


--
-- Name: jobs tr_update_jobs_updated_at; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER tr_update_jobs_updated_at BEFORE UPDATE ON public.jobs FOR EACH ROW EXECUTE FUNCTION public.update_jobs_updated_at();


--
-- Name: wallets tr_update_wallets_updated_at; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER tr_update_wallets_updated_at BEFORE UPDATE ON public.wallets FOR EACH ROW EXECUTE FUNCTION public.update_wallets_updated_at();


--
-- Name: van_details tr_van_details_set_updated_at; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER tr_van_details_set_updated_at BEFORE UPDATE ON public.van_details FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();


--
-- Name: marketplace_commission_overrides trg_commission_overrides_updated_at; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER trg_commission_overrides_updated_at BEFORE UPDATE ON public.marketplace_commission_overrides FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();


--
-- Name: customer_local_service_preferences trg_customer_local_service_preferences_updated_at; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER trg_customer_local_service_preferences_updated_at BEFORE UPDATE ON public.customer_local_service_preferences FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();


--
-- Name: driver_bids trg_driver_bids_updated_at; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER trg_driver_bids_updated_at BEFORE UPDATE ON public.driver_bids FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();


--
-- Name: errand_details trg_enforce_errand_spending_budget; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER trg_enforce_errand_spending_budget BEFORE UPDATE OF actual_spending ON public.errand_details FOR EACH ROW EXECUTE FUNCTION public.enforce_errand_spending_budget();


--
-- Name: jobs trg_enforce_job_acquisition_eligibility; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER trg_enforce_job_acquisition_eligibility BEFORE UPDATE OF driver_id ON public.jobs FOR EACH ROW EXECUTE FUNCTION public.enforce_job_acquisition_eligibility();

ALTER TABLE public.jobs DISABLE TRIGGER trg_enforce_job_acquisition_eligibility;


--
-- Name: jobs trg_enforce_job_payment_eligibility; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER trg_enforce_job_payment_eligibility BEFORE UPDATE OF driver_id, status ON public.jobs FOR EACH ROW EXECUTE FUNCTION public.enforce_job_payment_eligibility();


--
-- Name: fare_negotiations trg_fare_negotiations_updated_at; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER trg_fare_negotiations_updated_at BEFORE UPDATE ON public.fare_negotiations FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();


--
-- Name: jobs trg_freeze_subscription_driver_commission; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER trg_freeze_subscription_driver_commission BEFORE INSERT OR UPDATE OF driver_id ON public.jobs FOR EACH ROW EXECUTE FUNCTION public.freeze_subscription_driver_commission();


--
-- Name: jobs trg_gb_mot_job; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER trg_gb_mot_job BEFORE INSERT OR UPDATE OF driver_id ON public.jobs FOR EACH ROW EXECUTE FUNCTION public.enforce_gb_mot_acquisition('driver_id');


--
-- Name: marketplace_negotiation_sessions trg_gb_mot_negotiation; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER trg_gb_mot_negotiation BEFORE INSERT OR UPDATE OF active_driver_id ON public.marketplace_negotiation_sessions FOR EACH ROW EXECUTE FUNCTION public.enforce_gb_mot_acquisition('active_driver_id');


--
-- Name: profiles trg_gb_mot_online; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER trg_gb_mot_online BEFORE UPDATE OF is_online, is_available ON public.profiles FOR EACH ROW EXECUTE FUNCTION public.enforce_gb_mot_online();


--
-- Name: jobs trg_guard_direct_arrival; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER trg_guard_direct_arrival BEFORE UPDATE ON public.jobs FOR EACH ROW EXECUTE FUNCTION public.trg_guard_direct_arrival();


--
-- Name: local_place_search_cache trg_local_place_search_cache_updated_at; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER trg_local_place_search_cache_updated_at BEFORE UPDATE ON public.local_place_search_cache FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();


--
-- Name: local_service_categories trg_local_service_categories_updated_at; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER trg_local_service_categories_updated_at BEFORE UPDATE ON public.local_service_categories FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();


--
-- Name: local_service_providers trg_local_service_providers_updated_at; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER trg_local_service_providers_updated_at BEFORE UPDATE ON public.local_service_providers FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();


--
-- Name: marketplace_negotiation_events trg_marketplace_negotiation_events_updated_at; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER trg_marketplace_negotiation_events_updated_at BEFORE UPDATE ON public.marketplace_negotiation_events FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();


--
-- Name: marketplace_negotiation_sessions trg_marketplace_negotiation_sessions_updated_at; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER trg_marketplace_negotiation_sessions_updated_at BEFORE UPDATE ON public.marketplace_negotiation_sessions FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();


--
-- Name: marketplace_settings trg_marketplace_settings_updated_at; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER trg_marketplace_settings_updated_at BEFORE UPDATE ON public.marketplace_settings FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();


--
-- Name: profiles trg_notify_admins_account_closure_requested; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER trg_notify_admins_account_closure_requested AFTER UPDATE OF account_status ON public.profiles FOR EACH ROW EXECUTE FUNCTION public.notify_admins_account_closure_requested();


--
-- Name: pricing_config trg_pricing_config_updated_at; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER trg_pricing_config_updated_at BEFORE UPDATE ON public.pricing_config FOR EACH ROW EXECUTE FUNCTION public.set_pricing_config_updated_at();


--
-- Name: pricing_conversion_rules trg_pricing_conversion_rules_updated_at; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER trg_pricing_conversion_rules_updated_at BEFORE UPDATE ON public.pricing_conversion_rules FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();


--
-- Name: profiles trg_profiles_ownership_guard_delete; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER trg_profiles_ownership_guard_delete BEFORE DELETE ON public.profiles FOR EACH ROW EXECUTE FUNCTION public.enforce_profiles_ownership_guard();


--
-- Name: profiles trg_profiles_ownership_guard_insert; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER trg_profiles_ownership_guard_insert BEFORE INSERT ON public.profiles FOR EACH ROW EXECUTE FUNCTION public.enforce_profiles_ownership_guard();


--
-- Name: profiles trg_profiles_ownership_guard_update; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER trg_profiles_ownership_guard_update BEFORE UPDATE ON public.profiles FOR EACH ROW EXECUTE FUNCTION public.enforce_profiles_ownership_guard();


--
-- Name: provider_brand_assets trg_provider_brand_assets_updated_at; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER trg_provider_brand_assets_updated_at BEFORE UPDATE ON public.provider_brand_assets FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();


--
-- Name: profiles trg_registration_authority_guard; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER trg_registration_authority_guard BEFORE UPDATE OF registration_activated_at, registration_country_code, registration_market_city ON public.profiles FOR EACH ROW EXECUTE FUNCTION public.enforce_registration_authority_guard();


--
-- Name: jobs trg_sync_job_prices; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER trg_sync_job_prices BEFORE INSERT OR UPDATE OF price, total_price, estimated_price, currency_code, currency_symbol, country_code ON public.jobs FOR EACH ROW EXECUTE FUNCTION public.sync_job_prices();


--
-- Name: profiles trg_verified_driver_identity_guard; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER trg_verified_driver_identity_guard BEFORE UPDATE OF full_name, date_of_birth, country_code ON public.profiles FOR EACH ROW EXECUTE FUNCTION public.enforce_verified_driver_identity_guard();


--
-- Name: subscription_plans update_subscription_plans_updated_at; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER update_subscription_plans_updated_at BEFORE UPDATE ON public.subscription_plans FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();


--
-- Name: subscriptions update_subscriptions_updated_at; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER update_subscriptions_updated_at BEFORE UPDATE ON public.subscriptions FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();


--
-- Name: wallet_accounts wallet_accounts_append_only; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER wallet_accounts_append_only BEFORE DELETE OR UPDATE ON public.wallet_accounts FOR EACH ROW EXECUTE FUNCTION public.wallet_ledger_append_only();


--
-- Name: wallet_business_events wallet_business_events_append_only; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER wallet_business_events_append_only BEFORE DELETE OR UPDATE ON public.wallet_business_events FOR EACH ROW EXECUTE FUNCTION public.wallet_ledger_append_only();


--
-- Name: wallet_movements wallet_movements_append_only; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER wallet_movements_append_only BEFORE DELETE OR UPDATE ON public.wallet_movements FOR EACH ROW EXECUTE FUNCTION public.wallet_ledger_append_only();


--
-- Name: wallet_topup_attempts wallet_topup_attempt_freeze; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER wallet_topup_attempt_freeze BEFORE UPDATE ON public.wallet_topup_attempts FOR EACH ROW EXECUTE FUNCTION public.wallet_topup_attempt_freeze();


--
-- Name: jobs zz_finalize_agreed_fare_aliases; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER zz_finalize_agreed_fare_aliases BEFORE UPDATE OF agreed_fare, fare_breakdown, driver_id ON public.jobs FOR EACH ROW EXECUTE FUNCTION public.finalize_agreed_fare_aliases();


--
-- Name: admin_message_email_outbox admin_message_email_outbox_entry_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.admin_message_email_outbox
    ADD CONSTRAINT admin_message_email_outbox_entry_id_fkey FOREIGN KEY (entry_id) REFERENCES public.admin_message_entries(id) ON DELETE CASCADE;


--
-- Name: admin_message_email_outbox admin_message_email_outbox_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.admin_message_email_outbox
    ADD CONSTRAINT admin_message_email_outbox_user_id_fkey FOREIGN KEY (user_id) REFERENCES public.profiles(id) ON DELETE CASCADE;


--
-- Name: admin_message_entries admin_message_entries_notification_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.admin_message_entries
    ADD CONSTRAINT admin_message_entries_notification_id_fkey FOREIGN KEY (notification_id) REFERENCES public.notifications(id) ON DELETE SET NULL;


--
-- Name: admin_message_entries admin_message_entries_sender_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.admin_message_entries
    ADD CONSTRAINT admin_message_entries_sender_id_fkey FOREIGN KEY (sender_id) REFERENCES public.profiles(id) ON DELETE SET NULL;


--
-- Name: admin_message_entries admin_message_entries_thread_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.admin_message_entries
    ADD CONSTRAINT admin_message_entries_thread_id_fkey FOREIGN KEY (thread_id) REFERENCES public.admin_message_threads(id) ON DELETE CASCADE;


--
-- Name: admin_message_threads admin_message_threads_assigned_admin_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.admin_message_threads
    ADD CONSTRAINT admin_message_threads_assigned_admin_id_fkey FOREIGN KEY (assigned_admin_id) REFERENCES public.profiles(id) ON DELETE SET NULL;


--
-- Name: admin_message_threads admin_message_threads_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.admin_message_threads
    ADD CONSTRAINT admin_message_threads_user_id_fkey FOREIGN KEY (user_id) REFERENCES public.profiles(id) ON DELETE CASCADE;


--
-- Name: ai_pricing_audits ai_pricing_audits_job_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.ai_pricing_audits
    ADD CONSTRAINT ai_pricing_audits_job_id_fkey FOREIGN KEY (job_id) REFERENCES public.jobs(id) ON DELETE SET NULL;


--
-- Name: app_presence_sessions app_presence_sessions_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.app_presence_sessions
    ADD CONSTRAINT app_presence_sessions_user_id_fkey FOREIGN KEY (user_id) REFERENCES public.profiles(id) ON DELETE CASCADE;


--
-- Name: booking_status_history booking_status_history_changed_by_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.booking_status_history
    ADD CONSTRAINT booking_status_history_changed_by_fkey FOREIGN KEY (changed_by) REFERENCES public.profiles(id);


--
-- Name: booking_status_history booking_status_history_job_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.booking_status_history
    ADD CONSTRAINT booking_status_history_job_id_fkey FOREIGN KEY (job_id) REFERENCES public.jobs(id) ON DELETE CASCADE;


--
-- Name: booking_support_requests booking_support_requests_job_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.booking_support_requests
    ADD CONSTRAINT booking_support_requests_job_id_fkey FOREIGN KEY (job_id) REFERENCES public.jobs(id) ON DELETE CASCADE;


--
-- Name: booking_support_requests booking_support_requests_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.booking_support_requests
    ADD CONSTRAINT booking_support_requests_user_id_fkey FOREIGN KEY (user_id) REFERENCES public.profiles(id) ON DELETE CASCADE;


--
-- Name: competitor_fare_benchmarks competitor_fare_benchmarks_competitor_profile_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.competitor_fare_benchmarks
    ADD CONSTRAINT competitor_fare_benchmarks_competitor_profile_id_fkey FOREIGN KEY (competitor_profile_id) REFERENCES public.competitor_profiles(id) ON DELETE CASCADE;


--
-- Name: customer_local_service_preferences customer_local_service_preferences_customer_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.customer_local_service_preferences
    ADD CONSTRAINT customer_local_service_preferences_customer_id_fkey FOREIGN KEY (customer_id) REFERENCES public.profiles(id) ON DELETE CASCADE;


--
-- Name: customer_local_service_preferences customer_local_service_preferences_provider_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.customer_local_service_preferences
    ADD CONSTRAINT customer_local_service_preferences_provider_id_fkey FOREIGN KEY (provider_id) REFERENCES public.local_service_providers(id) ON DELETE SET NULL;


--
-- Name: delivery_details delivery_details_job_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.delivery_details
    ADD CONSTRAINT delivery_details_job_id_fkey FOREIGN KEY (job_id) REFERENCES public.jobs(id) ON DELETE CASCADE;


--
-- Name: device_push_tokens device_push_tokens_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.device_push_tokens
    ADD CONSTRAINT device_push_tokens_user_id_fkey FOREIGN KEY (user_id) REFERENCES public.profiles(id) ON DELETE CASCADE;


--
-- Name: dispatch_logs dispatch_logs_driver_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.dispatch_logs
    ADD CONSTRAINT dispatch_logs_driver_id_fkey FOREIGN KEY (driver_id) REFERENCES auth.users(id);


--
-- Name: dispatch_logs dispatch_logs_job_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.dispatch_logs
    ADD CONSTRAINT dispatch_logs_job_id_fkey FOREIGN KEY (job_id) REFERENCES public.jobs(id);


--
-- Name: driver_accounts driver_accounts_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.driver_accounts
    ADD CONSTRAINT driver_accounts_user_id_fkey FOREIGN KEY (user_id) REFERENCES auth.users(id) ON DELETE CASCADE;


--
-- Name: driver_bids driver_bids_counter_to_bid_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.driver_bids
    ADD CONSTRAINT driver_bids_counter_to_bid_id_fkey FOREIGN KEY (counter_to_bid_id) REFERENCES public.driver_bids(id) ON DELETE SET NULL;


--
-- Name: driver_bids driver_bids_driver_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.driver_bids
    ADD CONSTRAINT driver_bids_driver_id_fkey FOREIGN KEY (driver_id) REFERENCES public.profiles(id) ON DELETE CASCADE;


--
-- Name: driver_bids driver_bids_job_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.driver_bids
    ADD CONSTRAINT driver_bids_job_id_fkey FOREIGN KEY (job_id) REFERENCES public.jobs(id) ON DELETE CASCADE;


--
-- Name: driver_cash_credit_enrolments_v1e driver_cash_credit_enrolments_v1e_driver_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.driver_cash_credit_enrolments_v1e
    ADD CONSTRAINT driver_cash_credit_enrolments_v1e_driver_id_fkey FOREIGN KEY (driver_id) REFERENCES public.profiles(id);


--
-- Name: driver_cash_credit_holds_v1e driver_cash_credit_holds_v1e_driver_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.driver_cash_credit_holds_v1e
    ADD CONSTRAINT driver_cash_credit_holds_v1e_driver_id_fkey FOREIGN KEY (driver_id) REFERENCES public.profiles(id);


--
-- Name: driver_cash_credit_holds_v1e driver_cash_credit_holds_v1e_job_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.driver_cash_credit_holds_v1e
    ADD CONSTRAINT driver_cash_credit_holds_v1e_job_id_fkey FOREIGN KEY (job_id) REFERENCES public.jobs(id);


--
-- Name: driver_cash_credit_holds_v1e driver_cash_credit_holds_v1e_reserve_event_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.driver_cash_credit_holds_v1e
    ADD CONSTRAINT driver_cash_credit_holds_v1e_reserve_event_id_fkey FOREIGN KEY (reserve_event_id) REFERENCES public.wallet_business_events(id);


--
-- Name: driver_cash_credit_holds_v1e driver_cash_credit_holds_v1e_resolution_event_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.driver_cash_credit_holds_v1e
    ADD CONSTRAINT driver_cash_credit_holds_v1e_resolution_event_id_fkey FOREIGN KEY (resolution_event_id) REFERENCES public.wallet_business_events(id);


--
-- Name: driver_earnings driver_earnings_driver_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.driver_earnings
    ADD CONSTRAINT driver_earnings_driver_id_fkey FOREIGN KEY (driver_id) REFERENCES auth.users(id);


--
-- Name: driver_earnings driver_earnings_job_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.driver_earnings
    ADD CONSTRAINT driver_earnings_job_id_fkey FOREIGN KEY (job_id) REFERENCES public.jobs(id);


--
-- Name: driver_issuing_cardholders driver_issuing_cardholders_driver_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.driver_issuing_cardholders
    ADD CONSTRAINT driver_issuing_cardholders_driver_id_fkey FOREIGN KEY (driver_id) REFERENCES public.profiles(id) ON DELETE CASCADE;


--
-- Name: driver_issuing_cards driver_issuing_cards_driver_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.driver_issuing_cards
    ADD CONSTRAINT driver_issuing_cards_driver_id_fkey FOREIGN KEY (driver_id) REFERENCES public.profiles(id) ON DELETE CASCADE;


--
-- Name: driver_job_declines driver_job_declines_driver_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.driver_job_declines
    ADD CONSTRAINT driver_job_declines_driver_id_fkey FOREIGN KEY (driver_id) REFERENCES public.profiles(id) ON DELETE CASCADE;


--
-- Name: driver_job_declines driver_job_declines_job_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.driver_job_declines
    ADD CONSTRAINT driver_job_declines_job_id_fkey FOREIGN KEY (job_id) REFERENCES public.jobs(id) ON DELETE CASCADE;


--
-- Name: driver_locations driver_locations_city_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.driver_locations
    ADD CONSTRAINT driver_locations_city_id_fkey FOREIGN KEY (city_id) REFERENCES public.cities(id);


--
-- Name: driver_locations driver_locations_driver_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.driver_locations
    ADD CONSTRAINT driver_locations_driver_id_fkey FOREIGN KEY (driver_id) REFERENCES auth.users(id) ON DELETE CASCADE;


--
-- Name: driver_onboarding_notifications driver_onboarding_notifications_driver_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.driver_onboarding_notifications
    ADD CONSTRAINT driver_onboarding_notifications_driver_id_fkey FOREIGN KEY (driver_id) REFERENCES auth.users(id) ON DELETE CASCADE;


--
-- Name: driver_onboarding_requests driver_onboarding_requests_driver_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.driver_onboarding_requests
    ADD CONSTRAINT driver_onboarding_requests_driver_id_fkey FOREIGN KEY (driver_id) REFERENCES auth.users(id) ON DELETE CASCADE;


--
-- Name: driver_payment_accounts driver_payment_accounts_driver_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.driver_payment_accounts
    ADD CONSTRAINT driver_payment_accounts_driver_id_fkey FOREIGN KEY (driver_id) REFERENCES public.profiles(id);


--
-- Name: driver_requirement_audit driver_requirement_audit_driver_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.driver_requirement_audit
    ADD CONSTRAINT driver_requirement_audit_driver_id_fkey FOREIGN KEY (driver_id) REFERENCES auth.users(id) ON DELETE CASCADE;


--
-- Name: driver_subscriptions driver_subscriptions_driver_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.driver_subscriptions
    ADD CONSTRAINT driver_subscriptions_driver_id_fkey FOREIGN KEY (driver_id) REFERENCES public.profiles(id) ON DELETE CASCADE;


--
-- Name: driver_subscriptions driver_subscriptions_plan_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.driver_subscriptions
    ADD CONSTRAINT driver_subscriptions_plan_id_fkey FOREIGN KEY (plan_id) REFERENCES public.subscription_plans(id) ON DELETE SET NULL;


--
-- Name: driver_vehicle_mot_checks driver_vehicle_mot_checks_vehicle_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.driver_vehicle_mot_checks
    ADD CONSTRAINT driver_vehicle_mot_checks_vehicle_id_fkey FOREIGN KEY (vehicle_id) REFERENCES public.vehicles(id) ON DELETE CASCADE;


--
-- Name: email_logs email_logs_job_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.email_logs
    ADD CONSTRAINT email_logs_job_id_fkey FOREIGN KEY (job_id) REFERENCES public.jobs(id) ON DELETE SET NULL;


--
-- Name: email_logs email_logs_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.email_logs
    ADD CONSTRAINT email_logs_user_id_fkey FOREIGN KEY (user_id) REFERENCES public.profiles(id) ON DELETE SET NULL;


--
-- Name: errand_details errand_details_job_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.errand_details
    ADD CONSTRAINT errand_details_job_id_fkey FOREIGN KEY (job_id) REFERENCES public.jobs(id) ON DELETE CASCADE;


--
-- Name: errand_funding errand_funding_customer_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.errand_funding
    ADD CONSTRAINT errand_funding_customer_id_fkey FOREIGN KEY (customer_id) REFERENCES auth.users(id) ON DELETE CASCADE;


--
-- Name: errand_funding errand_funding_job_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.errand_funding
    ADD CONSTRAINT errand_funding_job_id_fkey FOREIGN KEY (job_id) REFERENCES public.jobs(id) ON DELETE CASCADE;


--
-- Name: fare_negotiations fare_negotiations_counter_to_negotiation_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.fare_negotiations
    ADD CONSTRAINT fare_negotiations_counter_to_negotiation_id_fkey FOREIGN KEY (counter_to_negotiation_id) REFERENCES public.fare_negotiations(id) ON DELETE SET NULL;


--
-- Name: fare_negotiations fare_negotiations_job_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.fare_negotiations
    ADD CONSTRAINT fare_negotiations_job_id_fkey FOREIGN KEY (job_id) REFERENCES public.jobs(id) ON DELETE CASCADE;


--
-- Name: fare_negotiations fare_negotiations_proposed_by_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.fare_negotiations
    ADD CONSTRAINT fare_negotiations_proposed_by_fkey FOREIGN KEY (proposed_by) REFERENCES public.profiles(id) ON DELETE CASCADE;


--
-- Name: job_budget_authorizations job_budget_authorizations_job_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.job_budget_authorizations
    ADD CONSTRAINT job_budget_authorizations_job_id_fkey FOREIGN KEY (job_id) REFERENCES public.jobs(id);


--
-- Name: job_completion_secrets job_completion_secrets_job_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.job_completion_secrets
    ADD CONSTRAINT job_completion_secrets_job_id_fkey FOREIGN KEY (job_id) REFERENCES public.jobs(id) ON DELETE CASCADE;


--
-- Name: job_events job_events_actor_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.job_events
    ADD CONSTRAINT job_events_actor_id_fkey FOREIGN KEY (actor_id) REFERENCES public.profiles(id);


--
-- Name: job_events job_events_job_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.job_events
    ADD CONSTRAINT job_events_job_id_fkey FOREIGN KEY (job_id) REFERENCES public.jobs(id) ON DELETE CASCADE;


--
-- Name: job_issuing_authorizations job_issuing_authorizations_driver_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.job_issuing_authorizations
    ADD CONSTRAINT job_issuing_authorizations_driver_id_fkey FOREIGN KEY (driver_id) REFERENCES public.profiles(id) ON DELETE SET NULL;


--
-- Name: job_issuing_authorizations job_issuing_authorizations_job_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.job_issuing_authorizations
    ADD CONSTRAINT job_issuing_authorizations_job_id_fkey FOREIGN KEY (job_id) REFERENCES public.jobs(id) ON DELETE SET NULL;


--
-- Name: job_issuing_reserves job_issuing_reserves_job_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.job_issuing_reserves
    ADD CONSTRAINT job_issuing_reserves_job_id_fkey FOREIGN KEY (job_id) REFERENCES public.jobs(id);


--
-- Name: job_issuing_spend_controls job_issuing_spend_controls_customer_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.job_issuing_spend_controls
    ADD CONSTRAINT job_issuing_spend_controls_customer_id_fkey FOREIGN KEY (customer_id) REFERENCES public.profiles(id) ON DELETE CASCADE;


--
-- Name: job_issuing_spend_controls job_issuing_spend_controls_driver_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.job_issuing_spend_controls
    ADD CONSTRAINT job_issuing_spend_controls_driver_id_fkey FOREIGN KEY (driver_id) REFERENCES public.profiles(id) ON DELETE CASCADE;


--
-- Name: job_issuing_spend_controls job_issuing_spend_controls_job_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.job_issuing_spend_controls
    ADD CONSTRAINT job_issuing_spend_controls_job_id_fkey FOREIGN KEY (job_id) REFERENCES public.jobs(id) ON DELETE CASCADE;


--
-- Name: job_issuing_transactions job_issuing_transactions_driver_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.job_issuing_transactions
    ADD CONSTRAINT job_issuing_transactions_driver_id_fkey FOREIGN KEY (driver_id) REFERENCES public.profiles(id) ON DELETE SET NULL;


--
-- Name: job_issuing_transactions job_issuing_transactions_job_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.job_issuing_transactions
    ADD CONSTRAINT job_issuing_transactions_job_id_fkey FOREIGN KEY (job_id) REFERENCES public.jobs(id) ON DELETE SET NULL;


--
-- Name: job_locations job_locations_driver_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.job_locations
    ADD CONSTRAINT job_locations_driver_id_fkey FOREIGN KEY (driver_id) REFERENCES auth.users(id);


--
-- Name: job_locations job_locations_job_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.job_locations
    ADD CONSTRAINT job_locations_job_id_fkey FOREIGN KEY (job_id) REFERENCES public.jobs(id) ON DELETE CASCADE;


--
-- Name: job_messages job_messages_job_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.job_messages
    ADD CONSTRAINT job_messages_job_id_fkey FOREIGN KEY (job_id) REFERENCES public.jobs(id) ON DELETE CASCADE;


--
-- Name: job_messages job_messages_receiver_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.job_messages
    ADD CONSTRAINT job_messages_receiver_id_fkey FOREIGN KEY (receiver_id) REFERENCES auth.users(id);


--
-- Name: job_messages job_messages_sender_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.job_messages
    ADD CONSTRAINT job_messages_sender_id_fkey FOREIGN KEY (sender_id) REFERENCES auth.users(id);


--
-- Name: job_payment_bindings job_payment_bindings_job_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.job_payment_bindings
    ADD CONSTRAINT job_payment_bindings_job_id_fkey FOREIGN KEY (job_id) REFERENCES public.jobs(id) ON DELETE RESTRICT;


--
-- Name: job_payout_queue job_payout_queue_job_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.job_payout_queue
    ADD CONSTRAINT job_payout_queue_job_id_fkey FOREIGN KEY (job_id) REFERENCES public.jobs(id);


--
-- Name: job_queue job_queue_city_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.job_queue
    ADD CONSTRAINT job_queue_city_id_fkey FOREIGN KEY (city_id) REFERENCES public.cities(id);


--
-- Name: job_queue job_queue_job_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.job_queue
    ADD CONSTRAINT job_queue_job_id_fkey FOREIGN KEY (job_id) REFERENCES public.jobs(id) ON DELETE CASCADE;


--
-- Name: job_service_details job_service_details_job_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.job_service_details
    ADD CONSTRAINT job_service_details_job_id_fkey FOREIGN KEY (job_id) REFERENCES public.jobs(id) ON DELETE CASCADE;


--
-- Name: jobs jobs_city_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.jobs
    ADD CONSTRAINT jobs_city_id_fkey FOREIGN KEY (city_id) REFERENCES public.cities(id);


--
-- Name: jobs jobs_customer_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.jobs
    ADD CONSTRAINT jobs_customer_id_fkey FOREIGN KEY (customer_id) REFERENCES auth.users(id);


--
-- Name: jobs jobs_driver_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.jobs
    ADD CONSTRAINT jobs_driver_id_fkey FOREIGN KEY (driver_id) REFERENCES auth.users(id);


--
-- Name: jobs jobs_service_type_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.jobs
    ADD CONSTRAINT jobs_service_type_id_fkey FOREIGN KEY (service_type_id) REFERENCES public.service_types(id) ON DELETE SET NULL;


--
-- Name: journey_evidence_v23 journey_evidence_v23_job_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.journey_evidence_v23
    ADD CONSTRAINT journey_evidence_v23_job_id_fkey FOREIGN KEY (job_id) REFERENCES public.jobs(id) ON DELETE CASCADE;


--
-- Name: journey_fare_enrolments_v23 journey_fare_enrolments_v23_job_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.journey_fare_enrolments_v23
    ADD CONSTRAINT journey_fare_enrolments_v23_job_id_fkey FOREIGN KEY (job_id) REFERENCES public.jobs(id) ON DELETE CASCADE;


--
-- Name: journey_fare_events_v23 journey_fare_events_v23_proposal_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.journey_fare_events_v23
    ADD CONSTRAINT journey_fare_events_v23_proposal_id_fkey FOREIGN KEY (proposal_id) REFERENCES public.journey_fare_proposals_v23(id);


--
-- Name: journey_fare_proposals_v23 journey_fare_proposals_v23_stop_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.journey_fare_proposals_v23
    ADD CONSTRAINT journey_fare_proposals_v23_stop_id_fkey FOREIGN KEY (stop_id) REFERENCES public.journey_stop_requests_v23(id);


--
-- Name: journey_start_markers_v23 journey_start_markers_v23_job_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.journey_start_markers_v23
    ADD CONSTRAINT journey_start_markers_v23_job_id_fkey FOREIGN KEY (job_id) REFERENCES public.jobs(id) ON DELETE CASCADE;


--
-- Name: journey_stop_events_v23 journey_stop_events_v23_request_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.journey_stop_events_v23
    ADD CONSTRAINT journey_stop_events_v23_request_id_fkey FOREIGN KEY (request_id) REFERENCES public.journey_stop_requests_v23(id) ON DELETE CASCADE;


--
-- Name: journey_stop_requests_v23 journey_stop_requests_v23_job_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.journey_stop_requests_v23
    ADD CONSTRAINT journey_stop_requests_v23_job_id_fkey FOREIGN KEY (job_id) REFERENCES public.jobs(id) ON DELETE CASCADE;


--
-- Name: kora_sandbox_booking_enrolments kora_sandbox_booking_enrolments_job_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.kora_sandbox_booking_enrolments
    ADD CONSTRAINT kora_sandbox_booking_enrolments_job_id_fkey FOREIGN KEY (job_id) REFERENCES public.jobs(id) ON DELETE RESTRICT;


--
-- Name: kora_sandbox_booking_enrolments kora_sandbox_booking_enrolments_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.kora_sandbox_booking_enrolments
    ADD CONSTRAINT kora_sandbox_booking_enrolments_user_id_fkey FOREIGN KEY (user_id) REFERENCES auth.users(id) ON DELETE RESTRICT;


--
-- Name: kora_sandbox_booking_payments kora_sandbox_booking_payments_job_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.kora_sandbox_booking_payments
    ADD CONSTRAINT kora_sandbox_booking_payments_job_id_fkey FOREIGN KEY (job_id) REFERENCES public.jobs(id) ON DELETE RESTRICT;


--
-- Name: kora_sandbox_booking_payments kora_sandbox_booking_payments_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.kora_sandbox_booking_payments
    ADD CONSTRAINT kora_sandbox_booking_payments_user_id_fkey FOREIGN KEY (user_id) REFERENCES auth.users(id) ON DELETE RESTRICT;


--
-- Name: kora_sandbox_sessions kora_sandbox_sessions_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.kora_sandbox_sessions
    ADD CONSTRAINT kora_sandbox_sessions_user_id_fkey FOREIGN KEY (user_id) REFERENCES auth.users(id) ON DELETE RESTRICT;


--
-- Name: local_service_providers local_service_providers_category_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.local_service_providers
    ADD CONSTRAINT local_service_providers_category_id_fkey FOREIGN KEY (category_id) REFERENCES public.local_service_categories(id) ON DELETE CASCADE;


--
-- Name: market_payment_route_audit market_payment_route_audit_route_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.market_payment_route_audit
    ADD CONSTRAINT market_payment_route_audit_route_id_fkey FOREIGN KEY (route_id) REFERENCES public.market_payment_routes(id);


--
-- Name: marketplace_negotiation_events marketplace_negotiation_events_job_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.marketplace_negotiation_events
    ADD CONSTRAINT marketplace_negotiation_events_job_id_fkey FOREIGN KEY (job_id) REFERENCES public.jobs(id) ON DELETE CASCADE;


--
-- Name: marketplace_negotiation_events marketplace_negotiation_events_proposed_by_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.marketplace_negotiation_events
    ADD CONSTRAINT marketplace_negotiation_events_proposed_by_fkey FOREIGN KEY (proposed_by) REFERENCES public.profiles(id) ON DELETE CASCADE;


--
-- Name: marketplace_negotiation_events marketplace_negotiation_events_session_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.marketplace_negotiation_events
    ADD CONSTRAINT marketplace_negotiation_events_session_id_fkey FOREIGN KEY (session_id) REFERENCES public.marketplace_negotiation_sessions(id) ON DELETE CASCADE;


--
-- Name: marketplace_negotiation_sessions marketplace_negotiation_sessions_active_driver_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.marketplace_negotiation_sessions
    ADD CONSTRAINT marketplace_negotiation_sessions_active_driver_id_fkey FOREIGN KEY (active_driver_id) REFERENCES public.profiles(id) ON DELETE SET NULL;


--
-- Name: marketplace_negotiation_sessions marketplace_negotiation_sessions_customer_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.marketplace_negotiation_sessions
    ADD CONSTRAINT marketplace_negotiation_sessions_customer_id_fkey FOREIGN KEY (customer_id) REFERENCES public.profiles(id) ON DELETE CASCADE;


--
-- Name: marketplace_negotiation_sessions marketplace_negotiation_sessions_job_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.marketplace_negotiation_sessions
    ADD CONSTRAINT marketplace_negotiation_sessions_job_id_fkey FOREIGN KEY (job_id) REFERENCES public.jobs(id) ON DELETE CASCADE;


--
-- Name: notifications notifications_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.notifications
    ADD CONSTRAINT notifications_user_id_fkey FOREIGN KEY (user_id) REFERENCES public.profiles(id) ON DELETE CASCADE;


--
-- Name: payment_card_consents payment_card_consents_job_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.payment_card_consents
    ADD CONSTRAINT payment_card_consents_job_id_fkey FOREIGN KEY (job_id) REFERENCES public.jobs(id) ON DELETE CASCADE;


--
-- Name: payment_card_consents payment_card_consents_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.payment_card_consents
    ADD CONSTRAINT payment_card_consents_user_id_fkey FOREIGN KEY (user_id) REFERENCES auth.users(id) ON DELETE CASCADE;


--
-- Name: payment_customers payment_customers_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.payment_customers
    ADD CONSTRAINT payment_customers_user_id_fkey FOREIGN KEY (user_id) REFERENCES auth.users(id) ON DELETE CASCADE;


--
-- Name: pricing_waiting_rules pricing_waiting_rules_country_code_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.pricing_waiting_rules
    ADD CONSTRAINT pricing_waiting_rules_country_code_fkey FOREIGN KEY (country_code) REFERENCES public.pricing_markets(country_code) ON DELETE CASCADE;


--
-- Name: pricing_zones pricing_zones_country_code_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.pricing_zones
    ADD CONSTRAINT pricing_zones_country_code_fkey FOREIGN KEY (country_code) REFERENCES public.pricing_markets(country_code) ON DELETE CASCADE;


--
-- Name: profiles profiles_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.profiles
    ADD CONSTRAINT profiles_id_fkey FOREIGN KEY (id) REFERENCES auth.users(id) ON DELETE CASCADE;


--
-- Name: provider_brand_assets provider_brand_assets_provider_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.provider_brand_assets
    ADD CONSTRAINT provider_brand_assets_provider_id_fkey FOREIGN KEY (provider_id) REFERENCES public.local_service_providers(id) ON DELETE SET NULL;


--
-- Name: quote_market_adjustments quote_market_adjustments_market_snapshot_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.quote_market_adjustments
    ADD CONSTRAINT quote_market_adjustments_market_snapshot_id_fkey FOREIGN KEY (market_snapshot_id) REFERENCES public.market_price_snapshots(id) ON DELETE SET NULL;


--
-- Name: quote_market_adjustments quote_market_adjustments_strategy_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.quote_market_adjustments
    ADD CONSTRAINT quote_market_adjustments_strategy_id_fkey FOREIGN KEY (strategy_id) REFERENCES public.market_pricing_strategies(id) ON DELETE SET NULL;


--
-- Name: ratings ratings_booking_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.ratings
    ADD CONSTRAINT ratings_booking_id_fkey FOREIGN KEY (booking_id) REFERENCES public.jobs(id) ON DELETE CASCADE;


--
-- Name: ratings ratings_customer_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.ratings
    ADD CONSTRAINT ratings_customer_id_fkey FOREIGN KEY (customer_id) REFERENCES public.profiles(id);


--
-- Name: ratings ratings_job_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.ratings
    ADD CONSTRAINT ratings_job_id_fkey FOREIGN KEY (job_id) REFERENCES public.jobs(id) ON DELETE CASCADE;


--
-- Name: refund_operations refund_operations_job_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.refund_operations
    ADD CONSTRAINT refund_operations_job_id_fkey FOREIGN KEY (job_id) REFERENCES public.jobs(id);


--
-- Name: ride_details ride_details_job_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.ride_details
    ADD CONSTRAINT ride_details_job_id_fkey FOREIGN KEY (job_id) REFERENCES public.jobs(id) ON DELETE CASCADE;


--
-- Name: service_market_rules service_market_rules_country_code_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.service_market_rules
    ADD CONSTRAINT service_market_rules_country_code_fkey FOREIGN KEY (country_code) REFERENCES public.pricing_markets(country_code) ON DELETE CASCADE;


--
-- Name: subscriptions subscriptions_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.subscriptions
    ADD CONSTRAINT subscriptions_user_id_fkey FOREIGN KEY (user_id) REFERENCES auth.users(id);


--
-- Name: tenant_users tenant_users_tenant_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.tenant_users
    ADD CONSTRAINT tenant_users_tenant_id_fkey FOREIGN KEY (tenant_id) REFERENCES public.tenants(id) ON DELETE CASCADE;


--
-- Name: tenant_users tenant_users_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.tenant_users
    ADD CONSTRAINT tenant_users_user_id_fkey FOREIGN KEY (user_id) REFERENCES auth.users(id) ON DELETE CASCADE;


--
-- Name: van_details van_details_job_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.van_details
    ADD CONSTRAINT van_details_job_id_fkey FOREIGN KEY (job_id) REFERENCES public.jobs(id) ON DELETE CASCADE;


--
-- Name: wallet_business_events wallet_business_events_reverses_event_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.wallet_business_events
    ADD CONSTRAINT wallet_business_events_reverses_event_id_fkey FOREIGN KEY (reverses_event_id) REFERENCES public.wallet_business_events(id);


--
-- Name: wallet_movements wallet_movements_account_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.wallet_movements
    ADD CONSTRAINT wallet_movements_account_id_fkey FOREIGN KEY (account_id) REFERENCES public.wallet_accounts(id);


--
-- Name: wallet_movements wallet_movements_event_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.wallet_movements
    ADD CONSTRAINT wallet_movements_event_id_fkey FOREIGN KEY (event_id) REFERENCES public.wallet_business_events(id) ON DELETE RESTRICT;


--
-- Name: wallet_topup_attempts wallet_topup_attempts_credited_event_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.wallet_topup_attempts
    ADD CONSTRAINT wallet_topup_attempts_credited_event_id_fkey FOREIGN KEY (credited_event_id) REFERENCES public.wallet_business_events(id);


--
-- Name: wallet_topup_verifications wallet_topup_verifications_attempt_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.wallet_topup_verifications
    ADD CONSTRAINT wallet_topup_verifications_attempt_id_fkey FOREIGN KEY (attempt_id) REFERENCES public.wallet_topup_attempts(id);


--
-- Name: wallet_transactions wallet_transactions_job_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.wallet_transactions
    ADD CONSTRAINT wallet_transactions_job_id_fkey FOREIGN KEY (job_id) REFERENCES public.jobs(id) ON DELETE SET NULL;


--
-- Name: wallet_transactions wallet_transactions_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.wallet_transactions
    ADD CONSTRAINT wallet_transactions_user_id_fkey FOREIGN KEY (user_id) REFERENCES auth.users(id) ON DELETE CASCADE;


--
-- Name: wallet_transactions wallet_transactions_wallet_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.wallet_transactions
    ADD CONSTRAINT wallet_transactions_wallet_id_fkey FOREIGN KEY (wallet_id) REFERENCES public.wallets(id) ON DELETE CASCADE;


--
-- Name: wallets wallets_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.wallets
    ADD CONSTRAINT wallets_user_id_fkey FOREIGN KEY (user_id) REFERENCES auth.users(id) ON DELETE CASCADE;


--
-- Name: subscriptions Admins can manage tenant subscriptions; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "Admins can manage tenant subscriptions" ON public.subscriptions USING ((public.is_tenant_admin() AND (tenant_id = public.get_my_tenant_id()))) WITH CHECK ((public.is_tenant_admin() AND (tenant_id = public.get_my_tenant_id())));


--
-- Name: job_messages Admins can read messages for jobs in their tenant; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "Admins can read messages for jobs in their tenant" ON public.job_messages FOR SELECT USING ((EXISTS ( SELECT 1
   FROM public.tenant_users
  WHERE ((tenant_users.user_id = auth.uid()) AND (tenant_users.role = 'admin'::text) AND (tenant_users.tenant_id = job_messages.tenant_id)))));


--
-- Name: driver_locations Admins can see all tenant locations; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "Admins can see all tenant locations" ON public.driver_locations FOR SELECT TO authenticated USING ((EXISTS ( SELECT 1
   FROM public.tenant_users
  WHERE ((tenant_users.user_id = auth.uid()) AND (tenant_users.role = 'admin'::text) AND (tenant_users.tenant_id = driver_locations.tenant_id)))));


--
-- Name: job_events Admins can view all events; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "Admins can view all events" ON public.job_events FOR SELECT USING ((EXISTS ( SELECT 1
   FROM public.profiles
  WHERE ((profiles.id = auth.uid()) AND (profiles.role = 'admin'::text)))));


--
-- Name: tenant_users Admins can view all tenant mappings; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "Admins can view all tenant mappings" ON public.tenant_users FOR SELECT USING ((public.is_tenant_admin() AND (tenant_id = public.get_my_tenant_id())));


--
-- Name: dispatch_logs Admins can view dispatch logs; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "Admins can view dispatch logs" ON public.dispatch_logs FOR SELECT USING ((EXISTS ( SELECT 1
   FROM public.tenant_users
  WHERE ((tenant_users.user_id = auth.uid()) AND (tenant_users.role = 'admin'::text)))));


--
-- Name: job_queue Admins can view job queue; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "Admins can view job queue" ON public.job_queue FOR SELECT USING ((EXISTS ( SELECT 1
   FROM public.tenant_users
  WHERE ((tenant_users.user_id = auth.uid()) AND (tenant_users.role = 'admin'::text) AND (tenant_users.tenant_id = job_queue.tenant_id)))));


--
-- Name: events Admins can view tenant events; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "Admins can view tenant events" ON public.events FOR SELECT USING ((EXISTS ( SELECT 1
   FROM public.tenant_users
  WHERE ((tenant_users.user_id = auth.uid()) AND (tenant_users.role = 'admin'::text) AND (tenant_users.tenant_id = events.tenant_id)))));


--
-- Name: subscriptions Admins can view tenant subscriptions; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "Admins can view tenant subscriptions" ON public.subscriptions FOR SELECT USING ((public.is_tenant_admin() AND (tenant_id = public.get_my_tenant_id())));


--
-- Name: local_service_categories Admins manage local service categories; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "Admins manage local service categories" ON public.local_service_categories TO authenticated USING ((EXISTS ( SELECT 1
   FROM public.profiles p
  WHERE ((p.id = auth.uid()) AND (p.role = 'admin'::text))))) WITH CHECK ((EXISTS ( SELECT 1
   FROM public.profiles p
  WHERE ((p.id = auth.uid()) AND (p.role = 'admin'::text)))));


--
-- Name: local_service_providers Admins manage local service providers; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "Admins manage local service providers" ON public.local_service_providers TO authenticated USING ((EXISTS ( SELECT 1
   FROM public.profiles p
  WHERE ((p.id = auth.uid()) AND (p.role = 'admin'::text))))) WITH CHECK ((EXISTS ( SELECT 1
   FROM public.profiles p
  WHERE ((p.id = auth.uid()) AND (p.role = 'admin'::text)))));


--
-- Name: provider_brand_assets Admins manage provider brand assets; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "Admins manage provider brand assets" ON public.provider_brand_assets TO authenticated USING ((EXISTS ( SELECT 1
   FROM public.profiles p
  WHERE ((p.id = auth.uid()) AND (p.role = 'admin'::text))))) WITH CHECK ((EXISTS ( SELECT 1
   FROM public.profiles p
  WHERE ((p.id = auth.uid()) AND (p.role = 'admin'::text)))));


--
-- Name: local_place_search_cache Admins read local search cache; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "Admins read local search cache" ON public.local_place_search_cache FOR SELECT TO authenticated USING ((EXISTS ( SELECT 1
   FROM public.profiles p
  WHERE ((p.id = auth.uid()) AND (p.role = 'admin'::text)))));


--
-- Name: pricing_calendar_events Allow active pricing events read; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "Allow active pricing events read" ON public.pricing_calendar_events FOR SELECT USING ((is_active = true));


--
-- Name: pricing_markets Allow active pricing markets read; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "Allow active pricing markets read" ON public.pricing_markets FOR SELECT USING ((market_enabled = true));


--
-- Name: pricing_config Allow active pricing read; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "Allow active pricing read" ON public.pricing_config FOR SELECT TO authenticated USING ((is_active = true));


--
-- Name: pricing_zones Allow active pricing zones read; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "Allow active pricing zones read" ON public.pricing_zones FOR SELECT USING ((is_active = true));


--
-- Name: service_market_rules Allow active service market rules read; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "Allow active service market rules read" ON public.service_market_rules FOR SELECT USING ((is_active = true));


--
-- Name: pricing_waiting_rules Allow active waiting rules read; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "Allow active waiting rules read" ON public.pricing_waiting_rules FOR SELECT USING ((is_active = true));


--
-- Name: ai_pricing_audits Allow admin pricing audit read; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "Allow admin pricing audit read" ON public.ai_pricing_audits FOR SELECT USING ((EXISTS ( SELECT 1
   FROM public.profiles
  WHERE ((profiles.id = auth.uid()) AND (profiles.role = 'admin'::text)))));


--
-- Name: pricing_calendar_events Allow admin pricing events management; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "Allow admin pricing events management" ON public.pricing_calendar_events USING ((EXISTS ( SELECT 1
   FROM public.profiles
  WHERE ((profiles.id = auth.uid()) AND (profiles.role = 'admin'::text))))) WITH CHECK ((EXISTS ( SELECT 1
   FROM public.profiles
  WHERE ((profiles.id = auth.uid()) AND (profiles.role = 'admin'::text)))));


--
-- Name: pricing_config Allow admin pricing management; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "Allow admin pricing management" ON public.pricing_config TO authenticated USING ((EXISTS ( SELECT 1
   FROM public.profiles
  WHERE ((profiles.id = auth.uid()) AND (profiles.role = 'admin'::text))))) WITH CHECK ((EXISTS ( SELECT 1
   FROM public.profiles
  WHERE ((profiles.id = auth.uid()) AND (profiles.role = 'admin'::text)))));


--
-- Name: pricing_markets Allow admin pricing markets management; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "Allow admin pricing markets management" ON public.pricing_markets USING ((EXISTS ( SELECT 1
   FROM public.profiles
  WHERE ((profiles.id = auth.uid()) AND (profiles.role = 'admin'::text))))) WITH CHECK ((EXISTS ( SELECT 1
   FROM public.profiles
  WHERE ((profiles.id = auth.uid()) AND (profiles.role = 'admin'::text)))));


--
-- Name: pricing_zones Allow admin pricing zones management; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "Allow admin pricing zones management" ON public.pricing_zones USING ((EXISTS ( SELECT 1
   FROM public.profiles
  WHERE ((profiles.id = auth.uid()) AND (profiles.role = 'admin'::text))))) WITH CHECK ((EXISTS ( SELECT 1
   FROM public.profiles
  WHERE ((profiles.id = auth.uid()) AND (profiles.role = 'admin'::text)))));


--
-- Name: service_market_rules Allow admin service market rules management; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "Allow admin service market rules management" ON public.service_market_rules USING ((EXISTS ( SELECT 1
   FROM public.profiles
  WHERE ((profiles.id = auth.uid()) AND (profiles.role = 'admin'::text))))) WITH CHECK ((EXISTS ( SELECT 1
   FROM public.profiles
  WHERE ((profiles.id = auth.uid()) AND (profiles.role = 'admin'::text)))));


--
-- Name: pricing_waiting_rules Allow admin waiting rules management; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "Allow admin waiting rules management" ON public.pricing_waiting_rules USING ((EXISTS ( SELECT 1
   FROM public.profiles
  WHERE ((profiles.id = auth.uid()) AND (profiles.role = 'admin'::text))))) WITH CHECK ((EXISTS ( SELECT 1
   FROM public.profiles
  WHERE ((profiles.id = auth.uid()) AND (profiles.role = 'admin'::text)))));


--
-- Name: subscription_plans Allow authenticated users to view active plans; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "Allow authenticated users to view active plans" ON public.subscription_plans FOR SELECT TO authenticated USING ((is_active = true));


--
-- Name: pricing_config Allow public read access; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "Allow public read access" ON public.pricing_config FOR SELECT USING ((is_active = true));


--
-- Name: app_features App features are publicly readable; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "App features are publicly readable" ON public.app_features FOR SELECT USING (true);


--
-- Name: errand_details Assigned drivers can update errand spend details; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "Assigned drivers can update errand spend details" ON public.errand_details FOR UPDATE TO authenticated USING ((EXISTS ( SELECT 1
   FROM public.jobs j
  WHERE ((j.id = errand_details.job_id) AND ((j.driver_id = auth.uid()) OR (j.accepted_driver_id = auth.uid())) AND (j.status <> ALL (ARRAY['completed'::text, 'cancelled'::text])))))) WITH CHECK ((EXISTS ( SELECT 1
   FROM public.jobs j
  WHERE ((j.id = errand_details.job_id) AND ((j.driver_id = auth.uid()) OR (j.accepted_driver_id = auth.uid())) AND (j.status <> ALL (ARRAY['completed'::text, 'cancelled'::text]))))));


--
-- Name: jobs Authorized users can update jobs; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "Authorized users can update jobs" ON public.jobs FOR UPDATE USING (((auth.uid() = customer_id) OR (auth.uid() = driver_id) OR ((driver_id IS NULL) AND (status = ANY (ARRAY['pending'::text, 'requested'::text, 'searching'::text])) AND (payment_status = ANY (ARRAY['pending'::text, 'authorized'::text, 'wallet_funded'::text, 'paid'::text]))) OR (EXISTS ( SELECT 1
   FROM public.tenant_users
  WHERE ((tenant_users.user_id = auth.uid()) AND (tenant_users.role = 'admin'::text) AND (tenant_users.tenant_id = jobs.tenant_id)))))) WITH CHECK (((auth.uid() = customer_id) OR (auth.uid() = driver_id) OR ((driver_id = auth.uid()) AND (status = ANY (ARRAY['assigned'::text, 'accepted'::text, 'heading_to_pickup'::text, 'arrived'::text, 'in_progress'::text]))) OR (EXISTS ( SELECT 1
   FROM public.tenant_users
  WHERE ((tenant_users.user_id = auth.uid()) AND (tenant_users.role = 'admin'::text) AND (tenant_users.tenant_id = jobs.tenant_id))))));


--
-- Name: cities Cities are publicly readable; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "Cities are publicly readable" ON public.cities FOR SELECT USING (true);


--
-- Name: jobs Customers can create jobs; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "Customers can create jobs" ON public.jobs FOR INSERT WITH CHECK ((auth.uid() = customer_id));


--
-- Name: driver_locations Customers can view assigned driver location; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "Customers can view assigned driver location" ON public.driver_locations FOR SELECT TO authenticated USING (public.customer_has_active_job_with_driver(auth.uid(), driver_id));


--
-- Name: job_completion_secrets Customers can view own completion pin; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "Customers can view own completion pin" ON public.job_completion_secrets FOR SELECT USING ((EXISTS ( SELECT 1
   FROM public.jobs j
  WHERE ((j.id = job_completion_secrets.job_id) AND (j.customer_id = auth.uid())))));


--
-- Name: errand_funding Customers can view own errand funding; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "Customers can view own errand funding" ON public.errand_funding FOR SELECT USING ((auth.uid() = customer_id));


--
-- Name: customer_local_service_preferences Customers manage own local service preferences; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "Customers manage own local service preferences" ON public.customer_local_service_preferences TO authenticated USING ((customer_id = auth.uid())) WITH CHECK ((customer_id = auth.uid()));


--
-- Name: job_locations Drivers can insert job locations; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "Drivers can insert job locations" ON public.job_locations FOR INSERT WITH CHECK (((auth.uid() = driver_id) AND (EXISTS ( SELECT 1
   FROM public.jobs
  WHERE ((jobs.id = job_locations.job_id) AND (jobs.driver_id = auth.uid()))))));


--
-- Name: driver_locations Drivers can manage their own location; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "Drivers can manage their own location" ON public.driver_locations TO authenticated USING ((auth.uid() = driver_id)) WITH CHECK ((auth.uid() = driver_id));


--
-- Name: driver_issuing_cardholders Drivers can read their issuing cardholder; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "Drivers can read their issuing cardholder" ON public.driver_issuing_cardholders FOR SELECT USING ((driver_id = auth.uid()));


--
-- Name: driver_issuing_cards Drivers can read their issuing cards; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "Drivers can read their issuing cards" ON public.driver_issuing_cards FOR SELECT USING ((driver_id = auth.uid()));


--
-- Name: driver_accounts Drivers can view their own connect account; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "Drivers can view their own connect account" ON public.driver_accounts FOR SELECT USING ((auth.uid() = user_id));


--
-- Name: driver_earnings Drivers can view their own earnings; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "Drivers can view their own earnings" ON public.driver_earnings FOR SELECT USING ((auth.uid() = driver_id));


--
-- Name: local_service_categories Enabled local service categories are readable; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "Enabled local service categories are readable" ON public.local_service_categories FOR SELECT TO authenticated USING ((enabled = true));


--
-- Name: local_service_providers Enabled local service providers are readable; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "Enabled local service providers are readable" ON public.local_service_providers FOR SELECT TO authenticated USING ((enabled = true));


--
-- Name: errand_details Job participants can read errand details; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "Job participants can read errand details" ON public.errand_details FOR SELECT TO authenticated USING ((EXISTS ( SELECT 1
   FROM public.jobs j
  WHERE ((j.id = errand_details.job_id) AND ((j.customer_id = auth.uid()) OR (j.driver_id = auth.uid()) OR (j.accepted_driver_id = auth.uid()))))));


--
-- Name: errand_funding Job participants can read errand funding; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "Job participants can read errand funding" ON public.errand_funding FOR SELECT TO authenticated USING ((EXISTS ( SELECT 1
   FROM public.jobs j
  WHERE ((j.id = errand_funding.job_id) AND ((j.customer_id = auth.uid()) OR (j.driver_id = auth.uid()) OR (j.accepted_driver_id = auth.uid()))))));


--
-- Name: job_issuing_authorizations Job participants can read issuing authorizations; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "Job participants can read issuing authorizations" ON public.job_issuing_authorizations FOR SELECT USING (((EXISTS ( SELECT 1
   FROM public.jobs
  WHERE ((jobs.id = job_issuing_authorizations.job_id) AND ((jobs.customer_id = auth.uid()) OR (jobs.driver_id = auth.uid()))))) OR (EXISTS ( SELECT 1
   FROM public.profiles
  WHERE ((profiles.id = auth.uid()) AND (profiles.role = 'admin'::text))))));


--
-- Name: job_issuing_spend_controls Job participants can read issuing spend controls; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "Job participants can read issuing spend controls" ON public.job_issuing_spend_controls FOR SELECT USING (((customer_id = auth.uid()) OR (driver_id = auth.uid()) OR (EXISTS ( SELECT 1
   FROM public.profiles
  WHERE ((profiles.id = auth.uid()) AND (profiles.role = 'admin'::text))))));


--
-- Name: job_issuing_transactions Job participants can read issuing transactions; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "Job participants can read issuing transactions" ON public.job_issuing_transactions FOR SELECT USING (((EXISTS ( SELECT 1
   FROM public.jobs
  WHERE ((jobs.id = job_issuing_transactions.job_id) AND ((jobs.customer_id = auth.uid()) OR (jobs.driver_id = auth.uid()))))) OR (EXISTS ( SELECT 1
   FROM public.profiles
  WHERE ((profiles.id = auth.uid()) AND (profiles.role = 'admin'::text))))));


--
-- Name: notifications System can insert notifications; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "System can insert notifications" ON public.notifications FOR INSERT WITH CHECK (true);


--
-- Name: job_events System/Authenticated users can insert events; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "System/Authenticated users can insert events" ON public.job_events FOR INSERT WITH CHECK ((auth.uid() IS NOT NULL));


--
-- Name: wallets Users can create own wallet; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "Users can create own wallet" ON public.wallets FOR INSERT WITH CHECK ((auth.uid() = user_id));


--
-- Name: booking_status_history Users can insert booking status history; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "Users can insert booking status history" ON public.booking_status_history FOR INSERT TO authenticated WITH CHECK ((EXISTS ( SELECT 1
   FROM public.jobs j
  WHERE ((j.id = booking_status_history.job_id) AND ((j.customer_id = auth.uid()) OR (j.driver_id = auth.uid()) OR (EXISTS ( SELECT 1
           FROM public.tenant_users tu
          WHERE ((tu.user_id = auth.uid()) AND (tu.tenant_id = j.tenant_id) AND (tu.role = 'admin'::text)))))))));


--
-- Name: booking_status_history Users can insert own booking status history; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "Users can insert own booking status history" ON public.booking_status_history FOR INSERT TO authenticated WITH CHECK (public.user_owns_job(job_id));


--
-- Name: delivery_details Users can insert own delivery details; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "Users can insert own delivery details" ON public.delivery_details FOR INSERT TO authenticated WITH CHECK (public.user_owns_job(job_id));


--
-- Name: errand_details Users can insert own errand details; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "Users can insert own errand details" ON public.errand_details FOR INSERT TO authenticated WITH CHECK (public.user_owns_job(job_id));


--
-- Name: ride_details Users can insert own ride details; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "Users can insert own ride details" ON public.ride_details FOR INSERT TO authenticated WITH CHECK (public.user_owns_job(job_id));


--
-- Name: van_details Users can insert own van details; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "Users can insert own van details" ON public.van_details FOR INSERT TO authenticated WITH CHECK (public.user_owns_job(job_id));


--
-- Name: booking_status_history Users can update own booking status history; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "Users can update own booking status history" ON public.booking_status_history FOR UPDATE TO authenticated USING (public.user_owns_job(job_id)) WITH CHECK (public.user_owns_job(job_id));


--
-- Name: delivery_details Users can update own delivery details; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "Users can update own delivery details" ON public.delivery_details FOR UPDATE TO authenticated USING (public.user_owns_job(job_id)) WITH CHECK (public.user_owns_job(job_id));


--
-- Name: errand_details Users can update own errand details; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "Users can update own errand details" ON public.errand_details FOR UPDATE TO authenticated USING (public.user_owns_job(job_id)) WITH CHECK (public.user_owns_job(job_id));


--
-- Name: ride_details Users can update own ride details; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "Users can update own ride details" ON public.ride_details FOR UPDATE TO authenticated USING (public.user_owns_job(job_id)) WITH CHECK (public.user_owns_job(job_id));


--
-- Name: van_details Users can update own van details; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "Users can update own van details" ON public.van_details FOR UPDATE TO authenticated USING (public.user_owns_job(job_id)) WITH CHECK (public.user_owns_job(job_id));


--
-- Name: notifications Users can update their own notifications; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "Users can update their own notifications" ON public.notifications FOR UPDATE USING ((auth.uid() = user_id)) WITH CHECK ((auth.uid() = user_id));


--
-- Name: booking_status_history Users can view booking status history; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "Users can view booking status history" ON public.booking_status_history FOR SELECT TO authenticated USING ((EXISTS ( SELECT 1
   FROM public.jobs j
  WHERE ((j.id = booking_status_history.job_id) AND ((j.customer_id = auth.uid()) OR (j.driver_id = auth.uid()) OR (EXISTS ( SELECT 1
           FROM public.tenant_users tu
          WHERE ((tu.user_id = auth.uid()) AND (tu.tenant_id = j.tenant_id) AND (tu.role = 'admin'::text)))))))));


--
-- Name: delivery_details Users can view delivery details; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "Users can view delivery details" ON public.delivery_details FOR SELECT USING (public.can_view_job_details(job_id));


--
-- Name: errand_details Users can view errand details; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "Users can view errand details" ON public.errand_details FOR SELECT USING (public.can_view_job_details(job_id));


--
-- Name: job_events Users can view events for their own jobs; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "Users can view events for their own jobs" ON public.job_events FOR SELECT USING ((EXISTS ( SELECT 1
   FROM public.jobs
  WHERE ((jobs.id = job_events.job_id) AND ((jobs.customer_id = auth.uid()) OR (jobs.driver_id = auth.uid()))))));


--
-- Name: job_locations Users can view job locations; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "Users can view job locations" ON public.job_locations FOR SELECT USING ((EXISTS ( SELECT 1
   FROM public.jobs
  WHERE ((jobs.id = job_locations.job_id) AND ((jobs.customer_id = auth.uid()) OR (jobs.driver_id = auth.uid()) OR (EXISTS ( SELECT 1
           FROM public.tenant_users
          WHERE ((tenant_users.user_id = auth.uid()) AND (tenant_users.role = 'admin'::text) AND (tenant_users.tenant_id = jobs.tenant_id)))))))));


--
-- Name: booking_status_history Users can view own booking status history; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "Users can view own booking status history" ON public.booking_status_history FOR SELECT TO authenticated USING (public.user_owns_job(job_id));


--
-- Name: delivery_details Users can view own delivery details; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "Users can view own delivery details" ON public.delivery_details FOR SELECT TO authenticated USING (public.user_owns_job(job_id));


--
-- Name: errand_details Users can view own errand details; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "Users can view own errand details" ON public.errand_details FOR SELECT TO authenticated USING (public.user_owns_job(job_id));


--
-- Name: ride_details Users can view own ride details; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "Users can view own ride details" ON public.ride_details FOR SELECT TO authenticated USING (public.user_owns_job(job_id));


--
-- Name: subscriptions Users can view own subscriptions; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "Users can view own subscriptions" ON public.subscriptions FOR SELECT USING ((auth.uid() = user_id));


--
-- Name: tenant_users Users can view own tenant mapping; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "Users can view own tenant mapping" ON public.tenant_users FOR SELECT USING ((auth.uid() = user_id));


--
-- Name: wallet_transactions Users can view own transactions; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "Users can view own transactions" ON public.wallet_transactions FOR SELECT USING ((EXISTS ( SELECT 1
   FROM public.wallets
  WHERE ((wallets.id = wallet_transactions.wallet_id) AND (wallets.user_id = auth.uid())))));


--
-- Name: van_details Users can view own van details; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "Users can view own van details" ON public.van_details FOR SELECT TO authenticated USING (public.user_owns_job(job_id));


--
-- Name: wallets Users can view own wallet; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "Users can view own wallet" ON public.wallets FOR SELECT USING ((auth.uid() = user_id));


--
-- Name: wallet_transactions Users can view own wallet transactions; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "Users can view own wallet transactions" ON public.wallet_transactions FOR SELECT USING ((auth.uid() = user_id));


--
-- Name: jobs Users can view relevant jobs; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "Users can view relevant jobs" ON public.jobs FOR SELECT USING (((auth.uid() = customer_id) OR (auth.uid() = driver_id) OR ((driver_id IS NULL) AND (status = ANY (ARRAY['pending'::text, 'requested'::text, 'searching'::text])) AND (payment_status = ANY (ARRAY['pending'::text, 'authorized'::text, 'wallet_funded'::text, 'paid'::text])) AND ((driver_search_expires_at IS NULL) OR (driver_search_expires_at > now()))) OR (EXISTS ( SELECT 1
   FROM public.tenant_users
  WHERE ((tenant_users.user_id = auth.uid()) AND (tenant_users.role = 'admin'::text) AND (tenant_users.tenant_id = jobs.tenant_id))))));


--
-- Name: ratings Users can view relevant ratings; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "Users can view relevant ratings" ON public.ratings FOR SELECT USING (public.can_view_job_details(job_id));


--
-- Name: booking_status_history Users can view relevant status history; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "Users can view relevant status history" ON public.booking_status_history FOR SELECT USING (public.can_view_job_details(job_id));


--
-- Name: ride_details Users can view ride details; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "Users can view ride details" ON public.ride_details FOR SELECT USING (public.can_view_job_details(job_id));


--
-- Name: notifications Users can view their own notifications; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "Users can view their own notifications" ON public.notifications FOR SELECT USING ((auth.uid() = user_id));


--
-- Name: tenants Users can view their own tenant; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "Users can view their own tenant" ON public.tenants FOR SELECT USING ((id = public.get_my_tenant_id()));


--
-- Name: van_details Users can view van details; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "Users can view van details" ON public.van_details FOR SELECT USING (public.can_view_job_details(job_id));


--
-- Name: wallets Users cannot update own balance; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "Users cannot update own balance" ON public.wallets FOR UPDATE USING ((auth.uid() = user_id)) WITH CHECK (((( SELECT wallets_1.available_balance
   FROM public.wallets wallets_1
  WHERE (wallets_1.user_id = auth.uid())) = available_balance) AND (( SELECT wallets_1.reserved_balance
   FROM public.wallets wallets_1
  WHERE (wallets_1.user_id = auth.uid())) = reserved_balance)));


--
-- Name: notifications Users create own notifications; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "Users create own notifications" ON public.notifications FOR INSERT TO authenticated WITH CHECK ((auth.uid() = user_id));


--
-- Name: device_push_tokens Users manage their push tokens; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "Users manage their push tokens" ON public.device_push_tokens TO authenticated USING ((auth.uid() = user_id)) WITH CHECK ((auth.uid() = user_id));


--
-- Name: notifications Users read own notifications; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "Users read own notifications" ON public.notifications FOR SELECT TO authenticated USING ((auth.uid() = user_id));


--
-- Name: notifications Users update own notification read state; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "Users update own notification read state" ON public.notifications FOR UPDATE TO authenticated USING ((auth.uid() = user_id)) WITH CHECK ((auth.uid() = user_id));


--
-- Name: provider_brand_assets Verified brand assets are readable; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "Verified brand assets are readable" ON public.provider_brand_assets FOR SELECT TO authenticated USING (((verified = true) OR (provider_id IS NOT NULL)));


--
-- Name: admin_message_email_outbox; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.admin_message_email_outbox ENABLE ROW LEVEL SECURITY;

--
-- Name: admin_message_entries; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.admin_message_entries ENABLE ROW LEVEL SECURITY;

--
-- Name: admin_message_threads; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.admin_message_threads ENABLE ROW LEVEL SECURITY;

--
-- Name: ai_pricing_audits; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.ai_pricing_audits ENABLE ROW LEVEL SECURITY;

--
-- Name: app_features; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.app_features ENABLE ROW LEVEL SECURITY;

--
-- Name: app_presence_sessions; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.app_presence_sessions ENABLE ROW LEVEL SECURITY;

--
-- Name: driver_earnings batch1d_client_no_delete; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY batch1d_client_no_delete ON public.driver_earnings AS RESTRICTIVE FOR DELETE TO authenticated, anon USING (false);


--
-- Name: wallet_transactions batch1d_client_no_delete; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY batch1d_client_no_delete ON public.wallet_transactions AS RESTRICTIVE FOR DELETE TO authenticated, anon USING (false);


--
-- Name: wallets batch1d_client_no_delete; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY batch1d_client_no_delete ON public.wallets AS RESTRICTIVE FOR DELETE TO authenticated, anon USING (false);


--
-- Name: driver_earnings batch1d_client_no_insert; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY batch1d_client_no_insert ON public.driver_earnings AS RESTRICTIVE FOR INSERT TO authenticated, anon WITH CHECK (false);


--
-- Name: wallet_transactions batch1d_client_no_insert; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY batch1d_client_no_insert ON public.wallet_transactions AS RESTRICTIVE FOR INSERT TO authenticated, anon WITH CHECK (false);


--
-- Name: wallets batch1d_client_no_insert; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY batch1d_client_no_insert ON public.wallets AS RESTRICTIVE FOR INSERT TO authenticated, anon WITH CHECK (false);


--
-- Name: driver_earnings batch1d_client_no_update; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY batch1d_client_no_update ON public.driver_earnings AS RESTRICTIVE FOR UPDATE TO authenticated, anon USING (false) WITH CHECK (false);


--
-- Name: wallet_transactions batch1d_client_no_update; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY batch1d_client_no_update ON public.wallet_transactions AS RESTRICTIVE FOR UPDATE TO authenticated, anon USING (false) WITH CHECK (false);


--
-- Name: wallets batch1d_client_no_update; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY batch1d_client_no_update ON public.wallets AS RESTRICTIVE FOR UPDATE TO authenticated, anon USING (false) WITH CHECK (false);


--
-- Name: booking_status_history; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.booking_status_history ENABLE ROW LEVEL SECURITY;

--
-- Name: booking_support_requests; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.booking_support_requests ENABLE ROW LEVEL SECURITY;

--
-- Name: cities; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.cities ENABLE ROW LEVEL SECURITY;

--
-- Name: marketplace_commission_overrides commission_overrides_admin; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY commission_overrides_admin ON public.marketplace_commission_overrides TO authenticated USING ((EXISTS ( SELECT 1
   FROM public.profiles
  WHERE ((profiles.id = auth.uid()) AND (profiles.role = 'admin'::text))))) WITH CHECK ((EXISTS ( SELECT 1
   FROM public.profiles
  WHERE ((profiles.id = auth.uid()) AND (profiles.role = 'admin'::text)))));


--
-- Name: competitor_fare_benchmarks; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.competitor_fare_benchmarks ENABLE ROW LEVEL SECURITY;

--
-- Name: competitor_profiles; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.competitor_profiles ENABLE ROW LEVEL SECURITY;

--
-- Name: customer_local_service_preferences; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.customer_local_service_preferences ENABLE ROW LEVEL SECURITY;

--
-- Name: customer_wallet_sandbox_attempts_v1l; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.customer_wallet_sandbox_attempts_v1l ENABLE ROW LEVEL SECURITY;

--
-- Name: customer_wallet_sandbox_cohort_v1l; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.customer_wallet_sandbox_cohort_v1l ENABLE ROW LEVEL SECURITY;

--
-- Name: delivery_details; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.delivery_details ENABLE ROW LEVEL SECURITY;

--
-- Name: device_push_tokens; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.device_push_tokens ENABLE ROW LEVEL SECURITY;

--
-- Name: dispatch_logs; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.dispatch_logs ENABLE ROW LEVEL SECURITY;

--
-- Name: driver_accounts; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.driver_accounts ENABLE ROW LEVEL SECURITY;

--
-- Name: driver_bids; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.driver_bids ENABLE ROW LEVEL SECURITY;

--
-- Name: driver_bids driver_bids_driver_insert; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY driver_bids_driver_insert ON public.driver_bids FOR INSERT TO authenticated WITH CHECK ((driver_id = auth.uid()));


--
-- Name: driver_bids driver_bids_participants_read; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY driver_bids_participants_read ON public.driver_bids FOR SELECT TO authenticated USING (((driver_id = auth.uid()) OR (EXISTS ( SELECT 1
   FROM public.jobs
  WHERE ((jobs.id = driver_bids.job_id) AND (jobs.customer_id = auth.uid())))) OR (EXISTS ( SELECT 1
   FROM public.profiles
  WHERE ((profiles.id = auth.uid()) AND (profiles.role = 'admin'::text))))));


--
-- Name: driver_cash_credit_config_v1e; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.driver_cash_credit_config_v1e ENABLE ROW LEVEL SECURITY;

--
-- Name: driver_cash_credit_enrolments_v1e; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.driver_cash_credit_enrolments_v1e ENABLE ROW LEVEL SECURITY;

--
-- Name: driver_cash_credit_holds_v1e; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.driver_cash_credit_holds_v1e ENABLE ROW LEVEL SECURITY;

--
-- Name: driver_earnings; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.driver_earnings ENABLE ROW LEVEL SECURITY;

--
-- Name: driver_earnings driver_earnings_anonymous_read_v23; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY driver_earnings_anonymous_read_v23 ON public.driver_earnings AS RESTRICTIVE FOR SELECT TO anon USING (false);


--
-- Name: driver_earnings driver_earnings_owner_read_v23; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY driver_earnings_owner_read_v23 ON public.driver_earnings AS RESTRICTIVE FOR SELECT TO authenticated USING (public.driver_can_read_earnings_v23(driver_id));


--
-- Name: driver_issuing_cardholders; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.driver_issuing_cardholders ENABLE ROW LEVEL SECURITY;

--
-- Name: driver_issuing_cards; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.driver_issuing_cards ENABLE ROW LEVEL SECURITY;

--
-- Name: driver_job_declines; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.driver_job_declines ENABLE ROW LEVEL SECURITY;

--
-- Name: driver_job_declines driver_job_declines_driver_all; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY driver_job_declines_driver_all ON public.driver_job_declines TO authenticated USING ((driver_id = auth.uid())) WITH CHECK ((driver_id = auth.uid()));


--
-- Name: jobs driver_jobs_anonymous_read_v23; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY driver_jobs_anonymous_read_v23 ON public.jobs AS RESTRICTIVE FOR SELECT TO anon USING (false);


--
-- Name: driver_locations; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.driver_locations ENABLE ROW LEVEL SECURITY;

--
-- Name: jobs driver_market_jobs_read_v23; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY driver_market_jobs_read_v23 ON public.jobs AS RESTRICTIVE FOR SELECT TO authenticated USING (public.driver_can_read_job_market_v23(to_jsonb(jobs.*)));


--
-- Name: driver_onboarding_notifications; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.driver_onboarding_notifications ENABLE ROW LEVEL SECURITY;

--
-- Name: driver_onboarding_requests; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.driver_onboarding_requests ENABLE ROW LEVEL SECURITY;

--
-- Name: driver_payment_accounts; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.driver_payment_accounts ENABLE ROW LEVEL SECURITY;

--
-- Name: driver_payout_markets; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.driver_payout_markets ENABLE ROW LEVEL SECURITY;

--
-- Name: driver_requirement_audit; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.driver_requirement_audit ENABLE ROW LEVEL SECURITY;

--
-- Name: driver_vehicle_mot_checks; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.driver_vehicle_mot_checks ENABLE ROW LEVEL SECURITY;

--
-- Name: errand_details; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.errand_details ENABLE ROW LEVEL SECURITY;

--
-- Name: errand_funding; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.errand_funding ENABLE ROW LEVEL SECURITY;

--
-- Name: events; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.events ENABLE ROW LEVEL SECURITY;

--
-- Name: fare_negotiations; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.fare_negotiations ENABLE ROW LEVEL SECURITY;

--
-- Name: fare_negotiations fare_negotiations_participants_insert; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY fare_negotiations_participants_insert ON public.fare_negotiations FOR INSERT TO authenticated WITH CHECK (((proposed_by = auth.uid()) AND (EXISTS ( SELECT 1
   FROM public.jobs
  WHERE ((jobs.id = fare_negotiations.job_id) AND ((jobs.customer_id = auth.uid()) OR (jobs.driver_id = auth.uid()) OR (jobs.accepted_driver_id = auth.uid())))))));


--
-- Name: fare_negotiations fare_negotiations_participants_read; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY fare_negotiations_participants_read ON public.fare_negotiations FOR SELECT TO authenticated USING (((proposed_by = auth.uid()) OR (EXISTS ( SELECT 1
   FROM public.jobs
  WHERE ((jobs.id = fare_negotiations.job_id) AND ((jobs.customer_id = auth.uid()) OR (jobs.driver_id = auth.uid()) OR (jobs.accepted_driver_id = auth.uid()))))) OR (EXISTS ( SELECT 1
   FROM public.profiles
  WHERE ((profiles.id = auth.uid()) AND (profiles.role = 'admin'::text))))));


--
-- Name: gb_mot_night_runs; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.gb_mot_night_runs ENABLE ROW LEVEL SECURITY;

--
-- Name: marketplace_negotiation_events hybrid_events_participants; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY hybrid_events_participants ON public.marketplace_negotiation_events FOR SELECT TO authenticated USING (((EXISTS ( SELECT 1
   FROM public.marketplace_negotiation_sessions s
  WHERE ((s.id = marketplace_negotiation_events.session_id) AND ((s.customer_id = auth.uid()) OR (s.active_driver_id = auth.uid()))))) OR (EXISTS ( SELECT 1
   FROM public.profiles
  WHERE ((profiles.id = auth.uid()) AND (profiles.role = 'admin'::text))))));


--
-- Name: marketplace_negotiation_sessions hybrid_sessions_owner_or_driver; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY hybrid_sessions_owner_or_driver ON public.marketplace_negotiation_sessions FOR SELECT TO authenticated USING (((customer_id = auth.uid()) OR (active_driver_id = auth.uid()) OR (EXISTS ( SELECT 1
   FROM public.profiles
  WHERE ((profiles.id = auth.uid()) AND (profiles.role = 'admin'::text))))));


--
-- Name: job_budget_authorizations; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.job_budget_authorizations ENABLE ROW LEVEL SECURITY;

--
-- Name: job_messages job_chat_participant_read; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY job_chat_participant_read ON public.job_messages FOR SELECT TO authenticated USING (public.job_chat_is_current_participant(job_id));


--
-- Name: job_messages job_chat_receiver_read_receipt; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY job_chat_receiver_read_receipt ON public.job_messages FOR UPDATE TO authenticated USING (((receiver_id = auth.uid()) AND public.job_chat_is_current_participant(job_id))) WITH CHECK (((receiver_id = auth.uid()) AND public.job_chat_is_current_participant(job_id)));


--
-- Name: job_completion_secrets; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.job_completion_secrets ENABLE ROW LEVEL SECURITY;

--
-- Name: job_events; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.job_events ENABLE ROW LEVEL SECURITY;

--
-- Name: job_issuing_authorizations; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.job_issuing_authorizations ENABLE ROW LEVEL SECURITY;

--
-- Name: job_issuing_reserves; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.job_issuing_reserves ENABLE ROW LEVEL SECURITY;

--
-- Name: job_issuing_spend_controls; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.job_issuing_spend_controls ENABLE ROW LEVEL SECURITY;

--
-- Name: job_issuing_transactions; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.job_issuing_transactions ENABLE ROW LEVEL SECURITY;

--
-- Name: job_locations; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.job_locations ENABLE ROW LEVEL SECURITY;

--
-- Name: job_messages; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.job_messages ENABLE ROW LEVEL SECURITY;

--
-- Name: job_payment_bindings; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.job_payment_bindings ENABLE ROW LEVEL SECURITY;

--
-- Name: job_payout_queue; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.job_payout_queue ENABLE ROW LEVEL SECURITY;

--
-- Name: job_queue; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.job_queue ENABLE ROW LEVEL SECURITY;

--
-- Name: jobs; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.jobs ENABLE ROW LEVEL SECURITY;

--
-- Name: journey_evidence_v23; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.journey_evidence_v23 ENABLE ROW LEVEL SECURITY;

--
-- Name: journey_fare_enrolments_v23; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.journey_fare_enrolments_v23 ENABLE ROW LEVEL SECURITY;

--
-- Name: journey_fare_events_v23; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.journey_fare_events_v23 ENABLE ROW LEVEL SECURITY;

--
-- Name: journey_fare_proposals_v23; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.journey_fare_proposals_v23 ENABLE ROW LEVEL SECURITY;

--
-- Name: journey_start_markers_v23; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.journey_start_markers_v23 ENABLE ROW LEVEL SECURITY;

--
-- Name: journey_stop_events_v23; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.journey_stop_events_v23 ENABLE ROW LEVEL SECURITY;

--
-- Name: journey_stop_requests_v23; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.journey_stop_requests_v23 ENABLE ROW LEVEL SECURITY;

--
-- Name: kora_sandbox_booking_enrolments; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.kora_sandbox_booking_enrolments ENABLE ROW LEVEL SECURITY;

--
-- Name: kora_sandbox_booking_payments; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.kora_sandbox_booking_payments ENABLE ROW LEVEL SECURITY;

--
-- Name: kora_sandbox_sessions; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.kora_sandbox_sessions ENABLE ROW LEVEL SECURITY;

--
-- Name: local_place_search_cache; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.local_place_search_cache ENABLE ROW LEVEL SECURITY;

--
-- Name: local_service_categories; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.local_service_categories ENABLE ROW LEVEL SECURITY;

--
-- Name: local_service_providers; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.local_service_providers ENABLE ROW LEVEL SECURITY;

--
-- Name: market_payment_route_audit; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.market_payment_route_audit ENABLE ROW LEVEL SECURITY;

--
-- Name: market_payment_routes; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.market_payment_routes ENABLE ROW LEVEL SECURITY;

--
-- Name: market_price_snapshots; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.market_price_snapshots ENABLE ROW LEVEL SECURITY;

--
-- Name: market_pricing_strategies; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.market_pricing_strategies ENABLE ROW LEVEL SECURITY;

--
-- Name: marketplace_commission_overrides; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.marketplace_commission_overrides ENABLE ROW LEVEL SECURITY;

--
-- Name: marketplace_commission_overrides marketplace_commission_overrides_admin; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY marketplace_commission_overrides_admin ON public.marketplace_commission_overrides TO authenticated USING ((EXISTS ( SELECT 1
   FROM public.profiles
  WHERE ((profiles.id = auth.uid()) AND (profiles.role = 'admin'::text))))) WITH CHECK ((EXISTS ( SELECT 1
   FROM public.profiles
  WHERE ((profiles.id = auth.uid()) AND (profiles.role = 'admin'::text)))));


--
-- Name: marketplace_negotiation_events; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.marketplace_negotiation_events ENABLE ROW LEVEL SECURITY;

--
-- Name: marketplace_negotiation_sessions; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.marketplace_negotiation_sessions ENABLE ROW LEVEL SECURITY;

--
-- Name: marketplace_settings; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.marketplace_settings ENABLE ROW LEVEL SECURITY;

--
-- Name: marketplace_settings marketplace_settings_admin_read; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY marketplace_settings_admin_read ON public.marketplace_settings FOR SELECT TO authenticated USING ((EXISTS ( SELECT 1
   FROM public.profiles
  WHERE ((profiles.id = auth.uid()) AND (profiles.role = 'admin'::text)))));


--
-- Name: marketplace_settings marketplace_settings_admin_write; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY marketplace_settings_admin_write ON public.marketplace_settings TO authenticated USING ((EXISTS ( SELECT 1
   FROM public.profiles
  WHERE ((profiles.id = auth.uid()) AND (profiles.role = 'admin'::text))))) WITH CHECK ((EXISTS ( SELECT 1
   FROM public.profiles
  WHERE ((profiles.id = auth.uid()) AND (profiles.role = 'admin'::text)))));


--
-- Name: notifications; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.notifications ENABLE ROW LEVEL SECURITY;

--
-- Name: payment_card_consents; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.payment_card_consents ENABLE ROW LEVEL SECURITY;

--
-- Name: payment_checkout_attempts; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.payment_checkout_attempts ENABLE ROW LEVEL SECURITY;

--
-- Name: payment_customers; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.payment_customers ENABLE ROW LEVEL SECURITY;

--
-- Name: pricing_calendar_events; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.pricing_calendar_events ENABLE ROW LEVEL SECURITY;

--
-- Name: pricing_config; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.pricing_config ENABLE ROW LEVEL SECURITY;

--
-- Name: pricing_markets; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.pricing_markets ENABLE ROW LEVEL SECURITY;

--
-- Name: pricing_waiting_rules; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.pricing_waiting_rules ENABLE ROW LEVEL SECURITY;

--
-- Name: pricing_zones; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.pricing_zones ENABLE ROW LEVEL SECURITY;

--
-- Name: provider_brand_assets; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.provider_brand_assets ENABLE ROW LEVEL SECURITY;

--
-- Name: quote_market_adjustments; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.quote_market_adjustments ENABLE ROW LEVEL SECURITY;

--
-- Name: ratings; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.ratings ENABLE ROW LEVEL SECURITY;

--
-- Name: ride_details; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.ride_details ENABLE ROW LEVEL SECURITY;

--
-- Name: service_market_rules; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.service_market_rules ENABLE ROW LEVEL SECURITY;

--
-- Name: subscription_plans; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.subscription_plans ENABLE ROW LEVEL SECURITY;

--
-- Name: subscription_plans subscription_plans_admin_delete; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY subscription_plans_admin_delete ON public.subscription_plans FOR DELETE TO authenticated USING (public.is_admin_user());


--
-- Name: subscription_plans subscription_plans_admin_insert; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY subscription_plans_admin_insert ON public.subscription_plans FOR INSERT TO authenticated WITH CHECK (public.is_admin_user());


--
-- Name: subscription_plans subscription_plans_admin_update; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY subscription_plans_admin_update ON public.subscription_plans FOR UPDATE TO authenticated USING (public.is_admin_user()) WITH CHECK (public.is_admin_user());


--
-- Name: subscription_plans subscription_plans_select; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY subscription_plans_select ON public.subscription_plans FOR SELECT TO authenticated, anon USING (true);


--
-- Name: subscriptions; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.subscriptions ENABLE ROW LEVEL SECURITY;

--
-- Name: tenant_users; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.tenant_users ENABLE ROW LEVEL SECURITY;

--
-- Name: tenants; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.tenants ENABLE ROW LEVEL SECURITY;

--
-- Name: van_details; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.van_details ENABLE ROW LEVEL SECURITY;

--
-- Name: vehicles; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.vehicles ENABLE ROW LEVEL SECURITY;

--
-- Name: vehicles vehicles_insert_all; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY vehicles_insert_all ON public.vehicles FOR INSERT WITH CHECK (true);


--
-- Name: vehicles vehicles_select_all; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY vehicles_select_all ON public.vehicles FOR SELECT USING (true);


--
-- Name: vehicles vehicles_update_all; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY vehicles_update_all ON public.vehicles FOR UPDATE USING (true) WITH CHECK (true);


--
-- Name: wallet_accounts; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.wallet_accounts ENABLE ROW LEVEL SECURITY;

--
-- Name: wallet_accounts wallet_accounts_select_own; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY wallet_accounts_select_own ON public.wallet_accounts FOR SELECT TO authenticated USING ((owner_id = auth.uid()));


--
-- Name: wallet_business_events; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.wallet_business_events ENABLE ROW LEVEL SECURITY;

--
-- Name: wallet_business_events wallet_business_events_select_own; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY wallet_business_events_select_own ON public.wallet_business_events FOR SELECT TO authenticated USING ((owner_id = auth.uid()));


--
-- Name: wallets wallet_insert_own; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY wallet_insert_own ON public.wallets FOR INSERT TO authenticated WITH CHECK ((user_id = auth.uid()));


--
-- Name: wallet_movements; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.wallet_movements ENABLE ROW LEVEL SECURITY;

--
-- Name: wallet_movements wallet_movements_select_own; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY wallet_movements_select_own ON public.wallet_movements FOR SELECT TO authenticated USING ((EXISTS ( SELECT 1
   FROM public.wallet_accounts a
  WHERE ((a.id = wallet_movements.account_id) AND (a.owner_id = auth.uid())))));


--
-- Name: wallets wallet_select_own; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY wallet_select_own ON public.wallets FOR SELECT TO authenticated USING ((user_id = auth.uid()));


--
-- Name: wallet_topup_attempts; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.wallet_topup_attempts ENABLE ROW LEVEL SECURITY;

--
-- Name: wallet_topup_attempts wallet_topup_attempts_select_own; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY wallet_topup_attempts_select_own ON public.wallet_topup_attempts FOR SELECT TO authenticated USING ((owner_id = auth.uid()));


--
-- Name: wallet_transactions; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.wallet_transactions ENABLE ROW LEVEL SECURITY;

--
-- Name: wallets; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.wallets ENABLE ROW LEVEL SECURITY;

--
-- Name: SCHEMA public; Type: ACL; Schema: -; Owner: -
--

GRANT USAGE ON SCHEMA public TO postgres;
GRANT USAGE ON SCHEMA public TO anon;
GRANT USAGE ON SCHEMA public TO authenticated;
GRANT USAGE ON SCHEMA public TO service_role;


--
-- Name: FUNCTION accept_assigned_job(p_job_id uuid, p_driver_id uuid); Type: ACL; Schema: public; Owner: -
--

REVOKE ALL ON FUNCTION public.accept_assigned_job(p_job_id uuid, p_driver_id uuid) FROM PUBLIC;
GRANT ALL ON FUNCTION public.accept_assigned_job(p_job_id uuid, p_driver_id uuid) TO authenticated;


--
-- Name: FUNCTION accept_driver_offer(p_job_id uuid, p_driver_id uuid); Type: ACL; Schema: public; Owner: -
--

REVOKE ALL ON FUNCTION public.accept_driver_offer(p_job_id uuid, p_driver_id uuid) FROM PUBLIC;
GRANT ALL ON FUNCTION public.accept_driver_offer(p_job_id uuid, p_driver_id uuid) TO service_role;


--
-- Name: FUNCTION accept_fare_negotiation(p_job_id uuid, p_driver_id uuid); Type: ACL; Schema: public; Owner: -
--

REVOKE ALL ON FUNCTION public.accept_fare_negotiation(p_job_id uuid, p_driver_id uuid) FROM PUBLIC;
GRANT ALL ON FUNCTION public.accept_fare_negotiation(p_job_id uuid, p_driver_id uuid) TO service_role;


--
-- Name: FUNCTION accept_searching_job(p_job_id uuid, p_driver_id uuid); Type: ACL; Schema: public; Owner: -
--

REVOKE ALL ON FUNCTION public.accept_searching_job(p_job_id uuid, p_driver_id uuid) FROM PUBLIC;
GRANT ALL ON FUNCTION public.accept_searching_job(p_job_id uuid, p_driver_id uuid) TO authenticated;
GRANT ALL ON FUNCTION public.accept_searching_job(p_job_id uuid, p_driver_id uuid) TO service_role;


--
-- Name: FUNCTION activate_job_issuing_control(p_job uuid, p_card text, p_budget numeric, p_metadata jsonb); Type: ACL; Schema: public; Owner: -
--

REVOKE ALL ON FUNCTION public.activate_job_issuing_control(p_job uuid, p_card text, p_budget numeric, p_metadata jsonb) FROM PUBLIC;
GRANT ALL ON FUNCTION public.activate_job_issuing_control(p_job uuid, p_card text, p_budget numeric, p_metadata jsonb) TO postgres;
GRANT ALL ON FUNCTION public.activate_job_issuing_control(p_job uuid, p_card text, p_budget numeric, p_metadata jsonb) TO service_role;


--
-- Name: FUNCTION admin_live_presence(); Type: ACL; Schema: public; Owner: -
--

REVOKE ALL ON FUNCTION public.admin_live_presence() FROM PUBLIC;
GRANT ALL ON FUNCTION public.admin_live_presence() TO postgres;
GRANT ALL ON FUNCTION public.admin_live_presence() TO authenticated;
GRANT ALL ON FUNCTION public.admin_live_presence() TO service_role;


--
-- Name: FUNCTION admin_message_conversation(p_actor uuid, p_action text, p_thread uuid, p_input jsonb); Type: ACL; Schema: public; Owner: -
--

REVOKE ALL ON FUNCTION public.admin_message_conversation(p_actor uuid, p_action text, p_thread uuid, p_input jsonb) FROM PUBLIC;
GRANT ALL ON FUNCTION public.admin_message_conversation(p_actor uuid, p_action text, p_thread uuid, p_input jsonb) TO postgres;
GRANT ALL ON FUNCTION public.admin_message_conversation(p_actor uuid, p_action text, p_thread uuid, p_input jsonb) TO service_role;


--
-- Name: FUNCTION append_journey_evidence_v23(p_job_id uuid, p_driver_id uuid, p_tenant_id uuid, p_lat double precision, p_lng double precision, p_accuracy double precision, p_sampled_at timestamp with time zone); Type: ACL; Schema: public; Owner: -
--

REVOKE ALL ON FUNCTION public.append_journey_evidence_v23(p_job_id uuid, p_driver_id uuid, p_tenant_id uuid, p_lat double precision, p_lng double precision, p_accuracy double precision, p_sampled_at timestamp with time zone) FROM PUBLIC;
GRANT ALL ON FUNCTION public.append_journey_evidence_v23(p_job_id uuid, p_driver_id uuid, p_tenant_id uuid, p_lat double precision, p_lng double precision, p_accuracy double precision, p_sampled_at timestamp with time zone) TO postgres;
GRANT ALL ON FUNCTION public.append_journey_evidence_v23(p_job_id uuid, p_driver_id uuid, p_tenant_id uuid, p_lat double precision, p_lng double precision, p_accuracy double precision, p_sampled_at timestamp with time zone) TO service_role;


--
-- Name: FUNCTION approve_card_errand_budget(p_job uuid, p_request uuid, p_old_intent text, p_new_intent text, p_budget numeric, p_available numeric, p_currency text); Type: ACL; Schema: public; Owner: -
--

REVOKE ALL ON FUNCTION public.approve_card_errand_budget(p_job uuid, p_request uuid, p_old_intent text, p_new_intent text, p_budget numeric, p_available numeric, p_currency text) FROM PUBLIC;
GRANT ALL ON FUNCTION public.approve_card_errand_budget(p_job uuid, p_request uuid, p_old_intent text, p_new_intent text, p_budget numeric, p_available numeric, p_currency text) TO postgres;
GRANT ALL ON FUNCTION public.approve_card_errand_budget(p_job uuid, p_request uuid, p_old_intent text, p_new_intent text, p_budget numeric, p_available numeric, p_currency text) TO service_role;


--
-- Name: FUNCTION approve_errand_over_budget(p_job_id uuid); Type: ACL; Schema: public; Owner: -
--

REVOKE ALL ON FUNCTION public.approve_errand_over_budget(p_job_id uuid) FROM PUBLIC;
GRANT ALL ON FUNCTION public.approve_errand_over_budget(p_job_id uuid) TO authenticated;
GRANT ALL ON FUNCTION public.approve_errand_over_budget(p_job_id uuid) TO service_role;


--
-- Name: FUNCTION assign_driver_to_job(p_job_id uuid, p_driver_id uuid); Type: ACL; Schema: public; Owner: -
--

REVOKE ALL ON FUNCTION public.assign_driver_to_job(p_job_id uuid, p_driver_id uuid) FROM PUBLIC;
GRANT ALL ON FUNCTION public.assign_driver_to_job(p_job_id uuid, p_driver_id uuid) TO authenticated;
GRANT ALL ON FUNCTION public.assign_driver_to_job(p_job_id uuid, p_driver_id uuid) TO service_role;


--
-- Name: FUNCTION audit_market_payment_route_v23(); Type: ACL; Schema: public; Owner: -
--

REVOKE ALL ON FUNCTION public.audit_market_payment_route_v23() FROM PUBLIC;
GRANT ALL ON FUNCTION public.audit_market_payment_route_v23() TO postgres;


--
-- Name: FUNCTION bind_driver_payment_recovery(p_id uuid, p_candidate text, p_evidence text); Type: ACL; Schema: public; Owner: -
--

REVOKE ALL ON FUNCTION public.bind_driver_payment_recovery(p_id uuid, p_candidate text, p_evidence text) FROM PUBLIC;
GRANT ALL ON FUNCTION public.bind_driver_payment_recovery(p_id uuid, p_candidate text, p_evidence text) TO postgres;


--
-- Name: FUNCTION can_view_job_details(p_job_id uuid); Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON FUNCTION public.can_view_job_details(p_job_id uuid) TO anon;
GRANT ALL ON FUNCTION public.can_view_job_details(p_job_id uuid) TO authenticated;
GRANT ALL ON FUNCTION public.can_view_job_details(p_job_id uuid) TO service_role;


--
-- Name: FUNCTION cancel_job_safely(p_job_id uuid, p_reason text); Type: ACL; Schema: public; Owner: -
--

REVOKE ALL ON FUNCTION public.cancel_job_safely(p_job_id uuid, p_reason text) FROM PUBLIC;
GRANT ALL ON FUNCTION public.cancel_job_safely(p_job_id uuid, p_reason text) TO service_role;


--
-- Name: FUNCTION canonical_driver_service(p_raw text); Type: ACL; Schema: public; Owner: -
--

REVOKE ALL ON FUNCTION public.canonical_driver_service(p_raw text) FROM PUBLIC;


--
-- Name: FUNCTION cash_credit_minor_v1e(v jsonb, c text); Type: ACL; Schema: public; Owner: -
--

REVOKE ALL ON FUNCTION public.cash_credit_minor_v1e(v jsonb, c text) FROM PUBLIC;
GRANT ALL ON FUNCTION public.cash_credit_minor_v1e(v jsonb, c text) TO postgres;


--
-- Name: FUNCTION cash_credit_service_writer_v1e(); Type: ACL; Schema: public; Owner: -
--

REVOKE ALL ON FUNCTION public.cash_credit_service_writer_v1e() FROM PUBLIC;
GRANT ALL ON FUNCTION public.cash_credit_service_writer_v1e() TO postgres;


--
-- Name: FUNCTION cash_credit_terms_v1e(b jsonb, c text); Type: ACL; Schema: public; Owner: -
--

REVOKE ALL ON FUNCTION public.cash_credit_terms_v1e(b jsonb, c text) FROM PUBLIC;
GRANT ALL ON FUNCTION public.cash_credit_terms_v1e(b jsonb, c text) TO postgres;


--
-- Name: FUNCTION check_errand_completion_guard(); Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON FUNCTION public.check_errand_completion_guard() TO anon;
GRANT ALL ON FUNCTION public.check_errand_completion_guard() TO authenticated;
GRANT ALL ON FUNCTION public.check_errand_completion_guard() TO service_role;


--
-- Name: FUNCTION check_wallet_integrity(); Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON FUNCTION public.check_wallet_integrity() TO anon;
GRANT ALL ON FUNCTION public.check_wallet_integrity() TO authenticated;
GRANT ALL ON FUNCTION public.check_wallet_integrity() TO service_role;


--
-- Name: FUNCTION claim_admin_message_email(); Type: ACL; Schema: public; Owner: -
--

REVOKE ALL ON FUNCTION public.claim_admin_message_email() FROM PUBLIC;
GRANT ALL ON FUNCTION public.claim_admin_message_email() TO postgres;
GRANT ALL ON FUNCTION public.claim_admin_message_email() TO service_role;


--
-- Name: TABLE booking_support_requests; Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON TABLE public.booking_support_requests TO postgres;
GRANT ALL ON TABLE public.booking_support_requests TO service_role;


--
-- Name: FUNCTION claim_booking_support_email(p_id uuid); Type: ACL; Schema: public; Owner: -
--

REVOKE ALL ON FUNCTION public.claim_booking_support_email(p_id uuid) FROM PUBLIC;
GRANT ALL ON FUNCTION public.claim_booking_support_email(p_id uuid) TO postgres;
GRANT ALL ON FUNCTION public.claim_booking_support_email(p_id uuid) TO service_role;


--
-- Name: FUNCTION claim_customer_wallet_sandbox_v1l(p_owner uuid, p_id uuid, p_fingerprint text); Type: ACL; Schema: public; Owner: -
--

REVOKE ALL ON FUNCTION public.claim_customer_wallet_sandbox_v1l(p_owner uuid, p_id uuid, p_fingerprint text) FROM PUBLIC;
GRANT ALL ON FUNCTION public.claim_customer_wallet_sandbox_v1l(p_owner uuid, p_id uuid, p_fingerprint text) TO postgres;
GRANT ALL ON FUNCTION public.claim_customer_wallet_sandbox_v1l(p_owner uuid, p_id uuid, p_fingerprint text) TO service_role;


--
-- Name: TABLE driver_payment_accounts; Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON TABLE public.driver_payment_accounts TO postgres;
GRANT SELECT,UPDATE ON TABLE public.driver_payment_accounts TO service_role;


--
-- Name: FUNCTION claim_driver_payment_setup(p_driver uuid, p_tenant uuid, p_country text, p_currency text, p_merchant text); Type: ACL; Schema: public; Owner: -
--

REVOKE ALL ON FUNCTION public.claim_driver_payment_setup(p_driver uuid, p_tenant uuid, p_country text, p_currency text, p_merchant text) FROM PUBLIC;
GRANT ALL ON FUNCTION public.claim_driver_payment_setup(p_driver uuid, p_tenant uuid, p_country text, p_currency text, p_merchant text) TO postgres;
GRANT ALL ON FUNCTION public.claim_driver_payment_setup(p_driver uuid, p_tenant uuid, p_country text, p_currency text, p_merchant text) TO service_role;


--
-- Name: FUNCTION claim_gb_mot_night(p_day date); Type: ACL; Schema: public; Owner: -
--

REVOKE ALL ON FUNCTION public.claim_gb_mot_night(p_day date) FROM PUBLIC;
GRANT ALL ON FUNCTION public.claim_gb_mot_night(p_day date) TO postgres;
GRANT ALL ON FUNCTION public.claim_gb_mot_night(p_day date) TO service_role;


--
-- Name: FUNCTION claim_job_settlement(p_job_id uuid, p_amount_minor bigint, p_currency text, p_destination text, p_lease_seconds integer); Type: ACL; Schema: public; Owner: -
--

REVOKE ALL ON FUNCTION public.claim_job_settlement(p_job_id uuid, p_amount_minor bigint, p_currency text, p_destination text, p_lease_seconds integer) FROM PUBLIC;
GRANT ALL ON FUNCTION public.claim_job_settlement(p_job_id uuid, p_amount_minor bigint, p_currency text, p_destination text, p_lease_seconds integer) TO postgres;
GRANT ALL ON FUNCTION public.claim_job_settlement(p_job_id uuid, p_amount_minor bigint, p_currency text, p_destination text, p_lease_seconds integer) TO service_role;


--
-- Name: FUNCTION claim_kora_sandbox_booking_refund(p_job uuid, p_user uuid, p_account text, p_reference text); Type: ACL; Schema: public; Owner: -
--

REVOKE ALL ON FUNCTION public.claim_kora_sandbox_booking_refund(p_job uuid, p_user uuid, p_account text, p_reference text) FROM PUBLIC;
GRANT ALL ON FUNCTION public.claim_kora_sandbox_booking_refund(p_job uuid, p_user uuid, p_account text, p_reference text) TO postgres;
GRANT ALL ON FUNCTION public.claim_kora_sandbox_booking_refund(p_job uuid, p_user uuid, p_account text, p_reference text) TO service_role;


--
-- Name: TABLE marketplace_negotiation_sessions; Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON TABLE public.marketplace_negotiation_sessions TO anon;
GRANT ALL ON TABLE public.marketplace_negotiation_sessions TO authenticated;
GRANT ALL ON TABLE public.marketplace_negotiation_sessions TO service_role;


--
-- Name: FUNCTION claim_marketplace_negotiation(p_job_id uuid, p_driver_id uuid); Type: ACL; Schema: public; Owner: -
--

REVOKE ALL ON FUNCTION public.claim_marketplace_negotiation(p_job_id uuid, p_driver_id uuid) FROM PUBLIC;
GRANT ALL ON FUNCTION public.claim_marketplace_negotiation(p_job_id uuid, p_driver_id uuid) TO authenticated;
GRANT ALL ON FUNCTION public.claim_marketplace_negotiation(p_job_id uuid, p_driver_id uuid) TO service_role;


--
-- Name: TABLE job_payout_queue; Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON TABLE public.job_payout_queue TO postgres;
GRANT ALL ON TABLE public.job_payout_queue TO service_role;


--
-- Name: FUNCTION claim_queued_job_payout(p_job_id uuid); Type: ACL; Schema: public; Owner: -
--

REVOKE ALL ON FUNCTION public.claim_queued_job_payout(p_job_id uuid) FROM PUBLIC;
GRANT ALL ON FUNCTION public.claim_queued_job_payout(p_job_id uuid) TO postgres;
GRANT ALL ON FUNCTION public.claim_queued_job_payout(p_job_id uuid) TO service_role;


--
-- Name: FUNCTION claim_wallet_topup_submission(p_attempt_id uuid); Type: ACL; Schema: public; Owner: -
--

REVOKE ALL ON FUNCTION public.claim_wallet_topup_submission(p_attempt_id uuid) FROM PUBLIC;
GRANT ALL ON FUNCTION public.claim_wallet_topup_submission(p_attempt_id uuid) TO postgres;
GRANT ALL ON FUNCTION public.claim_wallet_topup_submission(p_attempt_id uuid) TO service_role;


--
-- Name: TABLE jobs; Type: ACL; Schema: public; Owner: -
--

GRANT SELECT,INSERT,REFERENCES,DELETE,TRIGGER,TRUNCATE ON TABLE public.jobs TO anon;
GRANT SELECT,INSERT,REFERENCES,DELETE,TRIGGER,TRUNCATE ON TABLE public.jobs TO authenticated;
GRANT ALL ON TABLE public.jobs TO service_role;


--
-- Name: COLUMN jobs.status; Type: ACL; Schema: public; Owner: -
--

GRANT UPDATE(status) ON TABLE public.jobs TO authenticated;


--
-- Name: COLUMN jobs.updated_at; Type: ACL; Schema: public; Owner: -
--

GRANT UPDATE(updated_at) ON TABLE public.jobs TO authenticated;


--
-- Name: COLUMN jobs.pickup_lat; Type: ACL; Schema: public; Owner: -
--

GRANT UPDATE(pickup_lat) ON TABLE public.jobs TO authenticated;


--
-- Name: COLUMN jobs.pickup_lng; Type: ACL; Schema: public; Owner: -
--

GRANT UPDATE(pickup_lng) ON TABLE public.jobs TO authenticated;


--
-- Name: COLUMN jobs.dropoff_lat; Type: ACL; Schema: public; Owner: -
--

GRANT UPDATE(dropoff_lat) ON TABLE public.jobs TO authenticated;


--
-- Name: COLUMN jobs.dropoff_lng; Type: ACL; Schema: public; Owner: -
--

GRANT UPDATE(dropoff_lng) ON TABLE public.jobs TO authenticated;


--
-- Name: COLUMN jobs.negotiation_mode_enabled; Type: ACL; Schema: public; Owner: -
--

GRANT UPDATE(negotiation_mode_enabled) ON TABLE public.jobs TO authenticated;


--
-- Name: COLUMN jobs.is_draft; Type: ACL; Schema: public; Owner: -
--

GRANT UPDATE(is_draft) ON TABLE public.jobs TO authenticated;


--
-- Name: COLUMN jobs.expired_at; Type: ACL; Schema: public; Owner: -
--

GRANT UPDATE(expired_at) ON TABLE public.jobs TO authenticated;


--
-- Name: COLUMN jobs.expiry_reason; Type: ACL; Schema: public; Owner: -
--

GRANT UPDATE(expiry_reason) ON TABLE public.jobs TO authenticated;


--
-- Name: FUNCTION complete_job_with_pending_payout(p_job_id uuid, p_driver_id uuid, p_terms jsonb, p_metadata jsonb); Type: ACL; Schema: public; Owner: -
--

REVOKE ALL ON FUNCTION public.complete_job_with_pending_payout(p_job_id uuid, p_driver_id uuid, p_terms jsonb, p_metadata jsonb) FROM PUBLIC;
GRANT ALL ON FUNCTION public.complete_job_with_pending_payout(p_job_id uuid, p_driver_id uuid, p_terms jsonb, p_metadata jsonb) TO postgres;
GRANT ALL ON FUNCTION public.complete_job_with_pending_payout(p_job_id uuid, p_driver_id uuid, p_terms jsonb, p_metadata jsonb) TO service_role;


--
-- Name: FUNCTION configured_payment_countries_v23(); Type: ACL; Schema: public; Owner: -
--

REVOKE ALL ON FUNCTION public.configured_payment_countries_v23() FROM PUBLIC;
GRANT ALL ON FUNCTION public.configured_payment_countries_v23() TO postgres;
GRANT ALL ON FUNCTION public.configured_payment_countries_v23() TO service_role;


--
-- Name: FUNCTION confirm_kora_sandbox_booking(p_job uuid, p_user uuid, p_account text); Type: ACL; Schema: public; Owner: -
--

REVOKE ALL ON FUNCTION public.confirm_kora_sandbox_booking(p_job uuid, p_user uuid, p_account text) FROM PUBLIC;
GRANT ALL ON FUNCTION public.confirm_kora_sandbox_booking(p_job uuid, p_user uuid, p_account text) TO postgres;
GRANT ALL ON FUNCTION public.confirm_kora_sandbox_booking(p_job uuid, p_user uuid, p_account text) TO service_role;


--
-- Name: FUNCTION confirm_wallet_topup(p_attempt_id uuid, p_verified_provider_reference text, p_verified_merchant_account_ref text, p_verified_currency text, p_verified_amount_minor bigint, p_final_status text); Type: ACL; Schema: public; Owner: -
--

REVOKE ALL ON FUNCTION public.confirm_wallet_topup(p_attempt_id uuid, p_verified_provider_reference text, p_verified_merchant_account_ref text, p_verified_currency text, p_verified_amount_minor bigint, p_final_status text) FROM PUBLIC;
GRANT ALL ON FUNCTION public.confirm_wallet_topup(p_attempt_id uuid, p_verified_provider_reference text, p_verified_merchant_account_ref text, p_verified_currency text, p_verified_amount_minor bigint, p_final_status text) TO postgres;
GRANT ALL ON FUNCTION public.confirm_wallet_topup(p_attempt_id uuid, p_verified_provider_reference text, p_verified_merchant_account_ref text, p_verified_currency text, p_verified_amount_minor bigint, p_final_status text) TO service_role;


--
-- Name: FUNCTION create_booking_support_request(p_user_id uuid, p_job_id uuid, p_request_id uuid, p_category text, p_message text, p_email text, p_tenant_id uuid, p_country text, p_city text, p_driver_id uuid); Type: ACL; Schema: public; Owner: -
--

REVOKE ALL ON FUNCTION public.create_booking_support_request(p_user_id uuid, p_job_id uuid, p_request_id uuid, p_category text, p_message text, p_email text, p_tenant_id uuid, p_country text, p_city text, p_driver_id uuid) FROM PUBLIC;
GRANT ALL ON FUNCTION public.create_booking_support_request(p_user_id uuid, p_job_id uuid, p_request_id uuid, p_category text, p_message text, p_email text, p_tenant_id uuid, p_country text, p_city text, p_driver_id uuid) TO postgres;
GRANT ALL ON FUNCTION public.create_booking_support_request(p_user_id uuid, p_job_id uuid, p_request_id uuid, p_category text, p_message text, p_email text, p_tenant_id uuid, p_country text, p_city text, p_driver_id uuid) TO service_role;


--
-- Name: FUNCTION create_customer_offer(p_job_id uuid, p_amount numeric); Type: ACL; Schema: public; Owner: -
--

REVOKE ALL ON FUNCTION public.create_customer_offer(p_job_id uuid, p_amount numeric) FROM PUBLIC;
GRANT ALL ON FUNCTION public.create_customer_offer(p_job_id uuid, p_amount numeric) TO authenticated;
GRANT ALL ON FUNCTION public.create_customer_offer(p_job_id uuid, p_amount numeric) TO service_role;


--
-- Name: FUNCTION credit_wallet_topup(p_user_id uuid, p_amount numeric, p_currency_code text, p_stripe_payment_intent_id text); Type: ACL; Schema: public; Owner: -
--

REVOKE ALL ON FUNCTION public.credit_wallet_topup(p_user_id uuid, p_amount numeric, p_currency_code text, p_stripe_payment_intent_id text) FROM PUBLIC;


--
-- Name: FUNCTION credit_wallet_topup(p_user_id uuid, p_amount numeric, p_payment_intent_id text, p_currency_code text, p_metadata jsonb); Type: ACL; Schema: public; Owner: -
--

REVOKE ALL ON FUNCTION public.credit_wallet_topup(p_user_id uuid, p_amount numeric, p_payment_intent_id text, p_currency_code text, p_metadata jsonb) FROM PUBLIC;


--
-- Name: FUNCTION customer_accept_driver_counter(p_session_id uuid); Type: ACL; Schema: public; Owner: -
--

REVOKE ALL ON FUNCTION public.customer_accept_driver_counter(p_session_id uuid) FROM PUBLIC;
GRANT ALL ON FUNCTION public.customer_accept_driver_counter(p_session_id uuid) TO authenticated;
GRANT ALL ON FUNCTION public.customer_accept_driver_counter(p_session_id uuid) TO service_role;


--
-- Name: FUNCTION customer_cancel_offer(p_session_id uuid); Type: ACL; Schema: public; Owner: -
--

REVOKE ALL ON FUNCTION public.customer_cancel_offer(p_session_id uuid) FROM PUBLIC;
GRANT ALL ON FUNCTION public.customer_cancel_offer(p_session_id uuid) TO authenticated;
GRANT ALL ON FUNCTION public.customer_cancel_offer(p_session_id uuid) TO service_role;


--
-- Name: FUNCTION customer_counter_offer(p_session_id uuid, p_amount numeric); Type: ACL; Schema: public; Owner: -
--

REVOKE ALL ON FUNCTION public.customer_counter_offer(p_session_id uuid, p_amount numeric) FROM PUBLIC;
GRANT ALL ON FUNCTION public.customer_counter_offer(p_session_id uuid, p_amount numeric) TO authenticated;
GRANT ALL ON FUNCTION public.customer_counter_offer(p_session_id uuid, p_amount numeric) TO service_role;


--
-- Name: FUNCTION customer_decline_counter(p_session_id uuid); Type: ACL; Schema: public; Owner: -
--

REVOKE ALL ON FUNCTION public.customer_decline_counter(p_session_id uuid) FROM PUBLIC;
GRANT ALL ON FUNCTION public.customer_decline_counter(p_session_id uuid) TO authenticated;
GRANT ALL ON FUNCTION public.customer_decline_counter(p_session_id uuid) TO service_role;


--
-- Name: FUNCTION customer_expire_unpaid_agreement(p_session_id uuid); Type: ACL; Schema: public; Owner: -
--

REVOKE ALL ON FUNCTION public.customer_expire_unpaid_agreement(p_session_id uuid) FROM PUBLIC;
GRANT ALL ON FUNCTION public.customer_expire_unpaid_agreement(p_session_id uuid) TO authenticated;
GRANT ALL ON FUNCTION public.customer_expire_unpaid_agreement(p_session_id uuid) TO service_role;


--
-- Name: FUNCTION customer_has_active_job_with_driver(p_driver_id uuid); Type: ACL; Schema: public; Owner: -
--

REVOKE ALL ON FUNCTION public.customer_has_active_job_with_driver(p_driver_id uuid) FROM PUBLIC;
GRANT ALL ON FUNCTION public.customer_has_active_job_with_driver(p_driver_id uuid) TO anon;
GRANT ALL ON FUNCTION public.customer_has_active_job_with_driver(p_driver_id uuid) TO authenticated;
GRANT ALL ON FUNCTION public.customer_has_active_job_with_driver(p_driver_id uuid) TO service_role;


--
-- Name: FUNCTION customer_has_active_job_with_driver(p_customer_id uuid, p_driver_id uuid); Type: ACL; Schema: public; Owner: -
--

REVOKE ALL ON FUNCTION public.customer_has_active_job_with_driver(p_customer_id uuid, p_driver_id uuid) FROM PUBLIC;
GRANT ALL ON FUNCTION public.customer_has_active_job_with_driver(p_customer_id uuid, p_driver_id uuid) TO anon;
GRANT ALL ON FUNCTION public.customer_has_active_job_with_driver(p_customer_id uuid, p_driver_id uuid) TO authenticated;
GRANT ALL ON FUNCTION public.customer_has_active_job_with_driver(p_customer_id uuid, p_driver_id uuid) TO service_role;


--
-- Name: FUNCTION customer_wallet_sandbox_eligibility_v1m(p_owner uuid); Type: ACL; Schema: public; Owner: -
--

REVOKE ALL ON FUNCTION public.customer_wallet_sandbox_eligibility_v1m(p_owner uuid) FROM PUBLIC;
GRANT ALL ON FUNCTION public.customer_wallet_sandbox_eligibility_v1m(p_owner uuid) TO postgres;
GRANT ALL ON FUNCTION public.customer_wallet_sandbox_eligibility_v1m(p_owner uuid) TO service_role;


--
-- Name: FUNCTION customer_wallet_setup_enabled_v1h(); Type: ACL; Schema: public; Owner: -
--

REVOKE ALL ON FUNCTION public.customer_wallet_setup_enabled_v1h() FROM PUBLIC;
GRANT ALL ON FUNCTION public.customer_wallet_setup_enabled_v1h() TO postgres;
GRANT ALL ON FUNCTION public.customer_wallet_setup_enabled_v1h() TO service_role;


--
-- Name: FUNCTION driver_accept_customer_offer(p_session_id uuid); Type: ACL; Schema: public; Owner: -
--

REVOKE ALL ON FUNCTION public.driver_accept_customer_offer(p_session_id uuid) FROM PUBLIC;
GRANT ALL ON FUNCTION public.driver_accept_customer_offer(p_session_id uuid) TO authenticated;
GRANT ALL ON FUNCTION public.driver_accept_customer_offer(p_session_id uuid) TO service_role;


--
-- Name: FUNCTION driver_can_read_earnings_v23(driver uuid); Type: ACL; Schema: public; Owner: -
--

REVOKE ALL ON FUNCTION public.driver_can_read_earnings_v23(driver uuid) FROM PUBLIC;
GRANT ALL ON FUNCTION public.driver_can_read_earnings_v23(driver uuid) TO postgres;
GRANT ALL ON FUNCTION public.driver_can_read_earnings_v23(driver uuid) TO anon;
GRANT ALL ON FUNCTION public.driver_can_read_earnings_v23(driver uuid) TO authenticated;
GRANT ALL ON FUNCTION public.driver_can_read_earnings_v23(driver uuid) TO service_role;


--
-- Name: FUNCTION driver_can_read_job_market_v23(j jsonb); Type: ACL; Schema: public; Owner: -
--

REVOKE ALL ON FUNCTION public.driver_can_read_job_market_v23(j jsonb) FROM PUBLIC;
GRANT ALL ON FUNCTION public.driver_can_read_job_market_v23(j jsonb) TO postgres;
GRANT ALL ON FUNCTION public.driver_can_read_job_market_v23(j jsonb) TO anon;
GRANT ALL ON FUNCTION public.driver_can_read_job_market_v23(j jsonb) TO authenticated;
GRANT ALL ON FUNCTION public.driver_can_read_job_market_v23(j jsonb) TO service_role;


--
-- Name: FUNCTION driver_cash_credit_balance_v1e(t uuid, d uuid, c text); Type: ACL; Schema: public; Owner: -
--

REVOKE ALL ON FUNCTION public.driver_cash_credit_balance_v1e(t uuid, d uuid, c text) FROM PUBLIC;
GRANT ALL ON FUNCTION public.driver_cash_credit_balance_v1e(t uuid, d uuid, c text) TO postgres;
GRANT ALL ON FUNCTION public.driver_cash_credit_balance_v1e(t uuid, d uuid, c text) TO service_role;


--
-- Name: FUNCTION driver_cash_credit_enabled_v1e(); Type: ACL; Schema: public; Owner: -
--

REVOKE ALL ON FUNCTION public.driver_cash_credit_enabled_v1e() FROM PUBLIC;
GRANT ALL ON FUNCTION public.driver_cash_credit_enabled_v1e() TO postgres;
GRANT ALL ON FUNCTION public.driver_cash_credit_enabled_v1e() TO service_role;


--
-- Name: FUNCTION driver_cash_credit_lock_v1e(t uuid, d uuid, c text); Type: ACL; Schema: public; Owner: -
--

REVOKE ALL ON FUNCTION public.driver_cash_credit_lock_v1e(t uuid, d uuid, c text) FROM PUBLIC;
GRANT ALL ON FUNCTION public.driver_cash_credit_lock_v1e(t uuid, d uuid, c text) TO postgres;


--
-- Name: FUNCTION driver_cash_credit_status_v1f(p_driver_id uuid); Type: ACL; Schema: public; Owner: -
--

REVOKE ALL ON FUNCTION public.driver_cash_credit_status_v1f(p_driver_id uuid) FROM PUBLIC;
GRANT ALL ON FUNCTION public.driver_cash_credit_status_v1f(p_driver_id uuid) TO postgres;
GRANT ALL ON FUNCTION public.driver_cash_credit_status_v1f(p_driver_id uuid) TO service_role;


--
-- Name: FUNCTION driver_compliance_rule_passes(p_check_type text, p_value text, p_at timestamp with time zone); Type: ACL; Schema: public; Owner: -
--

REVOKE ALL ON FUNCTION public.driver_compliance_rule_passes(p_check_type text, p_value text, p_at timestamp with time zone) FROM PUBLIC;


--
-- Name: FUNCTION driver_compliance_rules(); Type: ACL; Schema: public; Owner: -
--

REVOKE ALL ON FUNCTION public.driver_compliance_rules() FROM PUBLIC;


--
-- Name: FUNCTION driver_counter_offer(p_session_id uuid, p_amount numeric); Type: ACL; Schema: public; Owner: -
--

REVOKE ALL ON FUNCTION public.driver_counter_offer(p_session_id uuid, p_amount numeric) FROM PUBLIC;
GRANT ALL ON FUNCTION public.driver_counter_offer(p_session_id uuid, p_amount numeric) TO authenticated;
GRANT ALL ON FUNCTION public.driver_counter_offer(p_session_id uuid, p_amount numeric) TO service_role;


--
-- Name: FUNCTION driver_has_active_job(p_driver_id uuid); Type: ACL; Schema: public; Owner: -
--

REVOKE ALL ON FUNCTION public.driver_has_active_job(p_driver_id uuid) FROM PUBLIC;


--
-- Name: FUNCTION driver_has_other_active_job(p_driver_id uuid, p_exclude_job_id uuid); Type: ACL; Schema: public; Owner: -
--

REVOKE ALL ON FUNCTION public.driver_has_other_active_job(p_driver_id uuid, p_exclude_job_id uuid) FROM PUBLIC;


--
-- Name: FUNCTION driver_job_market_matches_v23(p jsonb, j jsonb); Type: ACL; Schema: public; Owner: -
--

REVOKE ALL ON FUNCTION public.driver_job_market_matches_v23(p jsonb, j jsonb) FROM PUBLIC;
GRANT ALL ON FUNCTION public.driver_job_market_matches_v23(p jsonb, j jsonb) TO postgres;
GRANT ALL ON FUNCTION public.driver_job_market_matches_v23(p jsonb, j jsonb) TO anon;
GRANT ALL ON FUNCTION public.driver_job_market_matches_v23(p jsonb, j jsonb) TO authenticated;
GRANT ALL ON FUNCTION public.driver_job_market_matches_v23(p jsonb, j jsonb) TO service_role;


--
-- Name: FUNCTION driver_occupying_statuses(); Type: ACL; Schema: public; Owner: -
--

REVOKE ALL ON FUNCTION public.driver_occupying_statuses() FROM PUBLIC;


--
-- Name: FUNCTION driver_ranking_scores_v23(p_driver_ids uuid[]); Type: ACL; Schema: public; Owner: -
--

REVOKE ALL ON FUNCTION public.driver_ranking_scores_v23(p_driver_ids uuid[]) FROM PUBLIC;
GRANT ALL ON FUNCTION public.driver_ranking_scores_v23(p_driver_ids uuid[]) TO postgres;
GRANT ALL ON FUNCTION public.driver_ranking_scores_v23(p_driver_ids uuid[]) TO service_role;


--
-- Name: FUNCTION driver_service_eligibility(p_driver_id uuid, p_service text, p_at timestamp with time zone); Type: ACL; Schema: public; Owner: -
--

REVOKE ALL ON FUNCTION public.driver_service_eligibility(p_driver_id uuid, p_service text, p_at timestamp with time zone) FROM PUBLIC;


--
-- Name: FUNCTION driver_vehicle_can_accept_job(p_job_id uuid, p_driver_id uuid); Type: ACL; Schema: public; Owner: -
--

REVOKE ALL ON FUNCTION public.driver_vehicle_can_accept_job(p_job_id uuid, p_driver_id uuid) FROM PUBLIC;


--
-- Name: FUNCTION early_stop_fare_context_v23(p_actor uuid, p_job_id uuid, p_stop_id uuid); Type: ACL; Schema: public; Owner: -
--

REVOKE ALL ON FUNCTION public.early_stop_fare_context_v23(p_actor uuid, p_job_id uuid, p_stop_id uuid) FROM PUBLIC;
GRANT ALL ON FUNCTION public.early_stop_fare_context_v23(p_actor uuid, p_job_id uuid, p_stop_id uuid) TO postgres;
GRANT ALL ON FUNCTION public.early_stop_fare_context_v23(p_actor uuid, p_job_id uuid, p_stop_id uuid) TO service_role;


--
-- Name: FUNCTION end_job_driver_search(p_job_id uuid); Type: ACL; Schema: public; Owner: -
--

REVOKE ALL ON FUNCTION public.end_job_driver_search(p_job_id uuid) FROM PUBLIC;
GRANT ALL ON FUNCTION public.end_job_driver_search(p_job_id uuid) TO postgres;
GRANT ALL ON FUNCTION public.end_job_driver_search(p_job_id uuid) TO service_role;


--
-- Name: FUNCTION enforce_driver_job_market_v23(); Type: ACL; Schema: public; Owner: -
--

REVOKE ALL ON FUNCTION public.enforce_driver_job_market_v23() FROM PUBLIC;
GRANT ALL ON FUNCTION public.enforce_driver_job_market_v23() TO postgres;
GRANT ALL ON FUNCTION public.enforce_driver_job_market_v23() TO anon;
GRANT ALL ON FUNCTION public.enforce_driver_job_market_v23() TO authenticated;
GRANT ALL ON FUNCTION public.enforce_driver_job_market_v23() TO service_role;


--
-- Name: FUNCTION enforce_errand_spending_budget(); Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON FUNCTION public.enforce_errand_spending_budget() TO anon;
GRANT ALL ON FUNCTION public.enforce_errand_spending_budget() TO authenticated;
GRANT ALL ON FUNCTION public.enforce_errand_spending_budget() TO service_role;


--
-- Name: FUNCTION enforce_gb_mot_acquisition(); Type: ACL; Schema: public; Owner: -
--

REVOKE ALL ON FUNCTION public.enforce_gb_mot_acquisition() FROM PUBLIC;
GRANT ALL ON FUNCTION public.enforce_gb_mot_acquisition() TO postgres;
GRANT ALL ON FUNCTION public.enforce_gb_mot_acquisition() TO service_role;


--
-- Name: FUNCTION enforce_gb_mot_online(); Type: ACL; Schema: public; Owner: -
--

REVOKE ALL ON FUNCTION public.enforce_gb_mot_online() FROM PUBLIC;
GRANT ALL ON FUNCTION public.enforce_gb_mot_online() TO postgres;
GRANT ALL ON FUNCTION public.enforce_gb_mot_online() TO service_role;


--
-- Name: FUNCTION enforce_job_acquisition_eligibility(); Type: ACL; Schema: public; Owner: -
--

REVOKE ALL ON FUNCTION public.enforce_job_acquisition_eligibility() FROM PUBLIC;


--
-- Name: FUNCTION enforce_job_payment_eligibility(); Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON FUNCTION public.enforce_job_payment_eligibility() TO anon;
GRANT ALL ON FUNCTION public.enforce_job_payment_eligibility() TO authenticated;
GRANT ALL ON FUNCTION public.enforce_job_payment_eligibility() TO service_role;


--
-- Name: FUNCTION enforce_profiles_ownership_guard(); Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON FUNCTION public.enforce_profiles_ownership_guard() TO anon;
GRANT ALL ON FUNCTION public.enforce_profiles_ownership_guard() TO authenticated;
GRANT ALL ON FUNCTION public.enforce_profiles_ownership_guard() TO service_role;


--
-- Name: FUNCTION enforce_registration_authority_guard(); Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON FUNCTION public.enforce_registration_authority_guard() TO anon;
GRANT ALL ON FUNCTION public.enforce_registration_authority_guard() TO authenticated;
GRANT ALL ON FUNCTION public.enforce_registration_authority_guard() TO service_role;


--
-- Name: FUNCTION enforce_ride_cash_credit_v1e(); Type: ACL; Schema: public; Owner: -
--

REVOKE ALL ON FUNCTION public.enforce_ride_cash_credit_v1e() FROM PUBLIC;
GRANT ALL ON FUNCTION public.enforce_ride_cash_credit_v1e() TO postgres;


--
-- Name: FUNCTION enforce_verified_driver_identity_guard(); Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON FUNCTION public.enforce_verified_driver_identity_guard() TO anon;
GRANT ALL ON FUNCTION public.enforce_verified_driver_identity_guard() TO authenticated;
GRANT ALL ON FUNCTION public.enforce_verified_driver_identity_guard() TO service_role;


--
-- Name: FUNCTION ensure_customer_wallet_v1h(p_user_id uuid); Type: ACL; Schema: public; Owner: -
--

REVOKE ALL ON FUNCTION public.ensure_customer_wallet_v1h(p_user_id uuid) FROM PUBLIC;
GRANT ALL ON FUNCTION public.ensure_customer_wallet_v1h(p_user_id uuid) TO postgres;
GRANT ALL ON FUNCTION public.ensure_customer_wallet_v1h(p_user_id uuid) TO service_role;


--
-- Name: FUNCTION expire_gb_mot_online(); Type: ACL; Schema: public; Owner: -
--

REVOKE ALL ON FUNCTION public.expire_gb_mot_online() FROM PUBLIC;
GRANT ALL ON FUNCTION public.expire_gb_mot_online() TO postgres;
GRANT ALL ON FUNCTION public.expire_gb_mot_online() TO service_role;


--
-- Name: FUNCTION expire_unpaid_fare_agreement(p_session_id uuid); Type: ACL; Schema: public; Owner: -
--

REVOKE ALL ON FUNCTION public.expire_unpaid_fare_agreement(p_session_id uuid) FROM PUBLIC;
GRANT ALL ON FUNCTION public.expire_unpaid_fare_agreement(p_session_id uuid) TO service_role;


--
-- Name: FUNCTION fence_driver_payment_setup(p_id uuid, p_token uuid, p_bank text, p_last4 text, p_fingerprint text); Type: ACL; Schema: public; Owner: -
--

REVOKE ALL ON FUNCTION public.fence_driver_payment_setup(p_id uuid, p_token uuid, p_bank text, p_last4 text, p_fingerprint text) FROM PUBLIC;
GRANT ALL ON FUNCTION public.fence_driver_payment_setup(p_id uuid, p_token uuid, p_bank text, p_last4 text, p_fingerprint text) TO postgres;
GRANT ALL ON FUNCTION public.fence_driver_payment_setup(p_id uuid, p_token uuid, p_bank text, p_last4 text, p_fingerprint text) TO service_role;


--
-- Name: FUNCTION fetch_hybrid_opportunities(p_driver_id uuid); Type: ACL; Schema: public; Owner: -
--

REVOKE ALL ON FUNCTION public.fetch_hybrid_opportunities(p_driver_id uuid) FROM PUBLIC;
GRANT ALL ON FUNCTION public.fetch_hybrid_opportunities(p_driver_id uuid) TO authenticated;
GRANT ALL ON FUNCTION public.fetch_hybrid_opportunities(p_driver_id uuid) TO service_role;


--
-- Name: FUNCTION finalize_agreed_fare_aliases(); Type: ACL; Schema: public; Owner: -
--

REVOKE ALL ON FUNCTION public.finalize_agreed_fare_aliases() FROM PUBLIC;
GRANT ALL ON FUNCTION public.finalize_agreed_fare_aliases() TO postgres;
GRANT ALL ON FUNCTION public.finalize_agreed_fare_aliases() TO service_role;


--
-- Name: FUNCTION finalize_job_no_show(p_job_id uuid, p_driver_id uuid, p_reason text, p_contact_attempted boolean); Type: ACL; Schema: public; Owner: -
--

REVOKE ALL ON FUNCTION public.finalize_job_no_show(p_job_id uuid, p_driver_id uuid, p_reason text, p_contact_attempted boolean) FROM PUBLIC;
GRANT ALL ON FUNCTION public.finalize_job_no_show(p_job_id uuid, p_driver_id uuid, p_reason text, p_contact_attempted boolean) TO postgres;
GRANT ALL ON FUNCTION public.finalize_job_no_show(p_job_id uuid, p_driver_id uuid, p_reason text, p_contact_attempted boolean) TO service_role;


--
-- Name: FUNCTION finalize_job_payment(p_job_id uuid, p_payment_intent_id text, p_payment_status text, p_job_status text, p_expected_service_fare numeric, p_require_unowned boolean, p_dispatch_started_at timestamp with time zone, p_driver_search_expires_at timestamp with time zone, p_dispatch_attempts integer, p_intent_amount_minor bigint, p_currency text); Type: ACL; Schema: public; Owner: -
--

REVOKE ALL ON FUNCTION public.finalize_job_payment(p_job_id uuid, p_payment_intent_id text, p_payment_status text, p_job_status text, p_expected_service_fare numeric, p_require_unowned boolean, p_dispatch_started_at timestamp with time zone, p_driver_search_expires_at timestamp with time zone, p_dispatch_attempts integer, p_intent_amount_minor bigint, p_currency text) FROM PUBLIC;
GRANT ALL ON FUNCTION public.finalize_job_payment(p_job_id uuid, p_payment_intent_id text, p_payment_status text, p_job_status text, p_expected_service_fare numeric, p_require_unowned boolean, p_dispatch_started_at timestamp with time zone, p_driver_search_expires_at timestamp with time zone, p_dispatch_attempts integer, p_intent_amount_minor bigint, p_currency text) TO service_role;


--
-- Name: FUNCTION finalize_wallet_topup(p_amount numeric, p_description text, p_payment_intent_id text, p_user_id uuid); Type: ACL; Schema: public; Owner: -
--

REVOKE ALL ON FUNCTION public.finalize_wallet_topup(p_amount numeric, p_description text, p_payment_intent_id text, p_user_id uuid) FROM PUBLIC;
GRANT ALL ON FUNCTION public.finalize_wallet_topup(p_amount numeric, p_description text, p_payment_intent_id text, p_user_id uuid) TO service_role;


--
-- Name: FUNCTION finalize_wallet_topup_legacy_incompatible(p_user_id uuid, p_amount numeric, p_payment_intent_id text, p_description text); Type: ACL; Schema: public; Owner: -
--

REVOKE ALL ON FUNCTION public.finalize_wallet_topup_legacy_incompatible(p_user_id uuid, p_amount numeric, p_payment_intent_id text, p_description text) FROM PUBLIC;


--
-- Name: FUNCTION finish_admin_message_email(p_entry bigint, p_token uuid, p_sent boolean, p_error text); Type: ACL; Schema: public; Owner: -
--

REVOKE ALL ON FUNCTION public.finish_admin_message_email(p_entry bigint, p_token uuid, p_sent boolean, p_error text) FROM PUBLIC;
GRANT ALL ON FUNCTION public.finish_admin_message_email(p_entry bigint, p_token uuid, p_sent boolean, p_error text) TO postgres;
GRANT ALL ON FUNCTION public.finish_admin_message_email(p_entry bigint, p_token uuid, p_sent boolean, p_error text) TO service_role;


--
-- Name: FUNCTION finish_kora_sandbox_booking_checkout(p_job uuid, p_user uuid, p_account text, p_state text, p_url text); Type: ACL; Schema: public; Owner: -
--

REVOKE ALL ON FUNCTION public.finish_kora_sandbox_booking_checkout(p_job uuid, p_user uuid, p_account text, p_state text, p_url text) FROM PUBLIC;
GRANT ALL ON FUNCTION public.finish_kora_sandbox_booking_checkout(p_job uuid, p_user uuid, p_account text, p_state text, p_url text) TO postgres;
GRANT ALL ON FUNCTION public.finish_kora_sandbox_booking_checkout(p_job uuid, p_user uuid, p_account text, p_state text, p_url text) TO service_role;


--
-- Name: FUNCTION finish_kora_sandbox_booking_refund(p_job uuid, p_user uuid, p_account text, p_state text); Type: ACL; Schema: public; Owner: -
--

REVOKE ALL ON FUNCTION public.finish_kora_sandbox_booking_refund(p_job uuid, p_user uuid, p_account text, p_state text) FROM PUBLIC;
GRANT ALL ON FUNCTION public.finish_kora_sandbox_booking_refund(p_job uuid, p_user uuid, p_account text, p_state text) TO postgres;
GRANT ALL ON FUNCTION public.finish_kora_sandbox_booking_refund(p_job uuid, p_user uuid, p_account text, p_state text) TO service_role;


--
-- Name: FUNCTION finish_queued_job_payout(p_job_id uuid, p_token uuid, p_transfer_id text); Type: ACL; Schema: public; Owner: -
--

REVOKE ALL ON FUNCTION public.finish_queued_job_payout(p_job_id uuid, p_token uuid, p_transfer_id text) FROM PUBLIC;
GRANT ALL ON FUNCTION public.finish_queued_job_payout(p_job_id uuid, p_token uuid, p_transfer_id text) TO postgres;
GRANT ALL ON FUNCTION public.finish_queued_job_payout(p_job_id uuid, p_token uuid, p_transfer_id text) TO service_role;


--
-- Name: FUNCTION freeze_driver_payment_submission(); Type: ACL; Schema: public; Owner: -
--

REVOKE ALL ON FUNCTION public.freeze_driver_payment_submission() FROM PUBLIC;
GRANT ALL ON FUNCTION public.freeze_driver_payment_submission() TO postgres;


--
-- Name: FUNCTION freeze_subscription_driver_commission(); Type: ACL; Schema: public; Owner: -
--

REVOKE ALL ON FUNCTION public.freeze_subscription_driver_commission() FROM PUBLIC;
GRANT ALL ON FUNCTION public.freeze_subscription_driver_commission() TO postgres;
GRANT ALL ON FUNCTION public.freeze_subscription_driver_commission() TO service_role;


--
-- Name: FUNCTION gb_driver_mot_blocked(p_driver uuid); Type: ACL; Schema: public; Owner: -
--

REVOKE ALL ON FUNCTION public.gb_driver_mot_blocked(p_driver uuid) FROM PUBLIC;
GRANT ALL ON FUNCTION public.gb_driver_mot_blocked(p_driver uuid) TO postgres;
GRANT ALL ON FUNCTION public.gb_driver_mot_blocked(p_driver uuid) TO service_role;


--
-- Name: FUNCTION get_customer_wallet_sandbox_v1l(p_owner uuid, p_id uuid); Type: ACL; Schema: public; Owner: -
--

REVOKE ALL ON FUNCTION public.get_customer_wallet_sandbox_v1l(p_owner uuid, p_id uuid) FROM PUBLIC;
GRANT ALL ON FUNCTION public.get_customer_wallet_sandbox_v1l(p_owner uuid, p_id uuid) TO postgres;
GRANT ALL ON FUNCTION public.get_customer_wallet_sandbox_v1l(p_owner uuid, p_id uuid) TO service_role;


--
-- Name: FUNCTION get_least_recently_assigned_driver(p_city_id uuid, p_tenant_id uuid); Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON FUNCTION public.get_least_recently_assigned_driver(p_city_id uuid, p_tenant_id uuid) TO anon;
GRANT ALL ON FUNCTION public.get_least_recently_assigned_driver(p_city_id uuid, p_tenant_id uuid) TO authenticated;
GRANT ALL ON FUNCTION public.get_least_recently_assigned_driver(p_city_id uuid, p_tenant_id uuid) TO service_role;


--
-- Name: FUNCTION get_marketplace_commission(p_service_type_slug text, p_city_zone text, p_driver_tier text, p_tenant_id uuid); Type: ACL; Schema: public; Owner: -
--

REVOKE ALL ON FUNCTION public.get_marketplace_commission(p_service_type_slug text, p_city_zone text, p_driver_tier text, p_tenant_id uuid) FROM PUBLIC;
GRANT ALL ON FUNCTION public.get_marketplace_commission(p_service_type_slug text, p_city_zone text, p_driver_tier text, p_tenant_id uuid) TO service_role;


--
-- Name: FUNCTION get_marketplace_setting(p_key text, p_tenant_id uuid); Type: ACL; Schema: public; Owner: -
--

REVOKE ALL ON FUNCTION public.get_marketplace_setting(p_key text, p_tenant_id uuid) FROM PUBLIC;
GRANT ALL ON FUNCTION public.get_marketplace_setting(p_key text, p_tenant_id uuid) TO service_role;


--
-- Name: FUNCTION get_my_tenant_id(); Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON FUNCTION public.get_my_tenant_id() TO anon;
GRANT ALL ON FUNCTION public.get_my_tenant_id() TO authenticated;
GRANT ALL ON FUNCTION public.get_my_tenant_id() TO service_role;


--
-- Name: FUNCTION guard_booking_payment_margin(); Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON FUNCTION public.guard_booking_payment_margin() TO postgres;
GRANT ALL ON FUNCTION public.guard_booking_payment_margin() TO anon;
GRANT ALL ON FUNCTION public.guard_booking_payment_margin() TO authenticated;
GRANT ALL ON FUNCTION public.guard_booking_payment_margin() TO service_role;


--
-- Name: FUNCTION guard_cash_credit_hold_v1e(); Type: ACL; Schema: public; Owner: -
--

REVOKE ALL ON FUNCTION public.guard_cash_credit_hold_v1e() FROM PUBLIC;
GRANT ALL ON FUNCTION public.guard_cash_credit_hold_v1e() TO postgres;


--
-- Name: FUNCTION guard_customer_wallet_market_v1h(); Type: ACL; Schema: public; Owner: -
--

REVOKE ALL ON FUNCTION public.guard_customer_wallet_market_v1h() FROM PUBLIC;
GRANT ALL ON FUNCTION public.guard_customer_wallet_market_v1h() TO postgres;


--
-- Name: FUNCTION guard_driver_payment_account_identity(); Type: ACL; Schema: public; Owner: -
--

REVOKE ALL ON FUNCTION public.guard_driver_payment_account_identity() FROM PUBLIC;
GRANT ALL ON FUNCTION public.guard_driver_payment_account_identity() TO postgres;


--
-- Name: FUNCTION guard_errand_budget_payment_margin(); Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON FUNCTION public.guard_errand_budget_payment_margin() TO postgres;
GRANT ALL ON FUNCTION public.guard_errand_budget_payment_margin() TO anon;
GRANT ALL ON FUNCTION public.guard_errand_budget_payment_margin() TO authenticated;
GRANT ALL ON FUNCTION public.guard_errand_budget_payment_margin() TO service_role;


--
-- Name: FUNCTION guard_market_payment_route_v23(); Type: ACL; Schema: public; Owner: -
--

REVOKE ALL ON FUNCTION public.guard_market_payment_route_v23() FROM PUBLIC;
GRANT ALL ON FUNCTION public.guard_market_payment_route_v23() TO postgres;


--
-- Name: FUNCTION guard_refund_pending_payout(); Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON FUNCTION public.guard_refund_pending_payout() TO postgres;
GRANT ALL ON FUNCTION public.guard_refund_pending_payout() TO anon;
GRANT ALL ON FUNCTION public.guard_refund_pending_payout() TO authenticated;
GRANT ALL ON FUNCTION public.guard_refund_pending_payout() TO service_role;


--
-- Name: FUNCTION handle_new_user(); Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON FUNCTION public.handle_new_user() TO anon;
GRANT ALL ON FUNCTION public.handle_new_user() TO authenticated;
GRANT ALL ON FUNCTION public.handle_new_user() TO service_role;


--
-- Name: FUNCTION initiate_wallet_topup(p_attempt_key text, p_tenant_id uuid, p_owner_id uuid, p_country_code text, p_currency_code text, p_amount_minor bigint, p_destination_account_purpose text, p_payment_provider text, p_merchant_account_ref text, p_provider_idempotency_identity text); Type: ACL; Schema: public; Owner: -
--

REVOKE ALL ON FUNCTION public.initiate_wallet_topup(p_attempt_key text, p_tenant_id uuid, p_owner_id uuid, p_country_code text, p_currency_code text, p_amount_minor bigint, p_destination_account_purpose text, p_payment_provider text, p_merchant_account_ref text, p_provider_idempotency_identity text) FROM PUBLIC;
GRANT ALL ON FUNCTION public.initiate_wallet_topup(p_attempt_key text, p_tenant_id uuid, p_owner_id uuid, p_country_code text, p_currency_code text, p_amount_minor bigint, p_destination_account_purpose text, p_payment_provider text, p_merchant_account_ref text, p_provider_idempotency_identity text) TO postgres;
GRANT ALL ON FUNCTION public.initiate_wallet_topup(p_attempt_key text, p_tenant_id uuid, p_owner_id uuid, p_country_code text, p_currency_code text, p_amount_minor bigint, p_destination_account_purpose text, p_payment_provider text, p_merchant_account_ref text, p_provider_idempotency_identity text) TO service_role;


--
-- Name: FUNCTION is_admin_user(); Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON FUNCTION public.is_admin_user() TO anon;
GRANT ALL ON FUNCTION public.is_admin_user() TO authenticated;
GRANT ALL ON FUNCTION public.is_admin_user() TO service_role;


--
-- Name: FUNCTION is_tenant_admin(); Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON FUNCTION public.is_tenant_admin() TO anon;
GRANT ALL ON FUNCTION public.is_tenant_admin() TO authenticated;
GRANT ALL ON FUNCTION public.is_tenant_admin() TO service_role;


--
-- Name: FUNCTION job_canonical_service(p_job_id uuid); Type: ACL; Schema: public; Owner: -
--

REVOKE ALL ON FUNCTION public.job_canonical_service(p_job_id uuid) FROM PUBLIC;


--
-- Name: FUNCTION job_chat_is_current_participant(p_job_id uuid); Type: ACL; Schema: public; Owner: -
--

REVOKE ALL ON FUNCTION public.job_chat_is_current_participant(p_job_id uuid) FROM PUBLIC;
GRANT ALL ON FUNCTION public.job_chat_is_current_participant(p_job_id uuid) TO postgres;
GRANT ALL ON FUNCTION public.job_chat_is_current_participant(p_job_id uuid) TO authenticated;
GRANT ALL ON FUNCTION public.job_chat_is_current_participant(p_job_id uuid) TO service_role;


--
-- Name: FUNCTION journey_fare_pilot_v23(p_actor uuid, p_job_id uuid, p_stop_id uuid, p_action text, p_source_digest text, p_calculation jsonb, p_proposal_id uuid, p_note text); Type: ACL; Schema: public; Owner: -
--

REVOKE ALL ON FUNCTION public.journey_fare_pilot_v23(p_actor uuid, p_job_id uuid, p_stop_id uuid, p_action text, p_source_digest text, p_calculation jsonb, p_proposal_id uuid, p_note text) FROM PUBLIC;
GRANT ALL ON FUNCTION public.journey_fare_pilot_v23(p_actor uuid, p_job_id uuid, p_stop_id uuid, p_action text, p_source_digest text, p_calculation jsonb, p_proposal_id uuid, p_note text) TO postgres;
GRANT ALL ON FUNCTION public.journey_fare_pilot_v23(p_actor uuid, p_job_id uuid, p_stop_id uuid, p_action text, p_source_digest text, p_calculation jsonb, p_proposal_id uuid, p_note text) TO service_role;


--
-- Name: FUNCTION journey_stop_pilot_v23(p_actor uuid, p_job_id uuid, p_action text, p_request_id uuid, p_reason text, p_note text); Type: ACL; Schema: public; Owner: -
--

REVOKE ALL ON FUNCTION public.journey_stop_pilot_v23(p_actor uuid, p_job_id uuid, p_action text, p_request_id uuid, p_reason text, p_note text) FROM PUBLIC;
GRANT ALL ON FUNCTION public.journey_stop_pilot_v23(p_actor uuid, p_job_id uuid, p_action text, p_request_id uuid, p_reason text, p_note text) TO postgres;
GRANT ALL ON FUNCTION public.journey_stop_pilot_v23(p_actor uuid, p_job_id uuid, p_action text, p_request_id uuid, p_reason text, p_note text) TO service_role;


--
-- Name: FUNCTION kora_sandbox_booking_snapshot(p_job uuid); Type: ACL; Schema: public; Owner: -
--

REVOKE ALL ON FUNCTION public.kora_sandbox_booking_snapshot(p_job uuid) FROM PUBLIC;
GRANT ALL ON FUNCTION public.kora_sandbox_booking_snapshot(p_job uuid) TO postgres;
GRANT ALL ON FUNCTION public.kora_sandbox_booking_snapshot(p_job uuid) TO service_role;


--
-- Name: FUNCTION lock_marketplace_fare(p_job_id uuid, p_driver_id uuid, p_amount numeric); Type: ACL; Schema: public; Owner: -
--

REVOKE ALL ON FUNCTION public.lock_marketplace_fare(p_job_id uuid, p_driver_id uuid, p_amount numeric) FROM PUBLIC;
GRANT ALL ON FUNCTION public.lock_marketplace_fare(p_job_id uuid, p_driver_id uuid, p_amount numeric) TO authenticated;
GRANT ALL ON FUNCTION public.lock_marketplace_fare(p_job_id uuid, p_driver_id uuid, p_amount numeric) TO service_role;


--
-- Name: FUNCTION lookup_customer_wallet_sandbox_v1l(p_reference text); Type: ACL; Schema: public; Owner: -
--

REVOKE ALL ON FUNCTION public.lookup_customer_wallet_sandbox_v1l(p_reference text) FROM PUBLIC;
GRANT ALL ON FUNCTION public.lookup_customer_wallet_sandbox_v1l(p_reference text) TO postgres;
GRANT ALL ON FUNCTION public.lookup_customer_wallet_sandbox_v1l(p_reference text) TO service_role;


--
-- Name: FUNCTION mark_enrolled_ride_start_v23(); Type: ACL; Schema: public; Owner: -
--

REVOKE ALL ON FUNCTION public.mark_enrolled_ride_start_v23() FROM PUBLIC;
GRANT ALL ON FUNCTION public.mark_enrolled_ride_start_v23() TO postgres;


--
-- Name: FUNCTION mark_job_arrived(p_job_id uuid, p_driver_id uuid, p_grace_minutes integer); Type: ACL; Schema: public; Owner: -
--

REVOKE ALL ON FUNCTION public.mark_job_arrived(p_job_id uuid, p_driver_id uuid, p_grace_minutes integer) FROM PUBLIC;
GRANT ALL ON FUNCTION public.mark_job_arrived(p_job_id uuid, p_driver_id uuid, p_grace_minutes integer) TO postgres;
GRANT ALL ON FUNCTION public.mark_job_arrived(p_job_id uuid, p_driver_id uuid, p_grace_minutes integer) TO service_role;


--
-- Name: TABLE refund_operations; Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON TABLE public.refund_operations TO postgres;
GRANT ALL ON TABLE public.refund_operations TO anon;
GRANT ALL ON TABLE public.refund_operations TO authenticated;
GRANT ALL ON TABLE public.refund_operations TO service_role;


--
-- Name: FUNCTION mark_refund_operation(p_operation_id uuid, p_provider_id text, p_status text, p_error text); Type: ACL; Schema: public; Owner: -
--

REVOKE ALL ON FUNCTION public.mark_refund_operation(p_operation_id uuid, p_provider_id text, p_status text, p_error text) FROM PUBLIC;
GRANT ALL ON FUNCTION public.mark_refund_operation(p_operation_id uuid, p_provider_id text, p_status text, p_error text) TO postgres;
GRANT ALL ON FUNCTION public.mark_refund_operation(p_operation_id uuid, p_provider_id text, p_status text, p_error text) TO service_role;


--
-- Name: FUNCTION mark_reversal_operation(p_operation_id uuid, p_provider_id text, p_status text, p_error text); Type: ACL; Schema: public; Owner: -
--

REVOKE ALL ON FUNCTION public.mark_reversal_operation(p_operation_id uuid, p_provider_id text, p_status text, p_error text) FROM PUBLIC;
GRANT ALL ON FUNCTION public.mark_reversal_operation(p_operation_id uuid, p_provider_id text, p_status text, p_error text) TO postgres;
GRANT ALL ON FUNCTION public.mark_reversal_operation(p_operation_id uuid, p_provider_id text, p_status text, p_error text) TO service_role;


--
-- Name: FUNCTION mark_wallet_topup_failed(p_attempt_id uuid, p_reason text); Type: ACL; Schema: public; Owner: -
--

REVOKE ALL ON FUNCTION public.mark_wallet_topup_failed(p_attempt_id uuid, p_reason text) FROM PUBLIC;
GRANT ALL ON FUNCTION public.mark_wallet_topup_failed(p_attempt_id uuid, p_reason text) TO postgres;
GRANT ALL ON FUNCTION public.mark_wallet_topup_failed(p_attempt_id uuid, p_reason text) TO service_role;


--
-- Name: FUNCTION mark_wallet_topup_refunded(p_attempt_id uuid, p_evidence_reference text, p_verified_provider_reference text, p_verified_merchant_account_ref text, p_verified_currency text, p_verified_amount_minor bigint, p_final_status text, p_reason text); Type: ACL; Schema: public; Owner: -
--

REVOKE ALL ON FUNCTION public.mark_wallet_topup_refunded(p_attempt_id uuid, p_evidence_reference text, p_verified_provider_reference text, p_verified_merchant_account_ref text, p_verified_currency text, p_verified_amount_minor bigint, p_final_status text, p_reason text) FROM PUBLIC;
GRANT ALL ON FUNCTION public.mark_wallet_topup_refunded(p_attempt_id uuid, p_evidence_reference text, p_verified_provider_reference text, p_verified_merchant_account_ref text, p_verified_currency text, p_verified_amount_minor bigint, p_final_status text, p_reason text) TO postgres;
GRANT ALL ON FUNCTION public.mark_wallet_topup_refunded(p_attempt_id uuid, p_evidence_reference text, p_verified_provider_reference text, p_verified_merchant_account_ref text, p_verified_currency text, p_verified_amount_minor bigint, p_final_status text, p_reason text) TO service_role;


--
-- Name: FUNCTION mark_wallet_topup_uncertain(p_attempt_id uuid, p_reason text); Type: ACL; Schema: public; Owner: -
--

REVOKE ALL ON FUNCTION public.mark_wallet_topup_uncertain(p_attempt_id uuid, p_reason text) FROM PUBLIC;
GRANT ALL ON FUNCTION public.mark_wallet_topup_uncertain(p_attempt_id uuid, p_reason text) TO postgres;
GRANT ALL ON FUNCTION public.mark_wallet_topup_uncertain(p_attempt_id uuid, p_reason text) TO service_role;


--
-- Name: FUNCTION negotiation_lease_expiry(p_job_id uuid, p_seconds integer); Type: ACL; Schema: public; Owner: -
--

REVOKE ALL ON FUNCTION public.negotiation_lease_expiry(p_job_id uuid, p_seconds integer) FROM PUBLIC;
GRANT ALL ON FUNCTION public.negotiation_lease_expiry(p_job_id uuid, p_seconds integer) TO service_role;


--
-- Name: FUNCTION negotiation_live_proposal_role(p_session_id uuid); Type: ACL; Schema: public; Owner: -
--

REVOKE ALL ON FUNCTION public.negotiation_live_proposal_role(p_session_id uuid) FROM PUBLIC;
GRANT ALL ON FUNCTION public.negotiation_live_proposal_role(p_session_id uuid) TO authenticated;
GRANT ALL ON FUNCTION public.negotiation_live_proposal_role(p_session_id uuid) TO service_role;


--
-- Name: FUNCTION notify_admins_account_closure_requested(); Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON FUNCTION public.notify_admins_account_closure_requested() TO anon;
GRANT ALL ON FUNCTION public.notify_admins_account_closure_requested() TO authenticated;
GRANT ALL ON FUNCTION public.notify_admins_account_closure_requested() TO service_role;


--
-- Name: FUNCTION on_errand_funding_change(); Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON FUNCTION public.on_errand_funding_change() TO anon;
GRANT ALL ON FUNCTION public.on_errand_funding_change() TO authenticated;
GRANT ALL ON FUNCTION public.on_errand_funding_change() TO service_role;


--
-- Name: FUNCTION on_errand_spending_update(); Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON FUNCTION public.on_errand_spending_update() TO anon;
GRANT ALL ON FUNCTION public.on_errand_spending_update() TO authenticated;
GRANT ALL ON FUNCTION public.on_errand_spending_update() TO service_role;


--
-- Name: FUNCTION on_new_job_message(); Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON FUNCTION public.on_new_job_message() TO anon;
GRANT ALL ON FUNCTION public.on_new_job_message() TO authenticated;
GRANT ALL ON FUNCTION public.on_new_job_message() TO service_role;


--
-- Name: FUNCTION pay_job_from_wallet(p_job_id uuid, p_customer_id uuid, p_amount numeric, p_currency_code text, p_tenant_id uuid); Type: ACL; Schema: public; Owner: -
--

REVOKE ALL ON FUNCTION public.pay_job_from_wallet(p_job_id uuid, p_customer_id uuid, p_amount numeric, p_currency_code text, p_tenant_id uuid) FROM PUBLIC;
GRANT ALL ON FUNCTION public.pay_job_from_wallet(p_job_id uuid, p_customer_id uuid, p_amount numeric, p_currency_code text, p_tenant_id uuid) TO service_role;


--
-- Name: FUNCTION post_wallet_event(p_event_key text, p_operation text, p_tenant_id uuid, p_owner_id uuid, p_currency_code text, p_entries jsonb, p_payment_provider text, p_merchant_account_ref text, p_provider_reference text, p_reverses_event_id uuid); Type: ACL; Schema: public; Owner: -
--

REVOKE ALL ON FUNCTION public.post_wallet_event(p_event_key text, p_operation text, p_tenant_id uuid, p_owner_id uuid, p_currency_code text, p_entries jsonb, p_payment_provider text, p_merchant_account_ref text, p_provider_reference text, p_reverses_event_id uuid) FROM PUBLIC;
GRANT ALL ON FUNCTION public.post_wallet_event(p_event_key text, p_operation text, p_tenant_id uuid, p_owner_id uuid, p_currency_code text, p_entries jsonb, p_payment_provider text, p_merchant_account_ref text, p_provider_reference text, p_reverses_event_id uuid) TO postgres;
GRANT ALL ON FUNCTION public.post_wallet_event(p_event_key text, p_operation text, p_tenant_id uuid, p_owner_id uuid, p_currency_code text, p_entries jsonb, p_payment_provider text, p_merchant_account_ref text, p_provider_reference text, p_reverses_event_id uuid) TO service_role;


--
-- Name: FUNCTION post_wallet_reversal(p_original_event_key text, p_event_key text); Type: ACL; Schema: public; Owner: -
--

REVOKE ALL ON FUNCTION public.post_wallet_reversal(p_original_event_key text, p_event_key text) FROM PUBLIC;
GRANT ALL ON FUNCTION public.post_wallet_reversal(p_original_event_key text, p_event_key text) TO postgres;
GRANT ALL ON FUNCTION public.post_wallet_reversal(p_original_event_key text, p_event_key text) TO service_role;


--
-- Name: FUNCTION prepare_customer_wallet_sandbox_v1l(p_owner uuid, p_key uuid, p_amount bigint, p_merchant text, p_fingerprint text); Type: ACL; Schema: public; Owner: -
--

REVOKE ALL ON FUNCTION public.prepare_customer_wallet_sandbox_v1l(p_owner uuid, p_key uuid, p_amount bigint, p_merchant text, p_fingerprint text) FROM PUBLIC;
GRANT ALL ON FUNCTION public.prepare_customer_wallet_sandbox_v1l(p_owner uuid, p_key uuid, p_amount bigint, p_merchant text, p_fingerprint text) TO postgres;
GRANT ALL ON FUNCTION public.prepare_customer_wallet_sandbox_v1l(p_owner uuid, p_key uuid, p_amount bigint, p_merchant text, p_fingerprint text) TO service_role;


--
-- Name: FUNCTION process_payout_batch(); Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON FUNCTION public.process_payout_batch() TO anon;
GRANT ALL ON FUNCTION public.process_payout_batch() TO authenticated;
GRANT ALL ON FUNCTION public.process_payout_batch() TO service_role;


--
-- Name: FUNCTION protect_driver_operating_market_v23(); Type: ACL; Schema: public; Owner: -
--

REVOKE ALL ON FUNCTION public.protect_driver_operating_market_v23() FROM PUBLIC;
GRANT ALL ON FUNCTION public.protect_driver_operating_market_v23() TO postgres;
GRANT ALL ON FUNCTION public.protect_driver_operating_market_v23() TO anon;
GRANT ALL ON FUNCTION public.protect_driver_operating_market_v23() TO authenticated;
GRANT ALL ON FUNCTION public.protect_driver_operating_market_v23() TO service_role;


--
-- Name: FUNCTION queue_admin_message_notification(); Type: ACL; Schema: public; Owner: -
--

REVOKE ALL ON FUNCTION public.queue_admin_message_notification() FROM PUBLIC;
GRANT ALL ON FUNCTION public.queue_admin_message_notification() TO postgres;
GRANT ALL ON FUNCTION public.queue_admin_message_notification() TO service_role;


--
-- Name: FUNCTION recommended_country_payment_provider_v23(p_country text, p_currency text); Type: ACL; Schema: public; Owner: -
--

REVOKE ALL ON FUNCTION public.recommended_country_payment_provider_v23(p_country text, p_currency text) FROM PUBLIC;
GRANT ALL ON FUNCTION public.recommended_country_payment_provider_v23(p_country text, p_currency text) TO postgres;


--
-- Name: FUNCTION reconcile_wallet_topup(p_attempt_id uuid, p_evidence_key text); Type: ACL; Schema: public; Owner: -
--

REVOKE ALL ON FUNCTION public.reconcile_wallet_topup(p_attempt_id uuid, p_evidence_key text) FROM PUBLIC;
GRANT ALL ON FUNCTION public.reconcile_wallet_topup(p_attempt_id uuid, p_evidence_key text) TO postgres;
GRANT ALL ON FUNCTION public.reconcile_wallet_topup(p_attempt_id uuid, p_evidence_key text) TO service_role;


--
-- Name: FUNCTION record_customer_wallet_sandbox_v1l(p_owner uuid, p_id uuid, p_fingerprint text, p_status text, p_reference text, p_currency text, p_amount bigint, p_checkout text); Type: ACL; Schema: public; Owner: -
--

REVOKE ALL ON FUNCTION public.record_customer_wallet_sandbox_v1l(p_owner uuid, p_id uuid, p_fingerprint text, p_status text, p_reference text, p_currency text, p_amount bigint, p_checkout text) FROM PUBLIC;
GRANT ALL ON FUNCTION public.record_customer_wallet_sandbox_v1l(p_owner uuid, p_id uuid, p_fingerprint text, p_status text, p_reference text, p_currency text, p_amount bigint, p_checkout text) TO postgres;
GRANT ALL ON FUNCTION public.record_customer_wallet_sandbox_v1l(p_owner uuid, p_id uuid, p_fingerprint text, p_status text, p_reference text, p_currency text, p_amount bigint, p_checkout text) TO service_role;


--
-- Name: FUNCTION record_gb_vehicle_mot(p_vehicle_id uuid, p_registration text, p_status text, p_expiry date, p_checked_at timestamp with time zone); Type: ACL; Schema: public; Owner: -
--

REVOKE ALL ON FUNCTION public.record_gb_vehicle_mot(p_vehicle_id uuid, p_registration text, p_status text, p_expiry date, p_checked_at timestamp with time zone) FROM PUBLIC;
GRANT ALL ON FUNCTION public.record_gb_vehicle_mot(p_vehicle_id uuid, p_registration text, p_status text, p_expiry date, p_checked_at timestamp with time zone) TO postgres;
GRANT ALL ON FUNCTION public.record_gb_vehicle_mot(p_vehicle_id uuid, p_registration text, p_status text, p_expiry date, p_checked_at timestamp with time zone) TO service_role;


--
-- Name: FUNCTION record_issuing_authorization_request(p_card text, p_authorization text, p_amount numeric, p_currency text, p_event jsonb); Type: ACL; Schema: public; Owner: -
--

REVOKE ALL ON FUNCTION public.record_issuing_authorization_request(p_card text, p_authorization text, p_amount numeric, p_currency text, p_event jsonb) FROM PUBLIC;
GRANT ALL ON FUNCTION public.record_issuing_authorization_request(p_card text, p_authorization text, p_amount numeric, p_currency text, p_event jsonb) TO postgres;
GRANT ALL ON FUNCTION public.record_issuing_authorization_request(p_card text, p_authorization text, p_amount numeric, p_currency text, p_event jsonb) TO service_role;


--
-- Name: FUNCTION record_issuing_transaction(p_id text, p_authorization text, p_card text, p_amount numeric, p_currency text, p_type text, p_event jsonb); Type: ACL; Schema: public; Owner: -
--

REVOKE ALL ON FUNCTION public.record_issuing_transaction(p_id text, p_authorization text, p_card text, p_amount numeric, p_currency text, p_type text, p_event jsonb) FROM PUBLIC;
GRANT ALL ON FUNCTION public.record_issuing_transaction(p_id text, p_authorization text, p_card text, p_amount numeric, p_currency text, p_type text, p_event jsonb) TO postgres;
GRANT ALL ON FUNCTION public.record_issuing_transaction(p_id text, p_authorization text, p_card text, p_amount numeric, p_currency text, p_type text, p_event jsonb) TO service_role;


--
-- Name: FUNCTION record_job_settlement(p_job_id uuid, p_driver_id uuid, p_total_price numeric, p_driver_payout numeric, p_platform_fee numeric, p_commission_fee numeric, p_commission_rate numeric, p_stripe_transfer_id text, p_currency_code text, p_country_code text, p_was_already_completed boolean); Type: ACL; Schema: public; Owner: -
--

REVOKE ALL ON FUNCTION public.record_job_settlement(p_job_id uuid, p_driver_id uuid, p_total_price numeric, p_driver_payout numeric, p_platform_fee numeric, p_commission_fee numeric, p_commission_rate numeric, p_stripe_transfer_id text, p_currency_code text, p_country_code text, p_was_already_completed boolean) FROM PUBLIC;
GRANT ALL ON FUNCTION public.record_job_settlement(p_job_id uuid, p_driver_id uuid, p_total_price numeric, p_driver_payout numeric, p_platform_fee numeric, p_commission_fee numeric, p_commission_rate numeric, p_stripe_transfer_id text, p_currency_code text, p_country_code text, p_was_already_completed boolean) TO postgres;
GRANT ALL ON FUNCTION public.record_job_settlement(p_job_id uuid, p_driver_id uuid, p_total_price numeric, p_driver_payout numeric, p_platform_fee numeric, p_commission_fee numeric, p_commission_rate numeric, p_stripe_transfer_id text, p_currency_code text, p_country_code text, p_was_already_completed boolean) TO service_role;


--
-- Name: FUNCTION record_no_show_settlement(p_job_id uuid, p_driver_id uuid, p_amount_minor bigint, p_platform_share_minor bigint, p_fee_minor bigint, p_currency text, p_stripe_transfer_id text); Type: ACL; Schema: public; Owner: -
--

REVOKE ALL ON FUNCTION public.record_no_show_settlement(p_job_id uuid, p_driver_id uuid, p_amount_minor bigint, p_platform_share_minor bigint, p_fee_minor bigint, p_currency text, p_stripe_transfer_id text) FROM PUBLIC;
GRANT ALL ON FUNCTION public.record_no_show_settlement(p_job_id uuid, p_driver_id uuid, p_amount_minor bigint, p_platform_share_minor bigint, p_fee_minor bigint, p_currency text, p_stripe_transfer_id text) TO postgres;
GRANT ALL ON FUNCTION public.record_no_show_settlement(p_job_id uuid, p_driver_id uuid, p_amount_minor bigint, p_platform_share_minor bigint, p_fee_minor bigint, p_currency text, p_stripe_transfer_id text) TO service_role;


--
-- Name: FUNCTION record_wallet_topup_provider_reference(p_attempt_id uuid, p_provider_reference text); Type: ACL; Schema: public; Owner: -
--

REVOKE ALL ON FUNCTION public.record_wallet_topup_provider_reference(p_attempt_id uuid, p_provider_reference text) FROM PUBLIC;
GRANT ALL ON FUNCTION public.record_wallet_topup_provider_reference(p_attempt_id uuid, p_provider_reference text) TO postgres;
GRANT ALL ON FUNCTION public.record_wallet_topup_provider_reference(p_attempt_id uuid, p_provider_reference text) TO service_role;


--
-- Name: FUNCTION record_wallet_topup_verification(p_attempt_id uuid, p_evidence_key text, p_provider_reference text, p_merchant_account_ref text, p_currency_code text, p_amount_minor bigint, p_final_status text); Type: ACL; Schema: public; Owner: -
--

REVOKE ALL ON FUNCTION public.record_wallet_topup_verification(p_attempt_id uuid, p_evidence_key text, p_provider_reference text, p_merchant_account_ref text, p_currency_code text, p_amount_minor bigint, p_final_status text) FROM PUBLIC;
GRANT ALL ON FUNCTION public.record_wallet_topup_verification(p_attempt_id uuid, p_evidence_key text, p_provider_reference text, p_merchant_account_ref text, p_currency_code text, p_amount_minor bigint, p_final_status text) TO postgres;
GRANT ALL ON FUNCTION public.record_wallet_topup_verification(p_attempt_id uuid, p_evidence_key text, p_provider_reference text, p_merchant_account_ref text, p_currency_code text, p_amount_minor bigint, p_final_status text) TO service_role;


--
-- Name: FUNCTION reject_errand_over_budget(p_job_id uuid); Type: ACL; Schema: public; Owner: -
--

REVOKE ALL ON FUNCTION public.reject_errand_over_budget(p_job_id uuid) FROM PUBLIC;
GRANT ALL ON FUNCTION public.reject_errand_over_budget(p_job_id uuid) TO authenticated;
GRANT ALL ON FUNCTION public.reject_errand_over_budget(p_job_id uuid) TO service_role;


--
-- Name: FUNCTION release_job_refund(p_job_id uuid, p_amount_minor bigint); Type: ACL; Schema: public; Owner: -
--

REVOKE ALL ON FUNCTION public.release_job_refund(p_job_id uuid, p_amount_minor bigint) FROM PUBLIC;
GRANT ALL ON FUNCTION public.release_job_refund(p_job_id uuid, p_amount_minor bigint) TO postgres;
GRANT ALL ON FUNCTION public.release_job_refund(p_job_id uuid, p_amount_minor bigint) TO service_role;


--
-- Name: FUNCTION release_job_reversal(p_job_id uuid, p_amount_minor bigint); Type: ACL; Schema: public; Owner: -
--

REVOKE ALL ON FUNCTION public.release_job_reversal(p_job_id uuid, p_amount_minor bigint) FROM PUBLIC;
GRANT ALL ON FUNCTION public.release_job_reversal(p_job_id uuid, p_amount_minor bigint) TO postgres;
GRANT ALL ON FUNCTION public.release_job_reversal(p_job_id uuid, p_amount_minor bigint) TO service_role;


--
-- Name: FUNCTION release_job_wallet_reservation(p_job_id uuid, p_reason text); Type: ACL; Schema: public; Owner: -
--

REVOKE ALL ON FUNCTION public.release_job_wallet_reservation(p_job_id uuid, p_reason text) FROM PUBLIC;
GRANT ALL ON FUNCTION public.release_job_wallet_reservation(p_job_id uuid, p_reason text) TO service_role;


--
-- Name: FUNCTION release_marketplace_negotiation(p_job_id uuid, p_driver_id uuid, p_reason text); Type: ACL; Schema: public; Owner: -
--

REVOKE ALL ON FUNCTION public.release_marketplace_negotiation(p_job_id uuid, p_driver_id uuid, p_reason text) FROM PUBLIC;
GRANT ALL ON FUNCTION public.release_marketplace_negotiation(p_job_id uuid, p_driver_id uuid, p_reason text) TO authenticated;
GRANT ALL ON FUNCTION public.release_marketplace_negotiation(p_job_id uuid, p_driver_id uuid, p_reason text) TO service_role;


--
-- Name: FUNCTION release_refund_operation(p_operation_id uuid); Type: ACL; Schema: public; Owner: -
--

REVOKE ALL ON FUNCTION public.release_refund_operation(p_operation_id uuid) FROM PUBLIC;
GRANT ALL ON FUNCTION public.release_refund_operation(p_operation_id uuid) TO postgres;
GRANT ALL ON FUNCTION public.release_refund_operation(p_operation_id uuid) TO service_role;


--
-- Name: FUNCTION release_reversal_operation(p_operation_id uuid); Type: ACL; Schema: public; Owner: -
--

REVOKE ALL ON FUNCTION public.release_reversal_operation(p_operation_id uuid) FROM PUBLIC;
GRANT ALL ON FUNCTION public.release_reversal_operation(p_operation_id uuid) TO postgres;
GRANT ALL ON FUNCTION public.release_reversal_operation(p_operation_id uuid) TO service_role;


--
-- Name: FUNCTION release_stale_negotiation_lease(p_session_id uuid); Type: ACL; Schema: public; Owner: -
--

REVOKE ALL ON FUNCTION public.release_stale_negotiation_lease(p_session_id uuid) FROM PUBLIC;
GRANT ALL ON FUNCTION public.release_stale_negotiation_lease(p_session_id uuid) TO service_role;


--
-- Name: FUNCTION request_errand_over_budget(p_job_id uuid, p_amount numeric, p_reason text); Type: ACL; Schema: public; Owner: -
--

REVOKE ALL ON FUNCTION public.request_errand_over_budget(p_job_id uuid, p_amount numeric, p_reason text) FROM PUBLIC;
GRANT ALL ON FUNCTION public.request_errand_over_budget(p_job_id uuid, p_amount numeric, p_reason text) TO authenticated;
GRANT ALL ON FUNCTION public.request_errand_over_budget(p_job_id uuid, p_amount numeric, p_reason text) TO service_role;


--
-- Name: FUNCTION reserve_cash_job_credit_v1e(p_job_id uuid, p_driver_id uuid); Type: ACL; Schema: public; Owner: -
--

REVOKE ALL ON FUNCTION public.reserve_cash_job_credit_v1e(p_job_id uuid, p_driver_id uuid) FROM PUBLIC;
GRANT ALL ON FUNCTION public.reserve_cash_job_credit_v1e(p_job_id uuid, p_driver_id uuid) TO postgres;
GRANT ALL ON FUNCTION public.reserve_cash_job_credit_v1e(p_job_id uuid, p_driver_id uuid) TO service_role;


--
-- Name: FUNCTION reserve_errand_funds(p_job_id uuid, p_customer_id uuid, p_item_budget numeric, p_service_estimate numeric); Type: ACL; Schema: public; Owner: -
--

REVOKE ALL ON FUNCTION public.reserve_errand_funds(p_job_id uuid, p_customer_id uuid, p_item_budget numeric, p_service_estimate numeric) FROM PUBLIC;
GRANT ALL ON FUNCTION public.reserve_errand_funds(p_job_id uuid, p_customer_id uuid, p_item_budget numeric, p_service_estimate numeric) TO service_role;


--
-- Name: FUNCTION reserve_job_issuing_budget(p_job uuid, p_budget numeric, p_available numeric, p_currency text); Type: ACL; Schema: public; Owner: -
--

REVOKE ALL ON FUNCTION public.reserve_job_issuing_budget(p_job uuid, p_budget numeric, p_available numeric, p_currency text) FROM PUBLIC;
GRANT ALL ON FUNCTION public.reserve_job_issuing_budget(p_job uuid, p_budget numeric, p_available numeric, p_currency text) TO postgres;
GRANT ALL ON FUNCTION public.reserve_job_issuing_budget(p_job uuid, p_budget numeric, p_available numeric, p_currency text) TO service_role;


--
-- Name: FUNCTION reserve_job_refund(p_job_id uuid, p_amount_minor bigint, p_captured_minor bigint); Type: ACL; Schema: public; Owner: -
--

REVOKE ALL ON FUNCTION public.reserve_job_refund(p_job_id uuid, p_amount_minor bigint, p_captured_minor bigint) FROM PUBLIC;
GRANT ALL ON FUNCTION public.reserve_job_refund(p_job_id uuid, p_amount_minor bigint, p_captured_minor bigint) TO postgres;
GRANT ALL ON FUNCTION public.reserve_job_refund(p_job_id uuid, p_amount_minor bigint, p_captured_minor bigint) TO service_role;


--
-- Name: FUNCTION reserve_job_reversal(p_job_id uuid, p_amount_minor bigint, p_transfer_minor bigint); Type: ACL; Schema: public; Owner: -
--

REVOKE ALL ON FUNCTION public.reserve_job_reversal(p_job_id uuid, p_amount_minor bigint, p_transfer_minor bigint) FROM PUBLIC;
GRANT ALL ON FUNCTION public.reserve_job_reversal(p_job_id uuid, p_amount_minor bigint, p_transfer_minor bigint) TO postgres;
GRANT ALL ON FUNCTION public.reserve_job_reversal(p_job_id uuid, p_amount_minor bigint, p_transfer_minor bigint) TO service_role;


--
-- Name: FUNCTION reserve_kora_sandbox_booking(p_row jsonb); Type: ACL; Schema: public; Owner: -
--

REVOKE ALL ON FUNCTION public.reserve_kora_sandbox_booking(p_row jsonb) FROM PUBLIC;
GRANT ALL ON FUNCTION public.reserve_kora_sandbox_booking(p_row jsonb) TO postgres;
GRANT ALL ON FUNCTION public.reserve_kora_sandbox_booking(p_row jsonb) TO service_role;


--
-- Name: FUNCTION reserve_refund_operation(p_job_id uuid, p_amount_minor bigint, p_captured_minor bigint, p_service_fare_minor bigint, p_idempotency_key text, p_purpose text); Type: ACL; Schema: public; Owner: -
--

REVOKE ALL ON FUNCTION public.reserve_refund_operation(p_job_id uuid, p_amount_minor bigint, p_captured_minor bigint, p_service_fare_minor bigint, p_idempotency_key text, p_purpose text) FROM PUBLIC;
GRANT ALL ON FUNCTION public.reserve_refund_operation(p_job_id uuid, p_amount_minor bigint, p_captured_minor bigint, p_service_fare_minor bigint, p_idempotency_key text, p_purpose text) TO postgres;
GRANT ALL ON FUNCTION public.reserve_refund_operation(p_job_id uuid, p_amount_minor bigint, p_captured_minor bigint, p_service_fare_minor bigint, p_idempotency_key text, p_purpose text) TO service_role;


--
-- Name: FUNCTION reserve_reversal_operation(p_job_id uuid, p_amount_minor bigint, p_transfer_minor bigint, p_idempotency_key text, p_purpose text); Type: ACL; Schema: public; Owner: -
--

REVOKE ALL ON FUNCTION public.reserve_reversal_operation(p_job_id uuid, p_amount_minor bigint, p_transfer_minor bigint, p_idempotency_key text, p_purpose text) FROM PUBLIC;
GRANT ALL ON FUNCTION public.reserve_reversal_operation(p_job_id uuid, p_amount_minor bigint, p_transfer_minor bigint, p_idempotency_key text, p_purpose text) TO postgres;
GRANT ALL ON FUNCTION public.reserve_reversal_operation(p_job_id uuid, p_amount_minor bigint, p_transfer_minor bigint, p_idempotency_key text, p_purpose text) TO service_role;


--
-- Name: FUNCTION resolve_cash_job_credit_v1e(p_job_id uuid, p_outcome text); Type: ACL; Schema: public; Owner: -
--

REVOKE ALL ON FUNCTION public.resolve_cash_job_credit_v1e(p_job_id uuid, p_outcome text) FROM PUBLIC;
GRANT ALL ON FUNCTION public.resolve_cash_job_credit_v1e(p_job_id uuid, p_outcome text) TO postgres;
GRANT ALL ON FUNCTION public.resolve_cash_job_credit_v1e(p_job_id uuid, p_outcome text) TO service_role;


--
-- Name: FUNCTION safe_iso_date(p_raw text); Type: ACL; Schema: public; Owner: -
--

REVOKE ALL ON FUNCTION public.safe_iso_date(p_raw text) FROM PUBLIC;


--
-- Name: FUNCTION sandbox_attempt_guard_v1l(); Type: ACL; Schema: public; Owner: -
--

REVOKE ALL ON FUNCTION public.sandbox_attempt_guard_v1l() FROM PUBLIC;
GRANT ALL ON FUNCTION public.sandbox_attempt_guard_v1l() TO postgres;


--
-- Name: FUNCTION sandbox_attempt_json_v1l(p_id uuid); Type: ACL; Schema: public; Owner: -
--

REVOKE ALL ON FUNCTION public.sandbox_attempt_json_v1l(p_id uuid) FROM PUBLIC;
GRANT ALL ON FUNCTION public.sandbox_attempt_json_v1l(p_id uuid) TO postgres;


--
-- Name: FUNCTION seed_admin_message_thread(p_notification uuid, p_queue boolean); Type: ACL; Schema: public; Owner: -
--

REVOKE ALL ON FUNCTION public.seed_admin_message_thread(p_notification uuid, p_queue boolean) FROM PUBLIC;
GRANT ALL ON FUNCTION public.seed_admin_message_thread(p_notification uuid, p_queue boolean) TO postgres;


--
-- Name: FUNCTION send_chat_push_notification(); Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON FUNCTION public.send_chat_push_notification() TO anon;
GRANT ALL ON FUNCTION public.send_chat_push_notification() TO authenticated;
GRANT ALL ON FUNCTION public.send_chat_push_notification() TO service_role;


--
-- Name: FUNCTION send_job_message(p_job_id uuid, p_receiver_id uuid, p_message text, p_message_type text); Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON FUNCTION public.send_job_message(p_job_id uuid, p_receiver_id uuid, p_message text, p_message_type text) TO anon;
GRANT ALL ON FUNCTION public.send_job_message(p_job_id uuid, p_receiver_id uuid, p_message text, p_message_type text) TO authenticated;
GRANT ALL ON FUNCTION public.send_job_message(p_job_id uuid, p_receiver_id uuid, p_message text, p_message_type text) TO service_role;


--
-- Name: FUNCTION serialize_cash_credit_ledger_v1e(); Type: ACL; Schema: public; Owner: -
--

REVOKE ALL ON FUNCTION public.serialize_cash_credit_ledger_v1e() FROM PUBLIC;
GRANT ALL ON FUNCTION public.serialize_cash_credit_ledger_v1e() TO postgres;


--
-- Name: FUNCTION set_pricing_config_updated_at(); Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON FUNCTION public.set_pricing_config_updated_at() TO anon;
GRANT ALL ON FUNCTION public.set_pricing_config_updated_at() TO authenticated;
GRANT ALL ON FUNCTION public.set_pricing_config_updated_at() TO service_role;


--
-- Name: FUNCTION set_updated_at(); Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON FUNCTION public.set_updated_at() TO anon;
GRANT ALL ON FUNCTION public.set_updated_at() TO authenticated;
GRANT ALL ON FUNCTION public.set_updated_at() TO service_role;


--
-- Name: FUNCTION settle_errand_funds(p_booking_id uuid); Type: ACL; Schema: public; Owner: -
--

REVOKE ALL ON FUNCTION public.settle_errand_funds(p_booking_id uuid) FROM PUBLIC;
GRANT ALL ON FUNCTION public.settle_errand_funds(p_booking_id uuid) TO service_role;


--
-- Name: FUNCTION settle_job_wallet_reservation(p_job_id uuid, p_amount numeric); Type: ACL; Schema: public; Owner: -
--

REVOKE ALL ON FUNCTION public.settle_job_wallet_reservation(p_job_id uuid, p_amount numeric) FROM PUBLIC;
GRANT ALL ON FUNCTION public.settle_job_wallet_reservation(p_job_id uuid, p_amount numeric) TO service_role;


--
-- Name: TABLE job_budget_authorizations; Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON TABLE public.job_budget_authorizations TO postgres;
GRANT ALL ON TABLE public.job_budget_authorizations TO service_role;


--
-- Name: FUNCTION shopping_authorizations_pending_cleanup(); Type: ACL; Schema: public; Owner: -
--

REVOKE ALL ON FUNCTION public.shopping_authorizations_pending_cleanup() FROM PUBLIC;
GRANT ALL ON FUNCTION public.shopping_authorizations_pending_cleanup() TO postgres;
GRANT ALL ON FUNCTION public.shopping_authorizations_pending_cleanup() TO service_role;


--
-- Name: FUNCTION sync_agreed_fare_snapshot(); Type: ACL; Schema: public; Owner: -
--

REVOKE ALL ON FUNCTION public.sync_agreed_fare_snapshot() FROM PUBLIC;
GRANT ALL ON FUNCTION public.sync_agreed_fare_snapshot() TO postgres;
GRANT ALL ON FUNCTION public.sync_agreed_fare_snapshot() TO service_role;


--
-- Name: FUNCTION sync_configured_country_payment_routes_v23(); Type: ACL; Schema: public; Owner: -
--

REVOKE ALL ON FUNCTION public.sync_configured_country_payment_routes_v23() FROM PUBLIC;
GRANT ALL ON FUNCTION public.sync_configured_country_payment_routes_v23() TO postgres;


--
-- Name: FUNCTION sync_country_settings_payment_routes_v23(); Type: ACL; Schema: public; Owner: -
--

REVOKE ALL ON FUNCTION public.sync_country_settings_payment_routes_v23() FROM PUBLIC;
GRANT ALL ON FUNCTION public.sync_country_settings_payment_routes_v23() TO postgres;


--
-- Name: FUNCTION sync_job_issuing_spend(p_job uuid, p_finalize boolean); Type: ACL; Schema: public; Owner: -
--

REVOKE ALL ON FUNCTION public.sync_job_issuing_spend(p_job uuid, p_finalize boolean) FROM PUBLIC;
GRANT ALL ON FUNCTION public.sync_job_issuing_spend(p_job uuid, p_finalize boolean) TO postgres;
GRANT ALL ON FUNCTION public.sync_job_issuing_spend(p_job uuid, p_finalize boolean) TO service_role;


--
-- Name: FUNCTION sync_job_prices(); Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON FUNCTION public.sync_job_prices() TO anon;
GRANT ALL ON FUNCTION public.sync_job_prices() TO authenticated;
GRANT ALL ON FUNCTION public.sync_job_prices() TO service_role;


--
-- Name: FUNCTION sync_system_configs_columns(); Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON FUNCTION public.sync_system_configs_columns() TO anon;
GRANT ALL ON FUNCTION public.sync_system_configs_columns() TO authenticated;
GRANT ALL ON FUNCTION public.sync_system_configs_columns() TO service_role;


--
-- Name: FUNCTION touch_app_presence(p_session uuid); Type: ACL; Schema: public; Owner: -
--

REVOKE ALL ON FUNCTION public.touch_app_presence(p_session uuid) FROM PUBLIC;
GRANT ALL ON FUNCTION public.touch_app_presence(p_session uuid) TO postgres;
GRANT ALL ON FUNCTION public.touch_app_presence(p_session uuid) TO authenticated;
GRANT ALL ON FUNCTION public.touch_app_presence(p_session uuid) TO service_role;


--
-- Name: FUNCTION trg_guard_direct_arrival(); Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON FUNCTION public.trg_guard_direct_arrival() TO postgres;
GRANT ALL ON FUNCTION public.trg_guard_direct_arrival() TO anon;
GRANT ALL ON FUNCTION public.trg_guard_direct_arrival() TO authenticated;
GRANT ALL ON FUNCTION public.trg_guard_direct_arrival() TO service_role;


--
-- Name: FUNCTION update_driver_locations_updated_at(); Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON FUNCTION public.update_driver_locations_updated_at() TO anon;
GRANT ALL ON FUNCTION public.update_driver_locations_updated_at() TO authenticated;
GRANT ALL ON FUNCTION public.update_driver_locations_updated_at() TO service_role;


--
-- Name: FUNCTION update_errand_funding_updated_at(); Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON FUNCTION public.update_errand_funding_updated_at() TO anon;
GRANT ALL ON FUNCTION public.update_errand_funding_updated_at() TO authenticated;
GRANT ALL ON FUNCTION public.update_errand_funding_updated_at() TO service_role;


--
-- Name: FUNCTION update_jobs_updated_at(); Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON FUNCTION public.update_jobs_updated_at() TO anon;
GRANT ALL ON FUNCTION public.update_jobs_updated_at() TO authenticated;
GRANT ALL ON FUNCTION public.update_jobs_updated_at() TO service_role;


--
-- Name: FUNCTION update_updated_at_column(); Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON FUNCTION public.update_updated_at_column() TO postgres;
GRANT ALL ON FUNCTION public.update_updated_at_column() TO anon;
GRANT ALL ON FUNCTION public.update_updated_at_column() TO authenticated;
GRANT ALL ON FUNCTION public.update_updated_at_column() TO service_role;


--
-- Name: FUNCTION update_wallets_updated_at(); Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON FUNCTION public.update_wallets_updated_at() TO anon;
GRANT ALL ON FUNCTION public.update_wallets_updated_at() TO authenticated;
GRANT ALL ON FUNCTION public.update_wallets_updated_at() TO service_role;


--
-- Name: FUNCTION user_owns_job(p_job_id uuid); Type: ACL; Schema: public; Owner: -
--

REVOKE ALL ON FUNCTION public.user_owns_job(p_job_id uuid) FROM PUBLIC;
GRANT ALL ON FUNCTION public.user_owns_job(p_job_id uuid) TO anon;
GRANT ALL ON FUNCTION public.user_owns_job(p_job_id uuid) TO authenticated;
GRANT ALL ON FUNCTION public.user_owns_job(p_job_id uuid) TO service_role;


--
-- Name: FUNCTION validate_wallet_integrity(p_user_id uuid); Type: ACL; Schema: public; Owner: -
--

REVOKE ALL ON FUNCTION public.validate_wallet_integrity(p_user_id uuid) FROM PUBLIC;
GRANT ALL ON FUNCTION public.validate_wallet_integrity(p_user_id uuid) TO service_role;


--
-- Name: FUNCTION wallet_collection_enabled(); Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON FUNCTION public.wallet_collection_enabled() TO postgres;
GRANT ALL ON FUNCTION public.wallet_collection_enabled() TO anon;
GRANT ALL ON FUNCTION public.wallet_collection_enabled() TO authenticated;
GRANT ALL ON FUNCTION public.wallet_collection_enabled() TO service_role;


--
-- Name: FUNCTION wallet_currency_minor_exponent(p_currency_code text); Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON FUNCTION public.wallet_currency_minor_exponent(p_currency_code text) TO postgres;
GRANT ALL ON FUNCTION public.wallet_currency_minor_exponent(p_currency_code text) TO anon;
GRANT ALL ON FUNCTION public.wallet_currency_minor_exponent(p_currency_code text) TO authenticated;
GRANT ALL ON FUNCTION public.wallet_currency_minor_exponent(p_currency_code text) TO service_role;


--
-- Name: FUNCTION wallet_ledger_append_only(); Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON FUNCTION public.wallet_ledger_append_only() TO postgres;
GRANT ALL ON FUNCTION public.wallet_ledger_append_only() TO anon;
GRANT ALL ON FUNCTION public.wallet_ledger_append_only() TO authenticated;
GRANT ALL ON FUNCTION public.wallet_ledger_append_only() TO service_role;


--
-- Name: FUNCTION wallet_topup_attempt_freeze(); Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON FUNCTION public.wallet_topup_attempt_freeze() TO postgres;
GRANT ALL ON FUNCTION public.wallet_topup_attempt_freeze() TO anon;
GRANT ALL ON FUNCTION public.wallet_topup_attempt_freeze() TO authenticated;
GRANT ALL ON FUNCTION public.wallet_topup_attempt_freeze() TO service_role;


--
-- Name: TABLE admin_message_email_outbox; Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON TABLE public.admin_message_email_outbox TO postgres;
GRANT ALL ON TABLE public.admin_message_email_outbox TO service_role;


--
-- Name: TABLE admin_message_entries; Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON TABLE public.admin_message_entries TO postgres;
GRANT ALL ON TABLE public.admin_message_entries TO service_role;


--
-- Name: SEQUENCE admin_message_entries_id_seq; Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON SEQUENCE public.admin_message_entries_id_seq TO postgres;
GRANT ALL ON SEQUENCE public.admin_message_entries_id_seq TO anon;
GRANT ALL ON SEQUENCE public.admin_message_entries_id_seq TO authenticated;
GRANT ALL ON SEQUENCE public.admin_message_entries_id_seq TO service_role;


--
-- Name: TABLE admin_message_threads; Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON TABLE public.admin_message_threads TO postgres;
GRANT ALL ON TABLE public.admin_message_threads TO service_role;


--
-- Name: TABLE ai_pricing_audits; Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON TABLE public.ai_pricing_audits TO anon;
GRANT ALL ON TABLE public.ai_pricing_audits TO authenticated;
GRANT ALL ON TABLE public.ai_pricing_audits TO service_role;


--
-- Name: TABLE app_features; Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON TABLE public.app_features TO anon;
GRANT ALL ON TABLE public.app_features TO authenticated;
GRANT ALL ON TABLE public.app_features TO service_role;


--
-- Name: TABLE app_presence_sessions; Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON TABLE public.app_presence_sessions TO postgres;
GRANT ALL ON TABLE public.app_presence_sessions TO service_role;


--
-- Name: TABLE audit_logs; Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON TABLE public.audit_logs TO anon;
GRANT ALL ON TABLE public.audit_logs TO authenticated;
GRANT ALL ON TABLE public.audit_logs TO service_role;


--
-- Name: TABLE booking_status_history; Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON TABLE public.booking_status_history TO anon;
GRANT ALL ON TABLE public.booking_status_history TO authenticated;
GRANT ALL ON TABLE public.booking_status_history TO service_role;


--
-- Name: TABLE cities; Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON TABLE public.cities TO anon;
GRANT ALL ON TABLE public.cities TO authenticated;
GRANT ALL ON TABLE public.cities TO service_role;


--
-- Name: TABLE competitor_fare_benchmarks; Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON TABLE public.competitor_fare_benchmarks TO service_role;


--
-- Name: TABLE competitor_profiles; Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON TABLE public.competitor_profiles TO service_role;


--
-- Name: TABLE market_payment_routes; Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON TABLE public.market_payment_routes TO postgres;
GRANT SELECT ON TABLE public.market_payment_routes TO service_role;


--
-- Name: TABLE country_payment_assignments_v23; Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON TABLE public.country_payment_assignments_v23 TO postgres;
GRANT ALL ON TABLE public.country_payment_assignments_v23 TO service_role;


--
-- Name: TABLE customer_local_service_preferences; Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON TABLE public.customer_local_service_preferences TO anon;
GRANT ALL ON TABLE public.customer_local_service_preferences TO authenticated;
GRANT ALL ON TABLE public.customer_local_service_preferences TO service_role;


--
-- Name: TABLE customer_wallet_sandbox_attempts_v1l; Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON TABLE public.customer_wallet_sandbox_attempts_v1l TO postgres;


--
-- Name: TABLE customer_wallet_sandbox_cohort_v1l; Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON TABLE public.customer_wallet_sandbox_cohort_v1l TO postgres;


--
-- Name: TABLE delivery_details; Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON TABLE public.delivery_details TO anon;
GRANT ALL ON TABLE public.delivery_details TO authenticated;
GRANT ALL ON TABLE public.delivery_details TO service_role;


--
-- Name: TABLE device_push_tokens; Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON TABLE public.device_push_tokens TO anon;
GRANT ALL ON TABLE public.device_push_tokens TO authenticated;
GRANT ALL ON TABLE public.device_push_tokens TO service_role;


--
-- Name: TABLE dispatch_logs; Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON TABLE public.dispatch_logs TO anon;
GRANT ALL ON TABLE public.dispatch_logs TO authenticated;
GRANT ALL ON TABLE public.dispatch_logs TO service_role;


--
-- Name: TABLE driver_accounts; Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON TABLE public.driver_accounts TO anon;
GRANT ALL ON TABLE public.driver_accounts TO authenticated;
GRANT ALL ON TABLE public.driver_accounts TO service_role;


--
-- Name: TABLE driver_bids; Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON TABLE public.driver_bids TO anon;
GRANT ALL ON TABLE public.driver_bids TO authenticated;
GRANT ALL ON TABLE public.driver_bids TO service_role;


--
-- Name: TABLE driver_cash_credit_config_v1e; Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON TABLE public.driver_cash_credit_config_v1e TO postgres;


--
-- Name: TABLE driver_cash_credit_enrolments_v1e; Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON TABLE public.driver_cash_credit_enrolments_v1e TO postgres;


--
-- Name: TABLE driver_cash_credit_holds_v1e; Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON TABLE public.driver_cash_credit_holds_v1e TO postgres;
GRANT SELECT ON TABLE public.driver_cash_credit_holds_v1e TO service_role;


--
-- Name: TABLE driver_earnings; Type: ACL; Schema: public; Owner: -
--

GRANT SELECT ON TABLE public.driver_earnings TO anon;
GRANT SELECT ON TABLE public.driver_earnings TO authenticated;
GRANT ALL ON TABLE public.driver_earnings TO service_role;


--
-- Name: TABLE driver_issuing_cardholders; Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON TABLE public.driver_issuing_cardholders TO anon;
GRANT ALL ON TABLE public.driver_issuing_cardholders TO authenticated;
GRANT ALL ON TABLE public.driver_issuing_cardholders TO service_role;


--
-- Name: TABLE driver_issuing_cards; Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON TABLE public.driver_issuing_cards TO anon;
GRANT ALL ON TABLE public.driver_issuing_cards TO authenticated;
GRANT ALL ON TABLE public.driver_issuing_cards TO service_role;


--
-- Name: TABLE driver_job_declines; Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON TABLE public.driver_job_declines TO anon;
GRANT ALL ON TABLE public.driver_job_declines TO authenticated;
GRANT ALL ON TABLE public.driver_job_declines TO service_role;


--
-- Name: TABLE driver_locations; Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON TABLE public.driver_locations TO anon;
GRANT ALL ON TABLE public.driver_locations TO authenticated;
GRANT ALL ON TABLE public.driver_locations TO service_role;


--
-- Name: TABLE driver_onboarding_notifications; Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON TABLE public.driver_onboarding_notifications TO service_role;


--
-- Name: TABLE driver_onboarding_requests; Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON TABLE public.driver_onboarding_requests TO service_role;


--
-- Name: TABLE driver_payout_markets; Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON TABLE public.driver_payout_markets TO postgres;
GRANT SELECT ON TABLE public.driver_payout_markets TO service_role;


--
-- Name: TABLE driver_requirement_audit; Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON TABLE public.driver_requirement_audit TO service_role;


--
-- Name: TABLE driver_subscriptions; Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON TABLE public.driver_subscriptions TO anon;
GRANT ALL ON TABLE public.driver_subscriptions TO authenticated;
GRANT ALL ON TABLE public.driver_subscriptions TO service_role;


--
-- Name: TABLE driver_vehicle_mot_checks; Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON TABLE public.driver_vehicle_mot_checks TO postgres;
GRANT ALL ON TABLE public.driver_vehicle_mot_checks TO service_role;


--
-- Name: TABLE email_logs; Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON TABLE public.email_logs TO anon;
GRANT ALL ON TABLE public.email_logs TO authenticated;
GRANT ALL ON TABLE public.email_logs TO service_role;


--
-- Name: TABLE errand_details; Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON TABLE public.errand_details TO anon;
GRANT ALL ON TABLE public.errand_details TO authenticated;
GRANT ALL ON TABLE public.errand_details TO service_role;


--
-- Name: TABLE errand_funding; Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON TABLE public.errand_funding TO anon;
GRANT ALL ON TABLE public.errand_funding TO authenticated;
GRANT ALL ON TABLE public.errand_funding TO service_role;


--
-- Name: TABLE events; Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON TABLE public.events TO anon;
GRANT ALL ON TABLE public.events TO authenticated;
GRANT ALL ON TABLE public.events TO service_role;


--
-- Name: TABLE fare_negotiations; Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON TABLE public.fare_negotiations TO anon;
GRANT ALL ON TABLE public.fare_negotiations TO authenticated;
GRANT ALL ON TABLE public.fare_negotiations TO service_role;


--
-- Name: TABLE fixed_fare_bands_raw; Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON TABLE public.fixed_fare_bands_raw TO anon;
GRANT ALL ON TABLE public.fixed_fare_bands_raw TO authenticated;
GRANT ALL ON TABLE public.fixed_fare_bands_raw TO service_role;


--
-- Name: TABLE fixed_fare_bands; Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON TABLE public.fixed_fare_bands TO anon;
GRANT ALL ON TABLE public.fixed_fare_bands TO authenticated;
GRANT ALL ON TABLE public.fixed_fare_bands TO service_role;


--
-- Name: TABLE gb_mot_night_runs; Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON TABLE public.gb_mot_night_runs TO postgres;
GRANT ALL ON TABLE public.gb_mot_night_runs TO service_role;


--
-- Name: TABLE job_completion_secrets; Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON TABLE public.job_completion_secrets TO service_role;
GRANT SELECT ON TABLE public.job_completion_secrets TO authenticated;


--
-- Name: TABLE job_events; Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON TABLE public.job_events TO anon;
GRANT ALL ON TABLE public.job_events TO authenticated;
GRANT ALL ON TABLE public.job_events TO service_role;


--
-- Name: TABLE job_issuing_authorizations; Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON TABLE public.job_issuing_authorizations TO anon;
GRANT ALL ON TABLE public.job_issuing_authorizations TO authenticated;
GRANT ALL ON TABLE public.job_issuing_authorizations TO service_role;


--
-- Name: TABLE job_issuing_reserves; Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON TABLE public.job_issuing_reserves TO postgres;
GRANT ALL ON TABLE public.job_issuing_reserves TO service_role;


--
-- Name: TABLE job_issuing_spend_controls; Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON TABLE public.job_issuing_spend_controls TO anon;
GRANT ALL ON TABLE public.job_issuing_spend_controls TO authenticated;
GRANT ALL ON TABLE public.job_issuing_spend_controls TO service_role;


--
-- Name: TABLE job_issuing_transactions; Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON TABLE public.job_issuing_transactions TO anon;
GRANT ALL ON TABLE public.job_issuing_transactions TO authenticated;
GRANT ALL ON TABLE public.job_issuing_transactions TO service_role;


--
-- Name: TABLE job_locations; Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON TABLE public.job_locations TO anon;
GRANT ALL ON TABLE public.job_locations TO authenticated;
GRANT ALL ON TABLE public.job_locations TO service_role;


--
-- Name: TABLE job_messages; Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON TABLE public.job_messages TO service_role;
GRANT SELECT ON TABLE public.job_messages TO authenticated;


--
-- Name: COLUMN job_messages.read_at; Type: ACL; Schema: public; Owner: -
--

GRANT UPDATE(read_at) ON TABLE public.job_messages TO authenticated;


--
-- Name: TABLE job_payment_bindings; Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON TABLE public.job_payment_bindings TO postgres;
GRANT ALL ON TABLE public.job_payment_bindings TO service_role;


--
-- Name: TABLE job_queue; Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON TABLE public.job_queue TO anon;
GRANT ALL ON TABLE public.job_queue TO authenticated;
GRANT ALL ON TABLE public.job_queue TO service_role;


--
-- Name: TABLE job_service_details; Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON TABLE public.job_service_details TO anon;
GRANT ALL ON TABLE public.job_service_details TO authenticated;
GRANT ALL ON TABLE public.job_service_details TO service_role;


--
-- Name: TABLE journey_evidence_v23; Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON TABLE public.journey_evidence_v23 TO postgres;
GRANT SELECT ON TABLE public.journey_evidence_v23 TO service_role;


--
-- Name: SEQUENCE journey_evidence_v23_id_seq; Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON SEQUENCE public.journey_evidence_v23_id_seq TO postgres;


--
-- Name: TABLE journey_fare_enrolments_v23; Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON TABLE public.journey_fare_enrolments_v23 TO postgres;
GRANT SELECT ON TABLE public.journey_fare_enrolments_v23 TO service_role;


--
-- Name: TABLE journey_fare_events_v23; Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON TABLE public.journey_fare_events_v23 TO postgres;
GRANT SELECT ON TABLE public.journey_fare_events_v23 TO service_role;


--
-- Name: SEQUENCE journey_fare_events_v23_id_seq; Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON SEQUENCE public.journey_fare_events_v23_id_seq TO postgres;


--
-- Name: TABLE journey_fare_proposals_v23; Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON TABLE public.journey_fare_proposals_v23 TO postgres;
GRANT SELECT ON TABLE public.journey_fare_proposals_v23 TO service_role;


--
-- Name: TABLE journey_start_markers_v23; Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON TABLE public.journey_start_markers_v23 TO postgres;
GRANT SELECT ON TABLE public.journey_start_markers_v23 TO service_role;


--
-- Name: TABLE journey_stop_events_v23; Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON TABLE public.journey_stop_events_v23 TO postgres;
GRANT SELECT ON TABLE public.journey_stop_events_v23 TO service_role;


--
-- Name: SEQUENCE journey_stop_events_v23_id_seq; Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON SEQUENCE public.journey_stop_events_v23_id_seq TO postgres;


--
-- Name: TABLE journey_stop_requests_v23; Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON TABLE public.journey_stop_requests_v23 TO postgres;
GRANT SELECT ON TABLE public.journey_stop_requests_v23 TO service_role;


--
-- Name: TABLE kora_sandbox_booking_enrolments; Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON TABLE public.kora_sandbox_booking_enrolments TO postgres;
GRANT SELECT ON TABLE public.kora_sandbox_booking_enrolments TO service_role;


--
-- Name: TABLE kora_sandbox_booking_payments; Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON TABLE public.kora_sandbox_booking_payments TO postgres;
GRANT SELECT ON TABLE public.kora_sandbox_booking_payments TO service_role;


--
-- Name: TABLE kora_sandbox_sessions; Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON TABLE public.kora_sandbox_sessions TO postgres;
GRANT ALL ON TABLE public.kora_sandbox_sessions TO service_role;


--
-- Name: TABLE local_place_search_cache; Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON TABLE public.local_place_search_cache TO anon;
GRANT ALL ON TABLE public.local_place_search_cache TO authenticated;
GRANT ALL ON TABLE public.local_place_search_cache TO service_role;


--
-- Name: TABLE local_service_categories; Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON TABLE public.local_service_categories TO anon;
GRANT ALL ON TABLE public.local_service_categories TO authenticated;
GRANT ALL ON TABLE public.local_service_categories TO service_role;


--
-- Name: TABLE local_service_providers; Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON TABLE public.local_service_providers TO anon;
GRANT ALL ON TABLE public.local_service_providers TO authenticated;
GRANT ALL ON TABLE public.local_service_providers TO service_role;


--
-- Name: TABLE market_availability; Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON TABLE public.market_availability TO anon;
GRANT ALL ON TABLE public.market_availability TO authenticated;
GRANT ALL ON TABLE public.market_availability TO service_role;


--
-- Name: TABLE market_availability_audit; Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON TABLE public.market_availability_audit TO anon;
GRANT ALL ON TABLE public.market_availability_audit TO authenticated;
GRANT ALL ON TABLE public.market_availability_audit TO service_role;


--
-- Name: TABLE market_payment_route_audit; Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON TABLE public.market_payment_route_audit TO postgres;


--
-- Name: SEQUENCE market_payment_route_audit_id_seq; Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON SEQUENCE public.market_payment_route_audit_id_seq TO postgres;


--
-- Name: TABLE market_price_snapshots; Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON TABLE public.market_price_snapshots TO service_role;


--
-- Name: TABLE market_pricing_strategies; Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON TABLE public.market_pricing_strategies TO service_role;


--
-- Name: TABLE market_waiting_list; Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON TABLE public.market_waiting_list TO anon;
GRANT ALL ON TABLE public.market_waiting_list TO authenticated;
GRANT ALL ON TABLE public.market_waiting_list TO service_role;


--
-- Name: TABLE marketplace_commission_overrides; Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON TABLE public.marketplace_commission_overrides TO anon;
GRANT ALL ON TABLE public.marketplace_commission_overrides TO authenticated;
GRANT ALL ON TABLE public.marketplace_commission_overrides TO service_role;


--
-- Name: TABLE marketplace_negotiation_events; Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON TABLE public.marketplace_negotiation_events TO anon;
GRANT ALL ON TABLE public.marketplace_negotiation_events TO authenticated;
GRANT ALL ON TABLE public.marketplace_negotiation_events TO service_role;


--
-- Name: TABLE marketplace_settings; Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON TABLE public.marketplace_settings TO anon;
GRANT ALL ON TABLE public.marketplace_settings TO authenticated;
GRANT ALL ON TABLE public.marketplace_settings TO service_role;


--
-- Name: TABLE notifications; Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON TABLE public.notifications TO anon;
GRANT ALL ON TABLE public.notifications TO authenticated;
GRANT ALL ON TABLE public.notifications TO service_role;


--
-- Name: TABLE profiles; Type: ACL; Schema: public; Owner: -
--

GRANT SELECT ON TABLE public.profiles TO anon;
GRANT SELECT,UPDATE ON TABLE public.profiles TO authenticated;
GRANT ALL ON TABLE public.profiles TO service_role;


--
-- Name: TABLE operations_metrics; Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON TABLE public.operations_metrics TO anon;
GRANT ALL ON TABLE public.operations_metrics TO authenticated;
GRANT ALL ON TABLE public.operations_metrics TO service_role;


--
-- Name: TABLE operations_metrics_v2; Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON TABLE public.operations_metrics_v2 TO anon;
GRANT ALL ON TABLE public.operations_metrics_v2 TO authenticated;
GRANT ALL ON TABLE public.operations_metrics_v2 TO service_role;


--
-- Name: TABLE operations_metrics_v3; Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON TABLE public.operations_metrics_v3 TO anon;
GRANT ALL ON TABLE public.operations_metrics_v3 TO authenticated;
GRANT ALL ON TABLE public.operations_metrics_v3 TO service_role;


--
-- Name: TABLE payment_card_consents; Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON TABLE public.payment_card_consents TO postgres;
GRANT ALL ON TABLE public.payment_card_consents TO service_role;


--
-- Name: TABLE payment_checkout_attempts; Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON TABLE public.payment_checkout_attempts TO postgres;
GRANT ALL ON TABLE public.payment_checkout_attempts TO service_role;


--
-- Name: TABLE payment_customers; Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON TABLE public.payment_customers TO postgres;
GRANT ALL ON TABLE public.payment_customers TO service_role;


--
-- Name: TABLE payout_batches; Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON TABLE public.payout_batches TO anon;
GRANT ALL ON TABLE public.payout_batches TO authenticated;
GRANT ALL ON TABLE public.payout_batches TO service_role;


--
-- Name: TABLE pricing_calendar_events; Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON TABLE public.pricing_calendar_events TO anon;
GRANT ALL ON TABLE public.pricing_calendar_events TO authenticated;
GRANT ALL ON TABLE public.pricing_calendar_events TO service_role;


--
-- Name: TABLE pricing_config; Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON TABLE public.pricing_config TO anon;
GRANT ALL ON TABLE public.pricing_config TO authenticated;
GRANT ALL ON TABLE public.pricing_config TO service_role;


--
-- Name: TABLE pricing_conversion_rules; Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON TABLE public.pricing_conversion_rules TO anon;
GRANT ALL ON TABLE public.pricing_conversion_rules TO authenticated;
GRANT ALL ON TABLE public.pricing_conversion_rules TO service_role;


--
-- Name: TABLE pricing_markets; Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON TABLE public.pricing_markets TO anon;
GRANT ALL ON TABLE public.pricing_markets TO authenticated;
GRANT ALL ON TABLE public.pricing_markets TO service_role;


--
-- Name: TABLE pricing_rules_raw; Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON TABLE public.pricing_rules_raw TO anon;
GRANT ALL ON TABLE public.pricing_rules_raw TO authenticated;
GRANT ALL ON TABLE public.pricing_rules_raw TO service_role;


--
-- Name: TABLE pricing_rules; Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON TABLE public.pricing_rules TO anon;
GRANT ALL ON TABLE public.pricing_rules TO authenticated;
GRANT ALL ON TABLE public.pricing_rules TO service_role;


--
-- Name: TABLE pricing_waiting_rules; Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON TABLE public.pricing_waiting_rules TO anon;
GRANT ALL ON TABLE public.pricing_waiting_rules TO authenticated;
GRANT ALL ON TABLE public.pricing_waiting_rules TO service_role;


--
-- Name: TABLE pricing_zones; Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON TABLE public.pricing_zones TO anon;
GRANT ALL ON TABLE public.pricing_zones TO authenticated;
GRANT ALL ON TABLE public.pricing_zones TO service_role;


--
-- Name: TABLE provider_brand_assets; Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON TABLE public.provider_brand_assets TO anon;
GRANT ALL ON TABLE public.provider_brand_assets TO authenticated;
GRANT ALL ON TABLE public.provider_brand_assets TO service_role;


--
-- Name: TABLE quote_market_adjustments; Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON TABLE public.quote_market_adjustments TO service_role;


--
-- Name: TABLE ratings; Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON TABLE public.ratings TO anon;
GRANT ALL ON TABLE public.ratings TO authenticated;
GRANT ALL ON TABLE public.ratings TO service_role;


--
-- Name: TABLE regional_pricing_rules; Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON TABLE public.regional_pricing_rules TO anon;
GRANT ALL ON TABLE public.regional_pricing_rules TO authenticated;
GRANT ALL ON TABLE public.regional_pricing_rules TO service_role;


--
-- Name: TABLE ride_details; Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON TABLE public.ride_details TO anon;
GRANT ALL ON TABLE public.ride_details TO authenticated;
GRANT ALL ON TABLE public.ride_details TO service_role;


--
-- Name: TABLE schema_migrations; Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON TABLE public.schema_migrations TO anon;
GRANT ALL ON TABLE public.schema_migrations TO authenticated;
GRANT ALL ON TABLE public.schema_migrations TO service_role;


--
-- Name: TABLE service_market_rules; Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON TABLE public.service_market_rules TO anon;
GRANT ALL ON TABLE public.service_market_rules TO authenticated;
GRANT ALL ON TABLE public.service_market_rules TO service_role;


--
-- Name: TABLE service_types; Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON TABLE public.service_types TO anon;
GRANT ALL ON TABLE public.service_types TO authenticated;
GRANT ALL ON TABLE public.service_types TO service_role;


--
-- Name: TABLE stripe_events; Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON TABLE public.stripe_events TO anon;
GRANT ALL ON TABLE public.stripe_events TO authenticated;
GRANT ALL ON TABLE public.stripe_events TO service_role;


--
-- Name: TABLE subscription_plans; Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON TABLE public.subscription_plans TO anon;
GRANT ALL ON TABLE public.subscription_plans TO authenticated;
GRANT ALL ON TABLE public.subscription_plans TO service_role;


--
-- Name: TABLE subscriptions; Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON TABLE public.subscriptions TO postgres;
GRANT SELECT ON TABLE public.subscriptions TO anon;
GRANT SELECT ON TABLE public.subscriptions TO authenticated;
GRANT ALL ON TABLE public.subscriptions TO service_role;


--
-- Name: TABLE system_config; Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON TABLE public.system_config TO anon;
GRANT ALL ON TABLE public.system_config TO authenticated;
GRANT ALL ON TABLE public.system_config TO service_role;


--
-- Name: TABLE system_configs; Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON TABLE public.system_configs TO anon;
GRANT ALL ON TABLE public.system_configs TO authenticated;
GRANT ALL ON TABLE public.system_configs TO service_role;


--
-- Name: TABLE tenant_users; Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON TABLE public.tenant_users TO anon;
GRANT ALL ON TABLE public.tenant_users TO authenticated;
GRANT ALL ON TABLE public.tenant_users TO service_role;


--
-- Name: TABLE tenants; Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON TABLE public.tenants TO anon;
GRANT ALL ON TABLE public.tenants TO authenticated;
GRANT ALL ON TABLE public.tenants TO service_role;


--
-- Name: TABLE van_details; Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON TABLE public.van_details TO anon;
GRANT ALL ON TABLE public.van_details TO authenticated;
GRANT ALL ON TABLE public.van_details TO service_role;


--
-- Name: TABLE vehicles; Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON TABLE public.vehicles TO anon;
GRANT ALL ON TABLE public.vehicles TO authenticated;
GRANT ALL ON TABLE public.vehicles TO service_role;


--
-- Name: TABLE wallet_accounts; Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON TABLE public.wallet_accounts TO postgres;
GRANT SELECT ON TABLE public.wallet_accounts TO authenticated;
GRANT SELECT ON TABLE public.wallet_accounts TO service_role;


--
-- Name: TABLE wallet_business_events; Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON TABLE public.wallet_business_events TO postgres;
GRANT SELECT ON TABLE public.wallet_business_events TO authenticated;
GRANT SELECT ON TABLE public.wallet_business_events TO service_role;


--
-- Name: TABLE wallet_collection_config; Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON TABLE public.wallet_collection_config TO postgres;
GRANT SELECT ON TABLE public.wallet_collection_config TO service_role;


--
-- Name: TABLE wallet_movements; Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON TABLE public.wallet_movements TO postgres;
GRANT SELECT ON TABLE public.wallet_movements TO authenticated;
GRANT SELECT ON TABLE public.wallet_movements TO service_role;


--
-- Name: TABLE wallet_reconciliation_projection; Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON TABLE public.wallet_reconciliation_projection TO postgres;
GRANT ALL ON TABLE public.wallet_reconciliation_projection TO service_role;


--
-- Name: TABLE wallet_topup_attempts; Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON TABLE public.wallet_topup_attempts TO postgres;
GRANT SELECT ON TABLE public.wallet_topup_attempts TO authenticated;
GRANT SELECT ON TABLE public.wallet_topup_attempts TO service_role;


--
-- Name: TABLE wallet_topup_verifications; Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON TABLE public.wallet_topup_verifications TO postgres;
GRANT SELECT ON TABLE public.wallet_topup_verifications TO service_role;


--
-- Name: TABLE wallet_transactions; Type: ACL; Schema: public; Owner: -
--

GRANT SELECT ON TABLE public.wallet_transactions TO anon;
GRANT SELECT ON TABLE public.wallet_transactions TO authenticated;
GRANT ALL ON TABLE public.wallet_transactions TO service_role;


--
-- Name: TABLE wallets; Type: ACL; Schema: public; Owner: -
--

GRANT SELECT ON TABLE public.wallets TO anon;
GRANT SELECT ON TABLE public.wallets TO authenticated;
GRANT ALL ON TABLE public.wallets TO service_role;


--
-- Name: DEFAULT PRIVILEGES FOR SEQUENCES; Type: DEFAULT ACL; Schema: public; Owner: -
--

ALTER DEFAULT PRIVILEGES FOR ROLE postgres IN SCHEMA public GRANT ALL ON SEQUENCES  TO postgres;
ALTER DEFAULT PRIVILEGES FOR ROLE postgres IN SCHEMA public GRANT ALL ON SEQUENCES  TO anon;
ALTER DEFAULT PRIVILEGES FOR ROLE postgres IN SCHEMA public GRANT ALL ON SEQUENCES  TO authenticated;
ALTER DEFAULT PRIVILEGES FOR ROLE postgres IN SCHEMA public GRANT ALL ON SEQUENCES  TO service_role;


--
-- Name: DEFAULT PRIVILEGES FOR SEQUENCES; Type: DEFAULT ACL; Schema: public; Owner: -
--

ALTER DEFAULT PRIVILEGES FOR ROLE supabase_admin IN SCHEMA public GRANT ALL ON SEQUENCES  TO postgres;
ALTER DEFAULT PRIVILEGES FOR ROLE supabase_admin IN SCHEMA public GRANT ALL ON SEQUENCES  TO anon;
ALTER DEFAULT PRIVILEGES FOR ROLE supabase_admin IN SCHEMA public GRANT ALL ON SEQUENCES  TO authenticated;
ALTER DEFAULT PRIVILEGES FOR ROLE supabase_admin IN SCHEMA public GRANT ALL ON SEQUENCES  TO service_role;


--
-- Name: DEFAULT PRIVILEGES FOR FUNCTIONS; Type: DEFAULT ACL; Schema: public; Owner: -
--

ALTER DEFAULT PRIVILEGES FOR ROLE postgres IN SCHEMA public GRANT ALL ON FUNCTIONS  TO postgres;
ALTER DEFAULT PRIVILEGES FOR ROLE postgres IN SCHEMA public GRANT ALL ON FUNCTIONS  TO anon;
ALTER DEFAULT PRIVILEGES FOR ROLE postgres IN SCHEMA public GRANT ALL ON FUNCTIONS  TO authenticated;
ALTER DEFAULT PRIVILEGES FOR ROLE postgres IN SCHEMA public GRANT ALL ON FUNCTIONS  TO service_role;


--
-- Name: DEFAULT PRIVILEGES FOR FUNCTIONS; Type: DEFAULT ACL; Schema: public; Owner: -
--

ALTER DEFAULT PRIVILEGES FOR ROLE supabase_admin IN SCHEMA public GRANT ALL ON FUNCTIONS  TO postgres;
ALTER DEFAULT PRIVILEGES FOR ROLE supabase_admin IN SCHEMA public GRANT ALL ON FUNCTIONS  TO anon;
ALTER DEFAULT PRIVILEGES FOR ROLE supabase_admin IN SCHEMA public GRANT ALL ON FUNCTIONS  TO authenticated;
ALTER DEFAULT PRIVILEGES FOR ROLE supabase_admin IN SCHEMA public GRANT ALL ON FUNCTIONS  TO service_role;


--
-- Name: DEFAULT PRIVILEGES FOR TABLES; Type: DEFAULT ACL; Schema: public; Owner: -
--

ALTER DEFAULT PRIVILEGES FOR ROLE postgres IN SCHEMA public GRANT ALL ON TABLES  TO postgres;
ALTER DEFAULT PRIVILEGES FOR ROLE postgres IN SCHEMA public GRANT ALL ON TABLES  TO anon;
ALTER DEFAULT PRIVILEGES FOR ROLE postgres IN SCHEMA public GRANT ALL ON TABLES  TO authenticated;
ALTER DEFAULT PRIVILEGES FOR ROLE postgres IN SCHEMA public GRANT ALL ON TABLES  TO service_role;


--
-- Name: DEFAULT PRIVILEGES FOR TABLES; Type: DEFAULT ACL; Schema: public; Owner: -
--

ALTER DEFAULT PRIVILEGES FOR ROLE supabase_admin IN SCHEMA public GRANT ALL ON TABLES  TO postgres;
ALTER DEFAULT PRIVILEGES FOR ROLE supabase_admin IN SCHEMA public GRANT ALL ON TABLES  TO anon;
ALTER DEFAULT PRIVILEGES FOR ROLE supabase_admin IN SCHEMA public GRANT ALL ON TABLES  TO authenticated;
ALTER DEFAULT PRIVILEGES FOR ROLE supabase_admin IN SCHEMA public GRANT ALL ON TABLES  TO service_role;


--
-- PostgreSQL database dump complete
--

