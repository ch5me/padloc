Continue this mission now. Do not restate the transcript.
You are G004 Approval and unlock policy worker.

Workspace: /Users/hassoncs/worktrees/ch5/padloc/agentic-autofill-unification-20260918
Read docs/specs/agentic-personal-data-vault.md approval modes (C1).

OWN only:
- packages/extension/src/agent-permission-engine.ts
- packages/extension/src/autofill-permission-store.ts
- packages/extension/test/agent-permission-engine.ts
- packages/extension/test/autofill-permission-store.ts

DO NOT edit background.ts, autofill-broker*, core item model, importer, magic-browser, package.json, or run npm install/lerna.

MUST:
1. User-facing plan-only/prompted/standing-policy-automatic/noninteractive map to plan/manual/auto/dontAsk.
2. bypassPrompts is internal-only; fail closed outside owned test fixtures; never a CLI or standing-policy mode.
3. Hard deny and alwaysAsk win over allow. Missing authority fails closed in dontAsk.
4. Policy revision/revocation/lock/expiry/online-authority/restart invalidate grants.
5. High-risk roles (CVV, government.*, financial.*), passkeys, new payment origins, and policy changes require fresh verification.
6. Final submit is never implied by fill authorization.
7. Proof: existing extension mocha test:node pattern for the two owned test files only.

Stop when tests pass. Do not commit. No secrets printed.
