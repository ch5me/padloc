#!/usr/bin/env bash
set -euo pipefail

npm run runtime-config:check
npm run worker:migrate:production
npm run worker:deploy:production
PL_SERVER_URL="https://api-pad.ch5.me" PL_PWA_URL="https://pad.ch5.me" npm run pwa:build
echo "Production worker deployed. Deploy the web bundle to Pages project padloc-pwa if CI is not handling it."
