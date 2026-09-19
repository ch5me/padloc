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

## Critic Contract Freeze

Coordinator-frozen after Critic ITERATE C1-C6. Workers must not invent
identifiers, schemas, runners, proof keys, or fixture paths.

### Role vocabulary (C1)

Keep existing `AutofillItemKind` values `person_profile`, `postal_address`,
`payment_card_policy`, `gift_recipient`, and `merchant_profile`. Add
`login`, `government_identity`, and `financial_account`.

Keep existing `AutofillFieldRole` values. Add `login.url`, `government.ssn`,
`government.passport_number`, `government.drivers_license_number`,
`government.national_id`, `financial.account_number`,
`financial.routing_number`, `financial.iban`, and `financial.bic`.

Website/App templates persist `autofillKind=login` with roles `username`,
`password`, `login.url`, and `totp` when present. Computer templates are
`login` without `login.url`. Absent kind deserializes compatibly and grants
no fill authority. Unknown roles fail closed with no fill and no value
disclosure.

Release class is derived from roles:

| Class | Roles |
| --- | --- |
| `low` | person names, contact email/phone, address fields, `login.url`, `merchant.origin` |
| `secret` | `username`, `password`, `totp`, payment PAN/cardholder/expiry |
| `high-risk` | `payment.card.cvv_transient`, all `government.*`, all `financial.*` |

`payment.card.cvv_transient` is transaction-only. Fresh verification is
required for every high-risk role, passkeys, new payment origins, and policy
changes.

### Approval modes (C1)

User-facing names map onto the existing engine enum:

| User-facing | Engine | Semantics |
| --- | --- | --- |
| plan-only | `plan` | `describe` allowed; fill/authenticate/derive/reveal/submit denied |
| prompted | `manual` | ask when no exact allow policy; high-risk always asks unless recent verification is bound to this request digest |
| standing-policy automatic | `auto` | allow only on exact origin/frame/item/role/revision standing allow policy; otherwise ask; high-risk still requires fresh verification |
| noninteractive fail-closed | `dontAsk` | allow only on exact matching allow policy with no confirmation required; otherwise deny; never prompt |

`bypassPrompts` is an internal-only synthetic/test escape. It is never a
user-facing mode, never a Magic Browser CLI mode, never a standing policy,
and never a pilot/default. Setting it outside owned test fixtures is a defect.

### Closed schemas (C2)

`ImportProvenance` is `elf.import-provenance.v1` with required
`schema`, `source`, `sourceId`, `importedAt`, `importerVersion` and optional
opaque `sourceItemId`. `source` is one of `1pux`, `compatibility-envelope`,
`create-item`, `synthetic`. Unknown keys are rejected. No field values.

`ImportLossEntry` is `elf.import-loss.v1` with required `schema`,
`sourceItemId`, `category`, `outcome`, `reasonCode` and optional non-secret
`note`. Categories: `passkey`, `attachment`, `document`, `history`,
`sharing`, `totp-parameters`, `unsupported-field`, `trashed`, `unknown-kind`.
Outcomes: `skipped`, `lossy-normalized`. Reason codes:
`UNSUPPORTED_PASSKEY`, `UNSUPPORTED_ATTACHMENT`, `UNSUPPORTED_DOCUMENT`,
`UNSUPPORTED_HISTORY`, `UNSUPPORTED_SHARING`, `NONEXACT_TOTP_PARAMETERS`,
`UNSUPPORTED_FIELD`, `TRASHED_ITEM`, `UNKNOWN_KIND`.

`ImportResult` is `elf.import-result.v1` with required `schema`, `imported`,
`normalized`, `skipped`, `lossy`, `provenance`, `losses`,
`sourceIdentifiers`. Counts are integers `>= 0`. Unknown keys and field
values are rejected.

`EncryptedAutofillProfileEnvelope` is
`elf.encrypted-autofill-profile-envelope.v1` with required `schema`,
`envelopeId`, `formatVersion=1`, opaque base64 `ciphertext`, opaque base64
`wrappedKey`, `wrapAlgorithm=padloc-import-key-v1`, `sourceProvenance`,
`consentNonce`, `recordCountHint`, and `createdAt`. No plaintext, raw key,
or fill grant.

Key-custody handshake operations are `import-begin` then `import-commit`:
Magic Browser receives a one-time Padloc import public key, the local
keychain helper wraps the profile key, only the envelope crosses native
transport, and Padloc decrypts after unlock and returns `ImportResult`.

