# Elf Vault Agentic Personal Data

## Deliberate plan candidate

- Plan id: `agentic-autofill-unification-20260918`
- Revision: `2`
- Posture: `personal-dev`
- Assurance: `runtime_observed`
- Planning boundary: this pass writes planning artifacts only. It does not edit product source, access credentials, move personal data, deploy, or publish.
- Correction status: all independent architect findings A1-A9 are resolved in
  the owned planning artifacts; implementation remains pending.

## Objective

Make Elf Vault the only personal credential and autofill authority used by Magic
Browser. Preserve existing records and protocol-v1 consumers, keep raw values
inside the trusted extension executor, require exact target and policy
bindings, and make every generic model-observation path fail closed after a
private fill.

## Frozen decisions

1. Padloc owns encrypted personal records, sync, unlock, approval, passkeys, and
   value resolution. Magic Browser owns browser sessions, DOM inspection,
   guarded action, and redacted evidence. Hush remains operator/runtime secret
   authority only.
2. No raw personal value may enter model output, logs, argv, receipts,
   screenshots, generic observations, or portable workflow artifacts.
3. Origin, frame, document, form, field, session, nonce, TTL, policy revision,
   and revocation generation bindings fail closed.
4. Existing `@padloc`, `PL_*`, `PADLOC_*`, resource ids, bundle ids, schemes,
   legacy import identifiers, and protocol-v1 consumers remain compatible.
5. Working credentials and passkeys are not rotated, revoked, reissued,
   superseded, removed, or autonomously migrated.
6. Passkey migration means re-enrollment at the relying party followed by
   verified Elf Vault assertion. A 1PUX import never claims passkey migration.
7. CVV remains transaction-only. Final submit is a separate action grant.
8. Screenshot masking, cross-origin iframe recipient grants, model disclosure
   grants, and additional country-specific schemas stay deferred as specified.
9. CDP and typed snapshots are metadata-only: input values are absent before
   and after fill, independent of the later privacy gate.
10. Padloc alone produces `unknown`, `clean`, and `potentially-private` privacy
    state. A trusted, exact-target reset is the only path to `clean`.
11. Compatibility migration transports only an encrypted profile envelope and
    returns provenance/loss data; it never mints or applies a fill grant.
12. Exact privacy targeting is a `privacy-status.v2` contract. Protocol-v1
    responses lacking target identity remain readable only as non-authorizing
    data and cannot satisfy the observation gate.

## Observed seams

### Padloc

- `packages/core/src/item.ts` has `AutofillItemKind` and role metadata on
  fields, but `VaultItem` does not yet persist an item kind. Existing templates
  cover person, address, and payment roles; CVV is transaction-only.
- The create path currently passes fields/icon without template semantic metadata;
  G001 must wire `createItem` and `CreateItemDialog` so new records derive the
  same kind, roles, provenance, and release class as imported records.
- `packages/app/src/lib/1pux-parser.ts` and `packages/app/src/lib/import.ts`
  flatten 1PUX data into `VaultItem[]`. The current boundary has no structured
  `ImportResult`/provenance result and skips document-only items. G001 owns the
  shared core contract; G002 consumes it.
- The extension already has protocol-v1 broker operations, exact tab/frame/
  document/form/field target checks, short-lived grants, redacted receipts,
  privacy ledger state, and native-host queue redaction.
- The privacy ledger has no clean producer or trusted reset, and privacy-status
  lacks tab/form/target-revision binding. G005 owns the state machine, reset
  operation, and exact descriptor.
- `packages/extension/src/agent-permission-engine.ts` already models plan,
  manual, auto, dontAsk, and bypassPrompts modes, hard deny, revocation,
  expiry, online authority, and fresh confirmation. Role-derived high-risk
  defaults and complete government/financial vocabulary remain to be finished.

### Magic Browser

- `src/runtime/padloc-broker.ts` already rejects printable nested values and
  unsafe audit policies for native/CDP broker responses, but its response type
  is open-ended. G006 must close the schema and reject unknown nested keys.
