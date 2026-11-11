# Real Vitest comparison: exact pre-fix commit (95d745b, separate git worktree) vs the current
# working tree, plus focused top-up specs and the develop mobile build.
#
# Safety: the current working tree is never stashed, reset, checked out or overwritten. The only
# writes into it are the results folder under _to_delete_claude\ and the build's own dist\ output.
# The baseline worktree is created next to the repo; fixtures are copied into it ONLY where the
# file does not already exist there (robocopy /XC /XN /XO), so tracked baseline files stay at 95d745b.
#
# Native commands run through cmd.exe so their exit codes are captured exactly ($LASTEXITCODE)
# and their output is written raw (UTF-8) to log files. Test failures never stop the script; a
# summary is always produced at the end.
#
# Usage (Windows PowerShell 5.1 or 7):
#   powershell -NoProfile -ExecutionPolicy Bypass -File C:\Users\fedri\source\repos\Movabi-mobile-develop\deploy\vaydu-topup-verify-fix\compare-baseline.ps1
$ErrorActionPreference = 'Continue'
$BaseCommit = '95d745b'
$Repo  = (Resolve-Path (Join-Path $PSScriptRoot '..\..')).Path
$Base  = Join-Path (Split-Path $Repo -Parent) "Movabi-baseline-$BaseCommit"
$Stamp = Get-Date -Format 'yyyyMMdd-HHmmss'
$Out   = Join-Path $Repo "_to_delete_claude\vitest-compare-$Stamp"
New-Item -ItemType Directory -Force -Path $Out | Out-Null
$Codes = [ordered]@{ setup = $null; baseline = $null; patched = $null; focused = $null; build = $null; currentTreeUnchanged = $null }
$Notes = New-Object System.Collections.Generic.List[string]
function Run-Cmd([string]$Dir, [string]$CmdLine, [string]$Log) {
  Push-Location $Dir
  try { cmd /d /c "$CmdLine > ""$Log"" 2>&1"; return $LASTEXITCODE } finally { Pop-Location }
}
$PatchFiles = @('server\routes\driver-wallet-topup.routes.ts','server\services\payments\driver-card-topup-contracts.ts',
  'server\services\payments\driver-wallet-topup.ts','server\services\payments\stripe-driver-topup-sandbox.ts',
  'src\app\shared\ui\driver-wallet-topup.component.ts','src\app\shared\utils\driver-topup-verify-outcome.ts',
  'src\testing\driver-topup-verify-states.spec.ts')
function Tree-Fingerprint {
  $s = (cmd /d /c "git -C ""$Repo"" status --porcelain 2>&1") -join "`n"
  foreach ($f in $PatchFiles) { $p = Join-Path $Repo $f; if (Test-Path $p) { $s += "`n$f " + (Get-FileHash $p -Algorithm SHA256).Hash } else { $s += "`n$f MISSING" } }
  return $s
}
$RepoHead = (cmd /d /c "git -C ""$Repo"" rev-parse --short=7 HEAD 2>&1") -join ''
"repo=$Repo`nbaseline=$Base`nhead=$RepoHead" | Out-File -Encoding utf8 "$Out\context.txt"
$Before = Tree-Fingerprint
$Before | Out-File -Encoding utf8 "$Out\current-tree-before.txt"

