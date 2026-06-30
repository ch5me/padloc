#!/usr/bin/env bash
set -euo pipefail

android_home="${ANDROID_HOME:-${RUNNER_TEMP:-/tmp}/android-sdk}"
cmdline_tools_version="${ANDROID_CMDLINE_TOOLS_VERSION:-8512546}"
work_dir="${RUNNER_TEMP:-/tmp}/android-sdk-install"
sdkmanager="${android_home}/cmdline-tools/latest/bin/sdkmanager"

rm -rf "$work_dir"
mkdir -p "$work_dir" "$android_home/cmdline-tools"

curl -fsSL \
  "https://dl.google.com/android/repository/commandlinetools-linux-${cmdline_tools_version}_latest.zip" \
  -o "$work_dir/cmdline-tools.zip"
unzip -q "$work_dir/cmdline-tools.zip" -d "$work_dir"
rm -rf "$android_home/cmdline-tools/latest"
mv "$work_dir/cmdline-tools" "$android_home/cmdline-tools/latest"

env_file="${FORGEJO_ENV:-${GITHUB_ENV:-}}"
path_file="${FORGEJO_PATH:-${GITHUB_PATH:-}}"
if [ -n "$env_file" ]; then
  {
    echo "ANDROID_HOME=$android_home"
    echo "ANDROID_SDK_ROOT=$android_home"
  } >> "$env_file"
fi
if [ -n "$path_file" ]; then
  {
    echo "$android_home/cmdline-tools/latest/bin"
    echo "$android_home/platform-tools"
  } >> "$path_file"
fi

set +o pipefail
yes | "$sdkmanager" --sdk_root="$android_home" --licenses >/dev/null
license_status="${PIPESTATUS[1]}"
set -o pipefail
if [ "$license_status" -ne 0 ]; then
  exit "$license_status"
fi

"$sdkmanager" --sdk_root="$android_home" \
  "platform-tools" \
  "platforms;android-30" \
  "build-tools;30.0.3"

"$sdkmanager" --sdk_root="$android_home" --list_installed
