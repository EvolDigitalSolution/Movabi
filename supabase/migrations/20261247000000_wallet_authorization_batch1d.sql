-- Batch 1D: client financial authorization. ACL/RLS only; no balance changes,
-- provider-specific logic, RPC body changes, feature activation or layout changes.
BEGIN;
SET LOCAL search_path=pg_catalog,public;
CREATE TEMP TABLE _b1d_expected_rpc(signature text PRIMARY KEY,service_execute boolean,body_md5 text) ON COMMIT DROP;
INSERT INTO _b1d_expected_rpc VALUES
 ('public.approve_errand_over_budget(uuid)',true,'5f87d2b4d18a504cabdc827f33dfc8d1'),
 ('auth.cancel_job_safely(uuid)',true,'ab2833ffa05f56e40150951953700409'),
 ('auth.cancel_job_safely(uuid,text)',true,'bb146e293625148e9593d1164c92a90c'),
 ('auth.finalize_wallet_topup(uuid,numeric,text)',true,'b8d6e74584ebbc5567b84d2f8fb036e2'),
 ('auth.finalize_wallet_topup(uuid,numeric,text,text)',true,'e0ac080da2426157e62437d6b541a440'),
 ('auth.release_job_wallet_reservation(uuid,text)',true,'eeeab723410bdea784db76824b3c85c2'),
 ('auth.reserve_errand_funds(uuid,uuid,numeric,numeric)',true,'70ec3f148c4925e5aa2df6ee95cfbd38'),
 ('public.cancel_job_safely(uuid,text)',true,'6c60ef96336f52720590728913035c53'),
 ('public.credit_wallet_topup(uuid,numeric,text,text)',false,'5cf8fea7b88e25ad43b17dafe759b85a'),
 ('public.credit_wallet_topup(uuid,numeric,text,text,jsonb)',false,'08e51156ea7478f2866ab0cf4e3933a8'),
 ('public.finalize_wallet_topup(numeric,text,text,uuid)',true,'fb2bc12126daecee290732d51d566733'),
 ('public.finalize_wallet_topup_legacy_incompatible(uuid,numeric,text,text)',false,'e0ac080da2426157e62437d6b541a440'),
 ('public.pay_job_from_wallet(uuid,uuid,numeric,text,uuid)',true,'3429a6979b05404e780a339febcdfc42'),
 ('public.release_job_wallet_reservation(uuid,text)',true,'7dc12da11b4fd4d24adbce3784b899df'),
 ('public.settle_errand_funds(uuid)',true,'cba966733ad7034bb1dc9211de39b183'),
 ('public.settle_job_wallet_reservation(uuid,numeric)',true,'2bc02bdd6c003e6d9f9174e4c6d3ebf7'),
 ('public.validate_wallet_integrity(uuid)',true,'3a443c6dee4a86317d33dfcb1c3da97c');
DO $$
DECLARE t text; r text; f record;
BEGIN
 FOREACH t IN ARRAY ARRAY['wallets','wallet_transactions','driver_earnings'] LOOP
  IF NOT EXISTS(SELECT 1 FROM pg_class WHERE oid=to_regclass('public.'||t)
    AND relkind='r' AND relrowsecurity AND relpersistence='p') THEN
   RAISE EXCEPTION 'Batch 1D: expected persistent RLS table %',t;
  END IF;
 END LOOP;
 FOREACH r IN ARRAY ARRAY['anon','authenticated'] LOOP
  IF NOT EXISTS(SELECT 1 FROM pg_roles WHERE rolname=r AND NOT rolsuper AND NOT rolbypassrls)
     OR EXISTS(SELECT 1 FROM pg_class WHERE oid IN ('public.wallets'::regclass,'public.wallet_transactions'::regclass,'public.driver_earnings'::regclass)
       AND pg_has_role(r::name,relowner,'USAGE')) THEN
    RAISE EXCEPTION 'Batch 1D: client role % can bypass RLS',r;
  END IF;
 END LOOP;
 IF NOT EXISTS(SELECT 1 FROM pg_roles WHERE rolname='service_role' AND rolbypassrls) THEN
  RAISE EXCEPTION 'Batch 1D: expected service_role BYPASSRLS';
 END IF;
 FOR f IN SELECT * FROM _b1d_expected_rpc LOOP
  IF to_regprocedure(f.signature) IS NULL THEN RAISE EXCEPTION 'Batch 1D: missing inspected RPC %',f.signature; END IF;
  IF (SELECT md5(regexp_replace(prosrc,'[[:space:]]','','g')) FROM pg_proc WHERE oid=to_regprocedure(f.signature)) IS DISTINCT FROM f.body_md5 THEN
   RAISE EXCEPTION 'Batch 1D: unreviewed RPC body drift %',f.signature;
  END IF;
  IF has_function_privilege('service_role',to_regprocedure(f.signature),'EXECUTE') IS DISTINCT FROM f.service_execute THEN
   RAISE EXCEPTION 'Batch 1D: unreviewed service EXECUTE drift %',f.signature;
  END IF;
 END LOOP;
 IF EXISTS(SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
   WHERE n.nspname IN ('public','auth') AND p.prokind='f'
   AND EXISTS(SELECT 1 FROM _b1d_expected_rpc e JOIN pg_proc ep ON ep.oid=to_regprocedure(e.signature)
      WHERE ep.proname=p.proname AND ep.pronamespace=p.pronamespace)
   AND NOT EXISTS(SELECT 1 FROM _b1d_expected_rpc WHERE to_regprocedure(signature)=p.oid)) THEN
  RAISE EXCEPTION 'Batch 1D: unexpected financial RPC overload';
 END IF;
 IF NOT has_function_privilege('authenticated','public.approve_errand_over_budget(uuid)','EXECUTE')
    OR has_function_privilege('anon','public.approve_errand_over_budget(uuid)','EXECUTE') THEN
  RAISE EXCEPTION 'Batch 1D: unreviewed customer approval privilege drift';
 END IF;
 IF to_regprocedure('public.wallet_collection_enabled()') IS NULL THEN
  RAISE EXCEPTION 'Batch 1D: applied Batch 1C required';
 END IF;
 IF public.wallet_collection_enabled() IS DISTINCT FROM false THEN
  RAISE EXCEPTION 'Batch 1D: collection must remain disabled';
 END IF;
