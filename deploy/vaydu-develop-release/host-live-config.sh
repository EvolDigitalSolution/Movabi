#!/usr/bin/env bash
# READ-ONLY: what is switched on on develop right now (2026-11-13). Changes nothing.
# Usage on the develop host, from the directory holding live-config.sql:
#   bash host-live-config.sh > live-config-$(date -u +%Y%m%dT%H%M%SZ).txt 2>&1
# Prints feature flags (VAYDU_*, NODE_ENV), images and source SHAs, health, and live-config.sql.
# Any variable whose name looks secret is printed as <set>/<unset> only.
set -uo pipefail
API=movabi-develop-api DB=movabi-develop-db
echo "== taken at $(date -u +%FT%TZ)"
echo "== images"
docker ps --filter label=com.docker.compose.project=movabi-develop --format '{{.Names}} {{.Image}} {{.Status}}'
echo "== API source sha: $(docker exec "$API" cat /app/SOURCE_SHA 2>/dev/null || echo unknown)"
echo "== health: $(curl -s -m 10 https://movabi-api-develop.apps.evolsolution.com/health || echo unreachable)"
echo "== API flags (VAYDU_*, NODE_ENV; secret-looking names redacted)"
docker exec "$API" printenv | grep -E '^(VAYDU_[A-Z0-9_]+|NODE_ENV)=' | sort | while IFS='=' read -r k v; do
  if [[ "$k" =~ (KEY|SECRET|TOKEN|PASSWORD|PASS|REF|UID|ACCOUNT) ]]; then
    [ -n "$v" ] && echo "$k=<set>" || echo "$k=<unset>"
  else echo "$k=$v"; fi
done
echo "== Mapbox geocoding permanent setting in the running code (expect permanent=false only)"
docker exec "$API" sh -c "grep -rhoE 'permanent[^,;)]{0,20}' /app/server 2>/dev/null | sort | uniq -c" || true
echo "== database (read-only transaction)"
docker exec -i "$DB" sh -c 'PGPASSWORD="$POSTGRES_PASSWORD" psql -X -U supabase_admin -d movabi_develop' < live-config.sql
