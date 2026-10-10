#!/usr/bin/env bash
set -euo pipefail
umask 077
root=/srv/movabi/develop
migration="$root/shared/20261242100000_standard_fee_policy.sql"
printf '%s  %s\n' '5b4205fbf7717ed65771624b2c20df567ddf27ad05c9d49b109e0bd0d7c0e828' "$migration" | sha256sum -c -
docker exec movabi-develop-api node -e 'if (!(process.env.STRIPE_SECRET_KEY || "").startsWith("sk_test_")) throw Error("Expected develop TEST Stripe");'
backup="$root/shared/before-standard-fees-$(date -u +%Y%m%dT%H%M%SZ).dump"
docker exec movabi-develop-db sh -c 'export PGPASSWORD="$POSTGRES_PASSWORD"; exec pg_dump -w -U supabase_admin -d movabi_develop -Fc' > "$backup"
test -s "$backup"
docker exec -i movabi-develop-db pg_restore --list < "$backup" > /dev/null
echo "DATABASE_BACKUP=$backup"
sed 's/^COMMIT;$/ROLLBACK;/' "$migration" | docker exec -i movabi-develop-db sh -c 'export PGPASSWORD="$POSTGRES_PASSWORD"; exec psql -X -w -U supabase_admin -d movabi_develop -v ON_ERROR_STOP=1'
echo FEE_POLICY_DRY_RUN=PASS
docker exec -i movabi-develop-db sh -c 'export PGPASSWORD="$POSTGRES_PASSWORD"; exec psql -X -w -U supabase_admin -d movabi_develop -v ON_ERROR_STOP=1' < "$migration"
docker compose -p movabi-develop -f "$root/docker-compose.yml" restart api
curl --fail --retry 15 --retry-delay 2 --retry-all-errors https://movabi-api-develop.apps.evolsolution.com/health
docker exec -i movabi-develop-db sh -c 'export PGPASSWORD="$POSTGRES_PASSWORD"; exec psql -X -w -U supabase_admin -d movabi_develop -v ON_ERROR_STOP=1' <<'SQL'
SELECT key,value FROM public.marketplace_settings WHERE tenant_id IS NULL AND key IN ('commission','platform_fee') ORDER BY key;
SELECT count(*) AS mismatching_enabled_strategies FROM public.market_pricing_strategies WHERE enabled AND commission_percent IS DISTINCT FROM 15;
SQL
echo DEVELOP_STANDARD_FEE_POLICY=APPLIED
