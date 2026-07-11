#!/usr/bin/env bash
set -euo pipefail

cd "$(dirname "$0")/.."

sources=()
while IFS= read -r source; do
  sources+=("$source")
done < <(find ../*/src -type f -name '*.ts' -print | sort)

TS_NODE_COMPILER_OPTIONS='{"module":"commonjs"}' ../../node_modules/.bin/ts-node src/extract.ts "${sources[@]}"
rm -f res/translations/*.backup.json
