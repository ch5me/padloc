# CH5 Auth Passkey Provider — Durable Continuation Context

Last updated: 2026-07-10

> Historical continuation context. For current proof work, do not inspect or
> operate Google settings, Crown or production accounts, Hush account values,
> or the quarantined Google credential. Public/Google canaries require fresh,
> separate authorization. The current executable contract is
> `docs/passkey-provider-verification-matrix.md`.

## Objective

Finish and prove CH5 Auth as a standards-compatible passkey provider. Padloc
must retain the private credential key, unlock or verify locally, sign the
WebAuthn assertion, and return the public response to the relying party. It must
never inject, log, reveal, or export the private key outside the native
broker/store boundary, and must never reveal the master password.

Work in an autonomous diagnose-edit-test-verify loop until the controlled live
registration, authentication, and restart-persistence gates pass, or a genuine
human-presence action is immediately required.

## Authorization and safety boundaries

- The authorized live identity is the user's development-only Zack test
  account. It is not a Crown account.
- Browser and Mac control are authorized for this development workflow.
- The repo-local Hush value `PADLOC_ZACK_TEST_MASTER_PASSWORD` may be retrieved
  and entered into CH5 Auth when needed.
- Never print, log, screenshot, persist in source, or place in shell arguments
  the exact account email, passwords, Hush values, OTPs, cookies, tokens, raw
  WebAuthn payloads, or private keys.
- Do not touch Crown accounts, other Google accounts, MFA, recovery settings,
  or unrelated Google security settings.
- Ask only at a true human-presence boundary or when action-time confirmation is
  mandatory. Before such a boundary, play:

  ```sh
  for tone in Glass Ping Glass; do
    afplay "/System/Library/Sounds/${tone}.aiff"
  done
  ```

- Preserve the existing Zack Google passkey. It is under Google's security
  review, belongs to Apple/iCloud rather than CH5, and must not be deleted or
  recreated merely to obtain a fresh test.

## Provider surfaces — never conflate them

There are two CH5 implementation lanes and several non-CH5 controls:

1. **CH5 browser-extension provider**
   - A document-start page bridge intercepts enabled WebAuthn ceremonies.
   - The background validates RP/origin, requests CH5 approval/unlock, uses a
     vault-held ES256 credential, and returns the WebAuthn response.
2. **CH5 macOS native credential provider**
   - A signed AuthenticationServices credential-provider extension appears in
     the macOS system passkey sheet as **CH5 Auth Passkeys**.
   - Chrome reaches it after the user bypasses a browser password-manager
     prompt with **Use a security key or another passkey**.
3. **Non-CH5 controls**
   - 1Password's Chrome popup is a browser-extension provider.
   - **Save in Passwords** is Apple Passwords/iCloud Keychain.
   - Chrome-profile, phone, and security-key choices are also not CH5.

A result counts only for the provider that actually handled the ceremony.
Apple Passwords or 1Password success is not CH5 evidence.

## Repository and dirty-worktree state

Repository: `/Users/hassoncs/src/ch5/padloc`

The worktree contains extensive intentional passkey-provider work plus unrelated
user changes. Preserve it. Do not reset, discard, or overwrite unrelated files.
Read `AGENTS.md` before acting.

Primary durable artifacts:

- `docs/passkey-provider-test-plan.md`
- `docs/passkey-provider-completion-goal.md`
- `.omx/plans/padloc-native-passkey-broker-prd.md`
- `.omx/plans/padloc-native-passkey-broker-test-spec.md`
- `.omx/state/autopilot-state.json`
- `.omx/ultragoal/goals.json`

## Previously verified browser-extension baseline

Do not rerun this entire baseline unless a related code change requires it.

- 217 extension tests passed.
- Controlled non-Google registration and authentication passed through the real
  extension, including stale-verification/password fallback, hostile prompt
  metadata, strict encrypted-vault synchronization, rollback, zero-counter
  policy, backup flags, and five-credential selection.
- The exact fourth credential was selected in the five-profile scenario.
- Deterministic Google credential-shape coverage passed.
- Worker logging redaction, production extension build, runtime checks, and
  targeted unlock-session persistence tests passed.
- Code review approved. Architecture review retained only a non-blocking WATCH
  on the browser page-shim architecture.
- `packages/extension/dist` contains the restored production build.

## Native macOS provider implementation

Native project: `packages/macos/`

Important files:

- `project.yml`
- `NativeCore/PasskeyCodec.swift`
- `NativeCore/NativePasskeyStore.swift`
- `NativeCoreTests/PasskeyCodecTests.swift`
- `CredentialProvider/CredentialProviderViewController.swift`
- `Host/CH5AuthPasskeyProviderApp.swift`
- `Config/Host.entitlements`
- `Config/Provider.entitlements`
- `README.md`

