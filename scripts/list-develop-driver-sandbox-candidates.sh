#!/usr/bin/env bash
# Read-only activated driver inventory. No container Env/DSN/credential access.
set -eu
python3 - <<'PY'
import json,subprocess

d=['docker']
if subprocess.run(d+['info','--format','{{.ServerVersion}}'],stdout=subprocess.DEVNULL,stderr=subprocess.DEVNULL).returncode:
    d=['sudo','-n','docker']
def run(parts):
    p=subprocess.run(d+parts,capture_output=True,text=True,timeout=35)
    if p.returncode:raise SystemExit('Read-only driver inventory unavailable; raw diagnostics withheld')
    return p.stdout.strip()
# Select metadata fields only: never request full inspect or Config.Env.
image=run(['inspect','--format','{{.Image}}','movabi-develop-db'])
networks=json.loads(run(['inspect','--format','{{json .NetworkSettings.Networks}}','movabi-develop-db']))
if image!='sha256:632d750850d22dbc57c28380bed582538bd1a0b4c963fac50e2fa03e6c26542c' or set(networks)!={'movabi-develop-private'}:
    raise SystemExit('Develop database identity changed; stop for review')
for name in ['movabi-develop-api','movabi-develop-rest']:
    project=run(['inspect','--format','{{index .Config.Labels "com.docker.compose.project"}}',name])
    if project!='movabi-develop':raise SystemExit('Verified develop Compose identity required')
query="""WITH candidates AS (
 SELECT p.id,p.tenant_id,
 upper(coalesce(nullif(to_jsonb(p)->>'registration_country_code',''),to_jsonb(p)->>'country_code')) AS country
 FROM public.profiles p WHERE p.role='driver' AND p.registration_activated_at IS NOT NULL AND p.tenant_id IS NOT NULL
 AND coalesce(to_jsonb(p)->>'account_status','active')='active'
), markets AS (
 SELECT upper(country_code) AS country,
 CASE WHEN count(DISTINCT upper(supported_currency))=1 THEN max(upper(supported_currency)) ELSE NULL END AS currency
 FROM public.market_availability GROUP BY upper(country_code)
)
SELECT coalesce(json_agg(json_build_object('driverId',c.id,'tenantId',c.tenant_id,
 'registeredCountry',c.country,'registeredCurrency',m.currency,
 'ngnSandboxCandidate',coalesce(c.country='NG' AND m.currency='NGN',false)) ORDER BY c.id),'[]')
 FROM candidates c LEFT JOIN markets m ON m.country=c.country"""
drivers=json.loads(run(['exec','-e','PGOPTIONS=-c default_transaction_read_only=on','movabi-develop-db',
 'psql','-X','-U','postgres','-d','movabi_develop','-qAt','-v','ON_ERROR_STOP=1','-c',query]))
print(json.dumps({'database':'movabi_develop','activatedDriverCandidates':drivers,'count':len(drivers),
 'customerAccountsIncluded':False,'changesMade':False,'providerRequestsMade':False,
 'scope':'Activated driver/profile and configured-market candidates only; merchant support, login and provider readiness are not verified'}),flush=True)
PY
