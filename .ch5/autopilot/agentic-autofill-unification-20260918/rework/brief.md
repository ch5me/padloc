# Remaining-work Ultragoal Brief — review rework

Frozen architecture revision 5 stays in force. Do not restart clarification or re-plan topology.
Original brief: `.omx/ultragoal/brief.md`
Frozen spec: `docs/specs/agentic-personal-data-vault.md`
Independent code review: `.ch5/autopilot/agentic-autofill-unification-20260918/code-review.json` (`recommendation: fix-first`)

## Harvest (already landed, do not rebuild)

G001–G010 implemented and pushed on:
- padloc `grove/agentic-autofill-unification-20260918/padloc` (HEAD `01eda448` includes G010 + recursive fixture checks; G009 SHA `91f109a0`)
- magic-browser `grove/agentic-autofill-unification-20260918/magic-browser` (HEAD `6c9eb87f`; G009 SHA `31bf101f`)

Canonical G009 command (must stay green after rework):
```
cd /Users/hassoncs/worktrees/ch5/padloc/agentic-autofill-unification-20260918
node scripts/synthetic-agentic-autofill-e2e.mjs --magic-browser-tree /Users/hassoncs/worktrees/ch5/magic-browser/agentic-autofill-unification-20260918
```

## Remaining objective

Close every `fix-first` finding so Elf Vault is the only personal-data authority Magic Browser can use, with non-forgeable approval, v2-only authorizing ops, exact privacy-reset identity, closed schemas, and no model-visible raw values. Then re-run G009, spec-conformance, and independent review. Do not fast-forward `main`. Do not deploy.

## Stories

1. **G011 Padloc authorizing broker** — CR-001, CR-002, CR-003, CR-008, padloc CR-009
2. **G012 MB observation + form closed** — CR-004, CR-005, CR-006 (preserve in-progress dirty redaction)
3. **G013 MB vault quarantine + proof** — CR-007, CR-010, MB CR-009 client/native-host consumer

G011 ∥ G012 ∥ G013, then coordinator re-runs G009 + mocha/bun + spec-conformance.

## Invariants (unchanged)

- Elf Vault owns encrypted records, unlock, approval, passkeys, value resolution, DOM apply.
- Magic Browser owns DOM/session, redacted evidence, guarded submit.
- Hush is operator/runtime secrets only.
- No generic secret-read API. Raw values never in model output, logs, argv, receipts, snapshots.
- No real PII, no real 1Password export, no working-credential mutation, no production/store publish.
- Padloc: no `npm install` / lerna. Topic branch → exact-SHA CI → FF `main` later, not this story.
- Existing `@padloc` / `PL_*` / `PADLOC_*` identifiers remain compatibility names.

## Evidence required

- Targeted mocha/bun tests for each CR.
- Authorizing ops fail closed for protocol v1 and for SW/native `approve=true`.
- Observation reset cannot mint `clean` for invented documentId.
- Model-facing form tools accept no raw values.
- Local MB vault cannot decrypt/mint/apply on production paths.
- Canonical G009 exit 0 after v2 mint/apply.
- Independent review `APPROVE` + spec-conformance both axes `clean` (coordinator, after workers).
