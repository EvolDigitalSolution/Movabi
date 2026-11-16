#!/usr/bin/env bash
# Explicit operator recovery only. Refuse old API if the binding transaction committed.
set -euo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"; E="${1:?prior P8_API_EVIDENCE directory}"
(cd "$HERE" && sha256sum -c --quiet P8_SHA256SUMS)
[[ "$(cat "$E/api-before-source.txt")" = f949a14 && "$(cat "$E/api-project.txt")" = movabi-develop && "$(cat "$E/api-workdir.txt")" = /srv/movabi/develop ]] || { echo 'BLOCK: recovery identity mismatch'; exit 1; }
active=$(docker exec -i movabi-develop-db sh -c 'PGPASSWORD="$POSTGRES_PASSWORD" psql -X -U supabase_admin -d movabi_develop -v ON_ERROR_STOP=1 -qAt' <<'SQL'
SELECT count(*) FROM public.marketplace_settings WHERE key='quote_tenant_binding' AND value#>'{markets,GB,enabled}'='true'::jsonb;
SQL
)
[[ "$active" = 0 ]] || { echo 'BLOCK: GB binding has committed; retain paired API and investigate post-commit verification; never undo financial data blindly'; exit 1; }
ID=$(cat "$E/api-before-image-id.txt")
[[ "$ID" = sha256:* && "$(docker image inspect -f '{{.Id}}' "$(cat "$E/api-recovery-tag.txt")")" = "$ID" ]] || { echo 'BLOCK: recorded recovery image missing or changed'; exit 1; }
R=$(mktemp -d "$E/recovery.XXXXXX")
mkdir "$R/web-before"
bash "$HERE/verify-p8-web.sh" "$R/web-before"
cmp "$E/web-image-id.txt" "$R/web-before/web-image-id.txt"
printf 'services:\n  api:\n    image: %s\n' "$ID" | cmp - "$E/api-recovery.compose.yml"
IFS=',' read -r -a configs < "$E/api-compose-files.txt"
args=(); for f in "${configs[@]}"; do [[ "$f" = /* && -f "$f" ]] || { echo 'BLOCK: recorded compose file unavailable'; exit 1; }; args+=(-f "$f"); done
[[ "${#configs[@]}" -gt 0 ]] || exit 1
cd /srv/movabi/develop
docker compose -p movabi-develop "${args[@]}" -f "$E/api-recovery.compose.yml" up -d --no-deps --no-build api
[[ "$(docker inspect -f '{{.Image}}' movabi-develop-api)" = "$ID" ]]
[[ "$(docker exec movabi-develop-api cat /app/SOURCE_SHA)" = f949a14 ]]
mkdir "$R/web-after"
bash "$HERE/verify-p8-web.sh" "$R/web-after"
for f in web-image.txt web-image-id.txt web-container-id.txt; do cmp "$E/$f" "$R/web-after/$f"; done
curl -fsS --retry 5 --retry-connrefused --retry-delay 2 https://movabi-api-develop.apps.evolsolution.com/health
echo 'P8_API_RECOVERY_OK: exact f949a14 API image restored; web image/container unchanged; no SQL or migrations replayed'
