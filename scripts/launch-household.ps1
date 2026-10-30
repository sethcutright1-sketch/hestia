# Always-on entry point for household-app. Meant to be invoked by a Windows
# Task Scheduler task triggered "at log on" (see README.md's "Always-on setup"
# section for the exact task settings) -- NOT run directly by a person, though
# it's safe to run by hand for testing.
#
# This is the one and only copy of the app, on a fixed internal drive (D:) --
# see README.md's "Always-on & multi-device access" section for the
# architecture: it holds the real database and lives on `master`, and changes
# are made directly here (the old flash-drive dev checkout was retired
# 2026-10-03). Because this lives on a fixed internal NVMe disk rather than
# removable USB storage, there's no drive-letter hunting to do here (an
# earlier version of this script did exactly that, back when the live copy
# ran from a flash drive) -- it's just a fixed path.

$ErrorActionPreference = "Stop"

$root = "C:path	ohousehold-app"

$logDir = "C:\ProgramData\household-app\logs"
if (-not (Test-Path $logDir)) { New-Item -ItemType Directory -Path $logDir -Force | Out-Null }
$logFile = Join-Path $logDir ("server-{0}.log" -f (Get-Date -Format "yyyy-MM-dd"))

function Write-Log {
    param([string]$Message)
    $line = "[{0}] {1}" -f (Get-Date -Format "yyyy-MM-dd HH:mm:ss"), $Message
    Write-Host $line
    # Logging must never be able to kill the supervisor. With
    # $ErrorActionPreference = "Stop" set above, a locked log file -- two
    # supervisors appending to the same path, which is exactly the state this
    # got into on 2026-09-07 -- would otherwise terminate the script, taking
    # down the process whose only job is staying up.
    try { Add-Content -Path $logFile -Value $line -ErrorAction Stop } catch { }
}

# Only one supervisor at a time. The task can fire again while a previous run
# is still going (a second logon, a manual Start-ScheduledTask, someone running
# this by hand to test), and two of them fight over both port 3200 and the log
# file. A named mutex is released automatically if the holder is killed, so a
# crashed supervisor never blocks the next one.
$isOnlySupervisor = $false
$supervisorLock = New-Object System.Threading.Mutex($true, "Global\household-app-supervisor", [ref]$isOnlySupervisor)
if (-not $isOnlySupervisor) {
    Write-Log "Another supervisor is already running -- leaving it alone and exiting."
    exit 0
}

if (-not (Test-Path (Join-Path $root "data\household.db"))) {
    Write-Log "ERROR: $root\data\household.db not found. This script expects the live copy at a fixed path -- check it wasn't moved."
    exit 1
}

# Non-negotiable: server.ts loads .env/.env.local by relative path, and db.ts
# derives DATA_DIR/DB_PATH from process.cwd().
Set-Location $root
Write-Log "Working directory set to: $(Get-Location)"

# Clear a stale listener -- lifted from stop.ps1 -- if a previous run of this
# same script is still holding port 3200, starting a second server would fail
# to bind rather than replace it.
$port = 3200
$conns = Get-NetTCPConnection -LocalPort $port -State Listen -ErrorAction SilentlyContinue
foreach ($conn in $conns) {
    try {
        $proc = Get-Process -Id $conn.OwningProcess -ErrorAction Stop
        Write-Log "Port $port already in use by $($proc.ProcessName) (PID $($conn.OwningProcess)) -- stopping it."
        Stop-Process -Id $conn.OwningProcess -Force -Confirm:$false
    } catch {}
}

# An absolute node path, not relying on PATH: this runs from a Task Scheduler
# logon trigger, a context .claude/launch.json already works around by
# hand-patching PATH, so PATH here is not to be trusted.
$node = "C:\Program Files\nodejs\node.exe"
if (-not (Test-Path $node)) {
    $fallback = Get-Command node -ErrorAction SilentlyContinue
    if ($fallback) {
        $node = $fallback.Source
        Write-Log "node.exe not found at the expected path -- using $node from PATH instead."
    } else {
        Write-Log "ERROR: node.exe not found at '$node' or on PATH. Install Node.js or fix this script's path."
        exit 1
    }
}

if (-not (Test-Path (Join-Path $root "dist\server.cjs"))) {
    Write-Log "ERROR: dist\server.cjs not found. Run 'npm run build' (or scripts\rebuild-restart.ps1) before starting this."
    exit 1
}

# Supervise: restart on any exit, with a crash-loop guard -- if the server
# keeps dying within 10s of starting (a bad .env.local, a bad merge from the
# dev branch, ...), back off to a slow retry instead of hammering the disk.
$env:NODE_ENV = "production"
$fastFailures = 0

# The checks above ran under $ErrorActionPreference = "Stop", which is right for
# them: if the path or node is missing there is nothing to supervise and failing
# loudly beats looping forever. From here the opposite applies. This loop's only
# job is to stay alive, so nothing transient inside it may be allowed to
# terminate the script -- on 2026-09-07 the supervisor was found alive but no
# longer restarting anything, having stopped between "Starting server" and the
# "Server exited" line it writes afterwards, with a second supervisor holding
# the same log file.
$ErrorActionPreference = "Continue"

while ($true) {
    Write-Log "Starting server (node dist\server.cjs)..."
    $started = Get-Date
    $exitCode = -1

    try {
        & $node "dist\server.cjs" *>> $logFile
        $exitCode = $LASTEXITCODE
    } catch {
        # Covers the redirect failing as well as the invocation itself. Either
        # way the answer is the same: log it and go round again.
        Write-Log "Server invocation failed: $($_.Exception.Message)"
    }

    $ranFor = (Get-Date) - $started
    Write-Log "Server exited (code $exitCode) after $([int]$ranFor.TotalSeconds)s."

    if ($ranFor.TotalSeconds -lt 10) {
        $fastFailures++
    } else {
        $fastFailures = 0
    }

    if ($fastFailures -ge 5) {
        Write-Log "5 fast failures in a row -- backing off for 60s before retrying."
        Start-Sleep -Seconds 60
        $fastFailures = 0
    } else {
        Start-Sleep -Seconds 5
    }
}
