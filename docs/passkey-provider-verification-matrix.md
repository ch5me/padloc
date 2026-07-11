# CH5 Auth Passkey Provider Verification Matrix

This matrix is the durable retest contract for the browser-extension and native
macOS passkey-provider lanes. A green unit test is not a substitute for the
controlled RP system lane, and a public-site success is never evidence that CH5
handled the ceremony unless the selected provider is independently established.

## Stable entry points

| Command                                                                                 | Scope                                                                                                                                                                                                                                  | Human presence                                    |
| --------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------- |
| `npm run proof:passkeys:pr`                                                             | Linux-safe deterministic shared-RP, extension, redaction, runtime, and artifact-restoration lane                                                                                                                                       | None                                              |
| `npm run proof:passkeys:macos-contract`                                                 | Native codec/store/broker contract through the shared verifier                                                                                                                                                                         | None                                              |
| `npm run proof:passkeys`                                                                | macOS-only aggregate: shared RP/verifier, extension tests, Playwright controlled RP, Chromium restart, five-identity selection, TypeScript, native contract, Worker redaction, runtime contract, production artifact, and diff hygiene | None                                              |
| `npm run passkeys:native:test-injected`                                                 | Compile-time test-only synthetic verification grant; client-data-hash binding remains enforced                                                                                                                                         | None; not biometric proof                         |
| `npm run passkeys:native:install`                                                       | Regenerate, sign, install, enable, and assert exactly one macOS CH5 provider registration                                                                                                                                              | Signing authority must already exist              |
| `PADLOC_NATIVE_SYSTEM_E2E=1 npm --prefix packages/extension run test:passkey-rp:native` | Controlled native registration, assertion, Safari/provider restart, and second assertion                                                                                                                                               | Select CH5 and approve normal device-owner sheets |
| `PADLOC_NATIVE_SYSTEM_E2E=1 npm run proof:passkeys:system`                              | Deterministic suite followed by the supervised signed native lane                                                                                                                                                                      | Same protected native approvals                   |

The native runner scripts the RP server, page phases, exact-origin verification,
redacted status polling, process restart, and final verdict. It intentionally
does not synthesize Touch ID, Apple Watch, device-password, or protected system
sheet approval.

## Unattended proof guarantees

-   The extension RP lane refuses an already-owned Worker port, bounds startup
    and shutdown, escalates only its own child process, and verifies port
    release.
-   Each run uses a unique local canary identity, removes only that identity,
    and leaves no Playwright report or extension artifact that was not present
    before the run.
-   The proof wrapper restores the exact pre-run extension artifact, including
    the original absence of `dist`, after success or failure.
-   The controlled Playwright proof disables CI retries. Production build proof
    rejects source maps, requires the production API URL, scans changed
    diagnostics for ceremony material, and exits nonzero on every failed gate.
-   Native polling and hardware approval are bounded. Provider evidence stays in
    memory and is reduced to accepted/verified counts plus a redacted
    fingerprint; raw unified logs are never uploaded.

## CI taxonomy

| Lane                 | Trigger                                                                                 | Runner                   | Evidence and boundary                                                                                               |
| -------------------- | --------------------------------------------------------------------------------------- | ------------------------ | ------------------------------------------------------------------------------------------------------------------- |
| Required branch      | Every relevant pushed SHA before direct fast-forward, including non-`codex/**` branches | Ubuntu                   | `proof:passkeys:pr`; no Xcode, signing, accounts, or protected UI                                                   |
| Native contract      | Every relevant pushed SHA before direct fast-forward, including non-`codex/**` branches | Self-hosted macOS        | `proof:passkeys:macos-contract`; shared verifier and no system UI                                                   |
| Signed injected      | Protected manual dispatch                                                               | Self-hosted signed macOS | Synthetic compile-time-only grant to exercise the broker; never biometric or provider-sheet proof                   |
| Hardware in loop     | Weekly schedule or protected dispatch                                                   | Attended signed macOS    | `proof:passkeys:system`; scripts all RP/restart work and keeps the protected prompt alive for at least five minutes |
| Public/Google canary | Protected manual dispatch only                                                          | Attended signed macOS    | Separately authorized procedure; CI supplies no account or credential material                                      |

The provider workflow retains only redacted command outcomes. It must never
upload raw unified logs, WebAuthn material, credential IDs, or account data.

## Portable developer and CI bootstrap

The repeatable design separates company trust metadata from per-machine secret
identity. A developer Mac or CI runner must not depend on a remembered laptop
name, personal SSH key, root login, or numeric host address.

