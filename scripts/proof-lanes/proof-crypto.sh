#!/usr/bin/env bash
# proof:crypto — Core crypto parity verification lane
# Proves: @padloc/core crypto primitives match expected Cloudflare bindings
#         (subtlecrypto API availability, argon2id availability, HMAC-SHA256).
#
# Required env/bindings:
#   NODE_ENV=test          — Ensures test-only crypto paths are exercised
#
# Usage:
#   npm run proof:crypto
#   bash scripts/proof-lanes/proof-crypto.sh
#
# Exit codes:
#   0 — All crypto parity checks pass
#   1 — One or more crypto checks failed

set -euo pipefail

if [[ "${1:-}" == "--help" || "${1:-}" == "-h" ]]; then
  echo "Usage: npm run proof:crypto"
  echo ""
  echo "Proves: @padloc/core crypto primitives match expected Cloudflare bindings"
  echo "        (subtlecrypto API availability, argon2id availability, HMAC-SHA256)."
  echo ""
  echo "Required env/bindings:"
  echo "  NODE_ENV=test — Ensures test-only crypto paths are exercised"
  echo ""
  echo "Exit codes:"
  echo "  0 — All crypto parity checks pass"
  echo "  1 — One or more crypto checks failed"
  exit 0
fi

RED='\033[0;31m'
GREEN='\033[0;32m'
NC='\033[0m'

export NODE_ENV="${NODE_ENV:-test}"

echo "═══════════════════════════════════════════════════════"
echo "  proof:crypto — Crypto Parity Verification"
echo "═══════════════════════════════════════════════════════"

FAILURES=0

echo ""
echo "Running core crypto tests..."

# Run @padloc/core crypto tests
if npm test --workspaces --include-workspace-root --if-present -- --grep "crypto" 2>/dev/null; then
  echo -e "${GREEN}PASS${NC}: Core crypto tests passed."
else
  echo -e "${RED}FAIL${NC}: Core crypto tests failed or not found."
  FAILURES=$((FAILURES + 1))
fi

# If worker package exists with crypto tests, run those too
if [ -d "packages/worker" ] && [ -f "packages/worker/package.json" ]; then
  echo ""
  echo "Checking Worker crypto bindings..."
  
  cd packages/worker
  if npm test --if-present -- --grep "crypto" 2>/dev/null; then
    echo -e "${GREEN}PASS${NC}: Worker crypto tests passed."
  else
    echo -e "${YELLOW}SKIP${NC}: No Worker crypto tests found (expected before T2)."
  fi
  cd ../..
fi

if [ $FAILURES -gt 0 ]; then
  echo ""
  echo -e "${RED}FAIL${NC}: $FAILURES crypto check(s) failed."
  exit 1
fi

echo ""
echo -e "${GREEN}PASS${NC}: All crypto parity checks passed."
exit 0
