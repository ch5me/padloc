# Elf Vault Agentic Personal Data

## Posture

`personal-dev` with runtime-observed proof because the change handles authentication, payment data, and personally identifiable information.

## Problem Statement

People cannot yet treat Elf Vault as the single source for all browser-fillable personal data. Existing records and 1Password imports do not consistently carry the semantic roles required by the agentic broker. Magic Browser still has a parallel personal autofill vault, and the post-fill privacy signal is not enforced across every generic model-observation path. This prevents a safe limited real-data pilot.

## Solution

Elf Vault becomes the only personal-data authority. Its item model and importer preserve semantic meaning and explicit release policy. Magic Browser sends field metadata to the extension-owned broker, receives redacted plans, and requests local execution. Values never enter the model route. Exact standing policies support low-friction automation, while high-risk roles require fresh user verification. Magic Browser blocks generic observation after private values may have entered a document and exposes only redacted proof until a separate disclosure grant exists.

## User Stories

1. As a user, I can store login credentials with semantic username, password, URL, and TOTP roles.
2. As a user, I can store one or more person profiles and postal addresses.
3. As a user, I can store payment cards while treating CVV as transaction-only.
4. As a user, I can store government and financial identifiers with stricter release policy than ordinary profile data.
5. As a user, I can import a small 1Password 1PUX export and receive an exact report of imported, normalized, skipped, and lossy data.
6. As a user, I am never told that passkeys, attachments, documents, history, sharing, or exact TOTP parameters migrated when they did not.
7. As a user, I can re-enroll a passkey into Elf Vault and verify it before removing any old factor.
8. As an agent, I can classify page fields without reading vault values.
9. As an agent, I can request a redacted fill plan bound to the exact browser target.
10. As a user, I can approve once or create an exact origin/item/role standing policy.
11. As a user, I can choose plan-only, prompted, standing-policy automatic, or noninteractive fail-closed operation.
12. As a user, high-risk data and passkeys require recent password or biometric verification.
13. As an agent, I receive only opaque references and redacted receipts.
14. As a user, locking or logging out immediately prevents future fills and clears ephemeral authority.
15. As a user, revoking a standing policy immediately blocks future use.
16. As a user, final purchase or transfer submit remains a separate authorization.
17. As an agent, after private fill I cannot use generic screenshots, page text, accessibility, evaluation, or network/body capture on that document.
18. As an agent, I can still obtain redacted role/count/receipt proof.
19. As an operator, I can install and diagnose the Elf Vault extension/native host in Magic Browser without unlocking or reading values.
20. As an operator, I can run a synthetic end-to-end smoke that prints no personal values.

## Implementation Decisions

- Persist semantic item kind on vault items while preserving compatibility with records that omit it.
- Extend the shared role vocabulary for government and financial identifiers and align extension classification with HTML attributes and conservative heuristics.
- Add explicit risk/release semantics derived from roles; sensitive roles require fresh verification and never allow model disclosure.
- Normalize Website/App templates and 1PUX imports into semantic roles. Import produces a structured loss report instead of silent loss.
- Keep the existing protocol version when additions are optional and backward compatible; version any incompatible wire change.
- The extension owns value resolution and DOM writes. Magic Browser never receives fill values.
- Standing policies remain exact-origin, exact-frame, exact-item, exact-role, revisioned, revocable, and fail closed.
- Magic Browser records per-document privacy state and gates all generic observation primitives centrally.
- Magic Browser's local personal autofill vault stops being an authority. A bounded compatibility importer may convert its encrypted profile into Elf Vault, but standard fill commands use the broker.
- Passkey migration is re-enrollment, not export/import. Existing working passkeys remain untouched.

## Contract Corrections Before Implementation

These contracts close the independent architect findings without widening the
product scope.

- **Creation and import ownership (A4, A8):** G001 owns the shared core
  `ImportProvenance` and `ImportResult` types, persisted provenance on imported
  `VaultItem` records, `createItem`, and template-to-item metadata propagation.
  `createItem` derives `autofillKind`, roles, and release class when a template
  omits them. G002 consumes that contract from the 1PUX parser/importer and
  returns `ImportResult`; it does not invent a side channel. The result carries
  imported, normalized, skipped, and lossy counts plus loss entries and source
  identifiers, never field values.
- **Privacy state authority (A2, A3):** The Padloc extension observation ledger
  is the only producer of `privacy-status`. States are `unknown`, `clean`, and
  `potentially-private`; new tabs, navigations, new document ids, tab close,
  and target mismatches never inherit `clean`. The extension exposes the
  trusted `autofill-observation-reset` operation. Reset requires an exact target
  descriptor and an explicit trusted extension/user action, and can produce
  `clean` only when no private write is pending. The descriptor is
  `{tabId, frameId, origin, documentId, formRef, targetRevision, sessionId}`;
  `privacy-status` echoes it with `state`, `observationRevision`, and
  `genericObservation`. Magic Browser rejects missing, stale, active-tab-
  mismatched, or otherwise non-exact descriptors. Unknown and
  `potentially-private` both block generic observation; redacted proof remains
  available. The exact-target addition is a versioned `privacy-status.v2`
  contract. A protocol-v1 response that cannot prove the target remains
  readable only as non-authorizing data and must fail closed for observation
  gating.
