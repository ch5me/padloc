Continue this mission now. Do not restate the transcript.
You are G003 Passkey migration contract worker.

Workspace: /Users/hassoncs/worktrees/ch5/padloc/agentic-autofill-unification-20260918
Read docs/specs/agentic-personal-data-vault.md passkey rules.

OWN only these files (and matching tests already listed):
- packages/core/src/passkey.ts
- packages/extension/src/passkey-protocol.ts
- packages/extension/src/passkey-content-bridge.ts
- packages/extension/src/passkey-page.ts
- packages/extension/src/passkey-rp-policy.ts
- packages/extension/src/passkey-approval-coordinator.ts
- packages/extension/src/passkey-selection-coordinator.ts
- packages/extension/src/passkey-provider-engine.ts
- packages/extension/src/passkey-request-binding.ts
- packages/extension/src/passkey-user-verification.ts
- packages/extension/src/background.ts (passkey region only: nativeRuntime.onConnect/onMessage, buildPasskeyFallback, beginPasskeyRequest, resolvePasskeyRequest, requestPasskeyCredentialSelection, isPasskeyTabStillBound, assertPasskeyCeremonyActive, createVaultPasskeyRepository, passkey cases in handleRuntimeMessage)
- packages/extension/test/passkey-protocol.ts
- packages/extension/test/passkey-rp-policy.ts
- packages/extension/test/passkey-approval-coordinator.ts
- packages/extension/test/passkey-selection-coordinator.ts
- packages/extension/test/passkey-migration-contract.ts

DO NOT edit autofill-broker*, importer, core item.ts, magic-browser, package.json. Do not run npm install/lerna. Do not touch working credentials. Do not import passkeys from 1PUX.

MUST:
1. Re-enrollment creates a new Elf Vault credential at a synthetic RP. No 1PUX passkey import path.
2. Assertion requires flowId, ttl, topOrigin, rpId, exact target, and recent user verification.
3. Wrong origin, RP id, nonce, expiry, lock, or stale verification fails closed.
4. Existing working credentials remain untouched in every test.
5. Prove the passkey-owned background.ts region; do not alter autofill dispatch region.
6. Proof: extension mocha on owned passkey test files only, using existing test:node pattern.

Stop when tests pass. Do not commit. No secrets printed.
