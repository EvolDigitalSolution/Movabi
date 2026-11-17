#!/usr/bin/env bash
# Rehearse the REAL TypeScript JobPayoutService against the migrated database
# with a simulated payout provider.
#
# Disposable containers only: supabase/postgres:15.1.1.78 (the host's engine) +
# pinned GoTrue + postgrest/postgrest serving the migrated schema. The worker
# runs unmodified on the host machine; only stripe.service and
# payout-eligibility.service are stubbed (the provider boundary). Proves:
#   * fare entitlement + driver reimbursement travel in ONE transfer
#   * exactly-once across replays and uncertain provider outcomes
#   * purchases are marked reimbursed only after provider confirmation
#
# Usage: bash scripts/errand-purchase-payer/run-worker-rehearsal.sh
set -euo pipefail
export MSYS_NO_PATHCONV=1
root="$(cd "$(dirname "$0")/../.." && pwd)"
tests="$root/deploy/vaydu-errand-purchase-payer"
secret='synthetic-disposable-jwt-secret-minimum-40-characters'
id="$(od -An -N4 -tx1 /dev/urandom | tr -d ' \n')"
db="vaydu-worker-$id"; auth="$db-auth"; rest="$db-rest"; net="$db-net"; name=worker_test
keep="${KEEP:-0}"
cleanup(){ [ "$keep" = 1 ] && { echo "KEEP=1: leaving $db $rest on $net"; return; }; docker rm -f "$auth" "$db" "$rest" >/dev/null 2>&1 || true; docker network rm "$net" >/dev/null 2>&1 || true; }
trap cleanup EXIT
q(){ docker exec -i -e PGPASSWORD=isolated-test "$db" psql -X -U supabase_admin -d "$name" -v ON_ERROR_STOP=1 -qAt "$@"; }
# The supabase image restarts postgres once during init; tolerate transient refusals.
qw(){ local n=0; until q "$@" >/dev/null 2>&1; do n=$((n+1)); [ "$n" -ge 30 ] && return 1; sleep 2; done; }
qs(){ local f="$1" n=0; until q < "$f" >/dev/null 2>&1; do n=$((n+1)); [ "$n" -ge 30 ] && return 1; sleep 2; done; }

docker network create "$net" >/dev/null
docker run -d --rm --name "$db" --network "$net" -e POSTGRES_PASSWORD=isolated-test -e POSTGRES_DB="$name" supabase/postgres:15.1.1.78 >/dev/null
# supabase/postgres performs a two-phase boot (init phase, shutdown, real start); wait for the
# SECOND 'ready to accept connections' before any connection attempt.
for _ in $(seq 1 300); do [ "$(docker logs "$db" 2>&1 | grep -c 'ready to accept connections')" -ge 2 ] && break; sleep 1; done
qw -c 'select 1'
tmp="$(mktemp -d)"
cat > "$tmp/setup.sql" <<'SQL'
DO $$ BEGIN
 IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname='authenticator') THEN CREATE ROLE authenticator NOLOGIN; END IF;
END $$;
-- The supabase image ships DDL-watch event triggers (graphql/pgrst/pg_net) that fire while the
-- baseline is applied; they are irrelevant to this rehearsal and one errors on missing sequences.
DO $$ DECLARE e text; BEGIN
 FOR e IN SELECT evtname FROM pg_event_trigger LOOP EXECUTE format('ALTER EVENT TRIGGER %I DISABLE', e); END LOOP;
END $$;
-- PostgREST's authenticator must be able to switch into the API roles.
GRANT anon, authenticated, service_role TO authenticator;
ALTER ROLE authenticator WITH LOGIN PASSWORD 'isolated-test';
SQL
qs "$tmp/setup.sql"

docker run -d --rm --network "$net" --name "$auth" \
 -e GOTRUE_API_HOST=0.0.0.0 -e GOTRUE_API_PORT=9999 -e API_EXTERNAL_URL=http://localhost:9999 -e GOTRUE_SITE_URL=http://localhost:3000 \
 -e GOTRUE_DB_NAMESPACE=auth -e GOTRUE_DB_DRIVER=postgres \
 -e "GOTRUE_DB_DATABASE_URL=postgres://postgres:isolated-test@$db:5432/$name?sslmode=disable&options=-csearch_path%3Dauth%2Cpublic" \
 -e GOTRUE_JWT_SECRET="$secret" -e GOTRUE_JWT_AUD=authenticated \
 supabase/gotrue:v2.132.3 >/dev/null
