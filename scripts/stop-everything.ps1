# Fully stops household-app, including the always-on watchdog.
#
# Unlike stop.ps1 (which only kills the node server and gets relaunched
# within seconds by launch-household.ps1's supervise loop), this also kills
# the watchdog script itself so the app stays down until next logon/reboot
# or a manual restart of launch-household.ps1.

$root = "C:path	ohousehold-app"
$port = 3200

Write-Host "Stopping household-app (server + watchdog)..."

# Kill the watchdog loop (launch-household.ps1), wherever it's running from.
Get-CimInstance Win32_Process -Filter "Name = 'powershell.exe'" -ErrorAction SilentlyContinue |
    Where-Object { $_.CommandLine -and $_.CommandLine -like "*launch-household.ps1*" } |
    ForEach-Object {
        Write-Host "Killing watchdog powershell.exe (PID $($_.ProcessId))"
        Stop-Process -Id $_.ProcessId -Force -Confirm:$false -ErrorAction SilentlyContinue
    }

# Kill whatever is listening on the app's port.
$conns = Get-NetTCPConnection -LocalPort $port -State Listen -ErrorAction SilentlyContinue
foreach ($conn in $conns) {
    try {
        $proc = Get-Process -Id $conn.OwningProcess -ErrorAction Stop
        Write-Host "Killing $($proc.ProcessName) (PID $($conn.OwningProcess)) on port $port"
        Stop-Process -Id $conn.OwningProcess -Force -Confirm:$false
    } catch {}
}

# Catch any leftover node process launched from inside this folder.
Get-CimInstance Win32_Process -Filter "Name = 'node.exe'" -ErrorAction SilentlyContinue |
    Where-Object { $_.CommandLine -and $_.CommandLine -like "*$root*" } |
    ForEach-Object {
        Write-Host "Killing node.exe (PID $($_.ProcessId)) -- $($_.CommandLine)"
        Stop-Process -Id $_.ProcessId -Force -Confirm:$false -ErrorAction SilentlyContinue
    }

Write-Host "Done. (It will restart automatically at next logon via Task Scheduler.)"
Start-Sleep -Seconds 5
