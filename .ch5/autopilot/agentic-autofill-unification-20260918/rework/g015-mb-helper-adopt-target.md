Continue this mission now. Do not restate the transcript.
You are G015 Magic Browser helper-adopt-target Luna/Max implementer.

Workspace: /Users/hassoncs/worktrees/ch5/magic-browser/agentic-autofill-unification-20260918
Branch: grove/agentic-autofill-unification-20260918/magic-browser
HEAD at start: bece0e32
Do not run grove prepare. Work in this tree. CH5_GROVE_GUARD=off.

Read first:
- /Users/hassoncs/worktrees/ch5/padloc/agentic-autofill-unification-20260918/.omx/ultragoal/remaining-brief.md
- scripts/synthetic-agentic-autofill-e2e.mjs (bootstrap reset ~217 and later new-document reset ~452)
- nativeBroker / invokeExtensionBroker (~770)

OBJECTIVE
After every successful `autofill-observation-reset`, adopt the broker's returned target:
`target = response.target || target`
so later privacy-status/classify/plan/apply use the ledger identity, not a stale discoverTarget descriptor.

G009 last failed because padloc reset rewrote formRef/targetRevision. Even after padloc keeps claimed identity, the helper must adopt `response.target` so a future inspector change cannot desync the helper.

MUST FIX
1. Bootstrap reset (~217): after assertResponse clean, set `target = response.target || target` before privacy.bootstrap-clean.
2. Later new-document reset (~452): same adopt.
3. Any other reset in this helper: same adopt.
4. Keep `nativeBroker()` as `worker.evaluate(() => padlocAgenticAutofillBroker(request))`. Do not switch authorizing ops back to native-host poll.
5. Keep protocolVersion: 2 on authorizing ops.
6. Do not weaken assertExactTarget after classify/plan; after adopt, those should match.

FILES YOU MAY EDIT
- scripts/synthetic-agentic-autofill-e2e.mjs
- a focused helper unit test only if one already exists next to the script; do not invent a new test harness.

Do not edit padloc except you may READ the padloc remaining brief. Do not edit production MB vault/broker modules. Do not FF main. Do not deploy. Do not touch real credentials.

CONSTRAINTS
- No real PII. Synthetic values only. Raw values never in evidence, logs, argv, receipts.
- Checker allows tokens containing synthetic / example.invalid / fixture or hex `^[0-9a-f]{32,64}$`.
- Do not run the full canonical G009 yourself unless it is cheap and padloc G014 already landed; coordinator owns G016. You MAY run a syntax/node --check on the helper.

VERIFICATION
```
CH5_RAW_TEST_OK=1 bun test src/runtime/padloc-broker.test.ts src/runtime/form.test.ts src/worker/typed-tools.test.ts src/runtime/autofill-broker.test.ts src/runtime/browser-observation-safety.test.ts
node --check scripts/synthetic-agentic-autofill-e2e.mjs
```
Prove the helper now assigns `target = response.target || target` after each reset (rg the file).

Then commit and push on branch grove/agentic-autofill-unification-20260918/magic-browser.
Commit message: `fix(autofill): adopt broker target after trusted observation reset`
Do not commit runtime/evidence dumps.

Write a short answer to:
/Users/hassoncs/worktrees/ch5/padloc/agentic-autofill-unification-20260918/.ch5/autopilot/agentic-autofill-unification-20260918/rework/g015-answer.md
Include SHA, files, test command output summary. No raw values.

FIRST ACTION
Edit scripts/synthetic-agentic-autofill-e2e.mjs reset sites. node --check. bun tests above. Commit. Push. Write g015-answer.md.