for _ in $(seq 1 120); do [ "$(q -c "select to_regclass('auth.users') is not null and exists(select 1 from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname='auth' and p.proname='uid')" 2>/dev/null)" = t ] && break; sleep 0.5; done
sleep 2; docker rm -f "$auth" >/dev/null 2>&1 || true
# Shims for two auth objects the export references but GoTrue does not create (never exercised).
qw -c "CREATE TABLE IF NOT EXISTS auth.job_messages (id uuid); CREATE OR REPLACE FUNCTION auth.debug_errand_insert() RETURNS trigger LANGUAGE plpgsql AS \$\$ BEGIN RETURN NEW; END \$\$;"

sed 's/CREATE SCHEMA public;/CREATE SCHEMA IF NOT EXISTS public;/; s/CREATE EXTENSION /CREATE EXTENSION IF NOT EXISTS /' "$root/supabase/baseline/develop_live_public_schema_20261112.sql" > "$tmp/baseline.sql"
qs "$tmp/baseline.sql"
qs "$root/supabase/baseline/candidate/001_tenants.sql"
for m in 20261270500000_errand_purchase_payer 20261270600000_customer_wallet_booking_bridge; do
  qs "$root/supabase/migrations/$m.sql" && echo "APPLIED $m" || { echo "FAILED to apply $m"; exit 1; }
done

# PostgREST serves the public schema; service_role JWTs minted by the harness.
docker run -d --rm --network "$net" --name "$rest" \
 -e "PGRST_DB_URI=postgres://authenticator:isolated-test@$db:5432/$name" \
 -e PGRST_DB_SCHEMAS=public -e PGRST_DB_ANON_ROLE=authenticator \
 -e "PGRST_JWT_SECRET=$secret" -e PGRST_JWT_SECRET_IS_BASE64=false \
 -p 127.0.0.1::3000 postgrest/postgrest:v10.2.0 >/dev/null
