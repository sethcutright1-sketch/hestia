# Stops household-app: kills whatever is listening on its port, plus any
# leftover node/tsx process launched from inside this folder (in case it's
# somehow running on a different port).

$root = Split-Path -Parent $PSScriptRoot
$port = 3200

Write-Host "Stopping household-app..."

$conns = Get-NetTCPConnection -LocalPort $port -State Listen -ErrorAction SilentlyContinue
foreach ($conn in $conns) {
    try {
        $proc = Get-Process -Id $conn.OwningProcess -ErrorAction Stop
        Write-Host "Killing $($proc.ProcessName) (PID $($conn.OwningProcess)) on port $port"
        Stop-Process -Id $conn.OwningProcess -Force -Confirm:$false
    } catch {}
}

Get-CimInstance Win32_Process -Filter "Name = 'node.exe'" -ErrorAction SilentlyContinue |
    Where-Object { $_.CommandLine -and $_.CommandLine -like "*$root*" } |
    ForEach-Object {
        Write-Host "Killing node.exe (PID $($_.ProcessId)) -- $($_.CommandLine)"
        Stop-Process -Id $_.ProcessId -Force -Confirm:$false -ErrorAction SilentlyContinue
    }

Write-Host "Done."
