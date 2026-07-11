# CH5 Auth macOS passkey provider

This package contains the native macOS host and AuthenticationServices Credential Provider Extension required for authoritative browser passkey registration and assertion.

Generate the project with `xcodegen generate --spec packages/macos/project.yml`. Supply `DEVELOPMENT_TEAM` at build time; team-prefixed identifiers and signing data must not be committed.

Repeatable commands:

```sh
npm run passkeys:native:install
xcodebuild test -project packages/macos/CH5AuthPasskeyProvider.xcodeproj \
  -scheme CH5AuthHost -destination 'platform=macOS' CODE_SIGNING_ALLOWED=NO
PADLOC_NATIVE_SYSTEM_E2E=1 npm --prefix packages/extension run test:passkey-rp:native
```

The development provider uses `NativePasskeyBroker` as its authenticated local
vault boundary. Credential metadata and encrypted ES256 private-key payloads are
CH5-owned synchronizable Keychain items. Registration and assertion require a
single-use opaque `NativeUserVerification` capability produced by macOS
device-owner authentication (Touch ID, Apple Watch, or device password as
offered by the system). Only the broker can consume that capability, retrieve a
private key, and sign; the controller, AuthenticationServices response, and
logs never receive private key bytes.

This aligns the WebAuthn BE/BS flags required by AuthenticationServices with a
Keychain-synchronizable development store. The key payload is exportable inside
the broker/store module so Keychain can synchronize it; it is not a non-exportable
`SecKey`. Cross-device identity-store reconciliation is not implemented or
claimed yet. This is a native CH5 broker, not the browser extension's encrypted
Padloc item format; any future migration must preserve the same bounded
verification and signing boundary.
