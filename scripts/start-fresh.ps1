# First-time setup + start for household-app, for a computer that hasn't run it
# before: checks Node, installs dependencies, bootstraps .env.local, then hands
# off to start.ps1. Safe to re-run -- steps that are already done get skipped.

$root = Split-Path -Parent $PSScriptRoot

$node = Get-Command node -ErrorAction SilentlyContinue
if (-not $node) {
    Write-Host "Node.js isn't installed. Get it from https://nodejs.org (v22 or newer) and re-run this script." -ForegroundColor Red
    exit 1
}

$nodeVersion = [version]((node --version) -replace '^v', '')
if ($nodeVersion.Major -lt 22) {
    Write-Host "Node.js v$nodeVersion found, but this app needs v22+ (it uses node:sqlite). Please upgrade and re-run." -ForegroundColor Yellow
}

if (-not (Test-Path (Join-Path $root "node_modules"))) {
    Write-Host "Installing dependencies (npm install)..."
    Push-Location $root
    npm install
    $installExit = $LASTEXITCODE
    Pop-Location
    if ($installExit -ne 0) {
        Write-Host "npm install failed -- fix the error above and re-run this script." -ForegroundColor Red
        exit 1
    }
} else {
    Write-Host "Dependencies already installed, skipping npm install."
}

$envLocal = Join-Path $root ".env.local"
$envExample = Join-Path $root ".env.example"
if (-not (Test-Path $envLocal) -and (Test-Path $envExample)) {
    Copy-Item $envExample $envLocal
    Write-Host "Created .env.local from .env.example -- edit it if you need non-default Ollama or Plaid settings." -ForegroundColor Yellow
}

if (-not (Get-Command ollama -ErrorAction SilentlyContinue)) {
    Write-Host "Note: Ollama wasn't found on this computer. The app itself will still run, but the AI" -ForegroundColor Yellow
    Write-Host "assistant chat needs a local Ollama server (https://ollama.com) with the model from" -ForegroundColor Yellow
    Write-Host ".env.local pulled, e.g.: ollama pull llama3.1" -ForegroundColor Yellow
}

Write-Host "Setup done."
& (Join-Path $PSScriptRoot "start.ps1")
