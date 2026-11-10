$ErrorActionPreference='Stop'
$root=Split-Path -Parent $PSScriptRoot
$name='vaydu-card-canonical-'+[Guid]::NewGuid().ToString('N').Substring(0,8)
function DockerOk { & docker @args; if($LASTEXITCODE -ne 0){throw "Docker failed: $($args[0])"} }
function SqlFile([string]$relative){DockerOk cp (Join-Path $root $relative) "${name}:/tmp/check.sql";DockerOk exec $name psql -U postgres -d movabi_develop -X -v ON_ERROR_STOP=1 -f /tmp/check.sql}
try{
 & python (Join-Path $root 'scripts/prepare-driver-wallet-develop-sql.py');if($LASTEXITCODE -ne 0){throw 'Canonical generation failed'}
 DockerOk run --detach --rm --network none --name $name -e POSTGRES_PASSWORD=isolated-test -e POSTGRES_DB=movabi_develop postgres:15
 for($i=0;$i -lt 30;$i++){& docker exec $name pg_isready -h 127.0.0.1 -U postgres *> $null;if($LASTEXITCODE -eq 0){break};Start-Sleep -Seconds 1}
 foreach($file in @('scripts/check-wallet-topups-batch1c-fixture.sql','supabase/migrations/20261244000000_wallet_metadata_batch1a.sql','supabase/migrations/20261245000000_wallet_accounting_foundation_batch1b.sql','supabase/migrations/20261246000000_wallet_topups_batch1c.sql')){SqlFile $file}
 DockerOk exec $name psql -U postgres -d movabi_develop -v ON_ERROR_STOP=1 -c "ALTER TABLE public.market_payment_routes ADD CONSTRAINT market_payment_routes_provider_check CHECK(provider IN ('stripe','kora','fincra')); CREATE TABLE public.payment_checkout_attempts(reference text PRIMARY KEY,request jsonb NOT NULL,state text NOT NULL CHECK(state IN ('started','submitted','unknown')),checkout_url text,created_at timestamptz NOT NULL DEFAULT now()); INSERT INTO public.payment_checkout_attempts(reference,request,state) VALUES('synthetic-submitted','{}','submitted'),('synthetic-unknown','{}','unknown');"
 SqlFile 'scripts/driver-card-develop-release/supabase_incremental_schema_reconcile.sql'
 SqlFile 'scripts/driver-card-develop-release/supabase_incremental_schema_reconcile.sql'
 $result=& docker exec $name psql -U postgres -d movabi_develop -qAt -v ON_ERROR_STOP=1 -c "SELECT public.wallet_collection_enabled(),(SELECT count(*) FROM public.payment_checkout_attempts),(SELECT count(*) FROM public.driver_card_topup_sandbox_scopes),(SELECT count(*) FROM public.wallet_topup_fee_schedules),(SELECT count(*) FROM public.vaydu_driver_card_schema_releases);"
 if($LASTEXITCODE -ne 0 -or $result -ne 'f|2|0|0|1'){throw "Unexpected disabled canonical state: $result"}
 DockerOk exec $name psql -U postgres -d movabi_develop -v ON_ERROR_STOP=1 -c 'ALTER TABLE public.wallet_topup_attempts ADD COLUMN unexpected_fixture_drift text;'
 $refusal=& docker exec $name psql -U postgres -d movabi_develop -X -v ON_ERROR_STOP=1 -f /tmp/check.sql 2>&1 | Out-String
 if($LASTEXITCODE -eq 0 -or $refusal -notmatch 'release drift'){throw ('Canonical drift refusal failed: '+$refusal)}
 Write-Host 'PASS: canonical first apply, idempotent rerun, disabled flags, provider-store preservation and catalog-drift refusal'
}finally{& docker rm -f $name | Out-Null}
