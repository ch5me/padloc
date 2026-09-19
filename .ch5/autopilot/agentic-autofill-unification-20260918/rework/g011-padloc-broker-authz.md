Continue this mission now. Do not restate the transcript.
You are G011 Padloc authorizing-broker Luna/Max implementer.

Workspace: /Users/hassoncs/worktrees/ch5/padloc/agentic-autofill-unification-20260918
Branch: grove/agentic-autofill-unification-20260918/padloc
Read:
- docs/specs/agentic-personal-data-vault.md (Critic Contract Freeze, closed schemas, privacy reset)
- .ch5/autopilot/agentic-autofill-unification-20260918/code-review.json findings CR-001, CR-002, CR-003, CR-008, CR-009
- .ch5/autopilot/agentic-autofill-unification-20260918/rework/brief.md

OBJECTIVE
Make the Elf Vault extension broker non-forgeable. SW/native/CDP callers cannot approve or mint/apply. Protocol v1 cannot mutate. Privacy reset cannot mint `clean` for an invented document. Standing-policy v2 uses a private v2 grant, never a v1 approval object. Closed schemas reject unknown keys.

FILES AND OWNERSHIP
You own only:
- packages/extension/src/background.ts
- packages/extension/src/autofill-broker.ts
- packages/extension/src/autofill-broker-protocol.ts
- packages/extension/src/autofill-observation-policy.ts
- packages/extension/src/content.ts (only if inspectAgenticFields / inspectAgenticBrowserTarget must supply real tab/frame/document/form)
- packages/extension/src/popup.ts (keep popup `approveAgenticAutofill` as the only UI approval path; do not remove nonce)
- packages/extension/native-host/padloc-autofill-host.mjs
- packages/extension/test/autofill-broker.ts
- packages/extension/test/autofill-broker-protocol.ts
- packages/extension/test/autofill-observation-policy.ts
- packages/extension/test/agent-permission-engine.ts
- packages/extension/test/agentic-contract-fixtures.ts (keep recursive scalar/cardinality checks if present; do not weaken)
- scripts/synthetic-agentic-autofill-e2e.mjs only if padloc helper still mints v1; switch authorizing helper calls to protocolVersion 2. Canonical runner must still exist.

You are not alone. Do not edit magic-browser. Do not revert unrelated work. Do not edit package.json. Do not npm install / lerna.

INTERFACES
- Broker API: classify → plan → approve/policy → mint grant → trusted extension apply → redacted receipt.
- `handleAgenticAutofillBroker` is the server. `padlocAgenticAutofillBroker` (CDP global) and native host are non-authorizing transports.
- `assertExtensionUiSender` already exists near background.ts:1311. Use it.
- Popup path `approveAgenticAutofill` remains the only way to create approval, with one-time prompt nonce.
- E2E already approves via popup `approveAgenticAutofill`; keep that.
- After this fix, mint/apply/revoke/approve from tests and helpers must use protocolVersion 2 or they must fail closed.
- Reset descriptor: `{tabId, frameId, origin, documentId, formRef, targetRevision, sessionId}` resolved from content-script inspection, not caller-invented documentId. Reject private tab. Serialize reset vs fill.
- Standing-policy v2 success: private approval record + closed v2 response. Do not construct/return a v1 approval for a v2 request.
- Closed PadlocBrokerResponse: unknown keys rejected. v1 payloads remain readable only as non-authorizing compatibility data.

CONSTRAINTS
- No real PII, no credential mutation, no production deploy, no FF main.
- No generic secret-read.
- Raw values never in logs, argv, receipts, test names, or snapshots.
- Native-host poll returning v1 envelope is OK for reads; authorizing ops must fail unless v2 + UI nonce.
- Checker allows tokens containing synthetic / example.invalid / fixture or hex `^[0-9a-f]{32,64}$`.

MUST FIX
CR-001: broker `approve` from SW/native/CDP is non-authorizing. Only `chrome.runtime.sendMessage` from extension-origin UI with one-time prompt nonce may create approval.
CR-002: reject approve / mint-fill-bundle / apply-fill-bundle / revoke unless protocolVersion===2 at handleAgenticAutofillBroker. Keep v1 for enumerated compatibility reads only.
CR-003: resolve actual tab/frame/document/form from content script (inspectAgenticFields / inspectAgenticBrowserTarget). Reject invented documentId, private tab. Ledger already refuses reset after potentially-private; keep that.
CR-008: do not build v1 approval object on standing-policy v2 success (~background.ts:1507-1568, autofill-broker.ts:252-281).
CR-009 padloc: recursive value-free validation / closed schema, not key-name regex. Native host must not forward open v1 secret-bearing payloads.

VERIFICATION
Run from packages/extension:
```
CH5_RAW_TEST_OK=1 NODE_OPTIONS=--no-experimental-strip-types TS_NODE_COMPILER_OPTIONS='{"module":"commonjs"}' \
npx mocha --ui tdd --require ts-node/register/transpile-only --require tsconfig-paths/register --require test/setup.ts \
  test/agentic-contract-fixtures.ts test/autofill-broker.ts test/autofill-broker-protocol.ts \
  test/agent-permission-engine.ts test/autofill-observation-policy.ts
```
Success: all pass.
Add tests that:
1. CDP/native approve=true does not mint approval
2. v1 mint/apply/revoke/approve fail closed
3. reset with invented documentId fails
4. standing-policy v2 response is closed v2, not v1 approval
5. unknown keys on broker response rejected

Commit owned files with `git commit -m` and push branch `grove/agentic-autofill-unification-20260918/padloc`. Do not FF main. Do not commit `.ch5/autopilot/**/synthetic-e2e/runtime` or `agentic-autofill-unification-20260918/` workflow runtime.

RETURN
STATUS: complete | partial | blocked
CHANGES: file-by-file
VERIFIED: commands + observed evidence
JUDGMENT CALLS:
GAPS:
SHA:
