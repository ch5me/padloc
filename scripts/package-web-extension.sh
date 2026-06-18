#!/usr/bin/env bash
set -euo pipefail

usage() {
  cat <<'EOF'
Usage: scripts/package-web-extension.sh --extension-dir <dir> --zip-file <path>

Packages a built browser extension directory as a ZIP for Chrome/Edge signing.
Excludes Firefox signing outputs: web-ext-artifacts/** and *.xpi.
EOF
}

extension_dir=""
zip_file=""

while [ "$#" -gt 0 ]; do
  case "$1" in
    --extension-dir)
      extension_dir="${2:-}"
      shift 2
      ;;
    --zip-file)
      zip_file="${2:-}"
      shift 2
      ;;
    -h|--help)
      usage
      exit 0
      ;;
    *)
      echo "Unknown argument: $1" >&2
      usage >&2
      exit 2
      ;;
  esac
done

if [ -z "$extension_dir" ] || [ -z "$zip_file" ]; then
  usage >&2
  exit 2
fi

if ! command -v python3 >/dev/null 2>&1; then
  echo "python3 is required to package the web extension" >&2
  exit 1
fi

mkdir -p "$(dirname "$zip_file")"
rm -f "$zip_file"

EXTENSION_DIR="$extension_dir" ZIP_FILE="$zip_file" python3 <<'PY'
import os
import sys
from pathlib import Path
from zipfile import ZIP_DEFLATED, ZipFile

extension_dir = Path(os.environ["EXTENSION_DIR"]).resolve()
zip_file = Path(os.environ["ZIP_FILE"]).resolve()

if not extension_dir.is_dir():
    print(f"Extension directory does not exist: {extension_dir}", file=sys.stderr)
    sys.exit(1)

entries = []
for path in sorted(extension_dir.rglob("*")):
    if path.is_dir():
        continue
    rel = path.relative_to(extension_dir).as_posix()
    if rel.startswith("web-ext-artifacts/") or rel.endswith(".xpi"):
        continue
    entries.append((path, rel))

if not entries:
    print(f"No extension files found in {extension_dir}", file=sys.stderr)
    sys.exit(1)

with ZipFile(zip_file, "w", ZIP_DEFLATED) as archive:
    for path, rel in entries:
        archive.write(path, rel)

print(f"Packaged {len(entries)} files into {zip_file}")
PY
