#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "$ROOT"

if [[ "$(uname -s)" != "Darwin" ]]; then
  echo "test-only native verification injection requires macOS" >&2
  exit 2
fi

# The flag is supplied only to this test build. Release builds reject it in source.
derived_data="$(mktemp -d /tmp/ch5-passkey-native-injected.XXXXXX)"
trap 'rm -rf "$derived_data"' EXIT
xcodebuild test -quiet -project packages/macos/CH5AuthPasskeyProvider.xcodeproj \
  -scheme CH5AuthHost -destination 'platform=macOS' CODE_SIGNING_ALLOWED=NO \
  -derivedDataPath "$derived_data" \
  SWIFT_ACTIVE_COMPILATION_CONDITIONS='$(inherited) CH5_PASSKEY_TEST_VERIFICATION_INJECTION'

echo "native injection proof: Release excludes the synthetic grant factory"
xcodebuild build -quiet -project packages/macos/CH5AuthPasskeyProvider.xcodeproj \
  -scheme CH5AuthHost -configuration Release CODE_SIGNING_ALLOWED=NO \
  -derivedDataPath "$derived_data"
release_binary="$(find "$derived_data/Build/Products/Release" -type f -perm -111 -name 'CH5AuthCredentialProvider' -print -quit)"
if [[ -z "$release_binary" ]]; then
  echo "Release credential-provider binary was not found" >&2
  exit 1
fi
if strings "$release_binary" | rg -q 'NativeTestVerificationInjection|CH5_PASSKEY_TEST_VERIFICATION_INJECTION'; then
  echo "test-only native verification injection leaked into Release" >&2
  exit 1
fi
