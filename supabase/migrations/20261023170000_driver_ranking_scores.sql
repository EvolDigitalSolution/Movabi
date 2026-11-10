BEGIN;

DO $preflight$
BEGIN
  IF to_regclass('public.jobs') IS NULL OR to_regclass('public.ratings') IS NULL THEN
    RAISE EXCEPTION 'Driver ranking requires existing jobs and ratings tables';
  END IF;
  IF EXISTS (
    SELECT 1 FROM (VALUES
      ('jobs','id'),('jobs','driver_id'),('jobs','customer_id'),('jobs','status'),
      ('ratings','id'),('ratings','job_id'),('ratings','customer_id'),('ratings','score'),('ratings','created_at')
    ) AS needed(table_name,column_name)
    WHERE NOT EXISTS (
      SELECT 1 FROM information_schema.columns c
      WHERE c.table_schema='public' AND c.table_name=needed.table_name AND c.column_name=needed.column_name
    )
  ) THEN RAISE EXCEPTION 'Driver ranking schema preflight failed'; END IF;
END
$preflight$;

-- Service-only read: no profiles, jobs, payment or rating rows are changed.
CREATE OR REPLACE FUNCTION public.driver_ranking_scores_v23(p_driver_ids uuid[])
RETURNS TABLE(driver_id uuid, average_score numeric, review_count bigint)
LANGUAGE plpgsql STABLE SECURITY DEFINER
SET search_path = pg_catalog, public
AS $function$
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
$function$;

REVOKE ALL ON FUNCTION public.driver_ranking_scores_v23(uuid[]) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.driver_ranking_scores_v23(uuid[]) TO service_role;
COMMENT ON FUNCTION public.driver_ranking_scores_v23(uuid[]) IS
  'Service-only ranking input: latest 100 verified completed-booking reviews per eligible candidate; does not mutate operational data.';
COMMIT;