- `src/cli/session.ts` has a Padloc-native `padloc-broker-request` command, but
  `autofill-plan`, `autofill-apply`, `autofill-broker-bundle`, and
  `autofill-proof` still load the encrypted local vault.
- `src/runtime/autofill-vault.ts` and `src/runtime/autofill-broker.ts` remain a
  parallel personal-data authority and can return raw values inside the local
  process.
- `src/worker/typed-tools.ts`, `src/runtime/browser-evidence.ts`, screenshot
  paths, extension bridge observation, network/body capture, and guarded eval
  do not yet consume Padloc `privacy-status` or a shared
  `potentially-private` gate. Consumer enforcement is therefore `UNKNOWN`.
- `src/runtime/cdp.ts` currently includes input values in snapshots. G007 owns
  the metadata-only serializer and pre-fill/post-fill regression proof.

## Graph

The smallest complete sequence is:

```text
G001 -> {G002, G003, G004} -> G005 -> G007 -> G006 -> G008 -> G009 -> G010
```

Only G002/G003/G004 are parallel after G001. G005 waits for all three plus the
G002 import contract. G007 then establishes the shared observation gate before
G006 wires direct CLI screenshots. Ownership is repository-prefixed in the
graph: `padloc/...` and `magic-browser/...`. `background.ts` uses explicit
region-qualified ownership and a serial G003-to-G005 handoff. The G009 run
artifact is explicitly `padloc/.ch5/.../synthetic-e2e/**`.

| Node | Owner | Depends on | Observable acceptance |
| --- | --- | --- | --- |
| G001 | padloc domain-contract worker | - | Semantic item kind, creation-path propagation, persisted provenance, shared `ImportResult`, and complete role vocabulary persist; old records round-trip and risk is derivable without raw-value disclosure. |
| G002 | padloc migration worker | G001 | 1PUX records consume the shared contract, normalize into roles, retain provenance, and return exact imported/normalized/skipped/lossy counts without overclaiming. |
| G003 | padloc passkey worker | G001 | Re-enrollment and assertion verification are explicit, fresh verification is required, the passkey-owned `background.ts` region is complete, and existing working factors remain untouched. |
| G004 | padloc policy worker | G001 | All approval modes, hard deny, always-ask, lock, expiry, revocation, exact bindings, and high-risk fresh verification are enforced. |
| G005 | padloc trusted-executor worker | G001,G002,G003,G004 | Native broker resolves one value at a time inside the extension, owns the privacy state producer/reset and exact descriptor, validates the full target, returns only closed/redacted plans/receipts/privacy state, and exposes an encrypted-profile compatibility receiver with no fill authority. |
| G006 | magic-browser cutover worker | G005,G007 | Standard autofill commands use the Padloc native broker; the local vault sends only the bounded encrypted envelope and cannot be an authority. Closed-schema parsing, protocol-v1 compatibility, and direct CLI screenshot gate wiring are proven. |
| G007 | magic-browser privacy worker | G005 | A named shared observation gate and metadata-only snapshots protect every generic observation, extension-bridge, eval/body, and non-CLI screenshot path; unknown and potentially-private documents fail closed while redacted proof remains available. |
| G008 | cross-repo contract worker | G006,G007 | Shared fixtures prove role/protocol/privacy/redaction compatibility; missing `.ch5/proof.yaml` keys are added only through the existing proof authority or remain explicit `UNKNOWN`. |
| G009 | synthetic e2e worker | G008 | A fake-data native-host run proves install, unlock, classify, plan, approval/policy, mint, exact apply, privacy block, proof, revoke, lock, and worker restart. |
| G010 | operator-doc worker | G009 | Diagnostics, migration warnings, security boundaries, and the ordered limited-pilot runbook are exact and synthetic-first. |

## Ownership and write boundaries

- G001 owns only the domain/contract seams:
  `padloc/packages/core/src/item.ts`,
  `padloc/packages/core/src/import-result.ts`,
  `padloc/packages/core/src/app.ts#createItem`,
  `padloc/packages/app/src/elements/create-item-dialog.ts`, and focused model,
  creation, and contract tests. It must not edit importer implementation,
  broker, permission, passkey, or browser files.
