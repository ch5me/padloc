#!/usr/bin/env bash
# proof:extension — Extension build and runtime smoke test lane
# Proves: Extension builds successfully and Playwright harness passes.
#
# Required env/bindings:
#   None — builds against staging PL_SERVER_URL from config/environment-targets.json
#
# Usage:
#   npm run proof:extension
#   bash scripts/proof-lanes/proof-extension.sh
#
# Exit codes:
#   0 — Build and all smoke tests pass
#   1 — Build failed or smoke tests failed
#   2 — Playwright not installed

set -euo pipefail

if [[ "${1:-}" == "--help" || "${1:-}" == "-h" ]]; then
  echo "Usage: npm run proof:extension"
  echo ""
  echo "Proves: Extension builds successfully and Playwright smoke harness passes."
  echo ""
  echo "Required env/bindings:"
  echo "  None — builds with default staging PL_SERVER_URL."
  echo ""
  echo "Exit codes:"
  echo "  0 — Build and smoke tests pass"
  echo "  1 — Build failed or smoke tests failed"
  echo "  2 — Playwright not installed"
  exit 0
fi

RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m'

echo "═══════════════════════════════════════════════════════"
echo "  proof:extension — Extension Build + Smoke Tests"
echo "═══════════════════════════════════════════════════════"

# Verify Playwright Chromium is installed
if ! npx playwright --version &>/dev/null; then
  echo ""
  echo -e "${RED}FAIL${NC}: Playwright not found. Install with:"
  echo "       cd packages/extension && npx playwright install chromium"
  exit 2
fi

# Verify extension dist directory would be created
MANIFEST_PATH="packages/extension/dist/manifest.json"

# Clean old dist if it exists (forces fresh build)
if [ -d "packages/extension/dist" ]; then
  echo ""
  echo "Removing stale dist/ to ensure clean build..."
  rm -rf packages/extension/dist
fi

echo ""
echo "Building extension..."
if ! npm run web-extension:build 2>&1; then
  echo ""
  echo -e "${RED}FAIL${NC}: Extension build failed."
  exit 1
fi

# Verify manifest exists (globalSetup equivalent check)
if [ ! -f "$MANIFEST_PATH" ]; then
  echo ""
  echo -e "${RED}FAIL${NC}: Extension manifest not found at $MANIFEST_PATH after build."
  exit 1
fi

echo ""
echo "Manifest found: $MANIFEST_PATH"

echo ""
echo "Running extension runtime smoke tests..."
cd packages/extension
if ! npx playwright test --config test-harness/playwright.config.ts 2>&1; then
  echo ""
  echo -e "${RED}FAIL${NC}: Extension smoke tests failed."
  exit 1
fi

echo ""
echo -e "${GREEN}PASS${NC}: Extension build and smoke tests complete."
exit 0
