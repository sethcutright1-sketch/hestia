# Builds and runs the production server once, in the foreground, with no
# supervision -- for testing the production build interactively (e.g. after
# editing server.ts, before trusting scripts/launch-household.ps1's
# unattended version). Ctrl+C to stop; nothing restarts it.
#
# For the actual always-on setup, see scripts\launch-household.ps1 and
# README.md's "Always-on setup" section instead.

$root = Split-Path -Parent $PSScriptRoot
Set-Location $root

Write-Host "Building (npm run build)..."
npm run build
if ($LASTEXITCODE -ne 0) {
    Write-Host "Build failed -- fix the error above." -ForegroundColor Red
    exit 1
}

$port = 3200
$conns = Get-NetTCPConnection -LocalPort $port -State Listen -ErrorAction SilentlyContinue
foreach ($conn in $conns) {
    try {
        $proc = Get-Process -Id $conn.OwningProcess -ErrorAction Stop
        Write-Host "Port $port is in use by $($proc.ProcessName) (PID $($conn.OwningProcess)) -- stopping it first."
        Stop-Process -Id $conn.OwningProcess -Force -Confirm:$false
    } catch {}
}

Write-Host "Starting production server on port $port (Ctrl+C to stop; nothing will restart it automatically)..."
$env:NODE_ENV = "production"
node dist\server.cjs