- G002 owns only `padloc/packages/app/src/lib/1pux-parser.ts`,
  `padloc/packages/app/src/lib/import.ts`, and importer fixtures/tests. It
  consumes G001's `ImportResult`/provenance contract and must not change the
  frozen core model, creation API, or extension wire contract.
- G003 owns only passkey migration and verification seams:
  `padloc/packages/core/src/passkey.ts`,
  `padloc/packages/extension/src/passkey-*.ts`,
  `passkey-protocol.ts`, `passkey-content-bridge.ts`, `passkey-page.ts`,
  `passkey-rp-policy.ts`, `passkey-approval-coordinator.ts`,
  `passkey-selection-coordinator.ts`, and matching tests, plus the passkey
  region of `padloc/packages/extension/src/background.ts`:
  `nativeRuntime.onConnect`, `nativeRuntime.onMessage`,
  `buildPasskeyFallback`, `beginPasskeyRequest`, `resolvePasskeyRequest`,
  `requestPasskeyCredentialSelection`, `isPasskeyTabStillBound`,
  `assertPasskeyCeremonyActive`, `createVaultPasskeyRepository`, and passkey
  cases in `handleRuntimeMessage`. It must not alter broker transport or
  working credentials. G003 hands the frozen passkey region to G005 only after
  its terminal handoff fixture passes.
- G004 owns only policy and unlock seams:
  `padloc/packages/extension/src/agent-permission-engine.ts`,
  `padloc/packages/extension/src/autofill-permission-store.ts`, and matching
  tests. Background dispatch changes belong to G005.
- G005 owns only the trusted extension executor and native bridge:
  `padloc/packages/extension/src/autofill-broker*.ts`,
  `autofill-classifier.ts`, `autofill-observation-policy.ts`, `background.ts`,
  `content.ts`, native-host code, the explicit bounded
  compatibility-migration receiver, and matching tests. In `background.ts` it
  owns only the autofill dispatch region after the G003 handoff; it must not
  edit the passkey symbols listed above or make Magic Browser observation
  decisions. G005 adds the closed `privacy-status` descriptor, trusted reset,
  and encrypted-profile envelope receiver. Its write exclusion explicitly
  includes the G003 passkey region.
- G006 owns only the Magic Browser local-vault cutover:
  `magic-browser/src/runtime/autofill-vault.ts`,
  `autofill-broker.ts`, `padloc-broker.ts`, setup/CLI/session call sites, and
  their tests. It sends only the encrypted-profile envelope through a
  user-mediated keychain wrapping handshake, closes `PadlocBrokerResponse`
  (deny-by-default unknown keys), and must not own the generic observation gate.
- G007 owns only Magic Browser observation enforcement:
  `magic-browser/src/worker/typed-tools.ts`,
  `src/runtime/browser-evidence.ts`, `network-inspect.ts`,
  `src/runtime/browser-capability-gateway.ts`,
  `src/runtime/autofill-observation-gate.ts`, `src/runtime/cdp.ts`,
  `src/policy/guarded-eval.ts`,
  `src/session/extension-bridge.ts`, extension-app observation and screenshot
  call sites, and matching tests. Direct CLI screenshot wiring remains owned by
  G006 so the two nodes have disjoint ownership. It owns the metadata-only
  snapshot serializer and pre-fill/post-fill snapshot tests; it must not
  reintroduce a value store.
- G008 owns only cross-repository fixtures and the existing proof authority
  entries. G009 owns only synthetic smoke scripts and fixtures. G010 owns only
  operator/pilot documentation. None may edit real data, credentials, or
  deployment configuration.

## Deliberate pre-mortem

