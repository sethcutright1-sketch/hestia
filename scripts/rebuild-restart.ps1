# Ships a code change to the always-on instance: typecheck, build, then kick
# the currently-running server so the supervisor (scripts\launch-household.ps1,
# running as a Task Scheduler job pointed directly at this fixed D: path) picks
# up the new dist\ within a few seconds. Run this instead of touching the
# running server by hand.
#
# This is the live copy and the only checkout -- edit and commit here directly
# on `master` (the flash-drive dev checkout was retired 2026-10-03), then run
# this script. Check `git status` first: the build compiles the working tree,
# not HEAD. See README.md's "Always-on & multi-device access" section.

$root = Split-Path -Parent $PSScriptRoot
Set-Location $root

Write-Host "Typechecking (npm run lint)..."
npm run lint
if ($LASTEXITCODE -ne 0) {
    Write-Host "Typecheck failed -- fix the error above before building." -ForegroundColor Red
    exit 1
}

Write-Host "Building (npm run build)..."
npm run build
if ($LASTEXITCODE -ne 0) {
    Write-Host "Build failed -- fix the error above." -ForegroundColor Red
    exit 1
}

$port = 3200
$conns = Get-NetTCPConnection -LocalPort $port -State Listen -ErrorAction SilentlyContinue
if ($conns) {
    foreach ($conn in $conns) {
        try {
            $proc = Get-Process -Id $conn.OwningProcess -ErrorAction Stop
            Write-Host "Stopping $($proc.ProcessName) (PID $($conn.OwningProcess)) on port $port -- the supervisor task will restart it within a few seconds."
            Stop-Process -Id $conn.OwningProcess -Force -Confirm:$false
        } catch {}
    }
    # Voice input's whisper-server (assistant/speech/whisper.ts) is the app's child process. A forced stop skips the
    # app's exit handler, so make sure it isn't left holding its port -- the new app would then answer every recording
    # with "Voice isn't available". The app starts it again on the next recording.
    $whisperPort = if ($env:WHISPER_PORT) { [int]$env:WHISPER_PORT } else { 8178 }
    Start-Sleep -Seconds 1
    foreach ($wconn in @(Get-NetTCPConnection -LocalPort $whisperPort -State Listen -ErrorAction SilentlyContinue)) {
        $wproc = Get-Process -Id $wconn.OwningProcess -ErrorAction SilentlyContinue
        if ($wproc -and $wproc.ProcessName -eq "whisper-server") {
            Write-Host "Stopping whisper-server (PID $($wproc.Id)) on port $whisperPort."
            Stop-Process -Id $wproc.Id -Force -Confirm:$false
        }
    }
    Write-Host "Done. Give it ~10s, then check http://localhost:$port/api/health."
} else {
    Write-Host "Nothing was listening on port $port -- if the always-on task is set up, it should start on its own; otherwise run scripts\serve-prod.ps1 or wait for the next logon."
}
