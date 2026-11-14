-- After deactivate-gb.sql: everything off for GB, history kept, NG untouched. Last line: "<failures> | <passed>/<total>".
\set ON_ERROR_STOP on
BEGIN;
CREATE TEMP TABLE results(n int, name text, ok boolean, detail text);
INSERT INTO results SELECT 1,'no GB policy or GB campaign enabled',
  NOT EXISTS (SELECT 1 FROM public.cancellation_policies WHERE enabled) AND NOT EXISTS (SELECT 1 FROM public.campaigns WHERE enabled), NULL;
INSERT INTO results SELECT 1,'history kept: the published version and both campaigns still exist',
  (SELECT count(*) FROM public.cancellation_policies WHERE market_code='GB' AND tenant_id='6b000000-0000-4000-8000-0000000000aa')=1
  AND (SELECT count(*) FROM public.campaigns WHERE code IN ('FIRST5GB','REFERGB') AND tenant_id='6b000000-0000-4000-8000-0000000000aa')=2, NULL;
INSERT INTO results SELECT 1,'PIN: GB key removed (GB falls back to required); NG setting unchanged',
  (SELECT value FROM public.marketplace_settings WHERE tenant_id='6b000000-0000-4000-8000-0000000000aa' AND key='completion_pin_policy')='{"markets":{}}'::jsonb
  AND (SELECT value FROM public.marketplace_settings WHERE tenant_id='6b000000-0000-4000-8000-0000000000bb' AND key='completion_pin_policy')='{"markets":{"NG":"optional"}}'::jsonb, NULL;
SELECT n, CASE WHEN ok THEN 'ok' ELSE 'FAIL' END, name, coalesce(detail,'') FROM results ORDER BY n;
SELECT count(*) FILTER (WHERE NOT ok) || ' | ' || count(*) FILTER (WHERE ok) || '/' || count(*) FROM results;
ROLLBACK;
