# Chrome Extension Parity - Learnings <!-- oc:id=sec_aa -->

## Key Architecture Findings <!-- oc:id=sec_ab -->

### Current Extension Architecture Issues (MV3) <!-- oc:id=sec_ac -->

1. **Worker dormancy kills in-memory state**: `background.ts` holds `app: App` as module-level singleton. When MV3 service worker is killed (after ~30s inactivity), `app` and all its in-memory state (including `account.masterKey`) is lost. <!-- oc:id=item_aa -->

1. **`ExtensionStorage` uses `browser.storage.local` for ALL storage**: `storage.ts` line 8 writes everything to `browser.storage.local`, including `AppState` which holds `rememberedMasterKey`. This is a security concern per the plan's "Must NOT have" rules. <!-- oc:id=item_ab -->

1. **Popup unlock flow broken after worker restart**: `app.ts` line 38-44 requests master key from background via `requestMasterKey` message. If worker restarted, `application.account.masterKey` is null (lines 58-62 in background.ts) → user forced to re-enter master password. <!-- oc:id=item_ac -->

1. **`ExtensionPlatform.supportedAuthTypes` only exposes Email+Totp** (platform.ts line 8-10), excluding OAuth and WebAuthn — which are needed per the plan. <!-- oc:id=item_ad -->

### Core Unlock Pattern (`rememberedMasterKey`) <!-- oc:id=sec_ad -->

- Located: `packages/core/src/app.ts:188` (`StoredMasterKey extends SimpleContainer`), line 243-244 (state field), lines 1015-1054 (methods)
- Pattern: Encrypted container holding master key, unlocked via `unlockWithRememberedMasterKey(authToken)` which requires a server API call (`getKeyStoreEntry`)
- Account/session persistence needed to survive worker restart — core app uses `LocalStorage` which is `window.localStorage` in the browser (not available in extension worker)

### Storage Strategy for MV3 Extension <!-- oc:id=sec_ae -->

- `chrome.storage.session`: Session-scoped, survives worker restarts, cleared when browser session ends
- `chrome.storage.local`: Persistent, survives restarts but is NOT a secure keystore per plan rules
- **Decision**: Store `AppState` (with `rememberedMasterKey`) and `Account` in `chrome.storage.session`; keep other storage in `browser.storage.local`
- **Key insight**: `StoredMasterKey` (line 188) is an encrypted blob that can safely be stored in `chrome.storage.session` — the actual master key bytes never leave the encrypted container

### Critical Reference Paths <!-- oc:id=sec_af -->

- `packages/extension/src/background.ts:56-62` — `requestMasterKey` message handler returning `application.account.masterKey` from memory (BROKEN after worker restart)
- `packages/extension/src/app.ts:38-44` — Popup unlock flow that requests master key from background (fails if worker dead)
- `packages/extension/src/storage.ts:5-36` — `ExtensionStorage` using `browser.storage.local` only
- `packages/extension/src/platform.ts:5-17` — `ExtensionPlatform` with limited `supportedAuthTypes`
- `packages/core/src/app.ts:1015-1054` — `StoredMasterKey` setup and `unlockWithRememberedMasterKey` method

## Plan-Wide Decisions <!-- oc:id=sec_ag -->

- Wave 1 critical path: Task 1 → Tasks 2, 3, 4, 5, 6, 9
- Tasks 4 and 5 can run in parallel with Task 1 (Wave 1, but independent paths)
- Task 2 (WebAuthn) depends on Task 1 completing first
- `chrome.storage.session` is the key MV3 persistence primitive for extension session state

## Task 1 Implementation Notes <!-- oc:id=sec_ah -->

