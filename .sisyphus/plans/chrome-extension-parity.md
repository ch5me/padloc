# Chrome Extension Core Parity

## TL;DR

> **Summary**: Bring the existing Chrome extension to Chrome-first core parity
> with 1Password for CH5 Auth by adding secure re-unlock, extension-native
> OAuth, passkey/WebAuthn support, and materially better autofill without taking
> on full inline 1Password-mini UX in v1. **Deliverables**:
>
> -   secure MV3-compatible unlock/session architecture for the extension
> -   passkey/WebAuthn and OAuth auth support in the extension platform
> -   improved autofill for username, password, and TOTP on matched pages
> -   basic save/update credential flow in the extension
> -   extension-specific automated test lane and CI coverage **Effort**: XL
>     **Parallel**: YES - 3 waves **Critical Path**: 1 → 2 → 3 → 6 → 7 → 9

## Context

### Original Request

Build a decision-complete plan to get the Chrome extension to practical
1Password-style parity for passkeys, email, OAuth, simple autofill, and not
requiring master-password entry every time.

### Interview Summary

-   User chose **Chrome-first core parity** for phase one.
-   User chose **biometric/passkey re-unlock** for the first shipped unlock
    model.
-   User chose **tests-after** rather than strict TDD.
-   Rich inline 1Password-mini UI is not phase-one scope; simple autofill and
    core auth parity are.

### Metis Review (gaps addressed)

-   Treat MV3 service-worker dormancy as a core design constraint, not an edge
    case.
-   Do not persist raw master keys to extension storage.
-   Resolve extension OAuth via extension-native flow, not the web popup flow.
-   Add explicit proof/verification around WebAuthn support in extension
    contexts.
-   Keep scope tight: no Firefox/Safari work, no full inline mini UI, no broad
    multi-account redesign.

## Work Objectives

### Core Objective

Ship a Chrome extension that can authenticate with CH5 Auth using email,
passkeys/WebAuthn, and OAuth, restore usable unlock state without repeated
master-password entry, and autofill matched login flows at a practical
Chrome-first level.

### Deliverables

-   Extension auth platform parity for `Email`, `Oauth`, `WebAuthnPlatform`, and
    `WebAuthnPortable`
-   Secure extension session/re-unlock architecture compatible with MV3 worker
    restarts
-   Popup and background-worker behavior that survives dormancy correctly
-   Autofill improvements beyond active-input single-string fill: username,
    password, and TOTP field handling
-   Basic save/update login flow from detected submissions
-   Extension runtime tests plus CI execution path

### Definition of Done (verifiable conditions with commands)

-   `npm run runtime-config:check`
-   `npm run web-extension:build`
-   `npm run test:extension`
-   `npm test`
-   `npm run test:e2e` or the repo’s chosen extension-capable browser lane from
    this plan

### Must Have

-   No raw master key persisted to `browser.storage.local`
-   No dependency on warm service-worker memory for core unlock success
-   OAuth flow implemented with extension-native redirect/popup APIs
-   Passkey/WebAuthn support exposed through the extension platform rather than
    only the web app platform
-   Autofill remains content-script-driven and emits framework-friendly DOM
    events
-   Extension-specific automated verification lane added to CI

### Must NOT Have

-   No full 1Password-mini inline suggestion UI in v1
-   No Firefox or Safari parity work in this plan
-   No silent storage of raw master keys or plaintext unlock artifacts
-   No reuse of web-only popup OAuth mechanics inside the extension
-   No architectural dependence on `browser.storage.local` as a secure keystore

## Verification Strategy

> ZERO HUMAN INTERVENTION — all verification is agent-executed.

-   Test decision: tests-after using existing worker auth tests, existing
    Cypress/web proof lanes, and a new extension-specific browser automation
    lane
-   QA policy: Every task includes agent-executed scenarios
-   Evidence: `.sisyphus/evidence/task-{N}-{slug}.{ext}`

## Execution Strategy

### Parallel Execution Waves

> Target: 5-8 tasks per wave. <3 per wave (except final) = under-splitting.
> Extract shared dependencies as Wave-1 tasks for max parallelism.

