# Ultragoal Brief: Elf Vault Agentic Personal Data

## Objective

Make Elf Vault the only personal credential and autofill authority used by Magic Browser. Users can store passwords, passkeys, identity, addresses, payment cards, government identifiers, and financial-account data. Agents can classify page fields and cause approved values to be written by the trusted Elf Vault extension without receiving raw values.

## Repositories

- `padloc`: encrypted domain model, import, browser extension, approval, unlock, passkey, native broker, and trusted field executor.
- `magic-browser`: page inspection, broker client, privacy enforcement, redacted proof, and guarded submit.

## Required Outcomes

1. Persist semantic item kinds and complete semantic field roles for login, identity, address, payment, government ID, and financial-account data. Existing items remain readable.
2. Normalize newly created and imported records into semantic roles. The 1PUX importer must return a loss report and preserve provenance without claiming unsupported passkey, attachment, document, history, sharing, or exact TOTP migration.
3. Provide an explicit passkey migration workflow: re-enroll at the relying party, prove Elf Vault assertion, and never claim that 1PUX imported passkeys.
4. Make the extension-owned native broker the canonical Magic Browser autofill path. Agents receive only opaque references, roles, target bindings, policy decisions, and receipts. Raw values resolve only inside the trusted extension executor.
5. Implement conservative approval modes: plan-only, prompted/manual, exact standing-policy automatic fill, and noninteractive fail-closed execution. Hard deny, always-ask, revocation, lock state, target validation, and step-up requirements always win.
6. Require fresh verification for passkeys, CVV, government identifiers, financial-account secrets, new payment origins, and policy changes. Keep final submit separate from fill authorization.
7. Enforce post-fill privacy state in Magic Browser across all generic model-observation paths, including screenshots, page text/accessibility, script evaluation, and network/body capture. Redacted proof remains available.
8. Retire Magic Browser's parallel personal autofill vault as an authority. Compatibility may read it only through a bounded migration path, then standard commands must use Elf Vault.
9. Prove the full synthetic flow through extension install, unlock, classify, plan, approval or standing policy, grant mint, exact apply, privacy block, redacted proof, revocation, lock, and service-worker restart.
10. Deliver focused tests, operator documentation, migration warnings, and exact commands for a limited real-data pilot. Do not move real user credentials during autonomous implementation.

## Architecture Invariants

- Elf Vault owns encrypted personal records, sync, unlock, approval, passkeys, and value resolution.
- Magic Browser owns browser sessions, DOM inspection, redacted evidence, and guarded action.
- Hush remains operator/runtime secret authority only.
- No raw personal value enters model-visible output, logs, argv, receipts, screenshots, generic observations, or portable workflow artifacts.
- Origin, frame, document, form, field, session, nonce, TTL, policy revision, and revocation generation bindings fail closed.
- Existing `@padloc`, `PL_*`, `PADLOC_*`, resource IDs, bundle IDs, schemes, and legacy import/protocol identifiers remain compatibility identifiers.
- Existing vault records and protocol v1 consumers remain readable; incompatible wire changes require a versioned contract.
- Working credentials are not rotated, revoked, reissued, superseded, or removed.

## Out Of Scope

- Importing Chris's actual 1Password export or personal records.
- Removing any working credential or 1Password passkey.
- Production deployment or browser-store publication.
- Capturing or printing real personal information.
- Changing Hush into a personal autofill store.

## Evidence

- Focused domain, importer, classifier, broker, approval, unlock, privacy, and Magic Browser client tests.
- Cross-repository contract fixtures proving role and protocol compatibility.
- Synthetic native-host end-to-end proof with redacted artifacts only.
- Independent code review, spec-conformance review, and adversarial QA.
- Commits pushed to both repositories with clean owned Trees.

## Goals

1. **Semantic vault model** — Persist item kinds, complete login/profile/address/payment/government/financial roles, backward-compatible serialization, and conservative role-derived risk policy.
2. **1Password migration** — Normalize 1PUX records into semantic roles and produce a structured loss report for unsupported passkeys, documents, attachments, history, sharing, and TOTP parameters.
3. **Passkey migration contract** — Implement and document re-enrollment verification workflow without copying or removing working credentials.
4. **Approval and unlock policy** — Complete plan/manual/standing-policy/noninteractive modes, exact authority bindings, revocation, auto-lock, and fresh-verification requirements.
5. **Trusted extension execution** — Keep values inside Elf Vault, strengthen broker target/grant validation, and return only redacted plans and receipts.
6. **Magic Browser broker cutover** — Make standard personal autofill commands use the Elf Vault native broker and remove the parallel local vault as an authority with bounded compatibility migration only.
7. **Magic Browser privacy gate** — Centrally block every generic model-observation primitive after a document becomes potentially private while keeping redacted proof available.
8. **Cross-repository contract proof** — Add aligned fixtures and tests for role vocabulary, protocol compatibility, privacy state, and redaction.
9. **Synthetic end-to-end proof** — Exercise extension install, unlock, classify, plan, approval/policy, mint, apply, privacy block, proof, revoke, lock, and service-worker restart with fake data.
10. **Operator and pilot documentation** — Publish exact diagnostics, migration warnings, security boundaries, and the limited real-data pilot sequence.