END $$;
LOCK TABLE public.wallets,public.wallet_transactions,public.driver_earnings IN SHARE ROW EXCLUSIVE MODE;
CREATE TEMP TABLE _b1d_rpc_before ON COMMIT DROP AS
 SELECT to_regprocedure(signature)::oid AS oid,pg_get_functiondef(to_regprocedure(signature)) AS definition FROM _b1d_expected_rpc;
CREATE TEMP TABLE _b1d_trigger_before ON COMMIT DROP AS
 SELECT oid,tgrelid,tgname,tgenabled,pg_get_triggerdef(oid) AS definition
 FROM pg_trigger WHERE NOT tgisinternal AND tgrelid IN ('public.wallets'::regclass,'public.wallet_transactions'::regclass,'public.jobs'::regclass,'auth.users'::regclass);
CREATE TEMP TABLE _b1d_service_before ON COMMIT DROP AS
 SELECT t,r,has_table_privilege('service_role','public.'||t,r) AS allowed
 FROM unnest(ARRAY['wallets','wallet_transactions','driver_earnings']) t
 CROSS JOIN unnest(ARRAY['SELECT','INSERT','UPDATE','DELETE','TRUNCATE','REFERENCES','TRIGGER']) r;
CREATE TEMP TABLE _b1d_reads_before ON COMMIT DROP AS
 SELECT t,r,has_table_privilege(r,'public.'||t,'SELECT') AS allowed
 FROM unnest(ARRAY['wallets','wallet_transactions','driver_earnings']) t
 CROSS JOIN unnest(ARRAY['anon','authenticated','service_role']) r;
DO $$
DECLARE t text; r text; c record; f record; pname text; command text; pol record;
BEGIN
 FOREACH t IN ARRAY ARRAY['wallets','wallet_transactions','driver_earnings'] LOOP
  EXECUTE format('REVOKE INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER ON TABLE public.%I FROM PUBLIC,anon,authenticated',t);
  -- Table-level REVOKE does not remove column grants.
  FOR c IN SELECT attname FROM pg_attribute WHERE attrelid=('public.'||t)::regclass AND attnum>0 AND NOT attisdropped LOOP
   EXECUTE format('REVOKE INSERT(%I),UPDATE(%I),REFERENCES(%I) ON public.%I FROM PUBLIC,anon,authenticated',c.attname,c.attname,c.attname,t);
  END LOOP;
  -- Defense in depth if a future migration accidentally restores a client grant.
  FOREACH command IN ARRAY ARRAY['INSERT','UPDATE','DELETE'] LOOP
   pname:='batch1d_client_no_'||lower(command);
   SELECT * INTO pol FROM pg_policy WHERE polrelid=('public.'||t)::regclass AND polname=pname;
   IF FOUND THEN
    IF pol.polpermissive OR pol.polcmd IS DISTINCT FROM (CASE command WHEN 'INSERT' THEN 'a' WHEN 'UPDATE' THEN 'w' ELSE 'd' END)::"char"
      OR ARRAY(SELECT unnest(pol.polroles) ORDER BY 1) IS DISTINCT FROM (SELECT array_agg(oid ORDER BY oid) FROM pg_roles WHERE rolname IN ('anon','authenticated'))
      OR (command<>'INSERT' AND pg_get_expr(pol.polqual,pol.polrelid) IS DISTINCT FROM 'false')
      OR (command<>'DELETE' AND pg_get_expr(pol.polwithcheck,pol.polrelid) IS DISTINCT FROM 'false') THEN
       RAISE EXCEPTION 'Batch 1D: conflicting policy %.%',t,pname;
    END IF;
   ELSE
    EXECUTE format('CREATE POLICY %I ON public.%I AS RESTRICTIVE FOR %s TO anon,authenticated %s',pname,t,command,
      CASE command WHEN 'INSERT' THEN 'WITH CHECK(false)' WHEN 'UPDATE' THEN 'USING(false) WITH CHECK(false)' ELSE 'USING(false)' END);
   END IF;
  END LOOP;
 END LOOP;
 -- Preserve effective service authority even if it previously came via PUBLIC.
 FOR f IN SELECT * FROM _b1d_service_before WHERE allowed LOOP
  IF NOT has_table_privilege('service_role','public.'||f.t,f.r) THEN
   EXECUTE format('GRANT %s ON TABLE public.%I TO service_role',f.r,f.t);
  END IF;
 END LOOP;
 FOR f IN SELECT * FROM _b1d_expected_rpc WHERE signature<>'public.approve_errand_over_budget(uuid)' LOOP
  EXECUTE format('REVOKE ALL ON FUNCTION %s FROM PUBLIC,anon,authenticated',to_regprocedure(f.signature));
  IF f.service_execute AND NOT has_function_privilege('service_role',to_regprocedure(f.signature),'EXECUTE') THEN
   EXECUTE format('GRANT EXECUTE ON FUNCTION %s TO service_role',to_regprocedure(f.signature));
  END IF;
 END LOOP;
