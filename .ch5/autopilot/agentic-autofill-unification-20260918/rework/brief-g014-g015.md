# Remaining-work Ultragoal Brief — G014/G015 identity fix then G009 proof

Frozen architecture revision 5 stays in force. Do not restart clarification or re-plan topology.
Original brief: `.omx/ultragoal/brief.md`
Frozen spec: `docs/specs/agentic-personal-data-vault.md`
Rework brief: `.ch5/autopilot/agentic-autofill-unification-20260918/rework/brief.md`

## Harvest (already landed, do not rebuild)

| Story | Repo | SHA | Proof |
|---|---|---|---|
| G001–G005, G010 | padloc | through `45c5bfc4` / `01eda448` | mocha suites |
| G011 Padloc authorizing broker | padloc | `85c7d276` | 62 mocha pass |
| G006/G007/G008/G012 MB observation+form | magic-browser | `bece0e32` | bun typed-tools/form tests |
| G013 MB vault quarantine | magic-browser | `6e0b97dc` | 26 bun tests |
| G009 first landing | both | padloc `91f109a0`, MB `31bf101f` | later broken by G011 reset inspector |

Canonical G009 command (must stay green after this remaining work):
```
cd /Users/hassoncs/worktrees/ch5/padloc/agentic-autofill-unification-20260918
node scripts/synthetic-agentic-autofill-e2e.mjs --magic-browser-tree /Users/hassoncs/worktrees/ch5/magic-browser/agentic-autofill-unification-20260918
```

Last observed failure (helper exit 1):
- `privacy.bootstrap-status` ok, target digest `81e94127477b2da5`
- `privacy.bootstrap-reset` ok, target digest changed to `181e878c26977c95`
- `privacy.bootstrap-clean` `ok:false`, `kind:error`, `errorCode: INVALID_REQUEST`, `target:null`

## Remaining objective

Restore canonical synthetic E2E after G011's inspected reset. Then independent code-review + spec-conformance. Do not fast-forward `main`. Do not deploy. No real PII. No 1Password export. No credential mutation.

## Stories

1. **G014 Padloc reset identity** — If inspected `documentId` matches claimed, keep claimed `formRef`/`targetRevision`. Reject invented documentId, private tab, origin mismatch. Do not replace form identity with document-level hashes from `_inspectAgenticBrowserTarget()`.
2. **G015 MB helper adopts ledger target** — After every `autofill-observation-reset`, `target = response.target || target` so later privacy-status/classify/plan use the ledger identity.
3. **G016 Canonical G009 rerun** — Coordinator after G014+G015 land. Canonical command exit 0 + checker ok. Do not invent a parallel runner.
4. **G017 Independent review** — code-review APPROVE + spec-conformance both axes clean. No FF main.

G014 ∥ G015, then G016, then G017.

## Root cause (measured)

`packages/extension/src/content.ts` `_inspectAgenticBrowserTarget()` returns:
```
formRef = hash(documentId + "\0document")
targetRevision = hash(documentId + "\0document")
```
`discoverTarget` uses `_inspectAgenticFields()` which hashes form identity + field refs.

`inspectAgenticBrowserTargetForReset` currently returns:
```
formRef: inspection.formRef || claimed.formRef
targetRevision: inspection.targetRevision || claimed.targetRevision
```
Inspection formRef is always present, so claimed form identity is replaced. Ledger stores `clean` under the document-level identity. Helper then queries privacy-status with the original form-level descriptor → fail closed.

## Invariants (unchanged)

- Elf Vault owns encrypted records, unlock, approval, passkeys, value resolution, DOM apply.
- Magic Browser owns DOM/session, redacted evidence, guarded submit.
- Hush is operator/runtime secrets only.
- No generic secret-read API. Raw values never in model output, logs, argv, receipts, snapshots.
- No real PII, no real 1Password export, no working-credential mutation, no production/store publish.
- Padloc: no `npm install` / lerna. Topic branch → exact-SHA CI → FF `main` later, not this story.
- Existing `@padloc` / `PL_*` / `PADLOC_*` identifiers remain compatibility names.
- Popup `approveAgenticAutofill` is the only approval path.
- Authorizing ops require `protocolVersion: 2`.
- `nativeBroker()` must use `worker.evaluate(() => padlocAgenticAutofillBroker(request))`, not native-host poll.
- Checker allows `synthetic` / `example.invalid` / `fixture` or hex `^[0-9a-f]{32,64}$`.

## Evidence required

- Mocha: reset keeps claimed formRef/targetRevision when documentId matches; invented documentId still fails; private tab / origin mismatch still fail.
- Helper: after reset, subsequent privacy-status uses `response.target` when present.
- Canonical G009 exit 0 + checker ok.
- Independent review APPROVE + spec-conformance both axes clean (after G016).

## Trees

- padloc: `/Users/hassoncs/worktrees/ch5/padloc/agentic-autofill-unification-20260918` branch `grove/agentic-autofill-unification-20260918/padloc`
- magic-browser: `/Users/hassoncs/worktrees/ch5/magic-browser/agentic-autofill-unification-20260918` branch `grove/agentic-autofill-unification-20260918/magic-browser`

Work in these unification trees. Do not rebind to empty session groves. Do not run `grove prepare`. SessionStart grove route hung previous Luna workers; ignore grove-missing and continue. `CH5_GROVE_GUARD=off`.
