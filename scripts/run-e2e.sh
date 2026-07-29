#!/usr/bin/env bash
set -euo pipefail

mode="${1:-run}"
shift || true
# Ports are pinned literals in pitchfork.toml and no proxy slug is registered,
# so every service is reached at 127.0.0.1:<port>. These are NOT read from
# `pitchfork list --json`: it reports an empty `port` array for v3 and maildev
# even though pitchfork.toml pins both, so it is not a usable port source here.
repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
for port in 3000 8787 8081 1080; do
  grep -qE "^port = $port$" "$repo_root/pitchfork.toml" || {
    echo "run-e2e.sh port $port is no longer pinned in pitchfork.toml" >&2
    exit 1
  }
done
base_url="http://127.0.0.1:3000"     # daemons.web
server_url="http://127.0.0.1:8787"   # daemons.api
v3_url="http://127.0.0.1:8081"       # daemons.v3
maildev_url="http://127.0.0.1:1080"  # daemons.maildev

exec env \
  CYPRESS_BASE_URL="$base_url" \
  CYPRESS_SERVER_URL="$server_url" \
  CYPRESS_V3_URL="$v3_url" \
  CYPRESS_MAILDEV_URL="$maildev_url" \
  CYPRESS_CRASH_REPORTS=0 \
  ./node_modules/.bin/cypress "$mode" "$@"
