Continue this mission now. Do not restate the transcript.
You are G014 Padloc reset-identity Luna/Max implementer.

Workspace: /Users/hassoncs/worktrees/ch5/padloc/agentic-autofill-unification-20260918
Branch: grove/agentic-autofill-unification-20260918/padloc
HEAD at start: 85c7d276
Do not run grove prepare. Work in this tree. CH5_GROVE_GUARD=off.

Read first:
- docs/specs/agentic-personal-data-vault.md (privacy reset identity)
- .ch5/autopilot/agentic-autofill-unification-20260918/rework/brief.md
- .omx/ultragoal/remaining-brief.md
- packages/extension/src/background.ts inspectAgenticBrowserTargetForReset (~1784)
- packages/extension/src/content.ts _inspectAgenticBrowserTarget (~358) vs _inspectAgenticFields (~367)

OBJECTIVE
Fix observation reset identity so a trusted reset of a real inspected form keeps the claimed formRef/targetRevision when inspected documentId matches. Canonical G009 currently fails at privacy.bootstrap-clean because reset rewrites form identity to document-level hashes.

MUST FIX
`inspectAgenticBrowserTargetForReset` currently returns:
```
formRef: inspection.formRef || claimed.formRef
targetRevision: inspection.targetRevision || claimed.targetRevision
```
`_inspectAgenticBrowserTarget()` always supplies document-level hashes (`hash(documentId + "\0document")`). That replaces the form-level identity from discoverTarget/`_inspectAgenticFields`. Ledger stores clean under the new identity. Helper then queries the original descriptor and fails closed (INVALID_REQUEST, target:null).

Required behavior:
- If inspected documentId matches claimed.documentId AND frameOrigin matches AND tab origin matches AND tab is not private: keep claimed.formRef and claimed.targetRevision.
- Still reject invented documentId, private tab, missing tab, origin mismatch, missing inspection.
- Do not change `_inspectAgenticBrowserTarget()` document-level helper unless a test proves it is required. Narrowest fix is the reset inspector.
- Reset response must still return the exact target the ledger stored (claimed form identity).
- Extract a pure helper (e.g. `resolveInspectedResetTarget(claimed, inspection, tabFacts)`) so mocha can test without Chrome.

FILES YOU MAY EDIT
- packages/extension/src/background.ts
- packages/extension/src/autofill-observation-policy.ts (only if identity helper belongs there)
- packages/extension/test/autofill-observation-policy.ts
- packages/extension/test/autofill-broker.ts (if broker tests cover reset)
- packages/extension/src/content.ts ONLY if a failing test proves document-level inspect must stay unused for reset and you still need a comment/guard. Prefer not editing it.

Do not edit magic-browser. Do not edit package.json. Do not npm install / lerna. Do not FF main. Do not deploy. Do not touch real credentials.

CONSTRAINTS
- No real PII. Synthetic values only. Raw values never in logs, argv, receipts, test names, snapshots.
- Popup approveAgenticAutofill remains the only approval path.
- Authorizing ops remain protocolVersion 2.
- Existing v1 compatibility reads stay non-authorizing.

VERIFICATION (from packages/extension):
```
CH5_RAW_TEST_OK=1 NODE_OPTIONS=--no-experimental-strip-types TS_NODE_COMPILER_OPTIONS='{"module":"commonjs"}' \
npx mocha --ui tdd --require ts-node/register/transpile-only --require tsconfig-paths/register --require test/setup.ts \
  test/agentic-contract-fixtures.ts test/autofill-broker.ts test/autofill-broker-protocol.ts \
  test/agent-permission-engine.ts test/autofill-observation-policy.ts
```
Must stay green. Add tests:
1. matching documentId keeps claimed formRef/targetRevision even when inspection returns document-level hashes
2. mismatched documentId still throws invented-document error
3. private tab still refused
4. origin mismatch still refused

Then commit and push on branch grove/agentic-autofill-unification-20260918/padloc.
Commit message: `fix(autofill): keep claimed form identity on trusted observation reset`
Do not commit `.ch5/autopilot/**/synthetic-e2e/runtime/` or untracked autopilot review junk unless you own it.

Write a short answer to:
/Users/hassoncs/worktrees/ch5/padloc/agentic-autofill-unification-20260918/.ch5/autopilot/agentic-autofill-unification-20260918/rework/g014-answer.md
Include SHA, files, test command output summary. No raw values.

FIRST ACTION
Read inspectAgenticBrowserTargetForReset and _inspectAgenticBrowserTarget. Implement the pure identity helper + tests. Run mocha. Commit. Push. Write g014-answer.md.
