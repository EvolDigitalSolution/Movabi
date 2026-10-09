#!/usr/bin/env bash
set -euo pipefail
umask 077
root=/srv/movabi/develop
compose="$root/docker-compose.yml"
archive="$root/shared/__ARCHIVE__"
migration="$root/shared/20261242000000_completion_payout_outbox.sql"
printf '%s  %s\n' '__ARCHIVE_HASH__' "$archive" '__MIGRATION_HASH__' "$migration" | sha256sum -c -
docker exec movabi-develop-api node -e 'if(!(process.env.STRIPE_SECRET_KEY||"").startsWith("sk_test_")) throw Error("Expected develop TEST Stripe");'
docker load -i "$archive"
python3 - <<'PY'
import json,subprocess
for image in ('movabi-api:__TAG__','movabi-web:__TAG__'):
    d=json.loads(subprocess.check_output(['docker','image','inspect',image],text=True))[0]
    if d['Config'].get('Labels',{}).get('org.opencontainers.image.revision')!='__SHA__':
        raise SystemExit('Image revision mismatch')
PY
stopped=0
trap 'if [ "$stopped" -eq 1 ]; then docker compose -p movabi-develop -f "$compose" start api; fi' EXIT
docker compose -p movabi-develop -f "$compose" stop api
stopped=1
backup="$root/shared/before-completion-outbox-$(date -u +%Y%m%dT%H%M%SZ).dump"
docker exec movabi-develop-db sh -c 'export PGPASSWORD="$POSTGRES_PASSWORD"; exec pg_dump -w -U supabase_admin -d movabi_develop -Fc' > "$backup"
test -s "$backup"
docker exec -i movabi-develop-db pg_restore --list < "$backup" > /dev/null
echo "DATABASE_BACKUP=$backup"
dryrun=$(mktemp)
trap 'rm -f "$dryrun"; if [ "$stopped" -eq 1 ]; then docker compose -p movabi-develop -f "$compose" start api; fi' EXIT
python3 - "$migration" "$dryrun" <<'PY'
import sys
from pathlib import Path
s=Path(sys.argv[1]).read_text()
if not s.rstrip().endswith('COMMIT;'): raise SystemExit('Unexpected transaction envelope')
Path(sys.argv[2]).write_text(s.rstrip()[:-7]+'ROLLBACK;\n')
PY
docker exec -i movabi-develop-db sh -c 'export PGPASSWORD="$POSTGRES_PASSWORD"; exec psql -X -w -U supabase_admin -d movabi_develop -v ON_ERROR_STOP=1' < "$dryrun"
echo 'COMPLETION_MIGRATION_DRY_RUN=PASS'
docker exec -i movabi-develop-db sh -c 'export PGPASSWORD="$POSTGRES_PASSWORD"; exec psql -X -w -U supabase_admin -d movabi_develop -v ON_ERROR_STOP=1' < "$migration"
python3 - <<'PY'
import shutil,time
from pathlib import Path
import yaml
p=Path('/srv/movabi/develop/docker-compose.yml')
backup=p.parent/'shared'/f'compose-before-completion-{time.time_ns()}.yml'
shutil.copy2(p,backup);backup.chmod(0o600)
c=yaml.safe_load(p.read_text())
c['services']['api']['image']='movabi-api:__TAG__'
c['services']['web']['image']='movabi-web:__TAG__'
p.write_text(yaml.safe_dump(c,sort_keys=False));p.chmod(0o600)
print('COMPOSE_BACKUP='+str(backup))
PY
docker compose -p movabi-develop -f "$compose" up -d --no-deps --no-build api web
stopped=0
curl --fail --retry 15 --retry-delay 2 --retry-all-errors https://movabi-api-develop.apps.evolsolution.com/health
echo
code=$(curl --silent --output /dev/null --write-out '%{http_code}' https://movabi-develop.apps.evolsolution.com)
test "$code" = 200
echo 'DEVELOP_WEB_HTTP=200'
docker inspect movabi-develop-api movabi-develop-web --format '{{.Name}} Image={{.Config.Image}} Revision={{index .Config.Labels "org.opencontainers.image.revision"}} Status={{.State.Status}} Restarts={{.RestartCount}}'
echo 'COMPLETION_CHAT_PRICING_DEPLOYED=YES'