Wave 1: auth/session foundation, extension platform parity, test harness
foundation Wave 2: unlock restoration, OAuth, autofill pipeline, content-script
improvements Wave 3: save/update flow, CI/docs/runtime proof hardening

### Dependency Matrix (full, all tasks)

| Task | Depends On    |
| ---- | ------------- |
| 1    | —             |
| 2    | 1             |
| 3    | 1, 2          |
| 4    | 1             |
| 5    | 1             |
| 6    | 1, 5          |
| 7    | 6             |
| 8    | 6, 7          |
| 9    | 1             |
| 10   | 2, 3, 4, 8, 9 |

### Agent Dispatch Summary

| Wave  | Task Count | Categories                                  |
| ----- | ---------- | ------------------------------------------- |
| 1     | 4          | deep, unspecified-high, quick               |
| 2     | 4          | unspecified-high, quick, visual-engineering |
| 3     | 2          | unspecified-high, writing                   |
| Final | 4          | oracle, unspecified-high, deep              |

## TODOs

> Implementation + Test = ONE task. Never separate. EVERY task MUST have: Agent
> Profile + Parallelization + QA Scenarios.

-   [x] 1. Harden extension unlock/session architecture for MV3

    **What to do**: Replace the current warm-service-worker master-key relay
    architecture with an explicit MV3-safe unlock/session contract. Keep raw
    master keys out of `browser.storage.local`, define which artifacts may live
    in worker memory vs `chrome.storage.session` vs encrypted stored containers,
    and refactor extension state hydration so worker restart is a supported path
    instead of a failure mode. **Must NOT do**: Do not persist raw master keys
    to `browser.storage.local`; do not depend on popup-only state for unlock
    correctness; do not add Firefox/Safari abstractions.

    **Recommended Agent Profile**:

    -   Category: `deep` — Reason: security-sensitive state-contract work
        spanning extension, app core, and MV3 lifecycle
    -   Skills: `auth-session-contract`, `software-design-principles` — secure
        session boundaries and clean decomposition
    -   Omitted: `cloudflare-dns` — not relevant to extension runtime behavior

    **Parallelization**: Can Parallel: NO | Wave 1 | Blocks: 2, 3, 4, 5, 6, 9 |
    Blocked By: —

    **References**:

    -   Pattern: `packages/extension/src/background.ts:18` — current
        worker-local `App` singleton and baked sender setup
    -   Pattern: `packages/extension/src/background.ts:56` — current
        `requestMasterKey` relay from popup to worker
    -   Pattern: `packages/extension/src/app.ts:38` — popup-side request for
        worker-held master key on load
    -   Pattern: `packages/extension/src/storage.ts:5` — extension storage
        backend is `browser.storage.local`
    -   API/Type: `packages/core/src/app.ts:243` — `rememberedMasterKey` state
        already exists in core
    -   API/Type: `packages/core/src/app.ts:1043` — remembered-master-key unlock
        path exists and should be reused, not reinvented
    -   External:
        `https://developer.chrome.com/docs/extensions/develop/migrate/what-is-mv3`
        — MV3 worker lifecycle constraints

    **Acceptance Criteria**:

    -   [x] Worker restart no longer forces master-password re-entry solely
            because in-memory state was lost
    -   [x] No code path writes raw master key bytes or base64 master key
            strings into `browser.storage.local`
    -   [x] Extension unlock/session contract is implemented through explicit
            storage/state boundaries and verified by automated tests

    **QA Scenarios**:

    ```
    Scenario: Worker restart preserves secure re-unlock path
      Tool: Playwright / Bash
      Steps: Build extension, load unpacked extension in Chromium, log in, unlock once, force service-worker restart or extension reload, reopen popup
      Expected: Popup restores usable unlock path without requiring raw master-password re-entry solely due to worker cold start
      Evidence: .sisyphus/evidence/task-1-mv3-unlock-contract.txt

    Scenario: Raw master key never lands in local extension storage
      Tool: Bash
      Steps: After unlock flow, inspect extension storage via automated browser instrumentation or extension test harness storage dump
      Expected: No plaintext or base64 master key value exists in `browser.storage.local`
      Evidence: .sisyphus/evidence/task-1-mv3-unlock-contract-error.txt
    ```

    **Commit**: YES | Message:
    `feat(extension): harden mv3 unlock session model` | Files:
    `packages/extension/src/*`, `packages/core/src/app.ts`, tests

