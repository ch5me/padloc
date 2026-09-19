# UltraQA — agentic-autofill-unification-20260918

Verdict: **pass** (refreshed after native v2 forward)

Run timestamp: 2026-09-19T23:07Z
Subject: padloc `35ca1635`, magic-browser `2264cfe2`

## Canonical dynamic proof

Command:

```text
node scripts/synthetic-agentic-autofill-e2e.mjs --magic-browser-tree /Users/hassoncs/worktrees/ch5/magic-browser/agentic-autofill-unification-20260918
```

Observed exit code: `0`.

Evidence root:
`.ch5/autopilot/agentic-autofill-unification-20260918/synthetic-e2e/`

Observed runner result:

- `run-summary.json.status`: `passed`
- fixture hash: `647bcca04098801708b6701688b0a362ec5686a1316bd019d033a99bfed33e45`
- helper event count: `38`
- required proof steps present: setup, unlock/seed, clean bootstrap, classify, plan, approval, grant, apply, privacy block, redacted proof, revoke, stale-grant block, lock, service-worker restart, restart-stale block
- apply receipt: `status=completed`, `submittedByExecutor=true`, `modelDisclosure=none`
- post-fill privacy: `state=potentially-private`, `genericObservation=blocked`
- stale/restart negative paths: `errorCode=STALE` and `errorCode=LOCKED`

## Adversarial checks

| Scenario | Result | Evidence |
|---|---|---|
| Raw values in evidence/channels | pass | `artifact-check.json`: `ok=true`, `violations=[]`, `scannedFiles=14`, `tokenCount=2`; negative injected raw-value probe exited `1` and detected both raw token and `rawValue` field |
| Protocol-v1 privacy authorization | pass | Direct `assertAutofillObservationAllowed` probe rejected a v1 envelope with `code=invalid_privacy_status`; `src/runtime/padloc-broker.ts` marks v1 reads `authorizing=false` |
| Local vault grant mint | pass | Canonical CLI path sends `plan-fill`, `mint-fill-bundle`, and `apply-fill-bundle` to Padloc native broker; CLI output states no local vault authority; no local-vault read appears in `src/cli/session.ts`; `src/runtime/autofill-broker.ts` is not used by standard CLI authority path |
| Shared observation gate inventory | pass | `src/worker/typed-tools.ts` gates the generic worker tool set; `src/cli/session.ts` gates CDP/CLI screenshots; `src/runtime/autofill-observation-gate.ts` requires exact v2 target + clean/allowed state; direct screenshot paths call the same gate |

## Focused consumer tests

Command:

```text
bun test src/runtime/padloc-broker.test.ts src/runtime/agentic-contract-fixtures.test.ts src/worker/typed-tools.test.ts
```

Observed: `25 pass`, `0 fail`, exit code `0`.

Covered: closed v2 broker parsing, nested unknown/raw payload rejection, protocol-v1 non-authorizing reads, ciphertext-only import envelope, exact privacy target validation, redacted evidence resolution, and worker privacy gate.

## Scope / cleanup

No product source, `packages/`, or `src/` files edited by UltraQA. No real PII, credentials, or npm install used. No commit created.
