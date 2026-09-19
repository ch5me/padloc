Continue this mission now. Do not restate the transcript.
You are G006 Magic Browser broker cutover worker.

Workspace: /Users/hassoncs/worktrees/ch5/magic-browser/agentic-autofill-unification-20260918
Also read padloc spec at /Users/hassoncs/worktrees/ch5/padloc/agentic-autofill-unification-20260918/docs/specs/agentic-personal-data-vault.md (closed v2 variants, handshake, privacy-status.v2, EncryptedAutofillProfileEnvelope).
G007 shared gate already exists at src/runtime/autofill-observation-gate.ts — consume it; do not rewrite it.

OWN only:
- src/runtime/padloc-broker.ts
- src/runtime/autofill-vault.ts
- src/runtime/autofill-broker.ts
- src/runtime/agentic-chromium-setup.ts
- src/cli.ts
- src/cli/session.ts
- src/runtime/padloc-broker.test.ts
- src/runtime/autofill-vault.test.ts
- src/runtime/autofill-broker.test.ts

DO NOT edit typed-tools.ts, form.ts, browser-evidence.ts, network-inspect.ts, autofill-observation-gate.ts, padloc sources, package.json. Do not npm/bun install extra deps. Preserve concurrent G007 edits outside your ownership.

MUST:
1. Standard personal autofill plan/apply/proof CLI and session commands call the Padloc native broker only. Local vault is not an authority and must not mint grants.
2. Compatibility migration transports only the encrypted profile envelope and returns provenance/loss. It never mints or applies a fill grant. Unavailable key custody fails closed.
3. Closed response parsing of elf.padloc-broker-response.v2: reject unknown keys and missing required fields. Parse every v2 kind (status, classified, plan, approval-required, granted, applied, revoked, privacy-status, import-result, error) plus import-begin/import-commit handshake shapes. Protocol-v1 remains readable as non-authorizing data only.
4. Direct CLI screenshots use the already-proven shared observation gate. Do not fork a second gate.
5. No raw values in model output, logs, argv, receipts, or parsed broker responses.
6. Proof: from this Tree, with CH5_RAW_TEST_OK=1 reason="G006 owned bun unit files":
   bun test src/runtime/padloc-broker.test.ts src/runtime/autofill-vault.test.ts src/runtime/autofill-broker.test.ts
   Success: all pass; CLI call-site tests prove no standard command loads local vault authority; closed-schema rejects unknown keys.

Stop when tests pass. Do not commit. No secrets. No real PII.
