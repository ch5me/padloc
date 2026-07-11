#!/usr/bin/env bash
set -euo pipefail

: "${FORGEJO_TOKEN:?}"
api="${FORGEJO_SERVER_URL:-${GITHUB_SERVER_URL:-https://git.ch5.me}}/api/v1"
repo="${GITHUB_REPOSITORY:-ch5/padloc}"
mode="${1:?mode}"
shift

request() { curl -fsS --header "Authorization: token ${FORGEJO_TOKEN}" "$@"; }
create_release() {
  local tag="$1" name="$2" prerelease="$3" response status payload
  payload=$(mktemp); response=$(mktemp)
  TAG="$tag" NAME="$name" PRERELEASE="$prerelease" node -e 'process.stdout.write(JSON.stringify({tag_name:process.env.TAG,target_commitish:process.env.GITHUB_SHA,name:process.env.NAME,body:"Machine-readable CH5 Auth release ledger.",draft:false,prerelease:process.env.PRERELEASE==="true"}))' > "$payload"
  status=$(curl -sS -o "$response" -w '%{http_code}' -X POST -H "Authorization: token ${FORGEJO_TOKEN}" -H 'Content-Type: application/json' --data @"$payload" "$api/repos/$repo/releases")
  if [ "$status" = 409 ]; then request "$api/repos/$repo/releases/tags/$tag"; elif [[ "$status" =~ ^2 ]]; then cat "$response"; else cat "$response" >&2; return 1; fi
}
upload() {
  local id="$1" file="$2" replace="$3" name existing
  name=$(basename "$file")
  existing=$(request "$api/repos/$repo/releases/$id/assets" | NAME="$name" node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{const a=JSON.parse(s).find(x=>x.name===process.env.NAME);if(a)process.stdout.write(String(a.id))})')
  if [ -n "$existing" ]; then
    [ "$replace" = true ] || { echo "immutable asset already exists: $name" >&2; return 1; }
    request -X DELETE "$api/repos/$repo/releases/$id/assets/$existing" >/dev/null
  fi
  request -X POST -F "attachment=@$file" "$api/repos/$repo/releases/$id/assets?name=$(NAME="$name" node -e 'process.stdout.write(encodeURIComponent(process.env.NAME))')" >/dev/null
}

if [ "$mode" = immutable ]; then
  : "${TAG:?}"
  status=$(curl -sS -o /dev/null -w '%{http_code}' --header "Authorization: token ${FORGEJO_TOKEN}" "$api/repos/$repo/releases/tags/$TAG")
  if [ "$status" = 200 ]; then
    echo "immutable release tag already exists: $TAG" >&2
    exit 1
  fi
  [ "$status" = 404 ] || { echo "unexpected release lookup HTTP $status" >&2; exit 1; }
  release=$(create_release "$TAG" "$TAG" "${IMMUTABLE_PRERELEASE:-true}")
  id=$(printf '%s' "$release" | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>process.stdout.write(String(JSON.parse(s).id)))')
  for file in "$@"; do upload "$id" "$file" false; done
elif [ "$mode" = pointer ]; then
  file="${1:?manifest}"
  channel="${RELEASE_POINTER_CHANNEL:-staging}"
  [ "$channel" = staging ] || [ "$channel" = stable ] || { echo "invalid pointer channel" >&2; exit 2; }
  prerelease=true; [ "$channel" = stable ] && prerelease=false
  release=$(create_release "${channel}-latest" "CH5 Auth ${channel} latest" "$prerelease")
  id=$(printf '%s' "$release" | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>process.stdout.write(String(JSON.parse(s).id)))')
  cp "$file" latest.json
  upload "$id" latest.json true
else
  echo "unknown mode: $mode" >&2; exit 2
fi
