$ErrorActionPreference = 'Continue'
$root = (Resolve-Path (Join-Path $PSScriptRoot '..')).Path
$frozenSha = '35b259097c9c6a07940695d37bc4a70b6c7b2ea0'
$short = $frozenSha.Substring(0, 7)   # 8e09480
$bundleName = "vaydu-develop-$short"
$bundleDir = Join-Path $root "release\$bundleName"
$archive   = Join-Path $root "release\$bundleName.tar.gz"
$deploySrc = Join-Path $root 'deploy\vaydu-develop-validation'

function Hash-File([string]$p) { (Get-FileHash -Algorithm SHA256 -Path $p).Hash.ToLowerInvariant() }
function Write-Lf([string]$p, [string[]]$lines) {
  # Manifest/checksum files MUST use LF so Linux `sha256sum -c` and `while read`
  # parse them correctly (CRLF adds a trailing \r to every filename).
  [IO.File]::WriteAllText($p, (($lines -join "`n") + "`n"), [Text.UTF8Encoding]::new($false))
}
function Rel-Paths([string]$dir) {
  $res = @()
  Get-ChildItem -Path $dir -Recurse -File | ForEach-Object {
    $res += $_.FullName.Substring($dir.Length + 1).Replace('\', '/')
  }
  return $res
}

Push-Location $root
try {
  $head = (git rev-parse HEAD).Trim()
  if ($head -ne $frozenSha) { throw "HEAD is $head, expected frozen $frozenSha. Commit or reset before packaging." }
  Write-Output "FROZEN_SHA=$frozenSha"

  # ---- 1. Build mobile (develop) + admin + server typecheck -----------------
  Write-Output "== building mobile (develop) =="
  npm run build:mobile:develop
  if ($LASTEXITCODE -ne 0) { throw 'mobile build failed' }
  Write-Output "== building admin =="
  npm run build:admin
  if ($LASTEXITCODE -ne 0) { throw 'admin build failed' }
  Write-Output "== server typecheck =="
  npx tsc --noEmit -p server/tsconfig.json
  if ($LASTEXITCODE -ne 0) { throw 'server typecheck failed' }

  # ---- 2. Sync the 39 migrations into the deploy bundle source ---------------
  # ORDER.txt is authoritative (39 steps). candidate/* -> basename in bundle.
  $order = @(Get-Content (Join-Path $deploySrc 'ORDER.txt') | Where-Object { $_ -match '\.sql$' })
  # Normalize ORDER.txt to LF (parsed by `while read` on the server + hashed).
  Write-Lf (Join-Path $deploySrc 'ORDER.txt') $order
  $migDest = Join-Path $deploySrc 'migrations'
  Get-ChildItem $migDest -File -ErrorAction SilentlyContinue | Remove-Item -Force
  $order | ForEach-Object {
    $srcPath = if ($_ -like 'candidate/*') { Join-Path $root "supabase\baseline\$_" } else { Join-Path $root "supabase\migrations\$_" }
    $base = Split-Path $_ -Leaf
    Copy-Item $srcPath (Join-Path $migDest $base) -Force
  }
  Write-Output "MIGRATIONS_SYNCED=$($order.Count)"

  # ---- 3. Regenerate UPGRADE_MANIFEST.md (39 rows, ORDER.txt order) ----------
  $rows = @()
  $i = 0
  foreach ($step in $order) {
    $i++
    $base = Split-Path $step -Leaf
    $srcPath = if ($step -like 'candidate/*') { Join-Path $root "supabase\baseline\$step" } else { Join-Path $root "supabase\migrations\$step" }
    $h = Hash-File $srcPath
    $rows += "| $i | ``$base`` | ``$h`` |"
  }
  $manifest = @(
    '# Complete ordered candidate manifest (generated from the passing fixture)'
    ''
    "Frozen release SHA: ``$frozenSha``. Generated from the executable migration"
    'array in `src/testing/bike-authenticated-routes.integration.spec.ts`.'
    ''
    '| # | Step | SHA-256 |'
    '|---|---|---|'
  ) + $rows + @(
    ''
    '## Superseded step'
    ''
    '`20261254000000_flutterwave_provider_batch2a.sql` is replaced by'
    '`003_neutral_2a_columns.sql` (removal of the 7-line `NG/NGN/card` Flutterwave'
    'route insert only). Kora remains the NG/NGN/card provider.'
    ''
    '## Coverage notes'
    ''
    '- `20261103000000_completion_pin_policy.sql` supplies `effective_completion_pin_policy`'
    '  and `record_pin_attempt`, which the completion path calls and which are absent from'
    '  the deployed export.'
    '- `20261104000000`/`20261105000000` supply `customer_receivables` and'
    '  `referrals`/`campaigns` required by `20261255700000`.'
    '- Inspection has no schema in the repository and is out of scope for this release.'
  )
  Write-Lf (Join-Path $deploySrc 'UPGRADE_MANIFEST.md') $manifest
  Write-Output "UPGRADE_MANIFEST_REGEN=$($order.Count) rows"

  # ---- 4. Regenerate SHA256SUMS (migrations + manifest docs) ----------------
  $sums = @()
  foreach ($step in $order) {
    $base = Split-Path $step -Leaf
    $h = Hash-File (Join-Path $migDest $base)
    $sums += "$h  migrations/$base"
  }
  foreach ($doc in @('UPGRADE_MANIFEST.md','ORDER.txt','PREREQ.sql','VERIFY.sql','DEPENDENCY_CHECKLIST.md','README.md','COMMANDS.md','SMOKE_TESTS.md')) {
    $sums += "$(Hash-File (Join-Path $deploySrc $doc))  $doc"
  }
  Write-Lf (Join-Path $deploySrc 'SHA256SUMS') $sums
  Write-Output "SHA256SUMS_REGEN=$($sums.Count) entries"

  # ---- 5. Assemble the release bundle ----------------------------------------
  if (Test-Path $bundleDir) { Remove-Item $bundleDir -Recurse -Force }
  New-Item -ItemType Directory -Path $bundleDir -Force | Out-Null

  # built apps
  Copy-Item (Join-Path $root 'dist\admin') (Join-Path $bundleDir 'admin') -Recurse -Force
  Copy-Item (Join-Path $root 'dist\mobile') (Join-Path $bundleDir 'mobile') -Recurse -Force

  # server source (exclude node_modules/.git/.env/logs/dist)
  $serverDest = Join-Path $bundleDir 'server'
  New-Item -ItemType Directory -Path $serverDest -Force | Out-Null
  robocopy (Join-Path $root 'server') $serverDest /E /NFL /NDL /NJH /NJS /XD node_modules .git dist backups /XF *.log .env .env.local .env.* 2>$null | Out-Null
  if ($LASTEXITCODE -gt 7) { throw "robocopy server failed: $LASTEXITCODE" }

  # shared src (only src/app/shared)
  $sharedDest = Join-Path $bundleDir 'src\app\shared'
  New-Item -ItemType Directory -Path $sharedDest -Force | Out-Null
  robocopy (Join-Path $root 'src\app\shared') $sharedDest /E /NFL /NDL /NJH /NJS /XD node_modules .git 2>$null | Out-Null
  if ($LASTEXITCODE -gt 7) { throw "robocopy src failed: $LASTEXITCODE" }

  # canonical develop runtime (api/runtime.cjs + its relative deps) required by
  # server/routes/driver-payment-account-develop.routes.ts (VAYDU_PAYMENT_ACCOUNT_SETUP).
  $runtimeDest = Join-Path $bundleDir 'deploy\vaydu-payment-account-setup\api'
  New-Item -ItemType Directory -Path $runtimeDest -Force | Out-Null
  robocopy (Join-Path $root 'deploy\vaydu-payment-account-setup\api') $runtimeDest /E /NFL /NDL /NJH /NJS 2>$null | Out-Null
  if ($LASTEXITCODE -gt 7) { throw "robocopy api-runtime failed: $LASTEXITCODE" }

  # migrations + manifest + package files
  Copy-Item (Join-Path $deploySrc 'migrations') (Join-Path $bundleDir 'migrations') -Recurse -Force
  foreach ($f in @('ORDER.txt','SHA256SUMS','UPGRADE_MANIFEST.md','PREREQ.sql','VERIFY.sql','README.md','SMOKE_TESTS.md','BUILD_RESULTS.md','COMMANDS.md','DEPENDENCY_CHECKLIST.md')) {
    Copy-Item (Join-Path $deploySrc $f) (Join-Path $bundleDir $f) -Force
  }
  Copy-Item (Join-Path $root 'package.json') (Join-Path $bundleDir 'package.json') -Force
  Copy-Item (Join-Path $root 'package-lock.json') (Join-Path $bundleDir 'package-lock.json') -Force

  # ---- 6. Generate DIST_SHA256SUMS + ALL_SHA256SUMS --------------------------
  $distSums = @()
  foreach ($p in (Rel-Paths (Join-Path $root 'dist\mobile'))) { $distSums += "$(Hash-File (Join-Path $root "dist\mobile\$p"))  dist/mobile/$p" }
  foreach ($p in (Rel-Paths (Join-Path $root 'dist\admin')))  { $distSums += "$(Hash-File (Join-Path $root "dist\admin\$p"))  dist/admin/$p" }
  Write-Lf (Join-Path $bundleDir 'DIST_SHA256SUMS') $distSums

  $allSums = @()
  foreach ($p in (Rel-Paths $bundleDir)) {
    if ($p -eq 'ALL_SHA256SUMS') { continue }   # never self-reference
    $allSums += "$(Hash-File (Join-Path $bundleDir $p))  $p"
  }
  Write-Lf (Join-Path $bundleDir 'ALL_SHA256SUMS') $allSums

  # ---- 7. Tar.gz + archive sha256 -------------------------------------------
  if (Test-Path $archive) { Remove-Item $archive -Force }
  tar -czf $archive -C (Join-Path $root 'release') $bundleName
  if ($LASTEXITCODE -ne 0) { throw 'tar failed' }
  $archiveHash = Hash-File $archive
  [IO.File]::WriteAllText("$archive.sha256", "$archiveHash  $bundleName.tar.gz", [Text.UTF8Encoding]::new($false))

  Write-Output "=================================================="
  Write-Output "BUNDLE_DIR=$bundleDir"
  Write-Output "ARCHIVE=$archive"
  Write-Output "ARCHIVE_SHA256=$archiveHash"
  Write-Output "MIGRATIONS=$($order.Count)"
  Write-Output "ALL_FILES=$($allSums.Count)"
  Write-Output "DIST_FILES=$($distSums.Count)"
} finally { Pop-Location }
