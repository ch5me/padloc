Continue this mission now. Do not restate the transcript.
You are G008 Cross-repository contract proof worker.

Padloc workspace: /Users/hassoncs/worktrees/ch5/padloc/agentic-autofill-unification-20260918
Magic Browser workspace: /Users/hassoncs/worktrees/ch5/magic-browser/agentic-autofill-unification-20260918
Read docs/specs/agentic-personal-data-vault.md Critic Contract Freeze, C5 proof keys, C6 canonical fixtures, closed variant tables, handshake shapes.

OWN only:
- packages/extension/test/agentic-contract-fixtures.ts          (padloc)
- packages/extension/test/fixtures/agentic-autofill/contract.v1.json (padloc; canonical)
- .ch5/proof.yaml                                              (padloc)
- src/runtime/agentic-contract-fixtures.test.ts                (magic-browser)
- .ch5/proof.yaml                                              (magic-browser; consumer lane only)

DO NOT edit padloc packages/core/src, packages/app/src, packages/extension/src, magic-browser src/runtime/autofill-*.ts, magic-browser src/worker, package.json. Do not npm install/lerna.

MUST:
1. Canonical fixture at padloc/packages/extension/test/fixtures/agentic-autofill/contract.v1.json. Both repos consume that file. Local MB copy allowed only with recorded sha256; hash drift fails.
2. Fixture includes one example of every v2 kind and both handshake round-trips (import-begin success, import-commit success, handshake kind=error). Recursive unknown-key rejection (R5-A1). Recursive metadata-only: no values/secrets/ciphertext dumps (R5-A2).
3. Padloc .ch5/proof.yaml MUST add these eight command keys as real runnable commands (R5-A3); missing keys fail:
   - agentic-autofill-core-model
   - agentic-autofill-1pux-import
   - agentic-autofill-passkey-contract
   - agentic-autofill-permission-engine
   - agentic-autofill-broker
   - agentic-autofill-privacy-gate
   - agentic-autofill-contract-fixtures
   - agentic-autofill-synthetic-e2e
   Magic Browser .ch5/proof.yaml may add a consumer lane invoked by agentic-autofill-privacy-gate. Do not create a second registry.
4. Tests: fixture parse + redaction parity; privacy-status exact-target and state-transition parity; ImportResult/provenance and encrypted-profile envelope parity; closed-schema arbitrary-key and malformed-v1 rejection; legacy protocol-v1 read compatibility.
5. Proof commands that actually work (do not invent runners):
   Padloc core/app from packages/app:
   NODE_PATH="./node_modules:../extension/node_modules" NODE_OPTIONS=--no-experimental-strip-types TS_NODE_PROJECT=tsconfig.json TS_NODE_COMPILER_OPTIONS='{"module":"commonjs","esModuleInterop":true}' ./node_modules/.bin/mocha --ui tdd --require ts-node/register/transpile-only --require tsconfig-paths/register ../core/test/agentic-autofill-item.ts ../core/test/agentic-import-result.ts test/agentic-create-item-semantics.ts test/agentic-1pux-import.ts
   Padloc extension from packages/extension:
   NODE_OPTIONS=--no-experimental-strip-types TS_NODE_COMPILER_OPTIONS='{"module":"commonjs"}' npx mocha --ui tdd --require ts-node/register/transpile-only --require tsconfig-paths/register --require test/setup.ts test/agentic-contract-fixtures.ts
   MB: CH5_RAW_TEST_OK=1 bun test src/runtime/agentic-contract-fixtures.test.ts
   CH5_RAW_TEST_OK=1 only with reason="G008 owned mocha/bun unit files".

Stop when tests pass and proof.yaml keys exist. Do not commit. No secrets. No real PII.