-   [x] 2. Add extension WebAuthn/passkey auth support

    **What to do**: Extend `ExtensionPlatform` to expose extension-supported
    WebAuthn auth types, wire extension-safe WebAuthn client execution in a
    visible context, and connect the existing worker/server WebAuthn
    infrastructure to extension login and re-auth flows. **Must NOT do**: Do not
    assume background-only WebAuthn works without proof; do not fork a second
    incompatible WebAuthn protocol from the existing core/server flow.

    **Recommended Agent Profile**:

    -   Category: `unspecified-high` — Reason: cross-layer feature work with
        auth/runtime risk, but bounded by existing server/client abstractions
    -   Skills: `auth-session-contract` — auth flow integrity;
        `software-design-principles` — extension-specific adapters without
        duplicating web logic
    -   Omitted: `chrome-extension-developer` — optional but not required if the
        executor already knows MV3 mechanics

    **Parallelization**: Can Parallel: NO | Wave 1 | Blocks: 3, 10 | Blocked By:
    1

    **References**:

    -   Pattern: `packages/extension/src/platform.ts:5` — extension platform
        override point
    -   Pattern: `packages/app/src/lib/platform.ts:37` — web platform already
        exposes OAuth and WebAuthn auth types
    -   API/Type: `packages/core/src/auth.ts:26` — `WebAuthnPlatform` and
        `WebAuthnPortable` enums exist
    -   API/Type: `packages/app/src/lib/auth/webauthn.ts:13` — existing
        `WebAuthnClient` implementation
    -   API/Type: `packages/worker/src/auth/webauthn.ts` — server-side
        verification already exists
    -   External:
        `https://developer.chrome.com/docs/extensions/reference/api/webAuthenticationProxy`

    **Acceptance Criteria**:

    -   [x] Extension-supported auth types include WebAuthn where runtime
            capability checks pass
    -   [x] Extension login/re-auth flow can successfully complete a WebAuthn
            assertion against CH5 Auth
    -   [x] Automated tests cover success and unsupported-runtime fallback paths

    **QA Scenarios**:

    ```
    Scenario: Passkey authentication succeeds from extension flow
      Tool: Playwright
      Steps: Load extension, start login/unlock flow for a seeded account with WebAuthn enabled, complete platform/passkey prompt in automated test environment or mock harness
      Expected: Extension reaches authenticated state and persists the correct session metadata
      Evidence: .sisyphus/evidence/task-2-extension-webauthn.txt

    Scenario: Unsupported WebAuthn runtime falls back cleanly
      Tool: Bash / Playwright
      Steps: Run extension auth test in an environment with WebAuthn capability disabled or mocked unavailable
      Expected: UI offers supported fallback auth methods without crash or dead-end state
      Evidence: .sisyphus/evidence/task-2-extension-webauthn-error.txt
    ```

    **Commit**: YES | Message: `feat(extension): enable webauthn auth flows` |
    Files: `packages/extension/src/platform.ts`, auth adapters, tests

-   [x] 3. Implement biometric/passkey re-unlock for the extension

    **What to do**: Reuse the core remembered-master-key pattern so the
    extension can re-unlock through biometric/passkey-backed auth instead of
    asking for the master password on each cold start. Ensure the extension’s
    platform-specific keystore/auth-token path is secure and MV3-safe. **Must
    NOT do**: Do not invent a plaintext cache workaround; do not bypass the
    existing `rememberedMasterKey` concept; do not blur login auth with local
    re-unlock auth.

    **Recommended Agent Profile**:

    -   Category: `deep` — Reason: highest security sensitivity in the whole
        plan
    -   Skills: `auth-session-contract`, `software-design-principles` — secure
        reuse of core app unlock plumbing
    -   Omitted: `interactive-input` — not a planning or implementation
        dependency here

    **Parallelization**: Can Parallel: NO | Wave 2 | Blocks: 10 | Blocked By: 1,
    2

    **References**:

    -   API/Type: `packages/core/src/app.ts:1024` — remembered-master-key setup
        stores encrypted container metadata
    -   API/Type: `packages/core/src/app.ts:1043` — remembered-master-key unlock
        path
    -   Pattern: `packages/app/src/elements/unlock.ts:277` — existing biometric
        unlock UI flow in the main app
    -   Pattern: `packages/extension/src/app.ts:101` — extension unlock
        notifications to background
    -   Pattern: `packages/extension/src/background.ts:198` — auto-lock timer
        interaction with locked/unlocked state

    **Acceptance Criteria**:

    -   [x] After initial setup, extension can re-unlock with
            biometric/passkey-backed flow without master-password entry in the
            common path
    -   [x] Auto-lock followed by re-open uses the new re-unlock path correctly
    -   [x] Cold-start and extension-reload paths are covered by automated tests

    **QA Scenarios**:

    ```
    Scenario: Auto-lock followed by biometric re-unlock
      Tool: Playwright
      Steps: Unlock extension, wait or force auto-lock, reopen popup, trigger biometric/passkey re-unlock flow
      Expected: Extension returns to unlocked state without asking for master password in the common path
      Evidence: .sisyphus/evidence/task-3-biometric-reunlock.txt

    Scenario: Remembered unlock artifact missing or expired
      Tool: Playwright / Bash
      Steps: Delete or invalidate remembered-key metadata, attempt biometric re-unlock
      Expected: Extension shows a clean recovery/setup-required state rather than looping or crashing
      Evidence: .sisyphus/evidence/task-3-biometric-reunlock-error.txt
    ```

    **Commit**: YES | Message: `feat(extension): add biometric re-unlock` |
    Files: extension unlock flow, core app remembered-key paths, tests

-   [x] 4. Replace web OAuth popup logic with extension-native OAuth flow

    **What to do**: Implement OAuth for the extension using Chrome
    extension-native identity/redirect flow instead of the web app’s
    `window.open` / redirect mechanics. Align callback handling, session
    exchange, and runtime config with CH5 Auth’s real production hosts. **Must
    NOT do**: Do not reuse the web popup flow unchanged; do not assume
    `window.location.href` redirects are acceptable in the extension popup; do
    not add enterprise SSO scope beyond the selected Chrome-first core parity
    target.

    **Recommended Agent Profile**:

    -   Category: `unspecified-high` — Reason: auth flow redesign with
        platform-specific APIs
    -   Skills: `auth-session-contract`, `runtime-config-contract` — identity
        flow and host consistency
    -   Omitted: `cloudflare-project-ops` — not needed unless runtime endpoints
        themselves must change

    **Parallelization**: Can Parallel: YES | Wave 2 | Blocks: 10 | Blocked By: 1

    **References**:

    -   Pattern: `packages/app/src/lib/auth/oauth.ts:14` — current web flow
        depends on `window.open` and postMessage
    -   Pattern: `packages/extension/src/platform.ts:8` — extension currently
        suppresses OAuth entirely
    -   Pattern: `config/environment-targets.json:29` — app and API host mapping
        for production
    -   External:
        `https://developer.chrome.com/docs/extensions/reference/api/identity`
    -   External:
        `https://docs.cloud.google.com/identity-platform/docs/web/chrome-extension`

    **Acceptance Criteria**:

    -   [x] Extension supports OAuth login/authentication using an
            extension-native flow
    -   [x] Redirect/callback handling returns control to the extension and
            establishes the correct CH5 Auth session
    -   [x] Automated coverage includes success, cancel, and callback-error
            cases

    **QA Scenarios**:

    ```
    Scenario: OAuth login succeeds from extension
      Tool: Playwright
      Steps: Trigger OAuth login from extension popup, complete provider auth in controlled browser flow, return to extension
      Expected: Extension reaches logged-in state with persisted session metadata and no dead-end popup redirect
      Evidence: .sisyphus/evidence/task-4-extension-oauth.txt

    Scenario: OAuth user cancels mid-flow
      Tool: Playwright
      Steps: Start OAuth, close/cancel provider flow before callback
      Expected: Extension returns to recoverable auth state with explicit cancellation messaging
      Evidence: .sisyphus/evidence/task-4-extension-oauth-error.txt
    ```

    **Commit**: YES | Message: `feat(extension): add native oauth auth flow` |
    Files: extension platform/auth flow, tests

