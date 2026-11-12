#!/usr/bin/env bash
# READ-ONLY develop inventory for release reconciliation. Changes nothing: no restart, no write, no
# migration. Output: ~/vaydu-develop-inventory-<UTC>.tar.gz (+ .sha256) to copy back for review.
#
# Never captured: secret values. Environment variables whose name looks secret are recorded only as
# set/missing (Stripe keys as their mode prefix sk_test/sk_live/rk_test/rk_live). Compose/override files
# are recorded as path + sha256 only, not their contents. The schema dump is schema-only (no rows).
set -euo pipefail
export LC_ALL=C
STAMP=$(date -u +%Y%m%dT%H%M%SZ); OUT="$HOME/vaydu-develop-inventory-$STAMP"; mkdir -p "$OUT"
API=movabi-develop-api; DB=movabi-develop-db
WEB=$(docker ps --filter label=com.docker.compose.project=movabi-develop --filter label=com.docker.compose.service=web -q | head -1)
DBQ() { docker exec -i "$DB" sh -c 'PGPASSWORD="$POSTGRES_PASSWORD" psql -X -U supabase_admin -d movabi_develop -v ON_ERROR_STOP=1 -P pager=off -tA'; }
echo "inventory $STAMP" > "$OUT/README.txt"; uname -a >> "$OUT/README.txt"; date -u >> "$OUT/README.txt"

# 1. Containers, images, compose files (paths + hashes only).
docker ps -a --filter label=com.docker.compose.project=movabi-develop --format '{{.Names}}\t{{.Image}}\t{{.Status}}' > "$OUT/containers.tsv"
for c in $(docker ps -a --filter label=com.docker.compose.project=movabi-develop -q); do
  docker inspect -f '{{.Name}}	{{.Config.Image}}	{{.Image}}	{{.Created}}	{{index .Config.Labels "com.docker.compose.service"}}	{{index .Config.Labels "com.docker.compose.project.config_files"}}' "$c"
done > "$OUT/container-images.tsv"
cut -f6 "$OUT/container-images.tsv" | tr ',' '\n' | sort -u | while IFS= read -r f; do [ -n "$f" ] && { [ -f "$f" ] && sha256sum "$f" || echo "MISSING  $f"; }; done > "$OUT/compose-files.sha256"
ls -la "$HOME/vaydu-develop-overrides/" > "$OUT/overrides-ls.txt" 2>&1 || true
find "$HOME/vaydu-develop-overrides" -maxdepth 1 -type f -exec sha256sum {} + > "$OUT/overrides.sha256" 2>/dev/null || true
docker images --format '{{.Repository}}:{{.Tag}}\t{{.ID}}\t{{.CreatedAt}}' | grep -E '^movabi-(api|web)' > "$OUT/images.tsv" || true

# 2. API environment: flags with values, secrets as set/missing only.
docker exec "$API" printenv | awk -F= '{
  name=$1; value=substr($0,length($1)+2);
  if (name ~ /^STRIPE_(SECRET|RESTRICTED)/ ) { split(value,a,"_"); print name"=" (value==""?"missing":a[1]"_"a[2]"_<redacted>"); next }
  if (name ~ /(KEY|SECRET|TOKEN|PASSWORD|PASS|PRIVATE|CREDENTIAL|DSN|JWT|SIGNING|WEBHOOK)/) { print name"=" (value==""?"missing":"set"); next }
  if (name ~ /^(VAYDU_|NODE_ENV|PORT|SUPABASE_URL|API_URL|APP_URL|WEB_ORIGIN|CORS|DEPLOYMENT|STRIPE_MODE)/) { print name"="value; next }
  print name"=<not recorded>"
}' | sort > "$OUT/api-env.txt"

# 3. Running API source and files; running web files.
docker exec "$API" sh -c 'cat /app/SOURCE_SHA 2>/dev/null || echo unknown' > "$OUT/api-source-sha.txt"
API_PATHS='server src/app/shared deploy/vaydu-payment-account-setup/api package.json package-lock.json'
LIST='for p in '"$API_PATHS"'; do [ -e "$p" ] && find "$p" -type f; done | sort | while IFS= read -r f; do printf "%s  %s\n" "$(tr -d "\r" < "$f" | sha256sum | cut -d" " -f1)" "$f"; done'
docker exec "$API" sh -c "cd /app && $LIST" | sort -k2 > "$OUT/running-api.sha"
if [ -n "$WEB" ]; then
  WLIST='find . -type f ! -path ./50x.html -exec sha256sum {} + | sed -E "s#^([0-9a-f]{64}) [ *]\./#\1  #" | sort -k2'
  docker exec "$WEB" sh -c "cd /usr/share/nginx/html && $WLIST" > "$OUT/running-web.sha"
fi
curl -s -m 10 -o /dev/null -w 'api /health %{http_code}\n' http://127.0.0.1:3000/health >> "$OUT/README.txt" 2>/dev/null || true

