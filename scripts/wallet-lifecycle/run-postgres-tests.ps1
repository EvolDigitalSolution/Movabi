$ErrorActionPreference = 'Stop'
$container = 'movabi-wallet-test-' + [Guid]::NewGuid().ToString('N')
$toolsDir = Join-Path $env:TEMP $container
$oldUrl = $env:MOVABI_TEST_DATABASE_URL
$oldModule = $env:MOVABI_PG_MODULE
try {
    New-Item -ItemType Directory -Path $toolsDir | Out-Null
    npm install --prefix $toolsDir --no-audit --no-fund pg@8.16.3
    if ($LASTEXITCODE -ne 0) { throw 'Test dependency install failed' }
    docker run -d --name $container -e POSTGRES_PASSWORD=isolated_test_only -p 127.0.0.1::5432 --tmpfs /var/lib/postgresql/data postgres:15-alpine
    if ($LASTEXITCODE -ne 0) { throw 'Isolated PostgreSQL startup failed' }
    $ready = $false
    for ($i = 0; $i -lt 30; $i++) {
        docker exec $container pg_isready -U postgres 2>$null | Out-Null
        if ($LASTEXITCODE -eq 0) { $ready = $true; break }
        Start-Sleep -Seconds 1
    }
    if (!$ready) { throw 'Test database did not become ready' }
    $portLine = docker port $container 5432/tcp
    if ($LASTEXITCODE -ne 0) { throw 'Test port lookup failed' }
    $port = ($portLine -split ':')[-1].Trim()
    $env:MOVABI_TEST_DATABASE_URL = "postgresql://postgres:isolated_test_only@127.0.0.1:$port/postgres"
    $env:MOVABI_PG_MODULE = Join-Path $toolsDir 'node_modules/pg'
    node (Join-Path $PSScriptRoot 'postgres-tests.cjs')
    if ($LASTEXITCODE -ne 0) { throw 'Wallet PostgreSQL regression tests failed' }
} finally {
    docker rm -f $container 2>$null | Out-Null
    $env:MOVABI_TEST_DATABASE_URL = $oldUrl
    $env:MOVABI_PG_MODULE = $oldModule
    if (Test-Path $toolsDir) { Remove-Item -Recurse -Force $toolsDir }
}
