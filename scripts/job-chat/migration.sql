-- Job chat: participant-only reads, API-only sends, receiver-only read receipts.
BEGIN;
DO $$ BEGIN
 IF to_regclass('public.job_messages') IS NULL THEN RAISE EXCEPTION 'Existing job_messages table missing'; END IF;
END $$;
CREATE OR REPLACE FUNCTION public.job_chat_is_current_participant(p_job_id uuid)
RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path=public,pg_temp AS $$
 SELECT EXISTS(SELECT 1 FROM public.jobs j WHERE j.id=p_job_id AND auth.uid() IS NOT NULL
 AND (j.customer_id=auth.uid() OR coalesce(j.driver_id,j.accepted_driver_id)=auth.uid()));
$$;
REVOKE ALL ON FUNCTION public.job_chat_is_current_participant(uuid) FROM PUBLIC,anon;
GRANT EXECUTE ON FUNCTION public.job_chat_is_current_participant(uuid) TO authenticated,service_role;
ALTER TABLE public.job_messages ENABLE ROW LEVEL SECURITY;
DO $$ DECLARE p record; BEGIN
 FOR p IN SELECT policyname FROM pg_policies WHERE schemaname='public' AND tablename='job_messages'
 AND policyname <> 'Admins can read messages for jobs in their tenant'
 LOOP EXECUTE format('DROP POLICY %I ON public.job_messages',p.policyname); END LOOP;
END $$;
CREATE POLICY job_chat_participant_read ON public.job_messages FOR SELECT TO authenticated
 USING(public.job_chat_is_current_participant(job_id));
CREATE POLICY job_chat_receiver_read_receipt ON public.job_messages FOR UPDATE TO authenticated
 USING(receiver_id=auth.uid() AND public.job_chat_is_current_participant(job_id))
 WITH CHECK(receiver_id=auth.uid() AND public.job_chat_is_current_participant(job_id));
REVOKE ALL ON public.job_messages FROM PUBLIC,anon,authenticated;
GRANT SELECT ON public.job_messages TO authenticated;
GRANT UPDATE(read_at) ON public.job_messages TO authenticated;
GRANT SELECT,INSERT,UPDATE,DELETE ON public.job_messages TO service_role;
DO $$ BEGIN
 IF EXISTS(SELECT 1 FROM pg_publication WHERE pubname='supabase_realtime') AND
 NOT EXISTS(SELECT 1 FROM pg_publication_tables WHERE pubname='supabase_realtime' AND schemaname='public' AND tablename='job_messages') THEN
  ALTER PUBLICATION supabase_realtime ADD TABLE public.job_messages;
 END IF;
END $$;
NOTIFY pgrst,'reload schema';
COMMIT;
