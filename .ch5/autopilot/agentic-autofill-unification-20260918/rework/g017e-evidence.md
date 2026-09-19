# Independent review evidence packet (do not open other files)

SHAs: padloc 35ca1635, magic-browser 2264cfe2
Canonical G009: run-summary.json status=passed, helper 38 steps, checker ok, violations []

## Invariant slices (already extracted)

background.ts:1552-1553 broker type approve throws "Autofill approval is extension-UI-only"
background.ts:1326-1331 authorizing ops require protocolVersion===2
background.ts:1219-1223 UI approve returns opaque approvalId on closed v2
background.ts:1796-1800 reset uses resolveInspectedResetTarget
autofill-observation-policy.ts:259-271 invented documentId throws; matching documentId keeps claimed.formRef/targetRevision
native-host padloc-autofill-host.mjs:93-95 refuses v1 authorizing; 149-152 broker-response returns inner protocolVersion===2
padloc-broker.ts unwrapNativeBrokerEnvelope returns cached v2; parser allows optional approvalId/bundleId
typed-tools.ts:739-760 assertNoRawFormValues refuses form_fill/form_set raw values; gateWorkerObservation runs first

## Write these two files then stop. Overwrite existing coordinator COMMENT files.

1. /Users/hassoncs/worktrees/ch5/padloc/agentic-autofill-unification-20260918/.ch5/autopilot/agentic-autofill-unification-20260918/code-review-g017.json
{"schema":"ch5.autopilot.code-review.v1","independence":"sol-high-g017e-excerpt","recommendation":"APPROVE|COMMENT|REQUEST CHANGES","architectStatus":"CLEAR|WATCH|BLOCK","architectureInvariantGate":{"status":"passed|failed"},"findings":[]}

2. /Users/hassoncs/worktrees/ch5/padloc/agentic-autofill-unification-20260918/.ch5/autopilot/agentic-autofill-unification-20260918/spec-conformance-g017.json
{"schema":"ch5.autopilot.spec-conformance.v1","independence":"sol-high-g017e-excerpt","axes":{"standards":{"status":"clean|gap"},"spec":{"status":"clean|gap"}}}

Do not cat source trees. Do not run tests. Do not run E2E. FIRST ACTION: write both JSON files from this packet.
