BEGIN;
CREATE TABLE IF NOT EXISTS public.app_presence_sessions (
 user_id uuid NOT NULL REFERENCES public.profiles(id) ON DELETE CASCADE,
 session_id uuid NOT NULL, seen_at timestamptz NOT NULL,
 PRIMARY KEY(user_id,session_id)
);
CREATE INDEX IF NOT EXISTS app_presence_seen_idx ON public.app_presence_sessions(seen_at);
ALTER TABLE public.app_presence_sessions ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.app_presence_sessions FROM PUBLIC,anon,authenticated;
GRANT ALL ON public.app_presence_sessions TO service_role;
CREATE OR REPLACE FUNCTION public.touch_app_presence(p_session uuid) RETURNS void
 LANGUAGE plpgsql SECURITY DEFINER SET search_path=public AS $$
DECLARE actor uuid:=auth.uid();
BEGIN
 IF actor IS NULL OR p_session IS NULL THEN RAISE EXCEPTION 'Authentication required' USING ERRCODE='42501'; END IF;
 IF NOT EXISTS(SELECT 1 FROM profiles WHERE id=actor) THEN RETURN; END IF;
 INSERT INTO app_presence_sessions VALUES(actor,p_session,clock_timestamp())
 ON CONFLICT(user_id,session_id) DO UPDATE SET seen_at=EXCLUDED.seen_at;
 DELETE FROM app_presence_sessions WHERE user_id=actor AND seen_at<now()-interval '1 day';
END;$$;
CREATE OR REPLACE FUNCTION public.admin_live_presence() RETURNS jsonb
 LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=public AS $$
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
REVOKE ALL ON FUNCTION public.touch_app_presence(uuid),public.admin_live_presence() FROM PUBLIC,anon;
GRANT EXECUTE ON FUNCTION public.touch_app_presence(uuid),public.admin_live_presence() TO authenticated;
-- Financial metrics remain unchanged; the existing count now observes role and presence.
CREATE OR REPLACE VIEW public.operations_metrics_v3 AS
 SELECT jobs.tenant_id,
 count(*) FILTER(WHERE jobs.status=ANY(ARRAY['accepted'::text,'in_progress'::text])) AS active_jobs_count,
 sum(jobs.price) FILTER(WHERE jobs.status='completed' AND jobs.created_at>=CURRENT_DATE) AS revenue_today,
 sum(jobs.platform_fee) FILTER(WHERE jobs.status='completed' AND jobs.created_at>=CURRENT_DATE) AS platform_earnings_today,
 sum(jobs.driver_payout) FILTER(WHERE jobs.status='completed' AND jobs.created_at>=CURRENT_DATE) AS driver_payouts_today,
 count(*) FILTER(WHERE jobs.pricing_plan_used='pro') AS pro_jobs_count,
 count(*) FILTER(WHERE jobs.pricing_plan_used='starter') AS starter_jobs_count,
 (SELECT count(*) FROM profiles p WHERE p.role='driver' AND p.is_online=true AND p.tenant_id=jobs.tenant_id
 AND EXISTS(SELECT 1 FROM app_presence_sessions s WHERE s.user_id=p.id AND s.seen_at>now()-interval '2 minutes')) AS online_drivers_count,
 (SELECT count(*) FROM profiles WHERE profiles.pricing_plan='pro' AND profiles.tenant_id=jobs.tenant_id) AS total_pro_drivers
 FROM jobs GROUP BY jobs.tenant_id;
NOTIFY pgrst,'reload schema';
COMMIT;
