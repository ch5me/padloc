Continue this mission now. Do not restate the transcript.
You are G009 Synthetic end-to-end proof worker.

Padloc workspace: /Users/hassoncs/worktrees/ch5/padloc/agentic-autofill-unification-20260918
Magic Browser helper tree: /Users/hassoncs/worktrees/ch5/magic-browser/agentic-autofill-unification-20260918
Read docs/specs/agentic-personal-data-vault.md synthetic flow, privacy bootstrap, leak scanner (R5-A5).

OWN only:
- scripts/synthetic-agentic-autofill-e2e.mjs
- scripts/check-agentic-autofill-artifacts.mjs
- scripts/fixtures/agentic-autofill/**
- .ch5/autopilot/agentic-autofill-unification-20260918/synthetic-e2e/**
  (all of the above in padloc)
- magic-browser/scripts/synthetic-agentic-autofill-e2e.mjs
- magic-browser/scripts/check-agentic-autofill-artifacts.mjs
- magic-browser/scripts/fixtures/agentic-autofill/**

DO NOT edit padloc/packages/**, magic-browser/src/**, docs/**, package.json. Do not npm install/lerna. Evidence only under padloc .ch5/autopilot/agentic-autofill-unification-20260918/synthetic-e2e/.

MUST:
1. Canonical command from the padloc Tree:
   node scripts/synthetic-agentic-autofill-e2e.mjs --magic-browser-tree /Users/hassoncs/worktrees/ch5/magic-browser/agentic-autofill-unification-20260918
   Magic Browser script is a helper invoked only by that runner.
2. Bootstrap before first observation: privacy-status with exact descriptor → trusted autofill-observation-reset if unknown → require clean before classify/plan.
3. Exercise: extension install/setup with synthetic fixture, unlock, classify, plan, approval or standing policy, mint grant, exact apply, privacy block, redacted proof, revocation, lock, service-worker restart.
4. Fail non-zero on any raw-value leak, target mismatch, privacy bypass, stale grant, missing clean reset, or restart failure.
5. Leak scanner covers every channel (R5-A5): stdout, stderr, logs, argv, screenshots, artifacts, receipts. Synthetic data only. No real PII.
6. Proof: the canonical command exits 0; artifacts exist only under the padloc synthetic-e2e directory; check-agentic-autofill-artifacts.mjs passes.

Stop when the canonical command passes. Do not commit. No secrets. No real PII.