- **Snapshot boundary (A1):** CDP/page snapshots are metadata-only before and
  after fill. `input` and `textarea` nodes do not contain a `value` field;
  compatible snapshots may contain only non-secret metadata such as type,
  name, role, label, placeholder, and `valuePresent`. The CDP serializer and
  typed worker enforce this before any Padloc privacy-status check, and
  pre-fill and post-fill `open_snapshot` tests assert that values are absent.
- **Compatibility migration custody (A5):** The bounded migration path uses an
  `EncryptedAutofillProfileEnvelope` with a format version, envelope id,
  opaque ciphertext, a one-time Padloc import-key wrapping, source provenance,
  consent nonce, and record-count hint. Magic Browser may read the existing
  encrypted blob and ask its local keychain helper to wrap the profile key to
  the one-time Padloc public key; CDP/native transport carries only ciphertext,
  wrapped key, and metadata. Padloc decrypts only inside the trusted
  extension/native executor after explicit user unlock and returns
  `ImportResult` provenance/loss data. The adapter cannot mint or apply a fill
  grant, and no plaintext profile value, key material, or compatibility
  response is written to logs, argv, receipts, or workflow artifacts.
- **Closed broker response (A7):** `PadlocBrokerResponse` is a discriminated
  closed schema containing only the protocol version, request id, exact target
  descriptor, plan/receipt/privacy-status/import-result payloads, and structured
  errors. Unknown top-level or nested keys are rejected by default; no
  open-ended record is accepted. Protocol-v1 fields remain readable, and any
  incompatible change requires a new protocol version.

### Privacy state transitions

| Event | Resulting state | Owner and rule |
| --- | --- | --- |
| New tab, navigation, new document, or new target revision | `unknown` | Padloc ledger creates a fresh entry; no prior state carries forward. |
| Exact trusted reset with no pending private write | `clean` | Padloc extension only; Magic Browser cannot self-assert clean. |
| First value-bearing write | `potentially-private` before the write | Padloc executor marks the exact descriptor before resolving a value. |
| Additional writes, lock, logout, revoke, or worker restart | `potentially-private` or `unknown` for a new descriptor | Existing private state never becomes clean implicitly. |
| Tab close | Entry removed; future queries return `unknown` | Padloc extension clears the descriptor-bound entry. |
| Any descriptor mismatch | Request rejected; no state accepted | Both sides fail closed on tab/frame/document/form/revision mismatch. |

## Testing Decisions

- Domain round trips prove old and new items deserialize and preserve semantic metadata.
- Creation-path fixtures prove template metadata reaches `createItem`; import fixtures prove normalization, persisted provenance, and exact loss-report counts without including real secrets.
- Classifier tests cover login, profile, address, payment, government, financial, ambiguous, and adversarial fields.
- Permission tests cover every mode, hard deny, always-ask, missing authority, stale policy, revocation, lock, and fresh-verification boundaries.
- Broker tests prove redaction, exact target binding, one-value-at-a-time resolution, TTL, nonce, and receipt behavior.
- Passkey tests include the passkey-owned `background.ts` region handoff; no autofill-owned region may alter passkey orchestration.
- Privacy tests prove the state machine, trusted reset, exact tab/frame/document/form/revision binding, cross-tab negatives, and unknown/private blocking.
- CDP and typed-worker tests prove pre-fill and post-fill snapshots omit input values before any later privacy gate.
- Compatibility tests prove encrypted-profile transport never carries plaintext or a fill grant; closed broker-schema fixtures reject arbitrary nested keys while protocol-v1 fixtures remain readable.
- Magic Browser tests prove every generic observation primitive rejects an unknown or potentially-private document while redacted proof succeeds.
- One synthetic end-to-end run crosses the native host and extension boundary, including worker restart and lock.

## Out Of Scope

- Moving real 1Password data or entering real personal information.
- Removing or changing any working credential.
- Production deployment or public extension release.
- General secret retrieval APIs for models.

## Deferred

- Rendered-summary screenshot masking: build when a pilot requires screenshot evidence after private fill; until then screenshots remain blocked.
- Cross-origin iframe recipient grants: build when a real supported checkout requires them; until then cross-origin fill fails closed.
- Model disclosure grants: build only when Chris approves a concrete derived-data use case; exact secret reveal remains excluded.
- Additional country-specific identity schemas: add when a real record or form requires a role absent from the initial US-focused set.

## Further Notes

The limited real-data pilot occurs only after synthetic runtime proof. Start with one profile, one address, one card without CVV, two low-risk passwords, and one low-risk re-enrolled passkey. SSN enters last.
