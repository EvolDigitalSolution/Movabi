param([switch]$KeepContainer,[switch]$Integration)
$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot
$name = 'vaydu-topup-test-' + [Guid]::NewGuid().ToString('N').Substring(0,8)
function DockerOk { & docker @args; if ($LASTEXITCODE -ne 0) { throw "Docker command failed: $($args[0])" } }
function SqlFile([string]$path) {
  DockerOk cp (Join-Path $root $path) "${name}:/tmp/test.sql"
  DockerOk exec $name psql -U postgres -d vaydu_batch2a_test -X -v ON_ERROR_STOP=1 -f /tmp/test.sql
}
try {
  $testNetwork='none'
  if ($Integration) { $testNetwork=$name+'-base'; DockerOk network create --internal $testNetwork }
  DockerOk run --detach --rm --network $testNetwork --name $name -e POSTGRES_PASSWORD=isolated-test -e POSTGRES_DB=vaydu_batch2a_test postgres:15
  for ($i=0; $i -lt 30; $i++) { & docker exec $name pg_isready -h 127.0.0.1 -U postgres *> $null; if ($LASTEXITCODE -eq 0) { break }; Start-Sleep -Seconds 1 }
  SqlFile 'scripts/check-wallet-topups-batch1c-fixture.sql'
  DockerOk exec $name psql -U postgres -d vaydu_batch2a_test -X -v ON_ERROR_STOP=1 -c "ALTER TABLE public.market_payment_routes ADD CONSTRAINT market_payment_routes_provider_check CHECK(provider IN ('stripe','kora','fincra'));"
  foreach ($file in @('20261244000000_wallet_metadata_batch1a.sql','20261245000000_wallet_accounting_foundation_batch1b.sql','20261246000000_wallet_topups_batch1c.sql','20261253900000_flutterwave_market_provider_prerequisite.sql','20261254000000_flutterwave_provider_batch2a.sql','20261254100000_wallet_fee_freeze_batch2b.sql','20261254200000_flutterwave_provider_accept_batch2c.sql')) { SqlFile "supabase/migrations/$file" }
  SqlFile 'scripts/check-wallet-topups-batch1c.sql'
  SqlFile 'scripts/seed-driver-topup-legacy-test.sql'
  SqlFile 'supabase/migrations/20261254300000_wallet_atomic_confirm_batch2d.sql'
  SqlFile 'scripts/check-wallet-flutterwave-batch2a.sql'
  SqlFile 'supabase/migrations/20261254400000_wallet_fee_policy_v2.sql'
  SqlFile 'scripts/check-driver-topup-fees-v2.sql'
  SqlFile 'scripts/check-driver-topup-legacy-test.sql'
  SqlFile 'scripts/check-wallet-accounting-batch1b-role.sql'
  SqlFile 'scripts/rollback-driver-topup-fees-v2.sql'
  SqlFile 'supabase/migrations/20261254400000_wallet_fee_policy_v2.sql'
  SqlFile 'scripts/check-driver-topup-fees-v2.sql'
  SqlFile 'supabase/migrations/20261254500000_driver_card_five_percent_policy.sql'
  SqlFile 'scripts/check-driver-card-five-percent.sql'
  SqlFile 'scripts/rollback-driver-card-five-percent.sql'
  SqlFile 'supabase/migrations/20261254500000_driver_card_five_percent_policy.sql'
  SqlFile 'scripts/check-driver-card-five-percent.sql'
  if ($Integration) {
    $env:VAYDU_DISPOSABLE_DB=$name
    & npx vitest run src/testing/driver-topup-supabase.integration.spec.ts
    if ($LASTEXITCODE -ne 0) { throw 'Disposable Supabase integration failed' }
    Remove-Item Env:VAYDU_DISPOSABLE_DB
    DockerOk cp (Join-Path $root 'scripts/rollback-driver-topup-fees-v2.sql') "${name}:/tmp/refuse.sql"
    $refusal = & docker exec $name psql -U postgres -d vaydu_batch2a_test -X -v ON_ERROR_STOP=1 -f /tmp/refuse.sql 2>&1 | Out-String
    if ($LASTEXITCODE -eq 0 -or $refusal -notmatch 'frozen financial schedules exist') { throw 'Financial rollback refusal failed' }
    Write-Host 'PASS: rollback refused after financial snapshots'
  }
  Write-Host 'PASS: isolated PostgreSQL migrations, accounting, fee schedules, rollback/reapplication'
} finally { if (!$KeepContainer) { & docker rm -f $name | Out-Null; if ($Integration) { & docker network rm ($name+'-base') | Out-Null } } else { Write-Host "Preserved disposable container: $name" } }