- Corrected the unlock contract to use `browser.storage.session` only for raw master key material; `browser.storage.local` remains the persistent store for serialized app state and encrypted `rememberedMasterKey`. <!-- oc:id=item_ae -->
- Removed the popup ↔ background raw master-key relay (`requestMasterKey` / payloaded `unlocked` message). The worker now rehydrates by reading session storage directly, same as the popup. <!-- oc:id=item_af -->
- Scoped the session unlock blob by `accountId` and `sessionId` so stale session data does not unlock a different account/session after logout or session rotation. <!-- oc:id=item_ag -->
- Kept `rememberedMasterKey` as the cross-restart biometric path instead of inventing a new extension-only key wrapping scheme. <!-- oc:id=item_ah -->
- Exposed WebAuthn auth types from `ExtensionPlatform`, which unblocks the existing unlock/settings biometric UI for the extension once the dedicated WebAuthn task lands. <!-- oc:id=item_ai -->

- Verification so far: `npm run build` for `packages/extension` passed; direct LSP diagnostics were attempted twice but the TypeScript server timed out during initialize. <!-- oc:id=item_aj -->

## Task 3: OAuth Flow <!-- oc:id=sec_ai -->

### Key Findings

- Web OAuth at `packages/app/src/lib/auth/oauth.ts` uses `window.open` + `postMessage` — incompatible with extension popup context because the popup's `window` cannot receive `postMessage` from the auth popup.
- Chrome provides `chrome.identity.launchWebAuthFlow` for extension-native OAuth: opens auth URL, intercepts redirect to `chrome-extension://[ext-id].chromiumapp.org/callback`, returns the full redirect URL with code/state params.
- The `identity` permission is required in manifest.json for `launchWebAuthFlow` to work.
- Extension's `OauthClient` follows same `AuthClient` interface as web: `prepareRegistration` and `prepareAuthentication` both return `{ code, state }`.

### Implementation Notes

- `packages/extension/src/auth/oauth.ts` — new file, `OauthClient` using `browser.identity.launchWebAuthFlow`. Uses `webextension-polyfill-ts` for the `browser.identity` API.
- `packages/extension/src/platform.ts` — override `_getAuthClient` to return `oauthClient` for `AuthType.Oauth`; added `AuthType.Oauth` to `supportedAuthTypes`.
- `packages/extension/src/manifest.json` — added `"identity"` to permissions array.
- `packages/extension/test/oauth.ts` — tests for success (resolves code+state), cancel (rejects), error param in callback (rejects), undefined redirect URL (rejects), and missing code param (rejects).

### Reference Paths

- `packages/extension/src/auth/oauth.ts` — new OAuth client
- `packages/extension/src/platform.ts:8-20` — updated `supportedAuthTypes` and `_getAuthClient`
- `packages/extension/src/manifest.json:14` — added `identity` permission
- `packages/extension/test/oauth.ts` — OAuth test suite

## Task 5: Popup Cold-Start State Restoration

### Key Findings

- **Race condition**: `super.load()` fires `stateChanged()` which reads `state.context.browser?.url`. Tab capture happened AFTER `super.load()`, so `_matchingItems` returned empty even when there were matching items for the current tab.
- **Worker dormancy**: MV3 workers restart after ~30s inactivity. Popup had no liveness check — it made routing decisions before the worker had finished booting.
- **Fire-and-forget update()**: In `background.ts`, `update()` was called without `await` in message handlers, causing badge/menu race conditions on cold start.

### Implementation

- `packages/extension/src/app.ts`:
  - Tab capture moved before `super.load()` to fix stateChanged race
  - Added `_waitForWorkerReady()` with ping/pong handshake (100-500ms window)
  - Added fallback to "vaults" when `routerState.path` is empty
- `packages/extension/src/background.ts`:
  - Added ping/pong case in message handler
  - All `update()` calls now awaited
- `packages/extension/src/message.ts`:
  - Added `ping` and `pong` to Message union
- `packages/extension/test/cold-start.ts`:
  - New test suite covering cold-start scenarios

### Reference Paths

- `packages/extension/src/app.ts:46` — tab capture moved before `super.load()`
- `packages/extension/src/app.ts:53-70` — `_waitForWorkerReady()` and routing logic
- `packages/extension/src/background.ts:114` — `await update()` call
- `packages/extension/src/message.ts:13-14` — ping/pong message types

