Independent review only. Do not implement. Do not run synthetic E2E. Do not search outside the two trees.

SHAs: padloc 35ca1635, magic-browser 2264cfe2.
Trees:
- /Users/hassoncs/worktrees/ch5/padloc/agentic-autofill-unification-20260918
- /Users/hassoncs/worktrees/ch5/magic-browser/agentic-autofill-unification-20260918

Read only:
- docs/specs/agentic-personal-data-vault.md
- packages/extension/src/background.ts (approve UI-only, v2 authorizing, reset inspector)
- packages/extension/src/autofill-observation-policy.ts (resolveInspectedResetTarget)
- packages/extension/native-host/padloc-autofill-host.mjs (broker-response forwards v2)
- magic-browser src/runtime/padloc-broker.ts (unwrapNativeBrokerEnvelope, form raw-value refusal is in typed-tools)
- magic-browser src/worker/typed-tools.ts assertNoRawFormValues
- .ch5/autopilot/agentic-autofill-unification-20260918/synthetic-e2e/run-summary.json (ok true, 38 steps)

Write TWO files then stop:
1. .../code-review-g017.json with recommendation APPROVE|COMMENT|REQUEST CHANGES, findings[], architectureInvariantGate.status passed|failed
2. .../spec-conformance-g017.json with axes.standards and axes.spec each clean|gap

No raw PII. No FF main. FIRST ACTION: write the JSON files from those reads.
