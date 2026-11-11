# Removes the temporary baseline worktree ONLY if it holds nothing beyond what
# compare-baseline.ps1 put there. Never touches the current working tree or node_modules.
#   powershell -NoProfile -ExecutionPolicy Bypass -File C:\Users\fedri\source\repos\Movabi-mobile-develop\deploy\vaydu-topup-verify-fix\remove-baseline.ps1
$ErrorActionPreference = 'Continue'
$BaseCommit = '95d745b'
$Repo = (Resolve-Path (Join-Path $PSScriptRoot '..\..')).Path
$Base = Join-Path (Split-Path $Repo -Parent) "Movabi-baseline-$BaseCommit"
$Manifest = Join-Path (Split-Path $Repo -Parent) "Movabi-baseline-$BaseCommit.setup-manifest.txt"
if (-not (Test-Path $Base)) { Write-Host "No baseline at $Base"; exit 0 }
$head = (cmd /d /c "git -C ""$Base"" rev-parse --short=7 HEAD 2>&1") -join ''
$tracked = (cmd /d /c "git -C ""$Base"" status --porcelain -uno 2>&1") -join "`n"
if ($head -ne $BaseCommit) { Write-Host "STOP: $Base is at '$head', not $BaseCommit. Not removed."; exit 1 }
if ($tracked) { Write-Host "STOP: tracked changes in baseline:`n$tracked"; exit 1 }
$now = cmd /d /c "git -C ""$Base"" status --porcelain --untracked-files=all 2>&1"
$then = if (Test-Path $Manifest) { Get-Content $Manifest } else { @() }
$extra = Compare-Object -ReferenceObject @($then) -DifferenceObject @($now) | Where-Object SideIndicator -eq '=>'
if ($extra) { Write-Host "STOP: files appeared in the baseline after setup:"; $extra | ForEach-Object { Write-Host "  $($_.InputObject)" }; exit 1 }
# Remove the node_modules junction itself (rmdir on a junction never deletes the target).
$nm = Join-Path $Base 'node_modules'
if (Test-Path $nm) {
  if (((Get-Item $nm -Force).Attributes -band [IO.FileAttributes]::ReparsePoint) -eq 0) { Write-Host "STOP: $nm is a real directory, not the junction. Not removed."; exit 1 }
  cmd /d /c "rmdir ""$nm"""
}
# Only copied fixtures remain as untracked files, so --force is needed and now proven safe.
cmd /d /c "git -C ""$Repo"" worktree remove --force ""$Base"""
if ($LASTEXITCODE -eq 0) { Remove-Item $Manifest -ErrorAction SilentlyContinue; Write-Host "Removed $Base" } else { Write-Host "git worktree remove failed ($LASTEXITCODE)"; exit 1 }