Checked-in, non-secret company configuration owns the stable service DNS name,
unprivileged reader role, protocol version, allowed operations, and pinned host
key. Each authorized Mac selects its own machine-local Hush identity target;
each CI trust domain receives a separate Hush target and age recipient. The
encrypted target materializes only that identity's constrained SSH key for the
duration of the command and removes it afterward. Developer and CI identities
are never shared.

The constrained log-reader protocol allows exact repository/run/task metadata
and redacted job-log retrieval only. Its server forced command rejects arbitrary
shell, writes, path selection, malformed identifiers, and unsupported protocol
versions. Bootstrap and doctor commands must prove host trust, Hush identity
selection, protocol compatibility, read-only access, redaction, and cleanup
using the same entry point on every authorized Mac and in CI.

Enrollment is complete only after proving a second Mac, a distinct CI identity,
exact run/task retrieval, redaction, denial tests, key rotation, and revocation.
Until the unprivileged service and identities are enrolled, personal/root/IP
access is a temporary operator fallback and is not part of the architecture.

The dedicated Forgejo workflow contains both required pushed-SHA jobs: Ubuntu
runs `proof:passkeys:pr`, and the labeled self-hosted macOS runner runs
`proof:passkeys:macos-contract`. Manual dispatch runs only the selected signed
injection, hardware, or placeholder canary lane; the weekly schedule runs only
the supervised hardware lane. The branch regression, passkey-provider, and
general test workflows accept every pushed branch name; path filters limit work
by affected surface without making `codex/**` a hidden CI prerequisite.

## Feature and specification coverage

| Contract                                  | Automated proof                                                        | System/live proof                                                                                                  | Required result                                                                                                                                |
| ----------------------------------------- | ---------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------- |
| Random, expiring, single-use challenges   | `test:passkey-rp` challenge-store tests                                | Both controlled E2E lanes use server-issued ceremonies                                                             | Replay and stale ceremony fail closed                                                                                                          |
| Client-data type/challenge/origin         | Shared verifier negatives and native vectors                           | Both providers use the same verifier                                                                               | Wrong type, challenge, or origin rejected                                                                                                      |
| RP-ID binding                             | Shared verifier, extension policy, native cross-RP tests               | Controlled RP validates authenticator RP hash                                                                      | Wrong RP or suffix mismatch rejected                                                                                                           |
| ES256/COSE/CBOR/DER                       | Core authenticator, shared verifier, native codec vectors              | Both controlled RPs verify signatures                                                                              | Unsupported algorithm and malformed CBOR/DER rejected                                                                                          |
| UP/UV/BE/BS/counter                       | Core and native codec tests                                            | Controlled RPs require UV, BE, BS, and zero counter                                                                | Missing flags or non-zero synchronized counter rejected                                                                                        |
| Extension approval/unlock                 | Approval, nonce, binding, biometric/password, timeout, rollback tests  | Playwright drives real popup and stale-verification fallback                                                       | No signing before bound approval and fresh verification                                                                                        |
| Extension encrypted-vault boundary        | Serialization, sync, rollback, history-exclusion tests                 | Playwright reloads encrypted records                                                                               | Private key remains only in encrypted vault item                                                                                               |
| Extension restart persistence             | Playwright persistent Chromium profile restart                         | Second assertion after context relaunch                                                                            | Same credential verifies after restart                                                                                                         |
| Extension five-identity selection         | Deterministic selection plus Playwright five-record scenario           | Exact fourth credential selected                                                                                   | Ambiguity requires explicit bound choice                                                                                                       |
| Native authenticated broker               | Single-use grant and cross-RP tests                                    | Device-owner verification precedes callbacks                                                                       | Reused/absent grant cannot authorize key use                                                                                                   |
| Native test injection                     | `passkeys:native:test-injected` only                                   | None                                                                                                               | Synthetic one-use grant is DEBUG + compile-flag gated, remains clientDataHash-bound, and is never a device-owner claim                         |
| Native CH5 key boundary                   | Keychain reload, signing, deletion, pending-cleanup tests              | Signed provider uses AuthenticationServices                                                                        | Exportable key bytes are encrypted by Keychain and remain inside the broker/store module; they never enter controller, response, page, or logs |
| Native synchronized record                | Synchronizable Keychain configuration with isolated test mode          | Same-Mac restart assertion uses persisted record                                                                   | Storage configuration and BE/BS shape are proven; cross-device identity reconciliation is not yet claimed                                      |
| Native five-record credential lookup      | Five-record exact-fourth broker test                                   | OS ambiguity UI is not claimed; other-account enrollment is excluded                                               | Exact credential-ID lookup, no-match, and cross-RP behavior proven                                                                             |
| Native restart persistence and provenance | Store reload test                                                      | Runner correlates RP credential fingerprint with CH5 provider logs, terminates Safari/provider, and verifies again | Persisted CH5 credential remains usable; Apple Passwords cannot satisfy the lane                                                               |
| Failure redaction                         | Worker sentinel, generic RP errors, and changed-source diagnostic scan | Native logs contain stage/category plus approved redacted credential fingerprints                                  | No secrets, raw payloads, IDs, or key material logged                                                                                          |
| Production extension artifact             | E2E wrapper restores production build; proof checks URL/maps           | Loaded canary must match intended backend                                                                          | Production API URL and no source maps                                                                                                          |
| Padloc unlocked-vault integration         | None yet                                                               | None                                                                                                               | Blocked by `adr-passkey-native-vault-boundary.md`; current native broker is not represented as this integration                                |

