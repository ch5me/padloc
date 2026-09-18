# Elf Vault Agentic Personal Data Test Specification

## Test posture

- Scope is synthetic fixtures only. Never use a real 1Password export, real
  personal record, working passkey, production account, or plaintext secret.
- Proof must cross the consuming boundary. A listener, mock response, or
  redacted unit result alone is not live broker proof.
- Exact commands become the eight required keys in `padloc/.ch5/proof.yaml`
  through G008. Missing keys fail G008; they are not optional UNKNOWN closure.

## Candidate validation

1. Parse `graph-candidate.json` with `python3 -m json.tool`.
2. Verify `schema`, `planId`, positive `revision`, timestamps, unique node ids,
   and all referenced nodes.
3. Verify dependency DAG and symmetric `parallelWith` relations.
4. Verify no parallel ownership overlap after `padloc/` and `magic-browser/`
   normalization, including glob intersections and region-qualified
   `background.ts` ownership.
5. Verify every node has `intent`, `ownsPaths`, `deliverable`, and `proof`.
6. Reject unprefixed, absolute, or traversal paths; G009's run artifact must
   begin with `padloc/`.
7. Verify every dependency is reachable from G001 and that no node can bypass
   the shared import, executor, or privacy-gate contracts.

## Focused test matrix

### G001: semantic vault model

- Old serialized `VaultItem` records without `autofillKind` deserialize.
- New records round-trip item kind, role, transaction-only marker, provenance,
  and conservative risk metadata.
- Template-created login, government, and financial items pass semantic metadata
  through `CreateItemDialog` into `createItem`; absent metadata derives
  conservatively and never exposes field values.
- The shared `ImportProvenance` and `ImportResult` contracts are closed,
  encrypted/durable where required, and contain no printable personal values.
- Frozen identifiers are required: kinds `login`, `person_profile`,
  `postal_address`, `payment_card_policy`, `gift_recipient`,
  `merchant_profile`, `government_identity`, `financial_account`; roles include
  existing values plus `login.url` and the frozen government/financial set.
  CVV is never a persistent default role.
- Unknown role and absent kind fail closed without exposing field values.
- `ImportProvenance`/`ImportResult`/`ImportLossEntry` fixtures match the
  closed `elf.import-*.v1` schemas and reject unknown keys.
- Proof: core model round-trip and compatibility fixtures through the changed
  test wrapper.

### G002: 1PUX migration

- Login, profile, address, payment, government, and financial fixtures
  normalize into semantic roles.
- Import result reports imported, normalized, skipped, and lossy counts plus
  source provenance.
- Imported `VaultItem` records persist provenance from the shared core contract;
  the importer does not invent a parallel report or metadata channel.
- Separate fixtures for passkeys, document-only items, attachments, password
  history, sharing metadata, and non-exact TOTP parameters produce explicit
  loss entries and no migration claim.
- Trashed items preserve provenance without becoming hidden authority.
- No fixture contains a real secret.
- Proof: app importer/parser focused tests and deterministic loss-report
  snapshots.

### G003: passkey migration contract

- Re-enrollment creates a new Elf Vault credential at a synthetic relying
  party; no import path accepts a passkey from 1PUX.
- Exercise the existing protocol, page/content bridge, RP policy, approval,
  selection, provider, request-binding, and user-verification seams together;
  unchanged orchestration is not assumed from a unit test of one seam.
- Assertion requires `flowId`, `ttl`, `topOrigin`, `rpId`, exact target, and
  recent user verification.
- Wrong origin, RP id, nonce, expiry, lock, or stale verification fails
  closed.
- Existing working credentials remain untouched in every test.
- Proof: passkey request-binding, provider, user-verification, vault-sync,
  and synthetic relying-party tests. G003 proves the passkey-owned
  `background.ts` region; G005 proves the autofill integration only after the
  serial handoff.

### G004: approval and unlock policy

- User-facing plan-only/prompted/standing-policy-automatic/noninteractive map
  to `plan`/`manual`/`auto`/`dontAsk`.
- Exercise `plan`, `manual`, `auto`, `dontAsk`, and internal-only
  `bypassPrompts`. `bypassPrompts` fails closed outside owned test fixtures
  and is never a CLI or standing-policy mode.
- Hard deny and `alwaysAsk` win over allow; missing authority fails closed in
  noninteractive modes.
- Policy revision and revocation generation invalidate old grants.
- Lock/logout, expiry, online-authority loss, and service-worker restart clear
  ephemeral authority.
