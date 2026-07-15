#!/usr/bin/env bash
set -euo pipefail

source "$(dirname "$0")/check-native-build-python.sh"

max_attempts="${CI_BOOTSTRAP_ATTEMPTS:-3}"
node_executable="${npm_node_execpath:-$(command -v node)}"
export PATH="$(dirname "$node_executable"):$PATH"
hash -r
npm_executable="$(dirname "$node_executable")/npm"
if [ ! -x "$npm_executable" ]; then
  npm_executable="$(command -v npm)"
fi

for ((attempt = 1; attempt <= max_attempts; attempt += 1)); do
  if "$node_executable" node_modules/lerna/cli.js bootstrap --no-ci --npm-client "$npm_executable" -- --no-save; then
    exit 0
  fi
  if ((attempt == max_attempts)); then
    echo "workspace bootstrap failed after ${max_attempts} attempts" >&2
    exit 1
  fi

  echo "workspace bootstrap attempt ${attempt} failed; retrying" >&2
  # Legacy Sharp installs can be left incomplete in any bootstrapped workspace.
  find packages -mindepth 3 -maxdepth 3 -type d -path '*/node_modules/sharp' -prune -exec rm -rf {} +
  sleep $((attempt * 2))
done
