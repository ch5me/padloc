Continue this mission now. Do not restate the transcript.
You are G005 Trusted extension execution worker.

Workspace: /Users/hassoncs/worktrees/ch5/padloc/agentic-autofill-unification-20260918
Read docs/specs/agentic-personal-data-vault.md Critic Contract Freeze, broker variant field tables, handshake, privacy state.

OWN only:
- packages/extension/src/autofill-broker-protocol.ts
- packages/extension/src/autofill-broker.ts
- packages/extension/src/autofill-classifier.ts
- packages/extension/src/autofill-observation-policy.ts
- packages/extension/src/autofill-compatibility-migration.ts
- packages/extension/src/background.ts (autofill region only; do not edit passkey symbols: nativeRuntime.onConnect, nativeRuntime.onMessage, buildPasskeyFallback, beginPasskeyRequest, resolvePasskeyRequest, requestPasskeyCredentialSelection, isPasskeyTabStillBound, assertPasskeyCeremonyActive, createVaultPasskeyRepository, passkey cases in handleRuntimeMessage)
- packages/extension/src/content.ts
- packages/extension/native-host/padloc-autofill-host.mjs
- packages/extension/test/autofill-broker.ts
- packages/extension/test/autofill-broker-protocol.ts
- packages/extension/test/autofill-classifier.ts
- packages/extension/test/autofill-observation-policy.ts
- packages/extension/test/autofill-compatibility-migration.ts

DO NOT edit core item.ts, import.ts, agent-permission-engine.ts, passkey-*, magic-browser, package.json. Do not npm install/lerna.

MUST:
1. Classify, plan, approve, mint, apply, revoke, privacy-status through extension-owned executor.
2. Closed elf.padloc-broker-response.v2 discriminated union; unknown keys rejected. Protocol-v1 readable as non-authorizing only.
3. Exact target revalidation. One-value-at-a-time resolution. No values in plans/receipts/logs.
4. Privacy ledger producer: unknown/clean/potentially-private. Trusted autofill-observation-reset. privacy-status.v2 echoes {tabId,frameId,origin,documentId,formRef,targetRevision,sessionId} plus state, observationRevision, genericObservation.
5. EncryptedAutofillProfileEnvelope receiver: import-begin/import-commit handshake. Returns ImportResult only. No fill grant.
6. Classifier covers login, profile, address, payment, government, financial, ambiguous, adversarial.
7. Proof: extension mocha on owned test files only.

Stop when tests pass. Do not commit. No secrets. No real PII.