-   [x] 5. Refactor popup/background state restoration and matching-item UX

    **What to do**: Make popup boot and route restoration robust across worker
    cold starts, preserve matching-item UX, and remove assumptions that the
    worker or popup was already alive. Keep the current popup-centered
    interaction model but make it deterministic. **Must NOT do**: Do not broaden
    into a full inline suggestion surface; do not preserve dead commented
    toolbar paths as the primary UX.

    **Recommended Agent Profile**:

    -   Category: `quick` — Reason: focused extension state/route reliability
        work built atop the new session model
    -   Skills: `software-design-principles` — keep popup/background
        responsibilities clear
    -   Omitted: `visual-engineering` — UX changes are modest in this task

    **Parallelization**: Can Parallel: YES | Wave 2 | Blocks: 6, 8 | Blocked By:
    1

    **References**:

    -   Pattern: `packages/extension/src/app.ts:46` — popup captures current
        active tab into app context
    -   Pattern: `packages/extension/src/app.ts:49` — router-state persistence
        and matching-item restoration
    -   Pattern: `packages/extension/src/background.ts:114` — badge and
        context-menu refresh path
    -   Pattern: `packages/extension/src/manifest.json:16` — command surface
        already exists

    **Acceptance Criteria**:

    -   [x] Opening the popup after worker dormancy still restores route and
            matching-item behavior correctly
    -   [x] Matching-item count and popup route behavior are stable across tab
            changes and extension reloads
    -   [x] Automated tests cover popup load on locked, unlocked, and
            just-restarted worker states

    **QA Scenarios**:

    ```
    Scenario: Popup restores matching item view on a known login page
      Tool: Playwright
      Steps: Open a site with seeded matching credentials, open popup, close popup, reload extension worker, reopen popup
      Expected: Popup returns to matching-item flow instead of generic/home state when appropriate
      Evidence: .sisyphus/evidence/task-5-popup-restoration.txt

    Scenario: Popup load on just-restarted worker while locked
      Tool: Playwright
      Steps: Force worker restart, open popup without warm state
      Expected: Locked state is handled cleanly with no broken route or blank popup
      Evidence: .sisyphus/evidence/task-5-popup-restoration-error.txt
    ```

    **Commit**: YES | Message: `fix(extension): harden popup state restoration`
    | Files: `packages/extension/src/app.ts`, background/popup tests

-   [x] 6. Upgrade autofill orchestration to handle login-form field sets

    **What to do**: Move beyond single active-input string fill by introducing a
    deterministic autofill orchestration path for matched pages: choose the
    right credential item, map username/password/TOTP fields, and support fill
    actions from popup and context menu. **Must NOT do**: Do not attempt a full
    1Password inline mini UI; do not expand into payment-card/address autofill
    in this phase.

    **Recommended Agent Profile**:

    -   Category: `unspecified-high` — Reason: medium-complexity behavior across
        popup, worker, content script, and item models
    -   Skills: `software-design-principles` — field mapping and action
        boundaries; `chrome-extension-developer` — extension UX mechanics if
        needed
    -   Omitted: `agent-browser` — verification tool, not design guidance

    **Parallelization**: Can Parallel: YES | Wave 2 | Blocks: 7, 8, 10 | Blocked
    By: 1, 5

    **References**:

    -   Pattern: `packages/extension/src/content.ts:163` — current fillable
        input gate
    -   Pattern: `packages/extension/src/content.ts:175` — current single-input
        fill implementation
    -   Pattern: `packages/extension/src/background.ts:94` — current
        context-menu fill path by field index
    -   Pattern: `packages/extension/src/background.ts:172` — URL-based matching
        item lookup
    -   API/Type: `packages/core/src/app.ts:178` — URL matching/counting
        primitives

    **Acceptance Criteria**:

    -   [x] Extension can fill username and password together on a supported
            login form when fields are present
    -   [x] TOTP field fill is supported where the user chooses a matching item
            and OTP field
    -   [x] Existing single-field explicit fill remains functional as a fallback

    **QA Scenarios**:

    ```
    Scenario: Matched login form gets username and password filled correctly
      Tool: Playwright
      Steps: Open seeded login page fixture, choose matching credential from popup or context menu, trigger autofill
      Expected: Username and password land in the right fields and page JS sees the synthetic input/change events
      Evidence: .sisyphus/evidence/task-6-login-form-fill.txt

    Scenario: Ambiguous or partial form falls back safely
      Tool: Playwright
      Steps: Open a page with unusual or incomplete editable inputs, trigger autofill
      Expected: Extension either fills only confidently mapped fields or surfaces a recoverable fallback without corrupting unrelated inputs
      Evidence: .sisyphus/evidence/task-6-login-form-fill-error.txt
    ```

    **Commit**: YES | Message:
    `feat(extension): improve login autofill orchestration` | Files:
    content/background/popup fill paths, tests

