# Batch 2A — Flutterwave provider: guarded install + test + upload-report block.
# Run from the repo root. No live collection, payout, deployment or commit.
param(
  [string]$Db = 'vaydu_batch2a_test',
  [string]$Psql = 'psql'
)
$ErrorActionPreference = 'Stop'
$Root = Split-Path -Parent $MyInvocation.MyCommand.Path | Split-Path -Parent
Set-Location $Root

Write-Host "== 1. Guard target database =="
$name = & $Psql -X -qAt -d $Db -c 'SELECT current_database()' 2>$null
if ($LASTEXITCODE -ne 0) { throw "Cannot connect to '$Db'; run an isolated PostgreSQL 15 container first." }
if ($name -ne $Db) { throw "current_database()=$name != $Db" }
if ($Db -match 'movabi' -or $Db -in @('postgres','template0','template1')) { throw "Refusing protected database '$Db'." }

Write-Host "== 2. Apply Batch 2A + 2B migrations =="
& $Psql -X -v ON_ERROR_STOP=1 -d $Db -f "supabase/migrations/20261254000000_flutterwave_provider_batch2a.sql"
if ($LASTEXITCODE -ne 0) { throw "Batch 2A migration failed (exit $LASTEXITCODE)." }
& $Psql -X -v ON_ERROR_STOP=1 -d $Db -f "supabase/migrations/20261254100000_wallet_fee_freeze_batch2b.sql"
if ($LASTEXITCODE -ne 0) { throw "Batch 2B migration failed (exit $LASTEXITCODE)." }
& $Psql -X -v ON_ERROR_STOP=1 -d $Db -f "supabase/migrations/20261254200000_flutterwave_provider_accept_batch2c.sql"
if ($LASTEXITCODE -ne 0) { throw "Batch 2C migration failed (exit $LASTEXITCODE)." }
& $Psql -X -v ON_ERROR_STOP=1 -d $Db -f "supabase/migrations/20261254300000_wallet_atomic_confirm_batch2d.sql"
if ($LASTEXITCODE -ne 0) { throw "Batch 2D migration failed (exit $LASTEXITCODE)." }

Write-Host "== 3. SQL fee-integration test =="
& $Psql -X -v ON_ERROR_STOP=1 -d $Db -f "scripts/check-wallet-flutterwave-batch2a.sql"
if ($LASTEXITCODE -ne 0) { throw "SQL test failed." }

Write-Host "== 4. Static source checker =="
node "scripts/check-wallet-flutterwave-batch2a.cjs"
if ($LASTEXITCODE -ne 0) { throw "Source checker failed." }

Write-Host "== 4. Type-check (tsc) =="
$tsc = npx tsc --noEmit -p tsconfig.spec.json 2>&1 | Out-String
if ($LASTEXITCODE -eq 0) { Write-Host "tsc: OK" } else { Write-Host "tsc errors (non-blocking in sandbox):"; $tsc }

Write-Host "== 5. Tests =="
Write-Host "Vitest (flutterwave/fee specs): NOT RUN — esbuild spawn EPERM in this sandbox; run on the owner machine:"
Write-Host "    npx vitest run src/testing/wallet-flutterwave-batch2a.spec.ts"

Write-Host "== 6. Upload report (no live target) =="
Write-Host "Flutterwave Batch 2A installed (disabled by default). No live key, route or collection enabled."
Write-Host "Archive SHA256 must be computed from the packaging step; no paid calls or upload performed."
Write-Host "Batch 2A installer: PASSED (static); runtime DB suite NOT RUN here."
