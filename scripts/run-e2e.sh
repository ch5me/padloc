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
  const maildev = services.get("maildev");
  if (!web?.proxyUrl || !maildev?.proxyUrl) process.exit(1);
  process.stdout.write(`${web.proxyUrl}\n${maildev.proxyUrl}`);
});
')"

[ -n "$urls" ] || {
  echo "DevMux web or maildev proxy URL missing" >&2
  exit 1
}

base_url="${urls%%$'\n'*}"
maildev_url="${urls#*$'\n'}"
exec env \
  CYPRESS_BASE_URL="$base_url" \
  CYPRESS_MAILDEV_URL="$maildev_url" \
  CYPRESS_CRASH_REPORTS=0 \
  cypress "$mode" "$@"
