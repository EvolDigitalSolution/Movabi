$ErrorActionPreference = 'Stop'
$root = Resolve-Path (Join-Path $PSScriptRoot '../..')
Push-Location $root
try {
    if ((git branch --show-current) -ne 'movabi-2.2-develop') { throw 'Wrong branch' }
    if (git diff --cached --name-only) { throw 'Staging area must be empty before release' }
    & (Join-Path $PSScriptRoot 'check.ps1')
    $files = Get-Content (Join-Path $PSScriptRoot 'changed-files.json') -Raw | ConvertFrom-Json
    $changed = @(git status --porcelain --untracked-files=all)
    if ($LASTEXITCODE -ne 0) { throw 'Git status failed' }
    foreach ($line in $changed) {
        $path = $line.Substring(3).Replace('\','/')
        if ($path -notin $files) { throw "Unrelated change: $path" }
    }
    git add -f -- $files
    if ($LASTEXITCODE -ne 0) { throw 'Staging failed' }
    git diff --cached --check
    if ($LASTEXITCODE -ne 0) { throw 'Staged diff check failed' }
    $staged = @(git diff --cached --name-only)
    if ($staged.Count -gt 0) {
        git commit -m 'fix: separate completion from payout retries and protect chat and quote margins'
        if ($LASTEXITCODE -ne 0) { throw 'Commit failed' }
    }
    if (git status --porcelain) { throw 'Working tree is not clean' }
    git push origin HEAD:movabi-2.2-develop
    if ($LASTEXITCODE -ne 0) { throw 'Push failed' }
    $sha = (git rev-parse HEAD).Trim()
    $remote = git ls-remote origin refs/heads/movabi-2.2-develop
    if ($LASTEXITCODE -ne 0 -or ($remote -split '\s+')[0] -ne $sha) { throw 'Remote verification failed' }
    $tag = 'develop-' + $sha.Substring(0,7)
    docker build --platform linux/amd64 --label "org.opencontainers.image.revision=$sha" -f server/Dockerfile -t "movabi-api:$tag" .
    if ($LASTEXITCODE -ne 0) { throw 'API build failed' }
    docker run --rm --entrypoint npx "movabi-api:$tag" tsc -p server/tsconfig.json --noEmit
    if ($LASTEXITCODE -ne 0) { throw 'API image type check failed' }
    docker build --platform linux/amd64 --label "org.opencontainers.image.revision=$sha" --build-arg PROJECT_NAME=mobile --build-arg BUILD_CONFIGURATION=develop -f docker/frontend/Dockerfile -t "movabi-web:$tag" .
    if ($LASTEXITCODE -ne 0) { throw 'Web image build failed' }
    foreach ($imageName in @("movabi-api:$tag","movabi-web:$tag")) {
        $details = docker image inspect $imageName
        if ($LASTEXITCODE -ne 0) { throw 'Image inspection failed' }
        $image = ($details | ConvertFrom-Json)[0]
        if ($image.Config.Labels.'org.opencontainers.image.revision' -ne $sha) { throw 'Image revision mismatch' }
    }
    $archive = Join-Path (Split-Path $root) ("movabi-$tag-" + (Get-Date -Format 'yyyyMMdd-HHmmss') + '.tar')
    if (Test-Path $archive) { throw 'Archive already exists' }
    docker save -o $archive "movabi-api:$tag" "movabi-web:$tag"
    if ($LASTEXITCODE -ne 0) { throw 'Export failed' }
    $migration = Join-Path $root 'supabase/migrations/20261242000000_completion_payout_outbox.sql'
    $archiveHash = (Get-FileHash -Algorithm SHA256 $archive).Hash.ToLowerInvariant()
    $migrationHash = (Get-FileHash -Algorithm SHA256 $migration).Hash.ToLowerInvariant()
    $deploy = Join-Path (Split-Path $root) "movabi-$tag-deploy.sh"
    $template = Get-Content (Join-Path $PSScriptRoot 'deploy-template.sh') -Raw
    $template = $template.Replace('__SHA__',$sha).Replace('__TAG__',$tag).Replace('__ARCHIVE__',(Split-Path $archive -Leaf)).Replace('__ARCHIVE_HASH__',$archiveHash).Replace('__MIGRATION_HASH__',$migrationHash)
    [IO.File]::WriteAllText($deploy, $template.Replace("`r`n","`n"), [Text.UTF8Encoding]::new($false))
    scp -o ServerAliveInterval=15 -o ServerAliveCountMax=4 $archive $migration $deploy edsadmin@87.106.64.25:/srv/movabi/develop/shared/
    if ($LASTEXITCODE -ne 0) { throw 'Transfer failed' }
    Write-Output "DEVELOP_COMMIT=$sha"
    Write-Output "SERVER_COMMAND=bash /srv/movabi/develop/shared/$(Split-Path $deploy -Leaf)"
} finally { Pop-Location }
