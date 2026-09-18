Continue this mission now. Do not restate the transcript.
You are G001 Semantic vault model worker.

Workspace: /Users/hassoncs/worktrees/ch5/padloc/agentic-autofill-unification-20260918
Read docs/specs/agentic-personal-data-vault.md (Critic Contract Freeze through Exact scalar contracts) and implement only G001.

OWN only:
- packages/core/src/item.ts
- packages/core/src/import-result.ts (create if missing)
- packages/core/src/app.ts (createItem region only)
- packages/app/src/elements/create-item-dialog.ts
- packages/core/test/agentic-autofill-item.ts
- packages/core/test/agentic-import-result.ts
- packages/app/test/agentic-create-item-semantics.ts

DO NOT edit importer, extension, magic-browser, proof.yaml, docs except as needed for types consumed by owned tests.

MUST:
1. Keep existing AutofillItemKind values. Add login, government_identity, financial_account.
2. Keep existing AutofillFieldRole values. Add login.url, government.ssn, government.passport_number, government.drivers_license_number, government.national_id, financial.account_number, financial.routing_number, financial.iban, financial.bic.
3. Persist item kind on VaultItem with backward-compatible deserialize of missing kind (no fill authority).
4. Website/App template: autofillKind=login with username, password, login.url, totp when present. Computer template: login without login.url.
5. Role-derived release class: low/secret/high-risk exactly as spec. CVV transaction-only.
6. Implement closed elf.import-provenance.v1, elf.import-loss.v1, elf.import-result.v1 in import-result.ts. Unknown keys rejected. No field values.
7. createItem/CreateItemDialog propagate kind, roles, transactionOnly, provenance, release class when template omits them.
8. Tests: old records round-trip; missing kind compatible; unknown role fail-closed; ImportResult closed schema; no secret-bearing test output.
9. Proof: changed-only tests via npm run test:changed -- --files <owned test files>. Never print secrets.
10. Carry advisory R5-A1: ImportResult fixtures reject unknown nested keys and wrong cardinality.

Stop when tests pass and you have not touched excluded paths. Do not commit unless asked. No real PII. No credential mutation.