| Failure | Earliest signal | Prevention and proof |
| --- | --- | --- |
| Raw value leaks through a new response, cache, argv, or receipt | A fixture or recursive redaction test finds a non-empty `value`, `secret`, or `privateKey` key | Keep values in the extension executor; run nested-redaction tests on native, CDP, CLI, and E2E outputs. |
| A stale DOM target receives a value | Changed document/form/field hash still applies | Recompute exact target bindings immediately before each write and test frame/document/revision/nonce/TTL mismatch. |
| Import silently overclaims or loses unsupported data | Imported count differs from loss report, or passkey/document appears as migrated | Make provenance and loss categories first-class; fixture each unsupported category and assert explicit loss. |
| Magic Browser continues using its local vault | A standard command reads `~/.local/share/ch5-autofill/vault.json` or returns a local bundle | Route standard commands through `padloc-broker-request`; leave local vault only as bounded fixture/compatibility input and assert no authority path. |
| Privacy gate misses one observation primitive | Post-fill `open_snapshot`, evidence, screenshot, page text, eval, or network/body call succeeds | Centralize the check at the shared session/observation boundary and exercise every enumerated primitive, including extension bridge paths. |
| Privacy status is asserted for the wrong tab or a stale target | A cross-tab, frame, document, form, or target-revision fixture returns `clean` | Echo the exact descriptor from Padloc, reject mismatches, and require the trusted reset operation for `clean`. |
| Compatibility migration leaks or gains fill authority | Native/CDP fixture contains plaintext, a key, or a mint/apply grant | Use the one-time encrypted envelope and wrapped-key handshake; assert ciphertext-only transport and an `ImportResult`-only response. |
| A new item loses semantic metadata | Template-created login/government/financial item has absent or contradictory kind/roles | Make G001 own `createItem` plus template propagation and round-trip fixtures. |
| Passkey and autofill edits collide in `background.ts` | A diff touches a passkey symbol after the G003 handoff | Region-qualified ownership and a serial G003 -> G005 handoff are mandatory. |
| A broker response hides a raw value under an unexpected key | Recursive fixture finds any unknown nested key or printable payload | Use the closed response schema and deny unknown keys before consumer use. |
| Lock, revocation, restart, or missing authority bypasses policy | A previously valid grant applies after state change | Persist policy/revocation generations, require fresh verification, and test lock/restart/revoke before and during apply. |
| Padloc and Magic Browser contracts drift | Fixture parses in one repository but not the other, or privacy fields are ignored | Keep protocol-v1 compatibility fixtures in both repositories and make G008 a hard dependency of E2E. |

## Unknowns and gates

- `UNKNOWN`: Magic Browser consumer-side privacy enforcement is absent from the
  current checkout and must be implemented by G007.
- `UNKNOWN`: CDP snapshot input-value redaction is absent from the current
  checkout and must be implemented by G007 before any privacy-status call.
- `UNKNOWN`: live unlocked synthetic native-host checkout proof is not captured
  yet and must be produced by G009.
- `UNKNOWN`: exact government and financial role names must be resolved against
  the shared vocabulary before G001/G004 implementation.
- `UNKNOWN`: bridge mode naming must map the brief's plan-only/prompted/
  standing-policy/noninteractive terms to `plan`/`manual`/`auto`/`dontAsk`/
  `bypassPrompts`.
- `UNKNOWN`: `.ch5/proof.yaml` currently has no repo-owned keys. G008 must add
  keys to that existing authority or leave closure explicitly incomplete; do
  not invent a parallel proof registry.
- `UNKNOWN`: the encrypted-profile envelope and wrapped-key handshake are
  planning contracts only until G005/G006 implement and exercise them with
  synthetic ciphertext.
- Human gates remain for credentials, real-data pilot entry, production/store
  publication, external trust, and any working-credential mutation.

## Acceptance and cheapest proof

Planning acceptance is met only when all assigned artifacts exist, the graph is
shape-valid and semantically a DAG with disjoint parallel ownership (including
region-qualified `background.ts` handoff), every node has an intent and proof,
both repository prefixes appear, G009's run artifact is repository-prefixed,
and all frozen invariants, contracts, and unknowns are recorded.

Cheapest proof for this pass:

```bash
python3 -m json.tool .ch5/autopilot/agentic-autofill-unification-20260918/graph-candidate.json
```

The candidate is not implementation proof. No product tests, browser runs,
credential reads, or deployments were performed in this planning pass.
