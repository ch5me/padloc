Continue this mission now. Do not restate the transcript.
You are G012 Magic Browser observation+form Luna/Max implementer.

Workspace: /Users/hassoncs/worktrees/ch5/magic-browser/agentic-autofill-unification-20260918
Branch: grove/agentic-autofill-unification-20260918/magic-browser
Read:
- /Users/hassoncs/worktrees/ch5/padloc/agentic-autofill-unification-20260918/docs/specs/agentic-personal-data-vault.md (observation inventory, closed schemas, snapshot boundary)
- /Users/hassoncs/worktrees/ch5/padloc/agentic-autofill-unification-20260918/.ch5/autopilot/agentic-autofill-unification-20260918/code-review.json CR-004, CR-005, CR-006
- /Users/hassoncs/worktrees/ch5/padloc/agentic-autofill-unification-20260918/.ch5/autopilot/agentic-autofill-unification-20260918/rework/brief.md

OBJECTIVE
Generic model observation cannot see a document after private fill. Worker execution cannot authorize a caller-supplied target then attach a different CDP target. Model-facing form tools cannot take raw values or return page-derived secret text. Personal-data writes go through opaque Elf Vault references / local extension execution.

FILES AND OWNERSHIP
You own only:
- src/worker/typed-tools.ts
- src/worker/typed-tools.test.ts
- src/runtime/form.ts
- src/runtime/form.test.ts
- src/runtime/autofill-observation-gate.ts
- src/runtime/browser-capability-gateway.ts
- src/session/extension-bridge.ts
- src/cli/session.ts (only observation/form/inspect-js/session_health_check/privacy wiring; no drive-by refactors)
- src/policy/effect-gateway.ts (only if inspect-js bypasses the gate)
- src/runtime/agentic-contract-fixtures.test.ts (already dirty; keep additions)
- scripts/synthetic-agentic-autofill-e2e.mjs (switch authorizing mint/apply/revoke to protocolVersion 2; keep nativeBroker() returning the v2 object from worker.evaluate(() => padlocAgenticAutofillBroker(request)); invokeExtensionBroker must return evaluate result; catch SW throws into closed kind=error)

You are not alone. Dirty tree already has ~525 lines of redaction hardening in form.ts / typed-tools.ts / tests. FINISH that work; do not revert it. Do not edit padloc. Do not edit autofill-vault.ts or autofill-broker.ts (G013 owns those). Do not edit .ch5/proof.yaml (G013).

INTERFACES
- Privacy ledger lives in Padloc. MB must query privacy-status.v2 with exact target descriptor before screenshot, observe, fetch, inspect-js, session_health_check, and any attached screenshot path.
- Unknown and potentially-private block generic observation; redacted proof remains available.
- Worker gate must resolve/authorize the owned CDP target BEFORE attach/recovery, then re-check the live target. Caller-supplied target is not authority.
- form_fill / form_set: no raw value inputs. Route personal-data writes through opaque Padloc refs / local execution.
- form_submit / form_run_task: closed metadata-only results; no alert/body/success/page text payloads.
- Snapshots: input/textarea have no value field; valuePresent allowed.
- After CR-002, E2E mint must use protocolVersion 2 or it dies. Change helper authorizing calls to v2.

CONSTRAINTS
- No real PII, no credential mutation, no production deploy.
- No secrets in logs/argv/receipts.
- Preserve concurrent edits.
- CH5_RAW_TEST_OK=1 bun test only on owned files.

MUST FIX
CR-004: observation inventory required at screenshot/observe/fetch/inspect-js/session_health_check; attached screenshots cannot bypass.
CR-005: authorize live owned target after CDP attach/recovery, not caller target before attach.
CR-006: remove raw value inputs from model-facing form tools; mutation results closed metadata-only.

VERIFICATION
```
cd /Users/hassoncs/worktrees/ch5/magic-browser/agentic-autofill-unification-20260918
CH5_RAW_TEST_OK=1 bun test src/runtime/padloc-broker.test.ts src/runtime/form.test.ts src/worker/typed-tools.test.ts src/runtime/agentic-contract-fixtures.test.ts
```
Add tests proving:
1. screenshot/observe/fetch/inspect-js/session_health_check fail closed without privacy-status.v2 clean
2. recovered/attached target mismatch fails closed
3. form_fill/form_set reject raw values
4. form results contain no page-derived secret text

Commit owned files and push `grove/agentic-autofill-unification-20260918/magic-browser`.

RETURN
STATUS: complete | partial | blocked
CHANGES: file-by-file
VERIFIED: commands + observed evidence
JUDGMENT CALLS:
GAPS:
SHA:
