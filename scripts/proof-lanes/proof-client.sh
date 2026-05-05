#!/usr/bin/env bash
# proof:client — PWA client compatibility verification lane
# Proves: The PWA client builds successfully and can connect to a Worker backend
#         when PL_SERVER_URL points to the deployed Worker URL.
#
# Required env/bindings:
#   PL_SERVER_URL         — Deployed Worker URL for PWA client to connect to
#   NODE_ENV=production   — Ensures production build paths are exercised
#
# Usage:
#   npm run proof:client
#   bash scripts/proof-lanes/proof-client.sh
#
# Exit codes:
#   0 — PWA build passes and connectivity check succeeds (if PL_SERVER_URL set)
#   1 — Build failed or connectivity check failed
#   2 — Build succeeded but PL_SERVER_URL not set (connectivity skipped, not a failure)

set -euo pipefail

if [[ "${1:-}" == "--help" || "${1:-}" == "-h" ]]; then
  echo "Usage: npm run proof:client"
  echo ""
  echo "Proves: The PWA client builds successfully and connects to a Worker backend"
  echo "        when PL_SERVER_URL points to the deployed Worker URL."
  echo ""
  echo "Required env/bindings:"
  echo "  PL_SERVER_URL         — Deployed Worker URL for PWA client to connect to"
  echo "  NODE_ENV=production   — Ensures production build paths are exercised"
  echo ""
  echo "Exit codes:"
  echo "  0 — PWA build passes and connectivity check succeeds"
  echo "  1 — Build failed or connectivity check failed"
  echo "  2 — Build succeeded but PL_SERVER_URL not set (connectivity skipped)"
  exit 0
fi

RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m'

export NODE_ENV="${NODE_ENV:-production}"

echo "═══════════════════════════════════════════════════════"
echo "  proof:client — PWA Client Compatibility"
echo "═══════════════════════════════════════════════════════"

FAILURES=0

# Build PWA client
echo ""
echo "Building PWA client..."

if npm run pwa:build 2>&1; then
  echo -e "${GREEN}PASS${NC}: PWA build succeeded."
else
  echo -e "${RED}FAIL${NC}: PWA build failed."
  echo "       Check build logs for compilation errors."
  exit 1
fi

# Connectivity check to Worker backend (only if PL_SERVER_URL is set)
echo ""
if [ -z "${PL_SERVER_URL:-}" ]; then
  echo -e "${YELLOW}SKIP${NC}: PL_SERVER_URL not set — skipping connectivity check."
  echo "       Set PL_SERVER_URL to verify client-to-Worker communication."
  exit 2
fi

echo "Testing client-to-Worker connectivity at $PL_SERVER_URL..."

HEALTH_URL="${PL_SERVER_URL%/}/healthcheck"
HTTP_CODE=$(curl -s -o /dev/null -w "%{http_code}" "$HEALTH_URL" --max-time 10 2>/dev/null || echo "000")

if [ "$HTTP_CODE" = "200" ]; then
  echo -e "${GREEN}PASS${NC}: Health endpoint returned 200."
else
  echo -e "${RED}FAIL${NC}: Health endpoint returned HTTP $HTTP_CODE (expected 200)."
  echo "       Worker may not be deployed or PL_SERVER_URL may be incorrect."
  FAILURES=$((FAILURES + 1))
fi

if [ $FAILURES -gt 0 ]; then
  echo ""
  echo -e "${RED}FAIL${NC}: $FAILURES connectivity check(s) failed."
  exit 1
fi

echo ""
echo -e "${GREEN}PASS${NC}: PWA client compatibility proof complete."
exit 0