`PadlocBrokerResponse` for authorizing work is the closed discriminated
union `dance.elf.vault.broker-response.v2` keyed by `kind`: `status`,
`classified`, `plan`, `approval-required`, `granted`, `applied`, `revoked`,
`privacy-status`, `import-result`, `error`. Required on all variants:
`schema`, `kind`, `protocolVersion`, `requestId`, `ok`. Exact target is
required except `status` and `error`. Structured errors use
`dance.elf.vault.broker-error.v1` with `code`, `retryable`, optional
`safeMessage`, and codes `LOCKED`, `DENIED`, `ASK_REQUIRED`,
`TARGET_MISMATCH`, `STALE`, `UNKNOWN_PRIVACY`, `POTENTIALLY_PRIVATE`,
`INVALID_REQUEST`, `UNKNOWN_KEY`, `UNSUPPORTED`, `EXPIRED`, `REVOKED`.
Unknown keys are rejected. Protocol-v1 responses remain readable only as
non-authorizing compatibility data.

### Observation inventory (C3)

The named shared gate is
`magic-browser/src/runtime/autofill-observation-gate.ts`. It must run before
`open_snapshot`, `extract_links`, `extract_tables`, `read_image`,
`document_text`, `evidence`, `evidence_resolve`, `shape`, `network_detail`,
`replay_request`, `form_inspect`, `form_fill`, `form_set`, `form_submit`,
`form_run_task`, `form_upload_file`, `page.observe`, `page.fetch`,
screenshots, eval, network/body capture, and CDP snapshots.

Worker/tool output must omit `FormField.value`, `FormActionResult.value`,
input/textarea snapshot values, and network bodies when state is `unknown`
or `potentially-private`. `form_fill`/`form_set`/`form_submit` cannot
bypass the Padloc broker or return field values.

Safe exceptions: `todo_*`, `candidate_*`, `source_index`, `web_search`,
`wikipedia_as_of`, `helper_*`, `prompts`, `prompt_cancel`,
`scratchpad_status`, `session_health_check`, `deterministic_tally`, and
redacted Padloc privacy-status/receipt/plan commands.

G007 owns `magic-browser/src/runtime/form.ts` and its tests.

### Canonical synthetic runner (C4)

One command:

```bash
node scripts/synthetic-agentic-autofill-e2e.mjs --magic-browser-tree <mb-tree>
```

CWD is the padloc Grove Tree. The Magic Browser script is a helper invoked
only by that runner. Evidence writes only to
`padloc/.ch5/autopilot/agentic-autofill-unification-20260918/synthetic-e2e/`.

Bootstrap before first observation: install synthetic extension/native host,
unlock synthetic vault, open the synthetic target, query `privacy-status`
with the exact descriptor, trusted `autofill-observation-reset` if `unknown`,
and require `clean` before classify/plan.

### Proof authority (C5)

`padloc/.ch5/proof.yaml` is the program proof authority. G008 must add these
command keys; missing keys are a G008 failure, not optional UNKNOWN closure:

- `agentic-autofill-core-model`
- `agentic-autofill-1pux-import`
- `agentic-autofill-passkey-contract`
- `agentic-autofill-permission-engine`
- `agentic-autofill-broker`
- `agentic-autofill-privacy-gate`
- `agentic-autofill-contract-fixtures`
- `agentic-autofill-synthetic-e2e`

Magic Browser `.ch5/proof.yaml` may add a consumer lane invoked by
`agentic-autofill-privacy-gate`. Do not create a second registry.

### Canonical fixtures (C6)

Canonical source:
`padloc/packages/extension/test/fixtures/agentic-autofill/contract.v1.json`.
Padloc and Magic Browser tests consume that file. A local copy is allowed
only with a recorded sha256; hash drift fails.

### Broker variant field tables (C2 remainder)

Every `dance.elf.vault.broker-response.v2` object is closed. Unknown keys are
rejected. No variant may include field values, secrets, keys, or ciphertext
dumps.

Shared required fields: `schema`, `kind`, `protocolVersion=2`, `requestId`,
`ok`.

`target` is `AutofillBrokerTarget`: required `tabId`, `frameId`, `origin`,
`documentId`, `formRef`, `targetRevision`, `sessionId`, `topOrigin`,
`frameOrigin`.

| kind | additional required | optional | payload notes |
| --- | --- | --- | --- |
| `status` | `vaultState` (`locked`/`unlocked`/`unknown`) | `target` | no fill authority |
| `classified` | `target`, `fields` | | `fields[]`: `selector`, `role`, `fieldRef` only |
| `plan` | `target`, `planId`, `fields`, `expiresAt` | | `fields[]`: `fieldRef`, `role`, `sourceRef`, `transactionOnly`, `releaseClass` |
| `approval-required` | `target`, `planId`, `reasonCode`, `mode` | | `mode` is `plan`/`manual`/`auto`/`dontAsk` |
| `granted` | `target`, `grantId`, `planId`, `expiresAt`, `maxUses` | | no values |
| `applied` | `target`, `grantId`, `receipt` | | `receipt`: `receiptId`, `status`, `filledFieldRefs`, `modelDisclosure`, `submittedByExecutor` |
| `revoked` | `target`, `grantId`, `status=revoked` | | |
| `privacy-status` | `target`, `state`, `observationRevision`, `genericObservation` | | `state` is `unknown`/`clean`/`potentially-private` |
| `import-result` | `result` | `target` | `result` is `elf.import-result.v1` |
| `error` | `error` | `target` | `error` is `dance.elf.vault.broker-error.v1` |

