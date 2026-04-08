# build.ps1 - Build/package the PR Reviewer extension
# Usage: .\build.ps1
# Run from the repo root directory.

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

$RepoRoot = $PSScriptRoot

Write-Host ""
Write-Host "==> PR Reviewer - build script" -ForegroundColor Cyan
Write-Host ""

# --- 1. Check prerequisites ---
Write-Host "[1/3] Checking prerequisites..." -ForegroundColor Yellow

if (!(Get-Command node -ErrorAction SilentlyContinue)) {
    Write-Error "Node.js is not installed or not on PATH. Please install it from https://nodejs.org"
}

if (!(Get-Command npm -ErrorAction SilentlyContinue)) {
    Write-Error "npm is not installed or not on PATH."
}

# Install vsce if missing
if (!(Get-Command vsce -ErrorAction SilentlyContinue)) {
    Write-Host "  vsce not found - installing globally..."
    npm install -g @vscode/vsce
}

Write-Host "  OK" -ForegroundColor Green

# --- 2. Install npm dependencies ---
Write-Host "[2/3] Installing npm dependencies..." -ForegroundColor Yellow
Push-Location $RepoRoot
npm install --silent
Write-Host "  OK" -ForegroundColor Green

# --- 3. Package the extension ---
Write-Host "[3/3] Packaging extension..." -ForegroundColor Yellow

# Read version from package.json
$pkg = Get-Content (Join-Path $RepoRoot "package.json") | ConvertFrom-Json
$vsixName = "$($pkg.name)-$($pkg.version).vsix"
$vsixPath = Join-Path $RepoRoot $vsixName

vsce package --allow-missing-repository --skip-license --out $vsixPath

Pop-Location

if (!(Test-Path $vsixPath)) {
    Write-Error "VSIX file was not created at: $vsixPath"
}

Write-Host ""
Write-Host "==> Build complete!" -ForegroundColor Cyan
Write-Host "    Created: $vsixPath" -ForegroundColor Green
Write-Host ""
Write-Host "To install, run: .\install.ps1" -ForegroundColor Cyan
Write-Host ""
