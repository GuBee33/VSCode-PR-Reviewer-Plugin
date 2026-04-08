#!/bin/bash
# install.sh - Build and install the PR Reviewer extension locally (macOS/Linux)
# Usage: ./install.sh
# Run from the repo root directory.

set -e

REPO_ROOT="$(cd "$(dirname "$0")" && pwd)"

echo ""
echo "==> PR Reviewer - local install script"
echo ""

# --- 1. Check prerequisites ---
echo "[1/4] Checking prerequisites..."

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
echo "[2/4] Installing npm dependencies..."
cd "$REPO_ROOT"
npm install --silent
echo "  OK"

# --- 3. Package the extension ---
echo "[3/4] Packaging extension..."

# Read version and name from package.json
PKG_NAME=$(node -p "require('./package.json').name")
PKG_VERSION=$(node -p "require('./package.json').version")
PKG_PUBLISHER=$(node -p "require('./package.json').publisher")

VSIX_NAME="${PKG_NAME}-${PKG_VERSION}.vsix"
VSIX_PATH="${REPO_ROOT}/${VSIX_NAME}"

vsce package --allow-missing-repository --skip-license --out "$VSIX_PATH"

if [ ! -f "$VSIX_PATH" ]; then
    echo "Error: VSIX file was not created at: $VSIX_PATH"
    exit 1
fi
echo "  Created: $VSIX_PATH"

# --- 4. Extract to VS Code extensions folder ---
echo "[4/4] Installing into VS Code extensions..."

PUBLISHER_LOWER=$(echo "$PKG_PUBLISHER" | tr '[:upper:]' '[:lower:]')
EXT_ID="${PUBLISHER_LOWER}.${PKG_NAME}-${PKG_VERSION}"
EXTENSIONS_DIR="$HOME/.vscode/extensions"
TARGET_DIR="${EXTENSIONS_DIR}/${EXT_ID}"

if [ -d "$TARGET_DIR" ]; then
    echo "  Removing existing version..."
    rm -rf "$TARGET_DIR"
fi

mkdir -p "$TARGET_DIR"

# Extract the extension/ folder from VSIX (which is a zip file)
TEMP_DIR=$(mktemp -d)
unzip -q "$VSIX_PATH" -d "$TEMP_DIR"
cp -R "$TEMP_DIR/extension/"* "$TARGET_DIR/"
rm -rf "$TEMP_DIR"

echo "  Installed to: $TARGET_DIR"
echo ""
echo "==> Done! Reload VS Code to activate the extension."
echo "    Press Cmd+Shift+P and run: Developer: Reload Window"
echo ""
