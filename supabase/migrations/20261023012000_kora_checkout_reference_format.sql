BEGIN;
ALTER TABLE public.kora_sandbox_sessions
 DROP CONSTRAINT kora_sandbox_sessions_reference_check;
ALTER TABLE public.kora_sandbox_sessions
 ADD CONSTRAINT kora_sandbox_sessions_reference_check
 CHECK(reference ~ '^vaydu-(test-[a-f0-9]{32}|kora-test-[a-f0-9]{64})$');
COMMIT;
