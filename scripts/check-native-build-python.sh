#!/usr/bin/env bash
set -euo pipefail

python_executable="${npm_config_python:-}"
if [[ -z "$python_executable" ]] && command -v mise >/dev/null 2>&1; then
  python_executable="$(mise which python 2>/dev/null || true)"
fi
if [[ -z "$python_executable" ]]; then
  python_executable="$(command -v python3)"
fi

if ! "$python_executable" -c "import distutils" >/dev/null 2>&1; then
  echo "native builds require repo-pinned Python with distutils: $python_executable" >&2
  return 1 2>/dev/null || exit 1
fi

export npm_config_python="$python_executable"
