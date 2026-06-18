#!/usr/bin/env bash
set -euo pipefail

usage() {
  cat >&2 <<'EOF'
Usage: scripts/package-chrome-crx.sh --extension-dir <dir> --crx-file <path> --private-key-file <path>
EOF
}

extension_dir=""
crx_file=""
private_key_file=""

while [ "$#" -gt 0 ]; do
  case "$1" in
    --extension-dir)
      extension_dir="${2:-}"
      shift 2
      ;;
    --crx-file)
      crx_file="${2:-}"
      shift 2
      ;;
    --private-key-file)
      private_key_file="${2:-}"
      shift 2
      ;;
    -h|--help)
      usage
      exit 0
      ;;
    *)
      echo "Unknown argument: $1" >&2
      usage
      exit 64
      ;;
  esac
done

if [ -z "$extension_dir" ] || [ -z "$crx_file" ] || [ -z "$private_key_file" ]; then
  usage
  exit 64
fi

if [ ! -d "$extension_dir" ]; then
  echo "Extension directory not found: $extension_dir" >&2
  exit 1
fi

if [ ! -s "$private_key_file" ]; then
  echo "Chrome CRX private key file missing or empty: $private_key_file" >&2
  exit 1
fi

chrome_bin="${CHROME_BIN:-}"
if [ -z "$chrome_bin" ]; then
  for candidate in google-chrome chrome chromium chromium-browser; do
    if command -v "$candidate" >/dev/null 2>&1; then
      chrome_bin="$candidate"
      break
    fi
  done
fi

if [ -z "$chrome_bin" ]; then
  echo "Chrome/Chromium binary not found for CRX packaging." >&2
  exit 1
fi

mkdir -p "$(dirname "$crx_file")"
rm -f "$crx_file"
"$chrome_bin" \
  --no-sandbox \
  --disable-gpu \
  --pack-extension="$extension_dir" \
  --pack-extension-key="$private_key_file"

generated="${extension_dir}.crx"
if [ ! -f "$generated" ]; then
  echo "Chrome did not create expected CRX: $generated" >&2
  exit 1
fi

mv "$generated" "$crx_file"
echo "Packaged signed CRX: $crx_file"