-   [x] 7. Improve content-script field detection and fill reliability

    **What to do**: Strengthen the content script so it can reliably identify
    login-related fields across modern pages, shadow DOM, and framework-managed
    inputs, while keeping the content-script boundary clean and deterministic.
    **Must NOT do**: Do not build a full floating suggestion overlay; do not
    inject dynamic eval-style code or violate MV3 CSP constraints.

    **Recommended Agent Profile**:

    -   Category: `quick` — Reason: focused DOM/runtime refinement task
    -   Skills: `chrome-extension-developer` — content-script constraints and
        patterns
    -   Omitted: `visual-engineering` — not a design-system task

    **Parallelization**: Can Parallel: YES | Wave 2 | Blocks: 8, 10 | Blocked
    By: 6

    **References**:

    -   Pattern: `packages/extension/src/content.ts:158` — active-element
        traversal already supports shadow roots
    -   Pattern: `packages/extension/src/content.ts:180` — current event
        dispatch set for frameworks
    -   External:
        `https://developer.chrome.com/docs/extensions/develop/concepts/content-scripts`
    -   External:
        `https://contributing.bitwarden.com/architecture/deep-dives/autofill/`

    **Acceptance Criteria**:

    -   [x] Content script correctly targets common username/password/TOTP
            fields on at least the project’s chosen fixture set
    -   [x] Fill still works on framework-controlled inputs that require
            synthetic events
    -   [x] Automated tests cover plain DOM, React-style controlled inputs, and
            shadow-DOM cases

    **QA Scenarios**:

    ```
    Scenario: Shadow-DOM or framework-managed input still fills correctly
      Tool: Playwright
      Steps: Open fixture page using shadow DOM or controlled inputs, trigger autofill
      Expected: Correct field receives the value and the host framework state updates
      Evidence: .sisyphus/evidence/task-7-content-fill.txt

    Scenario: Non-fillable active element is ignored safely
      Tool: Playwright
      Steps: Focus a non-supported element and trigger explicit fill
      Expected: Extension does not inject bad values or throw uncaught errors
      Evidence: .sisyphus/evidence/task-7-content-fill-error.txt
    ```

    **Commit**: YES | Message:
    `fix(extension): harden content script field targeting` | Files:
    `packages/extension/src/content.ts`, fixtures/tests