Handshake closed shapes:

`elf.import-begin-request.v1` required: `schema`, `operation=import-begin`,
`requestId`, `consentNonce`.

`elf.import-begin-result.v1` required: `schema`, `kind=import-begin-result`,
`requestId`, `ok`, `wrapAlgorithm=padloc-import-key-v1`, `importPublicKey`,
`importKeyId`, `expiresAt`. `importPublicKey` is a one-time wrap key, never a
profile key.

`elf.import-commit-request.v1` required: `schema`, `operation=import-commit`,
`requestId`, `envelope` (`elf.encrypted-autofill-profile-envelope.v1`).

`elf.import-commit-result.v1` required: `schema`, `kind=import-result`,
`requestId`, `ok`, `result` (`elf.import-result.v1`).

Handshake errors use `dance.elf.vault.broker-error.v1`. Canonical fixture
`contract.v1.json` must include one example of every variant and both
handshake round-trips.

### Observation inventory remainder (C3)

Also gate `click_text`, `click_button_text`, `scroll_table`, and `drag`.
Those tools currently return snapshots or table text and are value-bearing.
After `unknown` or `potentially-private`, they fail closed or return
metadata-only/redacted output with no input values, textarea values, or
table cell values. G007 owns these call sites in `typed-tools.ts` and the
matching negatives.

### Exact scalar contracts (C2 remainder r5)

All strings are non-empty UTF-8 unless marked optional. Integers are
non-negative JSON numbers without fractions. Booleans are JSON booleans.
Arrays are JSON arrays of the named item schema. Optional means omit the key
or use JSON `null`; never send unknown keys.

`ImportProvenance` fields: `schema` string constant `elf.import-provenance.v1`;
`source` enum string; `sourceId` string; `importedAt` ISO-8601 string;
`importerVersion` string; `sourceItemId` optional string.

`ImportLossEntry` fields: `schema` string constant `elf.import-loss.v1`;
`sourceItemId` string; `category` enum string; `outcome` enum string;
`reasonCode` enum string; `note` optional string.

`ImportResult` fields: `schema` string constant `elf.import-result.v1`;
`imported` integer; `normalized` integer; `skipped` integer; `lossy` integer;
`provenance` exactly one `ImportProvenance`; `losses` array of
`ImportLossEntry`; `sourceIdentifiers` array of string.

Envelope fields: `schema` string constant
`elf.encrypted-autofill-profile-envelope.v1`; `envelopeId` string;
`formatVersion` integer constant `1`; `ciphertext` base64 string;
`wrappedKey` base64 string; `wrapAlgorithm` string constant
`padloc-import-key-v1`; `sourceProvenance` exactly one `ImportProvenance`;
`consentNonce` string; `recordCountHint` integer; `createdAt` ISO-8601 string.

`AutofillBrokerTarget` fields: `tabId` integer; `frameId` integer; `origin`
string URL; `documentId` string; `formRef` string; `targetRevision` string;
`sessionId` string; `topOrigin` string URL; `frameOrigin` string URL.

Inspected field: `selector` string; `role` string; `fieldRef` string.
Plan field: `fieldRef` string; `role` string; `sourceRef` string;
`transactionOnly` boolean; `releaseClass` enum `low`/`secret`/`high-risk`.
Receipt: `receiptId` string; `status` enum
`completed`/`partial`/`revoked`/`outcome-unknown`; `filledFieldRefs` array of
string; `modelDisclosure` enum `none`/`approved`; `submittedByExecutor`
boolean.

Error object: `schema` string constant `dance.elf.vault.broker-error.v1`; `code`
enum string from the frozen list; `retryable` boolean; `safeMessage` optional
string.

Handshake failure is not a separate schema. Both `import-begin` and
`import-commit` failures return `dance.elf.vault.broker-response.v2` with
`kind=error`, `ok=false`, required `error`, optional `target`. Success
responses are the named `import-begin-result` and `import-commit-result`
objects above, each with `ok=true`. Canonical fixture
`contract.v1.json` includes one success and one `kind=error` example for each
handshake operation and one success example for every broker kind.

### C3 result contracts (r5)

Worker-visible outputs of `click_text`, `click_button_text`, `scroll_table`,
and `drag` are metadata-only in `clean`, `unknown`, and
`potentially-private` states.

Forbidden keys in those results: `value`, `valueBefore`, `valueAfter`,
`ariaValueBefore`, `ariaValueAfter`, `allRows`, input/textarea `value`, and
any table cell string payload.

Allowed metadata: selector/role/fieldRef, heading labels, `rowCount`,
`valuePresent` booleans, drag geometry without values. Unknown and
`potentially-private` still fail closed before producing even metadata if the
shared gate says blocked; `clean` may return the metadata-only schema.
