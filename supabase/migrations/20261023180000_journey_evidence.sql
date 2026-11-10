BEGIN;
DO $preflight$
BEGIN
  IF to_regclass('public.jobs') IS NULL THEN RAISE EXCEPTION 'Existing jobs table required'; END IF;
  IF EXISTS (
    SELECT 1 FROM (VALUES ('id'),('driver_id'),('tenant_id'),('status')) needed(column_name)
    WHERE NOT EXISTS (SELECT 1 FROM information_schema.columns c
      WHERE c.table_schema='public' AND c.table_name='jobs' AND c.column_name=needed.column_name)
  ) THEN RAISE EXCEPTION 'Journey evidence schema preflight failed'; END IF;
END
$preflight$;

-- Separate from legacy/client-written job_locations; this table is service-only.
CREATE TABLE public.journey_evidence_v23 (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  job_id uuid NOT NULL REFERENCES public.jobs(id) ON DELETE CASCADE,
  driver_id uuid NOT NULL,
  tenant_id uuid NOT NULL,
  latitude double precision NOT NULL CHECK (latitude BETWEEN -90 AND 90),
  longitude double precision NOT NULL CHECK (longitude BETWEEN -180 AND 180),
  accuracy_metres double precision NOT NULL CHECK (accuracy_metres BETWEEN 0 AND 100),
  sampled_at timestamptz NOT NULL,
  received_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  booking_phase text NOT NULL,
  UNIQUE(job_id,sampled_at)
);
CREATE INDEX journey_evidence_v23_job_time ON public.journey_evidence_v23(job_id,sampled_at DESC);
CREATE INDEX journey_evidence_v23_received ON public.journey_evidence_v23(received_at);
ALTER TABLE public.journey_evidence_v23 ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.journey_evidence_v23 FROM PUBLIC,anon,authenticated,service_role;
GRANT SELECT ON public.journey_evidence_v23 TO service_role;
REVOKE ALL ON SEQUENCE public.journey_evidence_v23_id_seq FROM PUBLIC,anon,authenticated,service_role;

CREATE OR REPLACE FUNCTION public.append_journey_evidence_v23(
  p_job_id uuid,p_driver_id uuid,p_tenant_id uuid,
  p_lat double precision,p_lng double precision,p_accuracy double precision,p_sampled_at timestamptz
) RETURNS text LANGUAGE plpgsql SECURITY DEFINER
SET search_path=pg_catalog,public
AS $function$
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
$function$;
REVOKE ALL ON FUNCTION public.append_journey_evidence_v23(uuid,uuid,uuid,double precision,double precision,double precision,timestamptz)
  FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.append_journey_evidence_v23(uuid,uuid,uuid,double precision,double precision,double precision,timestamptz)
  TO service_role;
COMMENT ON TABLE public.journey_evidence_v23 IS
  'Restricted driver-reported GPS samples received through authenticated journey ingestion. Not independent proof of travel and not a payable-distance ledger.';
NOTIFY pgrst,'reload schema';
COMMIT;