-   [x] 8. Add basic save/update credential flow in the extension

    **What to do**: Implement a basic, popup-centered save/update experience
    when the extension detects a newly submitted login or changed credentials
    for a matched site. Keep scope to login credentials only. **Must NOT do**:
    Do not expand into address/card/profile saving; do not depend on a full
    inline prompt bar in phase one.

    **Recommended Agent Profile**:

    -   Category: `unspecified-high` — Reason: cross-cutting UX and
        data-integrity behavior
    -   Skills: `software-design-principles` — keep detection and persistence
        separated; `chrome-extension-developer` — extension-triggered prompt
        mechanics
    -   Omitted: `pm-lens` — product scoping is already decided for this plan

    **Parallelization**: Can Parallel: YES | Wave 3 | Blocks: 10 | Blocked By:
    5, 6, 7

    **References**:

    -   Pattern: `packages/extension/src/app.ts:31` — popup already has
        matching-item context
    -   Pattern: `packages/extension/src/content.ts:175` — current fill plumbing
        is the insertion point for complementary submit detection
    -   API/Type: `packages/core/src/app.ts` — vault/item update flows live in
        core app and should be reused
    -   Test: `cypress/e2e/01 - signup-login.cy.ts` — existing login-flow
        fixtures can inform save/update scenarios

    **Acceptance Criteria**:

    -   [x] Extension can detect a basic new-login or changed-password
            submission on supported fixtures
    -   [x] User can save a new credential or update an existing one through the
            extension UI
    -   [x] Duplicate or noisy prompts are suppressed for unsupported or
            ambiguous flows

    **QA Scenarios**:

    ```
    Scenario: New login submission prompts save flow
      Tool: Playwright
      Steps: Submit credentials on a fixture site with no existing saved item, then return focus to extension flow
      Expected: Extension offers a save action and persists the new item correctly
      Evidence: .sisyphus/evidence/task-8-save-credential.txt

    Scenario: Existing credential update prompts update flow only once
      Tool: Playwright
      Steps: Submit a changed password for an existing site credential
      Expected: Extension offers update, not duplicate create, and avoids repeated prompt spam
      Evidence: .sisyphus/evidence/task-8-save-credential-error.txt
    ```

    **Commit**: YES | Message: `feat(extension): add basic save update prompts`
    | Files: extension UI/content/background/core item flows, tests

-   [x] 9. Build an extension-specific automated test harness

    **What to do**: Add a browser-automation lane that can load the unpacked
    extension, exercise popup/background/content-script flows, and verify
    auth/autofill behavior. Keep existing worker tests and Cypress tests, but
    add an extension runtime lane purpose-built for Chrome extension behavior.
    **Must NOT do**: Do not rely on build-only CI validation; do not pretend
    Cypress alone covers extension runtime if it cannot load the extension
    reliably.

    **Recommended Agent Profile**:

    -   Category: `unspecified-high` — Reason: new verification infrastructure
        with browser/runtime integration
    -   Skills: `testing-lanes-bootstrap`, `chrome-extension-developer` —
        extension runtime testing and repo lane structure
    -   Omitted: `visual-tdd` — this is behavioral, not pixel-diff, verification

    **Parallelization**: Can Parallel: YES | Wave 1 | Blocks: 10 | Blocked By: 1

    **References**:

    -   Pattern: `package.json:48` — existing extension build lane exists and
        should feed the new test harness
    -   Test: `packages/worker/test/auth-flow-e2e.worker.ts` — auth correctness
        reference
    -   Test: `packages/worker/test/session-contract.test.mjs` — session/lock
        behavior reference
    -   Test: `cypress/e2e/01 - signup-login.cy.ts` — existing app auth journey
        reference
    -   CI: `.github/workflows/build-web-extension.yml` — current build-only
        extension validation

    **Acceptance Criteria**:

    -   [x] Repo gains a stable `test:extension` lane or equivalent command that
            loads the unpacked extension in automation
    -   [x] Extension auth and autofill smoke tests run locally and in CI
    -   [x] Evidence output is captured for popup/background/content-script
            failures

    **QA Scenarios**:

    ```
    Scenario: Extension smoke lane runs end-to-end locally
      Tool: Bash / Playwright
      Steps: Run the new extension test command against a prepared local or staging-compatible target
      Expected: Extension loads, popup opens, and at least one auth plus one autofill smoke scenario pass
      Evidence: .sisyphus/evidence/task-9-extension-test-harness.txt

    Scenario: Broken extension build or missing manifest fails fast
      Tool: Bash
      Steps: Intentionally point the harness at an invalid unpacked path or corrupt manifest in a fixture run
      Expected: Test lane fails with a clear extension-load error instead of hanging
      Evidence: .sisyphus/evidence/task-9-extension-test-harness-error.txt
    ```

    **Commit**: YES | Message:
    `test(extension): add chrome extension runtime lane` | Files: test harness,
    scripts, CI updates

