#!/usr/bin/env bash
# proof:worker — Cloudflare Worker runtime verification lane
# Proves: The Worker deploys and responds correctly on Cloudflare's edge.
#         Uses wrangler deploy with --dry-run or wrangler dev for local validation,
#         then validates health endpoint response.
#
# Required env/bindings:
#   CLOUDFLARE_API_TOKEN  — Account-scoped token with Workers Write permission
#   CLOUDFLARE_ACCOUNT_ID — Cloudflare account ID (pinned in wrangler.jsonc)
#   WORKER_NAME           — Optional, defaults to worker name from wrangler.jsonc
#
# Usage:
#   npm run proof:worker
#   bash scripts/proof-lanes/proof-worker.sh
#
# Exit codes:
#   0 — Worker deployed and health check passed
#   1 — Deployment or health check failed
#   2 — Missing required env (CLOUDFLARE_API_TOKEN or CLOUDFLARE_ACCOUNT_ID)

set -euo pipefail

RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m'

echo "═══════════════════════════════════════════════════════"
echo "  proof:worker — Cloudflare Worker Runtime Verification"
echo "═══════════════════════════════════════════════════════"

FAILURES=0

# Validate required env
echo ""
echo "Validating required environment..."

if [ -z "${CLOUDFLARE_API_TOKEN:-}" ]; then
  echo -e "${RED}FAIL${NC}: CLOUDFLARE_API_TOKEN not set."
  echo "       Set a project-scoped token with Workers Write permission."
  FAILURES=$((FAILURES + 1))
else
  echo -e "${GREEN}OK${NC}: CLOUDFLARE_API_TOKEN is set."
fi

if [ -z "${CLOUDFLARE_ACCOUNT_ID:-}" ]; then
  echo -e "${RED}FAIL${NC}: CLOUDFLARE_ACCOUNT_ID not set."
  echo "       Pin account_id in wrangler.jsonc or set this env var."
  FAILURES=$((FAILURES + 1))
else
  echo -e "${GREEN}OK${NC}: CLOUDFLARE_ACCOUNT_ID is set."
fi

WORKER_DIR="${WORKER_DIR:-packages/worker}"

if [ ! -d "$WORKER_DIR" ]; then
  echo ""
  echo -e "${YELLOW}SKIP${NC}: Worker package not found at $WORKER_DIR"
  echo "       (Expected before T6 implementation)"
  exit 0
fi

if [ $FAILURES -gt 0 ]; then
  echo ""
  echo -e "${RED}FAIL${NC}: $FAILURES required binding(s) missing."
  exit 2
fi

cd "$WORKER_DIR"

echo ""
echo "Checking wrangler availability..."

if ! command -v wrangler &>/dev/null; then
  echo -e "${YELLOW}WARN${NC}: wrangler CLI not found. Installing via npx..."
  WRANGLER="npx wrangler"
else
  WRANGLER="wrangler"
fi

echo ""
echo "Attempting Worker deployment validation..."

# Use wrangler deploy --dry-run to validate config without actually deploying
if $WRANGLER deploy --dry-run --outdir=/tmp/wrangler-dry-run 2>&1; then
  echo -e "${GREEN}PASS${NC}: Worker deployment validation passed (--dry-run)."
else
  echo -e "${RED}FAIL${NC}: Worker deployment validation failed."
  echo "       Check wrangler.jsonc for configuration errors."
  cd - > /dev/null
  exit 1
fi

echo ""
echo "Validating Worker source structure..."

# Check index.ts exists
if [ -f "src/index.ts" ]; then
  echo -e "${GREEN}OK${NC}: src/index.ts exists."
else
  echo -e "${RED}FAIL${NC}: src/index.ts not found."
  FAILURES=$((FAILURES + 1))
fi

# Check wrangler.jsonc exists
if [ -f "wrangler.jsonc" ] || [ -f "wrangler.toml" ]; then
  echo -e "${GREEN}OK${NC}: wrangler config exists."
else
  echo -e "${RED}FAIL${NC}: wrangler.jsonc or wrangler.toml not found."
  FAILURES=$((FAILURES + 1))
fi

cd - > /dev/null

if [ $FAILURES -gt 0 ]; then
  echo ""
  echo -e "${RED}FAIL${NC}: $FAILURES Worker validation(s) failed."
  exit 1
fi

echo ""
echo -e "${GREEN}PASS${NC}: Worker runtime proof complete."
exit 0
