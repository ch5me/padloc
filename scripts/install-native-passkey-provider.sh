#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
APP="/Applications/CH5 Auth Passkeys.app"
PROVIDER_ID="me.ch5.auth.dev.passkeys.provider"
PROJECT="$ROOT/packages/macos/CH5AuthPasskeyProvider.xcodeproj"

if [[ "${1:-}" == "--help" || "${1:-}" == "-h" ]]; then
  cat <<'EOF'
Usage: npm run passkeys:native:install

Builds, signs, installs, enables, and verifies exactly one CH5 Auth macOS
credential provider. Set DEVELOPMENT_TEAM when no prior signed app is installed.
EOF
  exit 0
fi

if [[ "$(uname -s)" != "Darwin" ]]; then
  echo "native provider installation requires macOS" >&2
  exit 2
fi

if [[ "${CH5_PASSKEY_TEST_VERIFICATION_INJECTION:-}" != "" ]]; then
  echo "refusing to install a test-verification-injection build" >&2
  exit 2
fi

TEAM_ID="${DEVELOPMENT_TEAM:-}"
if [[ -z "$TEAM_ID" && -d "$APP" ]]; then
  TEAM_ID="$(codesign -dv --verbose=4 "$APP" 2>&1 | sed -n 's/^TeamIdentifier=//p')"
fi
if [[ -z "$TEAM_ID" ]]; then
  echo "set DEVELOPMENT_TEAM for the signed native provider build" >&2
  exit 2
fi

DERIVED="$(mktemp -d /tmp/ch5auth-passkey-derived.XXXXXX)"
trap 'rm -rf "$DERIVED"' EXIT

xcodegen generate --spec "$ROOT/packages/macos/project.yml"
xcodebuild -quiet -project "$PROJECT" -scheme CH5AuthHost -configuration Debug \
  -derivedDataPath "$DERIVED" DEVELOPMENT_TEAM="$TEAM_ID" CODE_SIGN_STYLE=Automatic build

BUILT_APP="$DERIVED/Build/Products/Debug/CH5 Auth Passkeys.app"
BUILT_EXTENSION="$BUILT_APP/Contents/PlugIns/CH5AuthCredentialProvider.appex"
INSTALLED_EXTENSION="$APP/Contents/PlugIns/CH5AuthCredentialProvider.appex"
codesign --verify --deep --strict "$BUILT_APP"

/usr/bin/pkill -f "$PROVIDER_ID" >/dev/null 2>&1 || true
[[ -d "$INSTALLED_EXTENSION" ]] && pluginkit -r "$INSTALLED_EXTENSION" >/dev/null 2>&1 || true
pluginkit -r "$BUILT_EXTENSION" >/dev/null 2>&1 || true
ditto "$BUILT_APP" "$APP"
pluginkit -a "$INSTALLED_EXTENSION"
pluginkit -e use -i "$PROVIDER_ID"

codesign --verify --deep --strict "$APP"
COUNT="$(pluginkit -mAvvv | rg -c "$PROVIDER_ID" || true)"
if [[ "$COUNT" != "1" ]]; then
  echo "expected one registered CH5 credential provider; found ${COUNT:-0}" >&2
  exit 1
fi
echo "signed CH5 native passkey provider installed and uniquely registered"
