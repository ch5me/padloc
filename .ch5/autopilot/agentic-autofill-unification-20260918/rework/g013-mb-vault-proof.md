Continue this mission now. Do not restate the transcript.
You are G013 Magic Browser vault-quarantine + proof Luna/Max implementer.

Workspace: /Users/hassoncs/worktrees/ch5/magic-browser/agentic-autofill-unification-20260918
Branch: grove/agentic-autofill-unification-20260918/magic-browser
Read:
- /Users/hassoncs/worktrees/ch5/padloc/agentic-autofill-unification-20260918/docs/specs/agentic-personal-data-vault.md (compatibility migration custody, closed schemas, C3 observation inventory, proof authority)
- /Users/hassoncs/worktrees/ch5/padloc/agentic-autofill-unification-20260918/.ch5/autopilot/agentic-autofill-unification-20260918/code-review.json CR-007, CR-009, CR-010
- /Users/hassoncs/worktrees/ch5/padloc/agentic-autofill-unification-20260918/.ch5/autopilot/agentic-autofill-unification-20260918/rework/brief.md

OBJECTIVE
Magic Browser must not remain a personal-data authority. Production paths cannot decrypt, mint, or apply local autofill values. Broker client and native-host consumer reject open/legacy secret-bearing payloads. proof.yaml wires the frozen observation inventory with evidence.

FILES AND OWNERSHIP
You own only:
- src/runtime/autofill-vault.ts
- src/runtime/autofill-broker.ts
- src/runtime/padloc-broker.ts
- src/runtime/padloc-broker.test.ts
- src/cli/padloc.ts (only if it still calls decrypt/mint/apply)
- src/cli/padloc.test.ts (same)
- .ch5/proof.yaml
- new tests under src/runtime/ or .ch5/artifacts/proof/browser-observation-safety for CR-010
- If a Magic Browser native-host consumer exists, own it. Padloc native host `packages/extension/native-host/padloc-autofill-host.mjs` is G011; do not edit padloc.

You are not alone. Do not edit typed-tools.ts, form.ts, or G012 dirty files. Do not revert unrelated work.

INTERFACES
- Compatibility migration: EncryptedAutofillProfileEnvelope only (ciphertext, wrapped key, metadata). Padloc decrypts inside trusted extension after unlock. Adapter cannot mint/apply.
- Retain ciphertext-only compatibility-envelope wrapping and provenance/loss reporting.
- PadlocBrokerResponse is a closed discriminated schema. Reject unknown keys. Do not accept open-ended records. v1 is non-authorizing compatibility data only.
- Redaction: closed schemas + recursive value-free validation, not a narrow sensitive-key regex. Treat password/token/pan/cvv and any nested scalar value as forbidden in model-facing payloads.
- proof.yaml must run the frozen screenshot/observe/fetch/eval/network/CDP/form inventory, not only old action-attempt and agent-window tests. Evidence dir `.ch5/artifacts/proof/browser-observation-safety`.

CONSTRAINTS
- No real PII, no credential mutation, no production deploy.
- No secrets in logs/argv/receipts/proof artifacts.
- CH5_RAW_TEST_OK=1 bun test on owned files only.

MUST FIX
CR-007: delete or quarantine decrypt/mint/apply APIs from production paths in autofill-vault.ts / autofill-broker.ts.
CR-009 MB: reject legacy open payloads; recursive value-free validation in padloc-broker.ts scanner.
CR-010: wire proof.yaml + post-fill negative tests for every frozen observation primitive.

VERIFICATION
```
cd /Users/hassoncs/worktrees/ch5/magic-browser/agentic-autofill-unification-20260918
CH5_RAW_TEST_OK=1 bun test src/runtime/padloc-broker.test.ts src/cli/padloc.test.ts
```
Plus any new owned tests. Prove production modules cannot mint/apply/decrypt. Prove unknown keys rejected. Prove proof.yaml lists the inventory commands.

Commit owned files and push `grove/agentic-autofill-unification-20260918/magic-browser`. Do not commit secrets or large evidence binaries.

RETURN
STATUS: complete | partial | blocked
CHANGES: file-by-file
VERIFIED: commands + observed evidence
JUDGMENT CALLS:
GAPS:
SHA:
