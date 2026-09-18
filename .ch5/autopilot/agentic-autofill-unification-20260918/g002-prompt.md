Continue this mission now. Do not restate the transcript.
You are G002 1PUX migration worker.

Workspace: /Users/hassoncs/worktrees/ch5/padloc/agentic-autofill-unification-20260918
Read docs/specs/agentic-personal-data-vault.md Critic Contract Freeze (C1/C2). Consume G001 ImportResult/provenance from packages/core/src/import-result.ts. Do not invent schemas.

OWN only:
- packages/app/src/lib/1pux-parser.ts
- packages/app/src/lib/import.ts
- packages/app/test/agentic-1pux-import.ts

DO NOT edit core item model, createItem, extension, magic-browser, package.json, lerna, or run npm install.

MUST:
1. 1PUX import returns elf.import-result.v1 with imported/normalized/skipped/lossy counts, losses[], provenance, sourceIdentifiers. No field values in the result.
2. Login/profile/address/payment/government/financial fixtures normalize into frozen roles. Persist provenance on VaultItem.
3. Passkeys, attachments, documents, history, sharing, non-exact TOTP parameters produce explicit loss entries and never claim migration.
4. Trashed items preserve provenance without becoming hidden authority.
5. Synthetic fixtures only. No real 1Password export.
6. Tests: deterministic loss-report snapshots; unknown keys rejected if you parse ImportResult.
7. Proof: mocha tdd via packages/app mocha + ts-node + tsconfig-paths, NODE_PATH including packages/app/node_modules. Do not use lerna.

Stop when tests pass. Do not commit. No secrets printed.