-   [x] 10. Wire CI, proof lanes, and operator docs for extension parity

    **What to do**: Update the repo’s extension build/test lanes, CI workflow
    coverage, and operator-facing docs so the extension parity work is
    buildable, testable, and repeatable for future agents and humans. **Must NOT
    do**: Do not leave the extension as build-only CI; do not require tribal
    knowledge to build prod-targeted unpacked artifacts.

    **Recommended Agent Profile**:

    -   Category: `writing` — Reason: doc + workflow cleanup with some light
        config glue
    -   Skills: `testing-lanes-bootstrap`, `docs-wiki-operator-contract` — named
        proof lanes and durable operator docs
    -   Omitted: `project-setup` — repo is already onboarded

    **Parallelization**: Can Parallel: YES | Wave 3 | Blocks: Final verification
    | Blocked By: 2, 3, 4, 8, 9

    **References**:

    -   Pattern: `README.md` — repo-level development commands
    -   Pattern: `packages/extension/README.md` — extension build/install docs
        exist but need parity-era updates
    -   Pattern: `package.json:81` — runtime contract check already exists
    -   CI: `.github/workflows/build-web-extension.yml` — extension workflow
        starting point
    -   CI: `.github/workflows/run-tests.yml` — broader test workflow that
        should stop ignoring extension runtime coverage

    **Acceptance Criteria**:

    -   [x] Repo docs explain how to build a prod-targeted unpacked extension
            and run extension tests
    -   [x] CI runs extension build plus extension runtime tests on relevant
            changes
    -   [x] Proof/help output includes the extension lane so future operators
            can verify parity work quickly

    **QA Scenarios**:

    ```
    Scenario: Fresh operator can follow docs to run extension lane
      Tool: Bash
      Steps: Follow the documented commands from a clean checkout or scripted environment
      Expected: Build/test/docs flow succeeds without hidden manual knowledge
      Evidence: .sisyphus/evidence/task-10-extension-docs.txt

    Scenario: CI path catches extension regression
      Tool: Bash
      Steps: Run the same local commands CI will run, with one intentionally broken extension behavior in a fixture branch if needed
      Expected: Extension workflow fails in the targeted lane instead of passing on build-only checks
      Evidence: .sisyphus/evidence/task-10-extension-docs-error.txt
    ```

    **Commit**: YES | Message: `chore(extension): wire parity docs and ci lanes`
    | Files: workflows, docs, scripts

## Final Verification Wave (MANDATORY — after ALL implementation tasks)

> 4 review agents run in PARALLEL. ALL must APPROVE. Present consolidated
> results to user and get explicit "okay" before marking work complete. **Do NOT
> auto-proceed after verification. Wait for user's explicit approval before
> marking work complete.** > **Never mark F1-F4 as checked before getting user's
> okay.** Rejection or user feedback -> fix -> re-run -> present again -> wait
> for okay.

-   [x] F1. Plan Compliance Audit — oracle ✅ APPROVED
-   [x] F2. Code Quality Review — unspecified-high ✅ APPROVED (after 2 fix
        rounds)
-   [x] F3. Real Manual QA — unspecified-high (+ playwright if UI) ✅ APPROVED
-   [x] F4. Scope Fidelity Check — deep ✅ APPROVED (after 2 fix rounds)

## Commit Strategy

-   Use small conventional commits per wave once the wave’s verification passes.
-   Keep generated extension build artifacts out of commits unless the repo
    explicitly tracks release artifacts.
-   Land test harness and CI updates in the same wave as the behavior they
    verify.

## Success Criteria

-   Chrome extension supports extension-native email, OAuth, and
    WebAuthn/passkey auth flows for CH5 Auth.
-   User can re-unlock without typing the master password every time, and the
    design survives MV3 worker restarts.
-   Matching-login autofill covers username/password/TOTP on common sites using
    a deterministic, testable content-script path.
-   Extension has automated runtime coverage in CI instead of build-only
    validation.