## Manual compatibility canaries

| Canary          | When to run                                | What counts                                                                                                 | What does not count                                                              |
| --------------- | ------------------------------------------ | ----------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------- |
| `public-canary` | Optional after controlled lanes            | Public RP accepts CH5 create/get with CH5 visibly selected                                                  | Apple Passwords, Chrome, phone, security key, or 1Password success               |
| `google-canary` | Last, after every controlled gate is green | Authorized non-Crown account accepts a new CH5 credential and fresh signed-out assertion, including restart | OAuth, password autofill, existing session, or preserved Apple/iCloud credential |

The existing Google credential is quarantined and must never be deleted or
recreated merely to obtain a fresh test result.

## Fresh evidence and residual status (2026-07-11)

Fresh local evidence is green for `proof:passkeys:pr` (4 shared-verifier tests,
223 extension tests, controlled Chromium RP/restart/five-identity E2E,
typecheck, Worker redaction, runtime contract, production build, source-map
absence, diagnostic scan, and exact artifact restoration),
`proof:passkeys:macos-contract` (the same deterministic suite plus native
XCTest/shared-verifier contract), and `passkeys:native:test-injected` (injected
Debug tests plus Release exclusion scan). The installed signed provider remains
registered exactly once. The injected lane builds Release without the test flag
and scans the provider executable for the synthetic factory/condition marker.
Production code continues to use `LocalAuthentication`; injection neither
bypasses it in Release nor counts as biometric, Apple Watch, device-password, or
system-sheet evidence.

Forgejo exact-SHA evidence is green for `baebbcce5526`: workflow YAML task
`18026`, Node regression `18027`, Cordova Android `18028`, desktop Linux
`18029`, Linux passkey proof `18030`, general tests `18031`, extension runtime
`18032`, macOS native contract `18015`, and Docker build `18016`. Ordinary push
correctly skipped the protected signed-injected (`18020`), hardware (`18021`),
and optional public canary (`18023`) jobs. No protected lane was represented as
executed merely because its skipped status was green.

The supervised signed native command also passed on 2026-07-11. With CH5 Auth
Passkeys selected and normal macOS device-owner verification completed by the
operator, the runner verified controlled registration, a first assertion,
Safari/provider restart, a persisted second assertion, and redacted CH5 provider
provenance. This proves the attended hardware boundary for the current machine;
it does not change Gate 7 or turn synthetic injection into biometric evidence.

Residual status:

-   **RELEASE BLOCKER — Gate 7:** the Keychain-backed native broker is not the
    real Padloc unlocked-vault/local-service boundary. The accepted ADR remains
    controlling, and no proof lane changes that architecture fact.
-   **HUMAN ONLY:** the signed native system lane still requires selecting CH5
    Auth Passkeys and completing ordinary macOS device-owner verification. The
    runner owns registration, assertion, restart, persistence, provenance, and
    redacted verdicts around those protected sheets.
-   **WATCH:** cross-device native identity reconciliation is not claimed; the
    browser-extension page bridge remains a bounded canary surface; compensating
    vault sync remains best-effort if both primary and rollback sync fail. The
    legacy release workflows are not yet all included in the required actionlint
    lane, and `test:error-semantics` remains outside `packages/worker` `test:ci`
    while its existing 13/20 assertions fail; neither is represented as green.
-   **REMOTE GAP:** the portable constrained Forgejo log-reader client and
    server are committed on separate review branches, but the unprivileged
    service, per-device Hush targets, CI identity, and
    second-Mac/rotation/revocation proof are not enrolled yet. Public/Google
    compatibility remains separately authorized, manual-only, and untouched.
