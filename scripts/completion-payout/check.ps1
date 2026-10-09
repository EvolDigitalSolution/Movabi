$ErrorActionPreference = 'Stop'
$root = Resolve-Path (Join-Path $PSScriptRoot '../..')
Push-Location $root
try {
    npx tsc -p server/tsconfig.json --noEmit
    if ($LASTEXITCODE -ne 0) { throw 'Server type check failed' }
    npx tsc -p tsconfig.app.json --noEmit
    if ($LASTEXITCODE -ne 0) { throw 'Frontend type check failed' }
    npx vitest run src/testing/journey-navigation.spec.ts src/testing/completion-payout-retries.spec.ts src/testing/job-chat.spec.ts src/testing/batch2c-settlement-behavior.spec.ts src/testing/batch2c-money-authority.spec.ts src/testing/driver-settlement-remediation.spec.ts src/testing/customer-completion-pin.spec.ts src/testing/wallet-booking-lifecycle.spec.ts src/testing/goods-vehicle-capacity.spec.ts src/testing/fare-split-authority.spec.ts src/testing/market-pricing.spec.ts
    if ($LASTEXITCODE -ne 0) { throw 'Completion/chat/pricing regression tests failed' }
    & (Join-Path $PSScriptRoot 'run-postgres-tests.ps1')
    npm run build:mobile:develop
    if ($LASTEXITCODE -ne 0) { throw 'Mobile build failed' }
    git diff --check
    if ($LASTEXITCODE -ne 0) { throw 'Diff check failed' }
    Write-Output 'COMPLETION_CHAT_PRICING_CHECKS=PASS'
} finally { Pop-Location }
