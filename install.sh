#!/bin/bash
# install.sh - Install the PR Reviewer extension from a built VSIX
# Usage: ./install.sh
# Run from the repo root directory after running ./build.sh

set -e

REPO_ROOT="$(cd "$(dirname "$0")" && pwd)"

echo ""
echo "==> PR Reviewer - install script"
echo ""

# Check for Node.js (required for reading package.json)
if ! command -v node &> /dev/null; then
    echo "Error: Node.js is required but not found."
    echo "Please install Node.js from https://nodejs.org/ and try again."
    exit 1
fi

# Read version and name from package.json
PKG_NAME=$(node -p "require('./package.json').name")
PKG_VERSION=$(node -p "require('./package.json').version")
PKG_PUBLISHER=$(node -p "require('./package.json').publisher")

VSIX_NAME="${PKG_NAME}-${PKG_VERSION}.vsix"
VSIX_PATH="${REPO_ROOT}/${VSIX_NAME}"

# Check if VSIX exists
if [ ! -f "$VSIX_PATH" ]; then
    echo "Error: VSIX file not found at: $VSIX_PATH"
    echo "Run ./build.sh first to create it."
    exit 1
fi

echo "[1/1] Installing into VS Code extensions..."

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