# 4. Database: schema-only dump of the app schemas, function fingerprints, applied-migration records.
docker exec "$DB" sh -c 'PGPASSWORD="$POSTGRES_PASSWORD" pg_dump -U supabase_admin -d movabi_develop --schema-only --no-owner --no-privileges -n public' > "$OUT/schema-public.sql"
docker exec "$DB" sh -c 'PGPASSWORD="$POSTGRES_PASSWORD" pg_dump -U supabase_admin -d movabi_develop --schema-only -n public' > "$OUT/schema-public-with-privileges.sql"
echo "select version(); select current_setting('server_version_num');" | DBQ > "$OUT/db-version.txt"
echo "select n.nspname||'.'||p.proname||'('||pg_get_function_identity_arguments(p.oid)||')', md5(pg_get_functiondef(p.oid)) from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname='public' and p.prokind in ('f','p') order by 1;" | DBQ > "$OUT/function-fingerprints.tsv"
echo "select c.relname, md5(string_agg(a.attname||':'||format_type(a.atttypid,a.atttypmod)||':'||a.attnotnull, ',' order by a.attnum)) from pg_class c join pg_namespace n on n.oid=c.relnamespace join pg_attribute a on a.attrelid=c.oid and a.attnum>0 and not a.attisdropped where n.nspname='public' and c.relkind in ('r','p','v','m') group by 1 order by 1;" | DBQ > "$OUT/table-fingerprints.tsv"
echo "select tgrelid::regclass||'.'||tgname, tgenabled from pg_trigger where not tgisinternal and tgrelid::regclass::text not like 'auth.%' and tgrelid::regclass::text not like 'storage.%' order by 1;" | DBQ > "$OUT/triggers.tsv"
echo "select case when to_regclass('supabase_migrations.schema_migrations') is null then 'no supabase_migrations table' end;" | DBQ > "$OUT/migration-records.txt"
( echo "select version||' '||coalesce(name,'') from supabase_migrations.schema_migrations order by 1;" | DBQ ) >> "$OUT/migration-records.txt" 2>/dev/null || true

# 5. Market / policy configuration rows (no personal data): which features are configured or enabled.
Q() { local label="$1" sql="$2"; { echo "== $label"; echo "$sql" | DBQ 2>&1 || true; } >> "$OUT/config-state.txt"; }
: > "$OUT/config-state.txt"
for t in market_availability driver_cash_credit_markets_v1e driver_cash_credit_config_v1e cancellation_policies driver_pin_policies campaigns referral_programs commercial_policies market_bike_limits payment_market_routes driver_card_topup_policies wallet_fee_policies; do
  Q "$t exists" "select to_regclass('public.$t') is not null;"
done
Q "market_availability" "select to_jsonb(m) - 'created_at' - 'updated_at' from public.market_availability m order by 1;"
Q "cash markets" "select to_jsonb(m) from public.driver_cash_credit_markets_v1e m;"
Q "cash config" "select to_jsonb(c) from public.driver_cash_credit_config_v1e c;"
Q "cancellation policies (enabled count)" "select count(*) filter (where enabled), count(*) from public.cancellation_policies;"
Q "pin policies" "select count(*) from public.driver_pin_policies;"
Q "campaigns (active count)" "select count(*) filter (where status='active'), count(*) from public.campaigns;"
Q "cash-mode jobs" "select count(*) from public.jobs where metadata->>'cash_collection_mode'='full_customer_charge';"
Q "jobs by status" "select status, count(*) from public.jobs group by 1 order by 1;"

# 6. Backups and capacity.
ls -la "$HOME/vaydu-develop-backups/" > "$OUT/backups-ls.txt" 2>&1 || true
df -h "$HOME" /var/lib/docker > "$OUT/disk.txt" 2>&1 || true
echo "select pg_size_pretty(pg_database_size('movabi_develop'));" | DBQ >> "$OUT/disk.txt"
ls -d "$HOME"/vaydu-topup-fix-predeploy-* > "$OUT/previous-predeploy-records.txt" 2>/dev/null || true

# 7. Self-check: no secret-looking values left in the bundle, then package.
if grep -rIlE '(sk_(live|test)_[A-Za-z0-9]{8,}|eyJhbGciOi[A-Za-z0-9_-]{20,}|pk\.eyJ[A-Za-z0-9_-]{20,})' "$OUT" >/dev/null; then
  echo "FATAL: a secret-looking value was captured; inventory NOT packaged. Files:"; grep -rIlE '(sk_(live|test)_[A-Za-z0-9]{8,}|eyJhbGciOi[A-Za-z0-9_-]{20,}|pk\.eyJ[A-Za-z0-9_-]{20,})' "$OUT"; exit 1
fi
tar -czf "$OUT.tar.gz" -C "$HOME" "$(basename "$OUT")"; sha256sum "$OUT.tar.gz" | tee "$OUT.tar.gz.sha256"
echo "API image: $(docker inspect -f '{{.Config.Image}}' "$API")   source: $(cat "$OUT/api-source-sha.txt")"
[ -n "$WEB" ] && echo "Web image: $(docker inspect -f '{{.Config.Image}}' "$WEB")"
echo "functions: $(wc -l < "$OUT/function-fingerprints.tsv")   tables: $(wc -l < "$OUT/table-fingerprints.tsv")"
echo "DONE: $OUT.tar.gz"