- Payment PAN, CVV, government identifiers, financial secrets, passkeys,
  new payment origins, and policy changes require fresh verification.
- Final submit is never implied by fill authorization.
- Proof: permission engine/store tests with every reason code.

### G005: trusted extension executor

- `classify` accepts metadata only and returns no values.
- `plan-fill` returns opaque field/source refs, roles, target identity, and
  redacted audit data.
- `approve` and standing policy are exact-origin, exact-frame, exact-item,
  exact-role, revisioned, and revocable.
- `mint-fill-bundle` returns a short-lived nonce/TTL grant without resolving
  values; `apply-fill-bundle` resolves one value at a time inside the
  extension and returns only redacted receipts.
- Revalidate tab/frame/document/form/target revision and field hashes before
  every write.
- Mark `potentially-private` before the first value-bearing write; report
  `genericObservation: blocked`.
- `privacy-status` echoes the exact `{tabId, frameId, origin, documentId,
  formRef, targetRevision, sessionId}` descriptor; active-tab substitution,
  cross-tab/frame/document/revision mismatch, and stale reset all fail closed.
- A protocol-v1 privacy response that lacks target identity remains readable
  only as non-authorizing data; the shared gate rejects it with a
  target-binding-required result.
- `autofill-observation-reset` is the only trusted transition to `clean`, and
  it cannot clean a document that has already received a private write.
- Native host queues, claims, caches, and publishes only redacted responses;
  nested `value`, `secret`, and `privateKey` payloads are rejected.
- The bounded compatibility-migration adapter accepts only synthetic,
  ciphertext-only `EncryptedAutofillProfileEnvelope` data, records
  provenance/loss outcomes, and cannot mint or apply a fill grant. Negative
  fixtures reject plaintext, raw keys, unavailable key custody, and any
  migration response that contains a grant.
- Proof: broker, classifier, permission integration, observation-ledger, native
  framing/queue, lock, revoke, and worker-readiness tests.

### G006: Magic Browser broker cutover

- `padloc-broker-request` is the only standard personal autofill authority.
- `autofill-plan`, `autofill-apply`, `autofill-broker-bundle`, and
  `autofill-proof` do not read the local vault for standard commands.
- Local vault input is allowed only through an explicit bounded fixture/
  compatibility migration path owned by the Padloc adapter; it cannot mint or
  apply a personal fill grant.
- Native and CDP transports reject raw nested values and unsafe value policies.
- Closed `PadlocBrokerResponse` schemas reject unknown top-level and nested
  keys, arbitrary key names, nested arrays, printable error messages, and
  malformed protocol-v1 payloads before queue/cache/output.
- Canonical fixtures include one example of every v2 kind and both handshake
  request/response pairs with the spec field tables; missing fields fail.
- Protocol-v1 fields and legacy identifiers remain readable.
- Direct CLI screenshot wiring remains in this node and must invoke the shared
  privacy-gate boundary rather than bypassing it.
- Proof: Magic Browser padloc-broker tests, CLI command tests, setup/doctor
  tests, and a synthetic native host fixture.

### G007: Magic Browser privacy gate

- The named shared gate is `magic-browser/src/runtime/autofill-observation-gate.ts`;
  all generic observation call sites use it rather than inventing local checks.
- CDP and typed snapshots omit `input`/`textarea` values before and after fill,
  including `open_snapshot` and compact snapshots, even when Padloc has not
  yet returned a privacy status.
- After Padloc reports `potentially-private` or `genericObservation: blocked`,
  reject `open_snapshot`, `document_text`, `shape`, `network_detail`,
  `replay_request`, `form_inspect`, `form_fill`, `form_set`, `form_submit`,
  `form_run_task`, `form_upload_file`, `click_text`, `click_button_text`,
  `scroll_table`, `drag`, page text/accessibility, `evidence`,
  `evidence_resolve`, extension-bridge observation/fetch, non-CLI screenshots,
  `read_image`, `extract_links`, `extract_tables`, script/eval, and
  network/body capture for the exact tab/frame/document.
- Unknown document state also fails closed for generic observation.
- Redacted role/count/receipt/privacy-status proof remains available.
- `unknown`, `clean`, and `potentially-private` transitions for navigation, new
  document ids, tab close, and explicit trusted reset are deterministic; stale
  state cannot bleed across documents and reset cannot erase private history.
- Extension bridge `page.observe`, `page.fetch`, screenshot, direct CDP
  screenshot, typed-worker evidence, and guarded eval all use the same gate.
