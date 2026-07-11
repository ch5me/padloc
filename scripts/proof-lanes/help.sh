#!/usr/bin/env bash
# proof-lanes:help — List all proof lanes with commands and env requirements
#
# Usage:
#   npm run proof:help
#   bash scripts/proof-lanes/help.sh

set -euo pipefail

cat <<'EOF'
═══════════════════════════════════════════════════════
  Padloc Cloudflare Proof Lanes
═══════════════════════════════════════════════════════

Lane                Command                           Required Env
─────────────────────────────────────────────────── ────────────────────────────────────────────────────
proof:contract    bash scripts/proof-lanes/proof-contract.sh    None (static analysis)
proof:crypto      bash scripts/proof-lanes/proof-crypto.sh      NODE_ENV=test
proof:worker      bash scripts/proof-lanes/proof-worker.sh      CLOUDFLARE_API_TOKEN, CLOUDFLARE_ACCOUNT_ID
proof:client      bash scripts/proof-lanes/proof-client.sh      PL_SERVER_URL (optional)
proof:migration   bash scripts/proof-lanes/proof-migration.sh   CLOUDFLARE_API_TOKEN (for dry-run)
proof:extension   bash scripts/proof-lanes/proof-extension.sh   Playwright Chromium (install via: npx playwright install chromium)
proof:passkeys    bash scripts/proof-lanes/proof-passkeys.sh    macOS/Xcode + Playwright Chromium

Run all lanes with:
  npm run proof:all
EOF