Environment:

- Xcode 26.6
- Swift 6.3.3
- XcodeGen installed
- A valid Apple development signing identity and registered Mac are available.
  Never print identity details or team identifiers.

Installed development app:

- `/Applications/CH5 Auth Passkeys.app`
- Provider bundle ID: `me.ch5.auth.dev.passkeys.provider`
- Provider is enabled and appears exactly once in the AuthenticationServices
  provider registry.
- Host and extension are signed; deep/strict codesign verification passed.
- Provider entitlements and `ProvidesPasskeys` are present.

Packaging sharp edge:

- `CH5AuthNativeCore.framework` must be embedded inside the `.appex`.
- The provider implements `loadView()` because it has no XIB.
- Xcode may register a DerivedData provider copy. After signed builds, unregister
  build-tree `.appex` copies, register the `/Applications` copy, enable it, and
  assert exactly one matching provider entry.

Current native persistence uses an authenticated local broker boundary:

- `NativePasskeyBroker` owns registration and assertion key operations.
- P-256 private keys and credential metadata are stored as CH5-owned
  Keychain-synchronizable items. Same-Mac persistence is proven; cross-device
  identity-store reconciliation is not implemented or claimed.
- A short-lived, single-use `NativeUserVerification` capability from
  device-owner authentication is bound to the operation, RP, credential/user,
  and request hash before broker registration/assertion APIs consume it.
- Pending-registration cleanup removes both metadata and signing keys and does
  not erase unrelated published CH5 identities.
- Private bytes are reconstructed transiently only inside the native broker and
  never reach the controller, RP response, or logs.

## Native codec and verification state

`PasskeyCodec` constructs:

- RP-ID SHA-256 hash
- registration authenticator data with UP + AT
- zero signature counter
- zero AAGUID
- opaque credential ID
- EC2/ES256 COSE public key
- `fmt=none` CBOR attestation object
- assertion authenticator data and DER ECDSA signature

The native development provider sets UV only after macOS
`deviceOwnerAuthentication` succeeds. Live verification was completed through
Apple Watch; Touch ID or device password may be offered by macOS on other runs.

Fresh native tests passed:

- authenticator-data layout and RP hash
- UP/AT flags with UV clear
- zero counter and AAGUID positions
- credential-ID boundary and COSE-map boundary
- three-entry `fmt=none` attestation envelope
- UV-clear codec vectors and UV-set broker vectors
- shared-verifier registration/assertion and Keychain reload
- wrong origin/RP/credential, malformed CBOR/DER, unsupported algorithm, and
  missing-UV rejection
- five stored records with exact fourth credential-ID lookup and cross-RP /
  no-match rejection; native OS ambiguity UI is not claimed by this test

Command:

```sh
xcodebuild test \
  -project packages/macos/CH5AuthPasskeyProvider.xcodeproj \
  -scheme CH5AuthHost \
  -destination 'platform=macOS' \
  CODE_SIGNING_ALLOWED=NO
```

The native XCTest target last passed all 6 test methods with 0 failures.

The implementation was compared with Bitwarden's upstream macOS credential
provider. Both construct `ASPasskeyRegistrationCredential` using RP ID,
`clientDataHash`, credential ID, and `fmt=none` attestation object, then call
`completeRegistrationRequest`.

## Live non-Google evidence and current checkpoint

Current relying party: `https://webauthn.io`

Generic test username: `ch5-native-provider-test`

Verified live sequence:

1. Chrome opens webauthn.io in the Zack profile.
2. Registration first opens the 1Password Chrome-extension popup.
3. **Use a security key or another passkey** bypasses 1Password.
4. The macOS AuthenticationServices sheet offers:
   - **Save in CH5 Auth Passkeys**
   - **Save in Passwords**
5. Selecting CH5 invokes the native provider.
6. Earlier builds reached `identity-published`, proving key creation and CH5
   identity publication.

Fresh controlled evidence on 2026-07-10:

- The shared localhost RP accepted a registration from the final signed CH5
  provider build.
- The RP verified a CH5 assertion signature for that credential.
- After Safari and the provider process were terminated and relaunched, the RP
  verified a second assertion with the persisted credential.
- The repeatable runner correlates the RP's redacted credential fingerprint with
  CH5 provider callback logs, so Apple Passwords cannot satisfy the CH5 lane.
- Both registration and assertions used successful device-owner verification;
  Apple Watch was the observed system method.
