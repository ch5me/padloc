# ADR: Native passkey vault boundary

Date: 2026-07-10

## Status

Accepted as an explicit release constraint; real Padloc unlocked-vault/service
integration remains required before this native provider can be presented as a
Padloc vault-backed product feature.

## Decision

The current macOS provider uses the CH5-owned `NativePasskeyBroker` and its
Keychain store as a development signing boundary. This is deliberately not
called the Padloc unlocked-vault/service boundary: it has no authenticated IPC
or shared unlock session with the existing Padloc vault.

The controlled RP, signed-provider, and hardware lanes may prove protocol,
provenance, and device-owner verification behavior for this development
boundary. They do not satisfy acceptance gate 7 or authorize production
integration claims. A release candidate must either replace this store with an
authenticated Padloc local service/vault broker or receive a new ADR approving
an equivalent boundary with migration, unlock, sync, and deletion semantics.

## Consequences

- `clientDataHash` remains in both registration and assertion verification
  bindings; no test path may weaken or omit it.
- Private key payloads are Keychain-protected and exportable only inside the
  current broker/store module. They are not non-exportable `SecKey` material,
  and cross-device identity-store reconciliation is not implemented.
- Compile-time test injection creates synthetic one-use grants only. It is not
  LocalAuthentication, biometric, Apple Watch, device-password, or system-sheet
  proof and is excluded from Release compilation.