- Direct CLI screenshot behavior is proven by G006; this node owns the shared
  gate and all non-CLI call sites.
- Form inspect/action output omits `FormField.value` and
  `FormActionResult.value`; form writes cannot bypass the Padloc broker.
- Proof: unit tests for the shared gate plus worker, form, bridge,
  capability-gateway, network, screenshot, and eval integration tests,
  including negatives for `document_text`, `shape`, `network_detail`,
  `replay_request`, `form_inspect`, `click_text`, `click_button_text`,
  `scroll_table`, and `drag`.
- Click/table/drag results omit `value`, `valueBefore`, `valueAfter`,
  `ariaValueBefore`, `ariaValueAfter`, `allRows`, and cell strings in clean,
  unknown, and potentially-private; unknown/private still fail closed when
  the gate is blocked. Handshake fixtures include success and `kind=error`
  for import-begin and import-commit.

### G008: cross-repository contract proof

- Padloc and Magic Browser parse the same canonical file
  `padloc/packages/extension/test/fixtures/agentic-autofill/contract.v1.json`;
  hash drift fails.
- Redacted response fixtures reject nested values and preserve privacy state.
- Cross-tab, frame, document, form, and target-revision fixtures prove the
  privacy-status descriptor is not substituted with the active tab.
- Protocol-v1 responses without target identity are accepted only for
  non-authorizing compatibility reads and are rejected by the observation gate.
- Both repositories parse the encrypted-profile envelope and reject plaintext,
  raw keys, unavailable key custody, and fill-grant responses.
- Legacy protocol-v1 responses remain readable; incompatible changes require a
  versioned contract.
- G008 adds the eight required keys to `padloc/.ch5/proof.yaml`. Missing keys
  fail. Magic Browser may add a consumer lane invoked by
  `agentic-autofill-privacy-gate`. Do not create a second registry.
- Proof: fixture parser tests in both repositories and exact-SHA proof command
  records for all eight keys.

### G009: synthetic native-host end to end

- Canonical command from the padloc Tree:
  `node scripts/synthetic-agentic-autofill-e2e.mjs --magic-browser-tree <mb-tree>`.
  The Magic Browser script is a helper only.
- Install/setup the extension and native host using fake data only.
- Query privacy-status with the exact descriptor; if `unknown`, trusted
  `autofill-observation-reset`; require `clean` before first observation.
- Unlock synthetic vault, classify, plan, approve or match standing policy,
  mint, apply exact fields, and receive redacted receipt.
- Verify privacy block, redacted proof, revoke, lock/logout, and service-worker
  restart.
- Exercise at least one low-risk password, profile, address, payment card
  without CVV, and one re-enrolled synthetic passkey; SSN-like data remains
  last and synthetic.
- Capture no raw values in stdout, logs, argv, screenshots, artifacts, or
  workflow state.
- Fixtures live under each repository's `scripts/fixtures/agentic-autofill/`;
  each runner invokes its repository-local artifact scanner and writes only
  redacted evidence under the padloc-owned
  `padloc/.ch5/autopilot/agentic-autofill-unification-20260918/synthetic-e2e/`
  directory, then removes temporary browser profiles and queues.
- Proof: the canonical padloc script exits non-zero on any leak or bypass and
  stores only redacted evidence.

### G010: operator and pilot documentation

- Diagnostics explain native host install, extension id, transport choice,
  lock state, and redaction without unlocking or reading values.
- Migration warnings name every unsupported 1PUX category and the passkey
  re-enrollment requirement.
- Pilot runbook is synthetic proof first, then profile, address, card without
  CVV, low-risk passwords, and low-risk re-enrolled passkey; SSN enters last.
- Deferred screenshot masking, cross-origin iframe grants, model disclosure,
  and country-specific schemas are clearly marked deferred.
- Proof: docs lint/link check plus command snippets checked against
  `node scripts/synthetic-agentic-autofill-e2e.mjs --magic-browser-tree <mb-tree>`.

## Proof ladder and stop conditions

1. Candidate JSON parse and semantic graph checks.
2. Focused unit tests per node, changed-only.
3. Cross-repository fixture tests.
4. One synthetic native-host/browser run with redacted artifacts.
5. Independent code/spec review and adversarial QA.

Stop at the first failed rung. A missing proof authority, live browser result,
exact SHA, or consumer-side privacy observation is `UNKNOWN` and blocks a
completion claim; it is not silently inferred from a passing mock.
