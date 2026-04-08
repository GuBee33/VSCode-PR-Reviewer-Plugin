#!/bin/bash
# build.sh - Build/package the PR Reviewer extension
# Usage: ./build.sh
# Run from the repo root directory.

set -e

REPO_ROOT="$(cd "$(dirname "$0")" && pwd)"

echo ""
echo "==> PR Reviewer - build script"
echo ""

# --- 1. Check prerequisites ---
echo "[1/3] Checking prerequisites..."

if ! command -v node &> /dev/null; then
    echo "Error: Node.js is not installed or not on PATH. Please install it from https://nodejs.org"
    exit 1
fi

if ! command -v npm &> /dev/null; then
    echo "Error: npm is not installed or not on PATH."
    exit 1
fi

# Install vsce if missing
if ! command -v vsce &> /dev/null; then
    echo "  vsce not found - installing globally..."
    npm install -g @vscode/vsce
fi

echo "  OK"

# --- 2. Install npm dependencies ---
echo "[2/3] Installing npm dependencies..."
cd "$REPO_ROOT"
npm install --silent
echo "  OK"

# --- 3. Package the extension ---
echo "[3/3] Packaging extension..."

# Read version and name from package.json
PKG_NAME=$(node -p "require('./package.json').name")
PKG_VERSION=$(node -p "require('./package.json').version")

VSIX_NAME="${PKG_NAME}-${PKG_VERSION}.vsix"
VSIX_PATH="${REPO_ROOT}/${VSIX_NAME}"

vsce package --allow-missing-repository --skip-license --out "$VSIX_PATH"

if [ ! -f "$VSIX_PATH" ]; then
    echo "Error: VSIX file was not created at: $VSIX_PATH"
    exit 1
fi

echo ""
echo "==> Build complete!"
echo "    Created: $VSIX_PATH"
echo ""
echo "To install, run: ./install.sh"
echo ""
