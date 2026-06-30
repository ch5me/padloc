#!/usr/bin/env bash
set -euo pipefail

if [ "$#" -eq 0 ]; then
  echo "usage: $0 <apt-package> [apt-package ...]" >&2
  exit 2
fi

apt_get=(apt-get)
if command -v sudo >/dev/null 2>&1; then
  apt_get=(sudo apt-get)
fi

"${apt_get[@]}" update
DEBIAN_FRONTEND=noninteractive "${apt_get[@]}" install -y "$@"
