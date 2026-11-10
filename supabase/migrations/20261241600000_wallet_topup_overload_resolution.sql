-- Resolve ambiguous wallet top-up RPC overloads.
-- Preserve the JSON function matching available/reserved balance schema.
-- No wallet balances or transactions are modified.
BEGIN;

DO $$
BEGIN
  IF to_regprocedure('public.finalize_wallet_topup(numeric,text,text,uuid)') IS NULL THEN
    RAISE EXCEPTION 'Canonical wallet top-up function missing';
  END IF;

  IF pg_get_function_result(
    'public.finalize_wallet_topup(numeric,text,text,uuid)'::regprocedure
  ) <> 'jsonb' THEN
    RAISE EXCEPTION 'Unexpected canonical wallet top-up return type';
  END IF;

  IF to_regprocedure('public.finalize_wallet_topup(uuid,numeric,text,text)') IS NOT NULL THEN
    IF to_regprocedure(
      'public.finalize_wallet_topup_legacy_incompatible(uuid,numeric,text,text)'
    ) IS NOT NULL THEN
      RAISE EXCEPTION 'Both legacy function names exist; review required';
    END IF;

    ALTER FUNCTION public.finalize_wallet_topup(uuid,numeric,text,text)
      RENAME TO finalize_wallet_topup_legacy_incompatible;
  END IF;

  IF to_regprocedure(
    'public.finalize_wallet_topup_legacy_incompatible(uuid,numeric,text,text)'
  ) IS NOT NULL THEN
    REVOKE ALL ON FUNCTION
      public.finalize_wallet_topup_legacy_incompatible(uuid,numeric,text,text)
      FROM PUBLIC, anon, authenticated, service_role;
  END IF;

  IF (
    SELECT count(*) FROM pg_proc p
    JOIN pg_namespace n ON n.oid=p.pronamespace
    WHERE n.nspname='public' AND p.proname='finalize_wallet_topup'
  ) <> 1 THEN
    RAISE EXCEPTION 'Unexpected remaining wallet top-up overloads';
  END IF;
END $$;

ALTER FUNCTION public.finalize_wallet_topup(numeric,text,text,uuid)
  SET search_path TO public, pg_temp;

REVOKE ALL ON FUNCTION public.finalize_wallet_topup(numeric,text,text,uuid)
  FROM PUBLIC, anon, authenticated;

GRANT EXECUTE ON FUNCTION public.finalize_wallet_topup(numeric,text,text,uuid)
  TO service_role;

NOTIFY pgrst, 'reload schema';
COMMIT;
