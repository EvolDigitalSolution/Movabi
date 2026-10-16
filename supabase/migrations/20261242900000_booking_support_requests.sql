BEGIN;
CREATE TABLE IF NOT EXISTS public.booking_support_requests (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
 request_id uuid NOT NULL,user_id uuid NOT NULL REFERENCES public.profiles(id) ON DELETE CASCADE,
 job_id uuid NOT NULL REFERENCES public.jobs(id) ON DELETE CASCADE,tenant_id uuid,
 category text NOT NULL CHECK(category IN ('help','issue','payment','safety','lost_item')),
 message text NOT NULL CHECK(length(message) BETWEEN 3 AND 2000 AND (category<>'lost_item' OR length(message)<=1500)),sender_email text,
 country_code text,market_city text,driver_id uuid,
 status text NOT NULL DEFAULT 'open' CHECK(status IN ('open','resolved')),
 email_status text NOT NULL DEFAULT 'pending' CHECK(email_status IN ('pending','processing','sent')),
 email_sent_at timestamptz,driver_message_saved boolean NOT NULL DEFAULT false,
 attempt_count integer NOT NULL DEFAULT 0,retry_at timestamptz NOT NULL DEFAULT now(),
 lease_token uuid,lease_until timestamptz,last_error text,
 created_at timestamptz NOT NULL DEFAULT now(),UNIQUE(user_id,request_id)
);
CREATE INDEX IF NOT EXISTS booking_support_email_due ON public.booking_support_requests(retry_at)
 WHERE email_status<>'sent';
CREATE INDEX IF NOT EXISTS booking_support_user_created ON public.booking_support_requests(user_id,created_at);
ALTER TABLE public.booking_support_requests ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.booking_support_requests FROM PUBLIC,anon,authenticated;
GRANT ALL ON public.booking_support_requests TO service_role;
CREATE OR REPLACE FUNCTION public.create_booking_support_request(
 p_user_id uuid,p_job_id uuid,p_request_id uuid,p_category text,p_message text,p_email text,
 p_tenant_id uuid,p_country text,p_city text,p_driver_id uuid
) RETURNS SETOF public.booking_support_requests
LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
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
CREATE OR REPLACE FUNCTION public.claim_booking_support_email(p_id uuid DEFAULT NULL)
RETURNS SETOF public.booking_support_requests
LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
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
REVOKE ALL ON FUNCTION public.create_booking_support_request(uuid,uuid,uuid,text,text,text,uuid,text,text,uuid) FROM PUBLIC,anon,authenticated;
REVOKE ALL ON FUNCTION public.claim_booking_support_email(uuid) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.create_booking_support_request(uuid,uuid,uuid,text,text,text,uuid,text,text,uuid) TO service_role;
GRANT EXECUTE ON FUNCTION public.claim_booking_support_email(uuid) TO service_role;
NOTIFY pgrst,'reload schema';
COMMIT;
