#!/usr/bin/env bash
set -euo pipefail

version="${GRADLE_VERSION:-7.1.1}"
sha256="${GRADLE_SHA256:-bf8b869948901d422e9bb7d1fa61da6a6e19411baa7ad6ee929073df85d6365d}"
install_root="${RUNNER_TEMP:-/tmp}/gradle"
archive="$(mktemp "${RUNNER_TEMP:-/tmp}/gradle.XXXXXX.zip")"
trap 'rm -f "$archive"' EXIT

curl -fsSL --retry 5 --retry-all-errors --connect-timeout 20 \
  "https://services.gradle.org/distributions/gradle-${version}-bin.zip" -o "$archive"
printf '%s  %s\n' "$sha256" "$archive" | sha256sum -c -
rm -rf "$install_root"
mkdir -p "$install_root"
unzip -q "$archive" -d "$install_root"

gradle_bin="$install_root/gradle-${version}/bin"
path_file="${FORGEJO_PATH:-${GITHUB_PATH:-}}"
if [ -n "$path_file" ]; then
  echo "$gradle_bin" >> "$path_file"
fi
export PATH="$gradle_bin:$PATH"
gradle --version
