#!/bin/bash
# build_and_install.sh - Build and install the PR Reviewer extension in one step
# Usage: ./build_and_install.sh
# Run from the repo root directory.

set -e

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"

"$SCRIPT_DIR/build.sh" && "$SCRIPT_DIR/install.sh"