- The signed host passed deep/strict signature verification and the provider
  appeared exactly once in the system registry.

Earlier failure:

- After CH5 completed its registration callback, Chrome displayed a second
  fallback location chooser containing Apple/phone/Chrome-profile choices.
- webauthn.io then reported that the operation timed out or was not allowed.
- Therefore provider discovery, invocation, and local identity publication were
  working, but the browser-to-RP completion was not proven.

Current UI checkpoint: the controlled signed-system lane is complete and no
protected sheet is pending.

Chrome's dedicated control connection became unavailable late in the session.
Computer Use still sees and controls the Zack Chrome window. Follow the Chrome
skill troubleshooting rules before reconnecting; use the permitted Chrome to
Computer Use handoff for visible UI that the dedicated control surface cannot
address.

## Automated relying-party harness requirement

Routine testing must not depend on Google or webauthn.io. Build a controlled RP
server and shared verifier, then drive it from Playwright and native tests.

The RP server must:

- issue random, single-use, expiring registration and assertion challenges;
- serve a same-origin WebAuthn test page;
- verify client-data type, challenge, origin, RP-ID hash, flags, credential ID,
  CBOR/COSE structure, ES256 signature, and counter policy;
- store only public credential data and redacted metadata;
- reject replay, stale challenges, wrong RP/origin/credential, malformed
  CBOR/DER, unsupported algorithms, and missing required UV.

Required lanes:

1. `extension-rp-e2e`
   - Fully scripted Playwright with unpacked extension.
   - Register, authenticate, restart persistent Chromium context, authenticate
     again, and run five-profile selection.
2. `native-codec-rp-contract`
   - CI-safe macOS job.
   - Feed native registration/assertion responses into the same RP verifier.
   - Verify signatures, store reload, and negative vectors without system UI.
3. `native-system-e2e`
   - Signed macOS runner against the local RP.
   - Script the page/server and supervise only the protected system provider
     sheet when necessary.
4. `public-canary`
   - Optional webauthn.io compatibility check.
5. `google-canary`
   - Final delayed check only after controlled lanes pass.

The same verifier must judge extension and native output. Do not create a weaker
native-only verifier.

Target stable commands:

```sh
npm --prefix packages/extension run test:passkey-rp
npm --prefix packages/extension run test:passkey-rp:extension
xcodebuild test -project packages/macos/CH5AuthPasskeyProvider.xcodeproj \
  -scheme CH5AuthHost -destination 'platform=macOS' CODE_SIGNING_ALLOWED=NO
PADLOC_NATIVE_SYSTEM_E2E=1 npm --prefix packages/extension run test:passkey-rp:native
```

## Historical acceptance gates

Gates 1–6 and 8–10 below describe the earlier build-out sequence and are now
covered by deterministic or controlled proof architecture. Gate 7 remains the
release blocker. Gate 11 is outside current authorization and remains a
manual-only compatibility canary.

1. Complete a controlled non-Google native registration and have the RP accept
   it.
2. Authenticate with the same CH5 native credential and verify the signature at
   the RP.
3. Restart the relevant browser/app/provider and authenticate again.
4. Build the controlled RP server/shared verifier and scripted extension lane.
5. Add the native codec/store contract lane against that verifier.
6. Add the supervised signed macOS system lane.
7. **Release-blocked by ADR.** `docs/adr-passkey-native-vault-boundary.md`
   records that the current native Keychain broker is not the real Padloc local
   unlocked service/vault boundary. Do not claim this integration until the ADR
   replacement condition is implemented.
8. Implement real local verification and set UV only when backed by a trusted
   Padloc unlock/biometric/Apple Watch/device-owner result.
9. Verify five-profile behavior without creating credentials or changing
   settings on other accounts.
10. Run targeted regressions after each change, followed by proportional lint,
    typecheck, build, security/redaction, review, and adversarial QA gates.
11. Only then resume the delayed Zack Google compatibility proof. Preserve the
    existing Google credential throughout.

## Cleanup before final completion

- Remove the temporary password-mismatch diagnostic from
  `packages/app/src/elements/login-signup.ts` if it is still present.
- Keep logs redacted. Never log raw requests/responses, challenges, assertions,
  credential IDs, account identifiers, or private material.
- Update the verification matrix with exact fresh evidence.
- Report remaining risks honestly. Discovery/invocation is not RP acceptance;
  unit signature verification is not live system-provider proof.

## Stop condition

Continue automatically while safe progress remains. Stop only when all
acceptance gates are freshly evidenced, or when the next immediate action
requires human presence/action-time confirmation, missing credentials/authority,
or an unrecoverable external platform condition after safe alternatives are
exhausted.
