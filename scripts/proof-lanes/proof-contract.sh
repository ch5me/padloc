#!/usr/bin/env bash
# proof:contract — API contract verification lane
# Proves: All planned Cloudflare Worker API methods have explicit dispositions
#         (implemented, deferred, or explicitly rejected).
#
# Required env/bindings:
#   None — this is a static analysis lane.
#
# Usage:
#   npm run proof:contract
#   bash scripts/proof-lanes/proof-contract.sh
#
# Exit codes:
#   0 — All methods accounted for
#   1 — Undispositioned methods found
#   2 — Inventory script missing (T1 not yet executed)

set -euo pipefail

RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m'

INVENTORY_SCRIPT="scripts/proof-lanes/inventory-api-methods.sh"
DISPOSITION_FILE=".sisyphus/outputs/api-method-dispositions.json"

echo "═══════════════════════════════════════════════════════"
echo "  proof:contract — API Contract Verification"
echo "═══════════════════════════════════════════════════════"

# Check inventory script exists
if [ ! -f "$INVENTORY_SCRIPT" ]; then
  echo -e "${RED}FAIL${NC}: Inventory script not found at $INVENTORY_SCRIPT"
  echo "       T1 (inventory-api-methods) must be executed first."
  exit 2
fi

# Run inventory if dispositions file doesn't exist yet
if [ ! -f "$DISPOSITION_FILE" ]; then
  echo ""
  echo "No existing dispositions found. Running inventory..."
  bash "$INVENTORY_SCRIPT"
fi

# Validate dispositions exist
if [ ! -f "$DISPOSITION_FILE" ]; then
  echo -e "${RED}FAIL${NC}: $DISPOSITION_FILE not generated after inventory."
  exit 2
fi

# Count methods by disposition
TOTAL=$(cat "$DISPOSITION_FILE" | grep -c '"method"' || echo "0")
IMPLEMENTED=$(grep -c '"implemented"' "$DISPOSITION_FILE" || echo "0")
DEFERRED=$(grep -c '"deferred"' "$DISPOSITION_FILE" || echo "0")
REJECTED=$(grep -c '"rejected"' "$DISPOSITION_FILE" || echo "0")
UNSET=$(grep -c '"disposition": null' "$DISPOSITION_FILE" || echo "0")

echo ""
echo "Method Disposition Summary:"
echo "  Total methods:     $TOTAL"
echo -e "  Implemented:       ${GREEN}$IMPLEMENTED${NC}"
echo -e "  Deferred:          ${YELLOW}$DEFERRED${NC}"
echo -e "  Rejected:          ${RED}$REJECTED${NC}"
echo -e "  Undispositioned:   ${RED}$UNSET${NC}"

if [ "$UNSET" -gt 0 ]; then
  echo ""
  echo -e "${RED}FAIL${NC}: $UNSET method(s) without disposition."
  echo "       Assign disposition in $DISPOSITION_FILE"
  exit 1
fi

# Verify T2 crypto method is dispositioned
if grep -q '"crypto"' "$DISPOSITION_FILE"; then
  echo ""
  echo -e "${GREEN}PASS${NC}: All API methods have dispositions."
else
  echo ""
  echo -e "${YELLOW}WARN${NC}: No crypto-related methods found in inventory."
fi

echo ""
echo "Contract proof complete."
exit 0
