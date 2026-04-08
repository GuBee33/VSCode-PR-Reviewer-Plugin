# build_and_install.ps1 - Build and install the PR Reviewer extension in one step
# Usage: .\build_and_install.ps1
# Run from the repo root directory.

$ScriptDir = $PSScriptRoot

& "$ScriptDir\build.ps1"
if ($LASTEXITCODE -eq 0 -or $null -eq $LASTEXITCODE) {
    & "$ScriptDir\install.ps1"
}
