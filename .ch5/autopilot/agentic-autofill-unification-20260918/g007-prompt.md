Continue this mission now. Do not restate the transcript.
You are G007 Magic Browser privacy gate worker.

Workspace: /Users/hassoncs/worktrees/ch5/magic-browser/agentic-autofill-unification-20260918
Also read padloc spec at /Users/hassoncs/worktrees/ch5/padloc/agentic-autofill-unification-20260918/docs/specs/agentic-personal-data-vault.md (privacy inventory and C3 result contracts).

OWN only:
- src/worker/typed-tools.ts
- src/runtime/browser-evidence.ts
- src/runtime/network-inspect.ts
- src/runtime/browser-capability-gateway.ts
- src/runtime/autofill-observation-gate.ts
- src/runtime/cdp.ts
- src/runtime/form.ts
- src/runtime/form.test.ts
- src/policy/guarded-eval.ts
- src/session/extension-bridge.ts
- packages/extension-app/src/content/index.tsx
- packages/extension-app/src/background/service-worker.ts
- packages/extension-app/src/background/screenshot.ts
- src/worker/typed-tools.test.ts
- src/runtime/browser-evidence.test.ts
- src/runtime/browser-capability-gateway.test.ts
- src/policy/guarded-eval.test.ts
- packages/extension-app/src/background/screenshot.test.ts

DO NOT edit autofill-vault.ts, autofill-broker.ts, padloc-broker.ts, padloc sources, package.json. Do not npm/bun install extra deps.

MUST:
1. Named shared gate is src/runtime/autofill-observation-gate.ts. All generic observation call sites use it.
2. Gate checks exact Padloc privacy-status.v2 tab/frame/origin/document/form/revision. Unknown and potentially-private fail closed. Clean is exact-target only.
3. Exhaustive inventory: open_snapshot, extract_links, extract_tables, read_image, document_text, evidence, evidence_resolve, shape, network_detail, replay_request, form_inspect, form_fill, form_set, form_submit, form_run_task, form_upload_file, click_text, click_button_text, scroll_table, drag, page.observe, page.fetch, screenshot, eval, network/body, CDP snapshots.
4. Snapshots metadata-only: no input/textarea value fields even before privacy-status. FormField.value and FormActionResult.value omitted. Forbidden: value, valueBefore, valueAfter, ariaValueBefore, ariaValueAfter, allRows, table cell strings.
5. Redacted Padloc privacy-status/receipt/plan remains allowed.
6. Proof: bun test / existing magic-browser test runner on owned test files. CH5_RAW_TEST_OK=1 only if needed with reason.

Stop when tests pass. Do not commit. No secrets. No real PII.
