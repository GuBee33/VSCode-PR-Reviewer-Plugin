# install.ps1 - Install the PR Reviewer extension from a built VSIX
# Usage: .\install.ps1
# Run from the repo root directory after running .\build.ps1

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

$RepoRoot = $PSScriptRoot

Write-Host ""
Write-Host "==> PR Reviewer - install script" -ForegroundColor Cyan
Write-Host ""

# Read version from package.json
$pkg = Get-Content (Join-Path $RepoRoot "package.json") | ConvertFrom-Json
$vsixName = "$($pkg.name)-$($pkg.version).vsix"
$vsixPath = Join-Path $RepoRoot $vsixName

# Check if VSIX exists
if (!(Test-Path $vsixPath)) {
    Write-Error "VSIX file not found at: $vsixPath`nRun .\build.ps1 first to create it."
}

Write-Host "[1/1] Installing into VS Code extensions..." -ForegroundColor Yellow

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

Write-Host "  Installed to: $targetDir" -ForegroundColor Green
Write-Host ""
Write-Host "==> Done! Reload VS Code to activate the extension." -ForegroundColor Cyan
Write-Host "    Press Ctrl+Shift+P and run: Developer: Reload Window" -ForegroundColor Cyan
Write-Host ""
