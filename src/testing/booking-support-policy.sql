BEGIN;
CREATE SCHEMA movabi_booking_support_test;SET search_path=movabi_booking_support_test;
CREATE TABLE profiles(id uuid PRIMARY KEY);
CREATE TABLE jobs(id uuid PRIMARY KEY,customer_id uuid,driver_id uuid,accepted_driver_id uuid,tenant_id uuid);
INSERT INTO profiles VALUES ('11111111-1111-1111-1111-111111111111'),('22222222-2222-2222-2222-222222222222'),('33333333-3333-3333-3333-333333333333');
INSERT INTO jobs VALUES ('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa','11111111-1111-1111-1111-111111111111','22222222-2222-2222-2222-222222222222',NULL,'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb');
CREATE TABLE IF NOT EXISTS movabi_booking_support_test.booking_support_requests (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
 request_id uuid NOT NULL,user_id uuid NOT NULL REFERENCES movabi_booking_support_test.profiles(id) ON DELETE CASCADE,
 job_id uuid NOT NULL REFERENCES movabi_booking_support_test.jobs(id) ON DELETE CASCADE,tenant_id uuid,
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
CREATE INDEX IF NOT EXISTS booking_support_email_due ON movabi_booking_support_test.booking_support_requests(retry_at)
 WHERE email_status<>'sent';
CREATE INDEX IF NOT EXISTS booking_support_user_created ON movabi_booking_support_test.booking_support_requests(user_id,created_at);
ALTER TABLE movabi_booking_support_test.booking_support_requests ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON movabi_booking_support_test.booking_support_requests FROM PUBLIC,anon,authenticated;
GRANT ALL ON movabi_booking_support_test.booking_support_requests TO service_role;
CREATE OR REPLACE FUNCTION movabi_booking_support_test.create_booking_support_request(
 p_user_id uuid,p_job_id uuid,p_request_id uuid,p_category text,p_message text,p_email text,
 p_tenant_id uuid,p_country text,p_city text,p_driver_id uuid
) RETURNS SETOF movabi_booking_support_test.booking_support_requests
LANGUAGE plpgsql SECURITY DEFINER SET search_path=movabi_booking_support_test,pg_temp AS $$
DECLARE r movabi_booking_support_test.booking_support_requests%ROWTYPE;
BEGIN
 PERFORM pg_advisory_xact_lock(hashtextextended(p_user_id::text,42));
 SELECT * INTO r FROM movabi_booking_support_test.booking_support_requests WHERE user_id=p_user_id AND request_id=p_request_id;
 IF FOUND THEN
  IF r.job_id IS DISTINCT FROM p_job_id OR r.category IS DISTINCT FROM p_category OR r.message IS DISTINCT FROM p_message THEN
   RAISE EXCEPTION 'Request reference reused with different content';
  END IF;
  RETURN NEXT r;RETURN;
 END IF;
 IF NOT EXISTS(SELECT 1 FROM movabi_booking_support_test.jobs WHERE id=p_job_id AND tenant_id IS NOT DISTINCT FROM p_tenant_id
  AND (customer_id=p_user_id OR coalesce(driver_id,accepted_driver_id)=p_user_id)) THEN
  RAISE EXCEPTION 'Only booking participants may contact support';
 END IF;
 IF (SELECT count(*) FROM movabi_booking_support_test.booking_support_requests WHERE user_id=p_user_id AND created_at>now()-interval '15 minutes')>=5 THEN
  RAISE EXCEPTION 'Too many support requests. Please wait before starting another request.';
 END IF;
 INSERT INTO movabi_booking_support_test.booking_support_requests(request_id,user_id,job_id,tenant_id,category,message,sender_email,country_code,market_city,driver_id)
 VALUES(p_request_id,p_user_id,p_job_id,p_tenant_id,p_category,p_message,p_email,p_country,p_city,p_driver_id)
 RETURNING * INTO r;
 RETURN NEXT r;
END $$;
CREATE OR REPLACE FUNCTION movabi_booking_support_test.claim_booking_support_email(p_id uuid DEFAULT NULL)
RETURNS SETOF movabi_booking_support_test.booking_support_requests
LANGUAGE plpgsql SECURITY DEFINER SET search_path=movabi_booking_support_test,pg_temp AS $$
DECLARE selected uuid;
BEGIN
 SELECT id INTO selected FROM movabi_booking_support_test.booking_support_requests
 WHERE (p_id IS NULL OR id=p_id) AND email_status<>'sent'
 AND retry_at<=now() AND (lease_until IS NULL OR lease_until<now())
 ORDER BY created_at LIMIT 1 FOR UPDATE SKIP LOCKED;
 IF NOT FOUND THEN RETURN;END IF;
 RETURN QUERY UPDATE movabi_booking_support_test.booking_support_requests SET email_status='processing',
 lease_token=gen_random_uuid(),lease_until=now()+interval '10 minutes',attempt_count=attempt_count+1
 WHERE id=selected RETURNING *;
END $$;
REVOKE ALL ON FUNCTION movabi_booking_support_test.create_booking_support_request(uuid,uuid,uuid,text,text,text,uuid,text,text,uuid) FROM PUBLIC,anon,authenticated;
REVOKE ALL ON FUNCTION movabi_booking_support_test.claim_booking_support_email(uuid) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION movabi_booking_support_test.create_booking_support_request(uuid,uuid,uuid,text,text,text,uuid,text,text,uuid) TO service_role;
GRANT EXECUTE ON FUNCTION movabi_booking_support_test.claim_booking_support_email(uuid) TO service_role;
NOTIFY pgrst,'reload schema';

GRANT USAGE ON SCHEMA movabi_booking_support_test TO authenticated,service_role;
SET search_path=movabi_booking_support_test;
SELECT id FROM create_booking_support_request('11111111-1111-1111-1111-111111111111','aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa','cccccccc-cccc-cccc-cccc-cccccccccccc','help','Please help',NULL,'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb','GB','Bolton','22222222-2222-2222-2222-222222222222');
SELECT id FROM create_booking_support_request('11111111-1111-1111-1111-111111111111','aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa','cccccccc-cccc-cccc-cccc-cccccccccccc','help','Please help',NULL,'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb','GB','Bolton','22222222-2222-2222-2222-222222222222');
DO $$ DECLARE t uuid; rows integer; BEGIN
 IF (SELECT count(*) FROM booking_support_requests)<>1 THEN RAISE EXCEPTION 'Duplicate submission created another ticket';END IF;
 BEGIN PERFORM create_booking_support_request('11111111-1111-1111-1111-111111111111','aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa','cccccccc-cccc-cccc-cccc-cccccccccccc','help','Different message',NULL,'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb','GB','Bolton',NULL);RAISE EXCEPTION 'Expected rejection';EXCEPTION WHEN OTHERS THEN IF SQLERRM NOT LIKE '%reference reused%' THEN RAISE;END IF;END;
 BEGIN PERFORM create_booking_support_request('33333333-3333-3333-3333-333333333333','aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa',gen_random_uuid(),'help','Please help',NULL,'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb','GB','Bolton',NULL);RAISE EXCEPTION 'Expected rejection';EXCEPTION WHEN OTHERS THEN IF SQLERRM NOT LIKE '%Only booking participants%' THEN RAISE;END IF;END;
 BEGIN PERFORM create_booking_support_request('11111111-1111-1111-1111-111111111111','aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa',gen_random_uuid(),'help','Please help',NULL,NULL,'GB','Bolton',NULL);RAISE EXCEPTION 'Expected rejection';EXCEPTION WHEN OTHERS THEN IF SQLERRM NOT LIKE '%Only booking participants%' THEN RAISE;END IF;END;
 SELECT id INTO t FROM booking_support_requests LIMIT 1;
 SELECT count(*) INTO rows FROM claim_booking_support_email(t);IF rows<>1 THEN RAISE EXCEPTION 'First delivery claim failed';END IF;
 SELECT count(*) INTO rows FROM claim_booking_support_email(t);IF rows<>0 THEN RAISE EXCEPTION 'Concurrent worker claimed leased email';END IF;
 UPDATE booking_support_requests SET email_status='pending',lease_until=now()-interval '1 minute' WHERE id=t;
 SELECT count(*) INTO rows FROM claim_booking_support_email(t);IF rows<>1 THEN RAISE EXCEPTION 'Expired lease was not recovered';END IF;
 UPDATE booking_support_requests SET email_status='sent',lease_until=NULL WHERE id=t;
 SELECT count(*) INTO rows FROM claim_booking_support_email(t);IF rows<>0 THEN RAISE EXCEPTION 'Sent email was claimed again';END IF;
 FOR i IN 1..4 LOOP PERFORM create_booking_support_request('11111111-1111-1111-1111-111111111111','aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa',gen_random_uuid(),'help','Please help',NULL,'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb','GB','Bolton',NULL);END LOOP;
 BEGIN PERFORM create_booking_support_request('11111111-1111-1111-1111-111111111111','aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa',gen_random_uuid(),'help','Please help',NULL,'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb','GB','Bolton',NULL);RAISE EXCEPTION 'Expected rejection';EXCEPTION WHEN OTHERS THEN IF SQLERRM NOT LIKE '%Too many support%' THEN RAISE;END IF;END;
END $$;
SET ROLE authenticated;
DO $$ BEGIN
 BEGIN PERFORM count(*) FROM movabi_booking_support_test.booking_support_requests;RAISE EXCEPTION 'Browser role could read support table';EXCEPTION WHEN insufficient_privilege THEN NULL;END;
 BEGIN PERFORM movabi_booking_support_test.claim_booking_support_email(NULL);RAISE EXCEPTION 'Browser role could claim delivery';EXCEPTION WHEN insufficient_privilege THEN NULL;END;
END $$;
RESET ROLE;
DELETE FROM jobs WHERE id='aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa';
DO $$ BEGIN IF EXISTS(SELECT 1 FROM booking_support_requests) THEN RAISE EXCEPTION 'Booking cleanup did not cascade support rows';END IF;END $$;
SELECT 'BOOKING_SUPPORT_SQL_TESTS=PASSED' AS result;
ROLLBACK;