# ---- 1. Baseline worktree (create, or reuse only if clean and at the right commit) -------------
$SetupOk = $true
if (Test-Path $Base) {
  $head = (cmd /d /c "git -C ""$Base"" rev-parse --short=7 HEAD 2>&1") -join ''
  $mods = (cmd /d /c "git -C ""$Base"" status --porcelain -uno 2>&1") -join "`n"
  if ($head -ne $BaseCommit -or $mods) { $SetupOk = $false; $Notes.Add("existing $Base is at '$head' or has tracked changes; NOT touched. Move it aside and rerun.") }
  else { $Notes.Add("reused clean existing baseline worktree at $BaseCommit") }
} else {
  $c = Run-Cmd $Repo "git worktree add --detach ""$Base"" $BaseCommit" "$Out\worktree-add.log"
  if ($c -ne 0) { $SetupOk = $false; $Notes.Add("git worktree add failed (exit $c), see worktree-add.log") }
}
if ($SetupOk) {
  # Copy only files missing from the baseline (untracked fixtures); never the patch's own files.
  robocopy $Repo $Base /E /XC /XN /XO /R:1 /W:1 /NP /LOG:"$Out\robocopy-main.log" `
    /XD node_modules .git dist _to_delete_claude .temp vaydu-topup-verify-fix `
    /XF driver-topup-verify-outcome.ts driver-topup-verify-states.spec.ts | Out-Null
  if ($LASTEXITCODE -ge 8) { $SetupOk = $false; $Notes.Add("robocopy main failed ($LASTEXITCODE)") }
  foreach ($d in 'deployed-wallet-source-comparison','payment-account-baseline','vaydu-wallet-minimal-20261028','wallet-minimal-build') {
    $src = Join-Path $Repo ".temp\$d"
    if (Test-Path $src) {
      robocopy $src (Join-Path $Base ".temp\$d") /E /XC /XN /XO /R:1 /W:1 /NP /LOG+:"$Out\robocopy-temp.log" | Out-Null
      if ($LASTEXITCODE -ge 8) { $SetupOk = $false; $Notes.Add("robocopy .temp\$d failed ($LASTEXITCODE)") }
    }
  }
  foreach ($f in 'src\app\shared\utils\driver-topup-verify-outcome.ts','src\testing\driver-topup-verify-states.spec.ts') {
    if (Test-Path (Join-Path $Base $f)) { $SetupOk = $false; $Notes.Add("patch file leaked into baseline: $f") } }
  $mods = (cmd /d /c "git -C ""$Base"" status --porcelain -uno 2>&1") -join "`n"
  if ($mods) { $SetupOk = $false; $Notes.Add("baseline tracked files changed after copy: $mods") }
  if (-not (Test-Path "$Base\node_modules")) { cmd /d /c "mklink /J ""$Base\node_modules"" ""$Repo\node_modules""" | Out-Null }
  # Manifest of untracked files right after setup: used later to prove the baseline holds nothing else.
  cmd /d /c "git -C ""$Base"" status --porcelain --untracked-files=all > ""$Base\..\Movabi-baseline-$BaseCommit.setup-manifest.txt"" 2>&1"
}
$Codes.setup = $(if ($SetupOk) { 0 } else { 1 })

# ---- 2. Same real Vitest command in both trees -------------------------------------------------
$Vitest = 'npx vitest run --reporter=default --reporter=json --outputFile.json='
if ($SetupOk) { $Codes.baseline = Run-Cmd $Base ($Vitest + """$Out\baseline.json""") "$Out\baseline.log" }
$Codes.patched = Run-Cmd $Repo ($Vitest + """$Out\patched.json""") "$Out\patched.log"

# ---- 3. Focused top-up specs (current tree) ----------------------------------------------------
$Focused = 'src/testing/driver-topup-verify-states.spec.ts src/testing/stripe-driver-topup-sandbox.spec.ts src/testing/driver-wallet-topup-http.spec.ts src/testing/driver-wallet-stripe-branch.spec.ts src/testing/driver-wallet-develop.spec.ts src/testing/driver-topup-fees-v2.spec.ts src/testing/wallet-topup-orchestration.spec.ts'
$Codes.focused = Run-Cmd $Repo ("npx vitest run $Focused --reporter=verbose --reporter=json --outputFile.json=""$Out\focused.json""") "$Out\focused.log"

# ---- 4. Develop mobile build -------------------------------------------------------------------
$Codes.build = Run-Cmd $Repo 'npm run build:mobile:develop' "$Out\build.log"

# ---- 5. Prove the current tree was not changed, then summarise ---------------------------------
$After = Tree-Fingerprint
$After | Out-File -Encoding utf8 "$Out\current-tree-after.txt"
$Codes.currentTreeUnchanged = ($Before -eq $After)
($Codes | ConvertTo-Json -Compress) | Out-File -Encoding ascii "$Out\exit-codes.json"
$Notes | Out-File -Encoding utf8 "$Out\notes.txt"
Write-Host ""
Write-Host "RESULTS FOLDER: $Out"
Write-Host ("EXIT CODES: " + ($Codes | ConvertTo-Json -Compress))
foreach ($n in $Notes) { Write-Host "NOTE: $n" }
cmd /d /c "node ""$PSScriptRoot\compare-summary.cjs"" ""$Out"""
Write-Host "Baseline worktree kept at $Base. Remove it later with remove-baseline.ps1 (checks it first)."
