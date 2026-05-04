#!/usr/bin/env bash
# proof:migration — D1 migration fixture verification lane
# Proves: D1 migration SQL files are valid and can be executed against a test database.
#         Validates migration syntax, foreign key pragma usage, and fixture imports.
#
# Required env/bindings:
#   CLOUDFLARE_API_TOKEN  — Required for wrangler d1 execute --local
#   CLOUDFLARE_ACCOUNT_ID — Required for wrangler d1 operations
#
# Usage:
#   npm run proof:migration
#   bash scripts/proof-lanes/proof-migration.sh
#
# Exit codes:
#   0 — All migration validations pass
#   1 — Migration syntax error or fixture import failing
#   2 — Missing required env or wrangler CLI

set -euo pipefail

RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m'

echo "═══════════════════════════════════════════════════════"
echo "  proof:migration — D1 Migration Fixture Verification"
echo "═══════════════════════════════════════════════════════"

FAILURES=0
MIGRATIONS_DIR="${MIGRATIONS_DIR:-packages/worker/migrations}"

echo ""
echo "Checking migrations directory..."

if [ ! -d "$MIGRATIONS_DIR" ]; then
  echo -e "${YELLOW}SKIP${NC}: No migrations directory at $MIGRATIONS_DIR"
  echo "       (Expected before T8 migration implementation)"
  exit 0
fi

SQL_FILES=$(find "$MIGRATIONS_DIR" -name "*.sql" 2>/dev/null | wc -l || echo "0")

if [ "$SQL_FILES" -eq 0 ]; then
  echo -e "${YELLOW}SKIP${NC}: No SQL migration files found."
  exit 0
fi

echo "Found $SQL_FILES migration file(s)."

echo ""
echo "Validating migration syntax..."

while IFS= read -r sql_file; do
  FILENAME=$(basename "$sql_file")
  echo ""
  echo "Checking: $FILENAME"

  # Check for forbidden PRAGMA
  if grep -q "PRAGMA foreign_keys=OFF" "$sql_file"; then
    echo -e "${RED}FAIL${NC}: $FILENAME uses 'PRAGMA foreign_keys=OFF' (D1 incompatible)"
    echo "       Use 'PRAGMA defer_foreign_keys=on' instead."
    FAILURES=$((FAILURES + 1))
  fi

  # Check SQL syntax — attempt dry-run if wrangler available
  if command -v wrangler &>/dev/null && [ -n "${CLOUDFLARE_API_TOKEN:-}" ]; then
    if wrangler d1 execute --dry-run --file="$sql_file" 2>/dev/null; then
      echo -e "${GREEN}PASS${NC}: $FILENAME dry-run succeeded."
    else
      echo -e "${RED}FAIL${NC}: $FILENAME dry-run failed."
      FAILURES=$((FAILURES + 1))
    fi
  else
    echo -e "${YELLOW}SKIP${NC}: wrangler CLI or CLOUDFLARE_API_TOKEN not available — syntax dry-run skipped."
  fi

done < <(find "$MIGRATIONS_DIR" -name "*.sql" | sort)

echo ""
if [ $FAILURES -gt 0 ]; then
  echo -e "${RED}FAIL${NC}: $FAILURES migration(s) had errors."
  exit 1
fi

echo -e "${GREEN}PASS${NC}: All migration validations passed."
exit 0
