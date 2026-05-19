#!/usr/bin/env bash
set -euo pipefail

npm run runtime-config:check
npm run worker:migrate:staging
npm run worker:deploy:staging
PL_SERVER_URL="https://api-pad-staging.ch5.me" PL_PWA_URL="https://pad-staging.ch5.me" npm run pwa:build
echo "Staging worker deployed. Deploy the web bundle to Pages project padloc-pwa-staging if CI is not handling it."
