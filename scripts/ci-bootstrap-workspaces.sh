#!/usr/bin/env bash
set -euo pipefail

max_attempts="${CI_BOOTSTRAP_ATTEMPTS:-3}"
node_executable="${npm_node_execpath:-$(command -v node)}"
export PATH="$(dirname "$node_executable"):$PATH"
hash -r
npm_executable="$(dirname "$node_executable")/npm"

for ((attempt = 1; attempt <= max_attempts; attempt += 1)); do
  if "$node_executable" node_modules/lerna/cli.js bootstrap --npm-client "$npm_executable"; then
    exit 0
  fi
  if ((attempt == max_attempts)); then
    echo "workspace bootstrap failed after ${max_attempts} attempts" >&2
    exit 1
  fi

  echo "workspace bootstrap attempt ${attempt} failed; retrying" >&2
  rm -rf packages/extension/node_modules/sharp
  sleep $((attempt * 2))
done
