# Starts household-app on a computer that's already set up (node_modules and
# .env.local already exist). For first-time setup on a new computer, run
# start-fresh.ps1 instead.

$root = Split-Path -Parent $PSScriptRoot
$port = 3200

if (-not (Test-Path (Join-Path $root "node_modules"))) {
    Write-Host "node_modules is missing -- run start-fresh.ps1 instead so dependencies get installed." -ForegroundColor Red
    exit 1
}

# The server has no watch mode and locks its SQLite file, so a leftover process
# from a previous run would otherwise block this one from starting cleanly.
$conns = Get-NetTCPConnection -LocalPort $port -State Listen -ErrorAction SilentlyContinue
foreach ($conn in $conns) {
    try {
        $proc = Get-Process -Id $conn.OwningProcess -ErrorAction Stop
        Write-Host "Port $port is in use by $($proc.ProcessName) (PID $($conn.OwningProcess)) -- stopping it first."
        Stop-Process -Id $conn.OwningProcess -Force -Confirm:$false
    } catch {}
}

Write-Host "Starting household-app on port $port in a new window..."
Start-Process powershell -ArgumentList "-NoExit", "-Command", "cd '$root'; npm run dev"
Write-Host "Once that window says 'running on http://localhost:$port', open that address in a browser."
Write-Host "Note: signing in doesn't carry over between restarts -- the server issues a fresh session each time it starts, so everyone has to log back in."
