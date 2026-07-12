#!/usr/bin/env bash
set -euo pipefail

stage="${PADLOC_RELEASE_STAGE:-staging}"
bucket="${PADLOC_RELEASE_BUCKET:-padloc-attachments-${stage}}"
origin="${PADLOC_RELEASE_ORIGIN:-https://api-pad-${stage}.ch5.me/public-releases}"
mode="${1:?mode}"
shift

put() {
  local key="$1" file="$2"
  npm --prefix packages/worker exec -- wrangler r2 object put "${bucket}/public-releases/${key}" --file "$file" --remote
}

put_immutable() {
  local key="$1" file="$2" existing status
  existing=$(mktemp)
  status=$(curl -L -sS -o "$existing" -w '%{http_code}' "${origin}/${key}")
  if [ "$status" = 200 ]; then
    cmp -s "$existing" "$file" || { rm -f "$existing"; echo "immutable public asset collision: $key" >&2; return 1; }
    rm -f "$existing"
    return 0
  fi
  rm -f "$existing"
  [ "$status" = 404 ] || { echo "public asset lookup HTTP $status: $key" >&2; return 1; }
  put "$key" "$file"
}

if [ "$mode" = immutable ]; then
  tag="${TAG:?}"
  for file in "$@"; do put_immutable "releases/${tag}/$(basename "$file")" "$file"; done
elif [ "$mode" = pointer ]; then
  channel="${RELEASE_POINTER_CHANNEL:-staging}"
  [ "$channel" = staging ] || [ "$channel" = stable ] || { echo "invalid pointer channel" >&2; exit 2; }
  put "channels/${channel}/latest.json" "${1:?manifest}"
else
  echo "unknown mode: $mode" >&2
  exit 2
fi