for _ in $(seq 1 60); do [ -n "$(docker port "$rest" 3000 2>/dev/null)" ] && break; sleep 0.5; done
rest_port="$(docker port "$rest" 3000 | head -1 | sed 's/.*://')"
# PostgREST only listens after its DB connection and schema cache succeed.
for _ in $(seq 1 90); do [ "$(curl -s -o /dev/null -w '%{http_code}' "http://127.0.0.1:$rest_port/" 2>/dev/null)" = "200" ] && break; sleep 1; done

# Fixtures: three wallet-funded driver-personal errands completed through the
# real RPC chain (pay -> spend -> complete_job_with_pending_payout), leaving
# pending queue rows of 2850 minor (850 fare + 2000 reimbursement).
cat > "$tmp/fixtures.sql" <<'SQL'
DO $d$ DECLARE t text; BEGIN
 FOR t IN SELECT tgname FROM pg_trigger tr JOIN pg_class c ON c.oid=tr.tgrelid WHERE c.relname='jobs' AND NOT tgisinternal
   AND tgname NOT IN ('trg_enforce_job_payment_eligibility','enforce_ride_cash_credit_v1e')
 LOOP EXECUTE format('ALTER TABLE public.jobs DISABLE TRIGGER %I', t); END LOOP; END $d$;
INSERT INTO public.tenants(id,name,slug) VALUES ('11111111-1111-4111-8111-111111111111','t','t')
 ON CONFLICT DO NOTHING;
INSERT INTO public.market_availability(country_code,launch_status,supported_currency) VALUES ('GB','live','GBP')
 ON CONFLICT DO NOTHING;
INSERT INTO public.service_types(id,slug,name) VALUES ('dddddddd-dddd-4ddd-8ddd-dddddddddd02','errand','Errand')
 ON CONFLICT DO NOTHING;
INSERT INTO auth.users(id) SELECT ('dddddddd-aaaa-4aaa-8aaa-0000000000'||g)::uuid FROM generate_series(10,12) g;
INSERT INTO auth.users(id) VALUES ('ffffffff-dddd-4ddd-8ddd-dddddddddddd');
INSERT INTO public.profiles(id,tenant_id,role,country_code,registration_country_code)
 SELECT ('dddddddd-aaaa-4aaa-8aaa-0000000000'||g)::uuid,'11111111-1111-4111-8111-111111111111','driver','GB','GB'
 FROM generate_series(10,12) g;
INSERT INTO public.profiles(id,tenant_id,role,country_code,registration_country_code) VALUES
 ('ffffffff-dddd-4ddd-8ddd-dddddddddddd','11111111-1111-4111-8111-111111111111','customer','GB','GB');
INSERT INTO public.wallets(user_id,available_balance,reserved_balance,currency_code)
 VALUES ('ffffffff-dddd-4ddd-8ddd-dddddddddddd',900,0,'GBP');
DO $d$ DECLARE j uuid; n int; BEGIN
 FOR n IN 10..12 LOOP
  INSERT INTO public.jobs(id,tenant_id,customer_id,pickup_address,dropoff_address,scheduled_time,service_type_id,
    payment_status,country_code,currency_code,status,total_price,metadata,fare_breakdown)
  VALUES (gen_random_uuid(),'11111111-1111-4111-8111-111111111111','ffffffff-dddd-4ddd-8ddd-dddddddddddd','a','b',now(),
    'dddddddd-dddd-4ddd-8ddd-dddddddddd02','pending','GB','GBP','requested',10,
    jsonb_build_object('quote_id',gen_random_uuid(),'quote_expires_at',now()+interval '10 minutes'),
    jsonb_build_object('calculationVersion','test-v1'))
  RETURNING id INTO j;
  INSERT INTO public.errand_details(job_id,items_list,estimated_budget) VALUES (j,'[]',30);
  INSERT INTO public.errand_funding(job_id,customer_id,item_budget,service_estimate,amount_reserved,status)
   VALUES (j,'ffffffff-dddd-4ddd-8ddd-dddddddddddd',30,10,30,'pending');
  PERFORM public.pay_job_from_wallet(j,'ffffffff-dddd-4ddd-8ddd-dddddddddddd',40,'GBP','11111111-1111-4111-8111-111111111111');
  UPDATE public.jobs SET driver_id=('dddddddd-aaaa-4aaa-8aaa-0000000000'||n)::uuid,
    accepted_driver_id=('dddddddd-aaaa-4aaa-8aaa-0000000000'||n)::uuid,status='accepted' WHERE id=j;
  UPDATE public.errand_details SET actual_spending=20 WHERE job_id=j;
  UPDATE public.jobs SET status='in_progress' WHERE id=j;
  PERFORM public.complete_job_with_pending_payout(j,('dddddddd-aaaa-4aaa-8aaa-0000000000'||n)::uuid,
    jsonb_build_object('total',10,'payout',8.5,'platformFee',1,'commission',0.5,'commissionRate',15,
      'currency','gbp','amountMinor',850,'destination','acct_drv_test','country','GB'),
    jsonb_build_object('completion_pin_verified_at',now()));
 END LOOP; END $d$;
SQL
qs "$tmp/fixtures.sql"
mapfile -t jobs < <(q -c "select job_id from public.job_payout_queue where status='pending' order by created_at")
[ "${#jobs[@]}" = 3 ] || { echo "expected 3 pending payout jobs, got ${#jobs[@]}"; exit 1; }
export JOB_OK="${jobs[0]}" JOB_UNCERTAIN="${jobs[1]}" JOB_REPLAY="${jobs[2]}"
echo "rehearsal jobs: $JOB_OK $JOB_UNCERTAIN $JOB_REPLAY"
echo "PGRST_URL=http://127.0.0.1:$rest_port"

# The harness runs on the host's node, which needs a native (Windows) path.
harness="$(cd "$tests" && { pwd -W 2>/dev/null || pwd; })/payout-worker-rehearsal.cjs"
PGRST_URL="http://127.0.0.1:$rest_port" SUPABASE_JWT_SECRET="$secret" \
  JOB_OK="$JOB_OK" JOB_UNCERTAIN="$JOB_UNCERTAIN" JOB_REPLAY="$JOB_REPLAY" \
  node "$harness"