END $$;
DO $$
DECLARE t text;r text;c record;f record;
BEGIN
 FOREACH t IN ARRAY ARRAY['wallets','wallet_transactions','driver_earnings'] LOOP
  FOREACH r IN ARRAY ARRAY['anon','authenticated'] LOOP
   IF has_table_privilege(r,'public.'||t,'INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER') THEN
    RAISE EXCEPTION 'Batch 1D: remaining inherited client table privilege % %',r,t;
   END IF;
   FOR c IN SELECT attname FROM pg_attribute WHERE attrelid=('public.'||t)::regclass AND attnum>0 AND NOT attisdropped LOOP
    IF has_column_privilege(r,'public.'||t,c.attname,'INSERT,UPDATE,REFERENCES') THEN
      RAISE EXCEPTION 'Batch 1D: remaining inherited client column privilege % %.%',r,t,c.attname;
    END IF;
   END LOOP;
  END LOOP;
 END LOOP;
 FOR f IN SELECT * FROM _b1d_expected_rpc LOOP
  IF f.signature<>'public.approve_errand_over_budget(uuid)' AND
     (has_function_privilege('anon',to_regprocedure(f.signature),'EXECUTE') OR has_function_privilege('authenticated',to_regprocedure(f.signature),'EXECUTE')) THEN
   RAISE EXCEPTION 'Batch 1D: remaining inherited RPC EXECUTE %',f.signature;
  END IF;
  IF has_function_privilege('service_role',to_regprocedure(f.signature),'EXECUTE') IS DISTINCT FROM f.service_execute THEN
   RAISE EXCEPTION 'Batch 1D: service EXECUTE changed %',f.signature;
  END IF;
 END LOOP;
 IF NOT has_function_privilege('authenticated','public.approve_errand_over_budget(uuid)','EXECUTE') THEN RAISE EXCEPTION 'Batch 1D: customer approval lost'; END IF;
 IF EXISTS(SELECT 1 FROM _b1d_rpc_before WHERE pg_get_functiondef(oid) IS DISTINCT FROM definition) THEN RAISE EXCEPTION 'Batch 1D: RPC body changed'; END IF;
 IF EXISTS(SELECT 1 FROM _b1d_service_before b WHERE b.allowed IS DISTINCT FROM has_table_privilege('service_role','public.'||b.t,b.r)) THEN RAISE EXCEPTION 'Batch 1D: service table authority changed'; END IF;
 IF EXISTS(SELECT 1 FROM _b1d_reads_before b WHERE b.allowed IS DISTINCT FROM has_table_privilege(b.r,'public.'||b.t,'SELECT')) THEN RAISE EXCEPTION 'Batch 1D: read grants changed'; END IF;
 IF EXISTS(
  WITH after AS (SELECT oid,tgrelid,tgname,tgenabled,pg_get_triggerdef(oid) AS definition
    FROM pg_trigger WHERE NOT tgisinternal AND tgrelid IN ('public.wallets'::regclass,'public.wallet_transactions'::regclass,'public.jobs'::regclass,'auth.users'::regclass))
  (SELECT * FROM _b1d_trigger_before EXCEPT SELECT * FROM after) UNION ALL
  (SELECT * FROM after EXCEPT SELECT * FROM _b1d_trigger_before)
 ) THEN RAISE EXCEPTION 'Batch 1D: existing triggers changed'; END IF;
 IF public.wallet_collection_enabled() IS DISTINCT FROM false THEN RAISE EXCEPTION 'Batch 1D: collection enabled'; END IF;
END $$;
NOTIFY pgrst,'reload schema';
COMMIT;
