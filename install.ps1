# install.ps1 - Build and install the PR Reviewer extension locally
# Usage: .\install.ps1
# Run from the repo root directory.

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

$RepoRoot = $PSScriptRoot

Write-Host ""
Write-Host "==> PR Reviewer - local install script" -ForegroundColor Cyan
Write-Host ""

# --- 1. Check prerequisites ---
Write-Host "[1/4] Checking prerequisites..." -ForegroundColor Yellow

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
Write-Host "[2/4] Installing npm dependencies..." -ForegroundColor Yellow
Push-Location $RepoRoot
npm install --silent
Write-Host "  OK" -ForegroundColor Green

# --- 3. Package the extension ---
Write-Host "[3/4] Packaging extension..." -ForegroundColor Yellow

# Read version from package.json
$pkg = Get-Content (Join-Path $RepoRoot "package.json") | ConvertFrom-Json
$vsixName = "$($pkg.name)-$($pkg.version).vsix"
$vsixPath = Join-Path $RepoRoot $vsixName

vsce package --allow-missing-repository --out $vsixPath

if (!(Test-Path $vsixPath)) {
    Write-Error "VSIX file was not created at: $vsixPath"
}
Write-Host "  Created: $vsixPath" -ForegroundColor Green

# --- 4. Extract to VS Code extensions folder ---
Write-Host "[4/4] Installing into VS Code extensions..." -ForegroundColor Yellow

$publisher    = $pkg.publisher.ToLower()
$extId        = "$publisher.$($pkg.name)-$($pkg.version)"
$extensionsDir = "$env:USERPROFILE\.vscode\extensions"
$targetDir    = Join-Path $extensionsDir $extId

if (Test-Path $targetDir) {
    Write-Host "  Removing existing version..."
    Remove-Item $targetDir -Recurse -Force
}
New-Item -ItemType Directory -Path $targetDir -Force | Out-Null

Add-Type -AssemblyName System.IO.Compression.FileSystem
$zip = [System.IO.Compression.ZipFile]::OpenRead($vsixPath)

foreach ($entry in $zip.Entries) {
    if ($entry.FullName.StartsWith("extension/")) {
        $relative = $entry.FullName.Substring("extension/".Length)
        if ($relative -eq "") { continue }

        $dest = Join-Path $targetDir $relative
        $destDir = Split-Path $dest -Parent
        if (!(Test-Path $destDir)) {
            New-Item -ItemType Directory -Path $destDir -Force | Out-Null
        }

        if (!$entry.FullName.EndsWith("/")) {
            [System.IO.Compression.ZipFileExtensions]::ExtractToFile($entry, $dest, $true)
        }
    }
}

$zip.Dispose()
Pop-Location

Write-Host "  Installed to: $targetDir" -ForegroundColor Green
Write-Host ""
Write-Host "==> Done! Reload VS Code to activate the extension." -ForegroundColor Cyan
Write-Host "    Press Ctrl+Shift+P and run: Developer: Reload Window" -ForegroundColor Cyan
Write-Host ""