## Task 6: Multi-Field Login Form Autofill

### Key Findings

- **Context menu bug**: `handleContextMenuClick` used a single regex `^item\/([^\/]+)(?:\/(\d+))?$` but then called `parseInt(ind)` where `ind` is `undefined` for `item/{id}`. `parseInt(undefined)` → `NaN`, `isNaN(NaN)` → `true`, causing early return. The top-level item click did nothing.
- **Field classification lives in content script**: Page field roles (username/password/TOTP) are determined by the content script scanning the DOM, not from item data. This decouples item data from page structure.
- **Shadow DOM traversal required**: Many modern sites use Web Components with shadow DOM — field detection must walk shadow roots.
- **TOTP fill value**: `Field.transform()` for `Totp` type runs `totp(base32ToBytes(value))` which returns the live OTP code, not the secret.
- **Menu title UX signal**: Appending `▸  Fill Login` to the item name when it has username+password fields gives users a clear affordance.

### Implementation

- `message.ts`: New `FieldMappings` type and `fillFields` message for orchestrated multi-field fill
- `content.ts`: `_detectFieldTypes()` traverses DOM + shadow roots, `_classifyField()` classifies by heuristics, `_fillFields()` orchestrates
- `background.ts`: Two distinct regex patterns in `handleContextMenuClick` — `item/{id}/{fieldIndex}` (single) and `item/{id}` (multi). `fillItemMultiField()` extracts fields by `FieldType` and sends `fillFields`
- `app.ts`: `_fieldClicked()` wired to `field-clicked` event — transforms and sends `fillActive` for single-field popup fill

### Reference Paths

- `packages/extension/src/content.ts:175` — original single-field fill (unchanged, remains fallback)
- `packages/extension/src/message.ts:5` — `FieldMappings` type and `fillFields` message
- `packages/extension/src/background.ts:119` — rewritten `handleContextMenuClick` with two-pattern dispatch
- `packages/extension/src/app.ts:214` — `_fieldClicked()` implementation
- `packages/extension/test/autofill.ts` — test suite for classification, parsing, and orchestration logic

## Task 7: Content Script Field Detection Reliability

### Key Findings

- **Label text resolves field purpose**: `aria-labelledby`, `aria-label`, `<label for>`, and ancestor `<label>` text collectively identify field purpose on virtually all modern login pages — Google, GitHub, Salesforce, Okta, Azure AD, Slack all use these attributes.
- **TOTP via pattern+maxLength**: `pattern="\d+"` + `maxLength` in [4,8] reliably detects OTP fields even without name/id signals. Combined with `inputmode="numeric"`, this covers numeric-only OTP inputs.
- **React/Vue/Angular need `beforeinput`**: React 18+ reads `input.value` in `beforeinput` before the DOM value is set. Using `InputEvent` (not plain `Event`) for both `beforeinput` and `input` is required.
- **Selection range gating**: React and Vue controlled inputs check `selectionStart`/`selectionEnd` before accepting input. Restoring selection after value assignment prevents framework-side rejection.
- **form="" attribute**: Inputs rendered outside a `<form>` but associated via `form="id"` must be found by querying the external form element via `CSS.escape(id)`.
- **Shadow DOM is recursive**: `querySelectorAll("*")` on a shadow root finds elements whose shadow roots must then be recursively queried — a two-level walk is insufficient for deeply nested web components.

### Reference Paths

- `packages/extension/src/content.ts:180` — `_getLabelText()` helper (aria-labelledby, aria-label, form.labels, ancestor label)
- `packages/extension/src/content.ts:214` — `_fill()` with `beforeinput` + `InputEvent` + selection preservation + Angular key events
- `packages/extension/src/content.ts:293` — `_collectFields()` with form="" attribute support and recursive shadow DOM traversal
- `packages/extension/src/content.ts:336` — `_classifyField()` with multi-signal TOTP/OTP detection (pattern, maxLength, inputmode)
- `packages/extension/test/content.ts` — full test suite for classification, SaaS patterns, shadow DOM, fill events

