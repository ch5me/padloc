#!/usr/bin/env bash
set -euo pipefail

mode="${1:-run}"
shift || true
urls="$(devmux status --json | node -e '
let input = "";
process.stdin.on("data", (chunk) => input += chunk);
process.stdin.on("end", () => {
  const status = JSON.parse(input);
  const services = new Map(status.services.map((service) => [service.name, service]));
  const web = services.get("web");
  const api = services.get("api");
  const v3 = services.get("v3");
  const maildev = services.get("maildev");
  if (!web?.proxyUrl || !api?.proxyUrl || !v3?.resolvedPort || !maildev?.proxyUrl) process.exit(1);
  process.stdout.write(`${web.proxyUrl}\n${api.proxyUrl}\nhttp://127.0.0.1:${v3.resolvedPort}\n${maildev.proxyUrl}`);
});
')"

[ -n "$urls" ] || {
  echo "DevMux web, api, v3, or maildev URL missing" >&2
  exit 1
}

base_url="${urls%%$'\n'*}"
rest="${urls#*$'\n'}"
server_url="${rest%%$'\n'*}"
rest="${rest#*$'\n'}"
v3_url="${rest%%$'\n'*}"
maildev_url="${rest#*$'\n'}"
exec env \
  CYPRESS_BASE_URL="$base_url" \
  CYPRESS_SERVER_URL="$server_url" \
  CYPRESS_V3_URL="$v3_url" \
  CYPRESS_MAILDEV_URL="$maildev_url" \
  CYPRESS_CRASH_REPORTS=0 \
  ./node_modules/.bin/cypress "$mode" "$@"
