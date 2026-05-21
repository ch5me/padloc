# Chrome Extension MV3 Unlock Notes

## Findings

- The old MV3 flow treated the background service worker as the session keystore: the popup sent the raw master key to `background.ts`, and the popup asked the worker for that same key again on later opens.
- That breaks on every cold start because MV3 service workers are ephemeral; worker restart is normal, not exceptional.
- `rememberedMasterKey` already exists in core as the right cross-restart biometric pattern: keep an encrypted `StoredMasterKey` in persistent app state, then fetch the unwrap key through authenticated biometric access.

## Design

- `browser.storage.session` is now the only place raw master key material is stored outside live memory.
- The session record is scoped by `accountId` and `sessionId` so a stale session unlock blob is ignored after logout or session churn.
- `browser.storage.local` still stores extension app state, including encrypted `rememberedMasterKey`, but never stores raw master key bytes/base64.
- Popup and worker both restore unlock state from `browser.storage.session`; the worker no longer acts as a master-key relay.
- WebAuthn auth types are exposed on `ExtensionPlatform` so the existing remembered-master-key UX can light up in the extension.

## Implementation Notes

- `packages/extension/src/storage.ts` now owns the MV3 session-key helpers: configure access level, write/read session unlock state, and clear it on lock/logout.
- `packages/extension/src/app.ts` restores from `browser.storage.session` on popup load, writes the session key after unlock, and clears it on lock/logout.
- `packages/extension/src/background.ts` restores from `browser.storage.session` after worker startup and after popup unlock messages, so service-worker wake is a supported path.
- `packages/extension/src/message.ts` no longer ships raw master key payloads over runtime messages.
- `packages/extension/src/platform.ts` now exposes Email, TOTP, and supported WebAuthn types.

## Verification Notes

- `npm run build` passed in `packages/extension` after the refactor.
- LSP diagnostics could not be collected because the workspace TypeScript server timed out during initialize in this session.

## Task 2: WebAuthn/Passkey Auth Support

### Findings

- `WebPlatform._getAuthClient` (private) already returns `webAuthnClient` for `AuthType.WebAuthnPlatform` and `AuthType.WebAuthnPortable`. No override needed in `ExtensionPlatform` — inheritance handles the auth client wiring automatically.
- The extension popup context has full `navigator.credentials` support; WebAuthn assertion/registration executes correctly in popup (not service worker).
- `@simplewebauthn/browser` 5.4.0 and `@simplewebauthn/typescript-types` 5.4.0 resolved correctly from `@padloc/app/node_modules/` via the existing tsconfig path aliases and webpack alias resolution.
- `packages/core/src/auth.ts` defines `AuthType.WebAuthnPlatform` ("webauthn_platform") and `AuthType.WebAuthnPortable` ("webauthn_portable") — both match the server-side WebAuthn flow.
- Worker-side WebAuthn verification uses `@simplewebauthn/server` (version 9.x); the browser client sends `PublicKeyCredential` responses that the worker verifies against registration records.

### Implementation

- `packages/extension/src/auth/webauthn.ts` — extension-scoped `WebAuthnClient` mirroring `@padloc/app/src/lib/auth/webauthn.ts`. Uses `@simplewebauthn/browser` directly via `browserSupportsWebauthn()`, `platformAuthenticatorIsAvailable()`, `startRegistration()`, `startAuthentication()`.
- `packages/extension/package.json` — added `@simplewebauthn/browser` 5.4.0 and `@simplewebauthn/typescript-types` 5.4.0 as dependencies; added `mocha` 9.2.2, `chai` 4.3.4, `@types/chai`, `@types/mocha` for test coverage.
- `packages/extension/test/webauthn.ts` — smoke tests for `ExtensionPlatform.supportedAuthTypes` and `WebAuthnClient.supportsType` behavior.
- `packages/extension/src/platform.ts` — unchanged from Task 1; `supportedAuthTypes` already includes WebAuthn types.

### Verification

- `tsc --noEmit` passed (0 errors).
- `npm run build` passed — webpack bundles `@simplewebauthn/browser` into both `popup.js` (1.4M) and `background.js` (1.5M).

## Task 3: Extension-Native OAuth Flow

### Findings

- `packages/app/src/lib/auth/oauth.ts` uses `window.open` + `postMessage` to handle OAuth — this does NOT work in extension popup context because the popup is a separate browsing context that doesn't receive `postMessage` from the auth window.
- `chrome.identity.launchWebAuthFlow` is the Chrome extension-native OAuth API: opens provider auth URL in a browser-managed window, intercepts the redirect to `https://<extension-id>.chromiumapp.org/provider_callback_path`, and returns the final URL with code/state params.
- `ExtensionPlatform` now overrides `_getAuthClient` to return the extension's `oauthClient` for `AuthType.Oauth` instead of the web `OauthClient`.
- The `identity` permission was added to `manifest.json` to enable `chrome.identity.launchWebAuthFlow`.

### Implementation

- `packages/extension/src/auth/oauth.ts` — extension `OauthClient` using `browser.identity.launchWebAuthFlow`. Mirrors the `AuthClient` interface: `prepareRegistration` and `prepareAuthentication` both call `_getAuthorizationCode` which launches the web auth flow and returns `{ code, state }`.
- `packages/extension/src/platform.ts` — added `AuthType.Oauth` to `supportedAuthTypes` and overridden `_getAuthClient` to return `oauthClient` for OAuth type.
- `packages/extension/src/manifest.json` — added `"identity"` permission.
- `packages/extension/test/oauth.ts` — tests covering success (code+state returned), cancel (rejects with AUTHENTICATION_FAILED), error callback (rejects with error param), no redirect URL, and missing code param.

### Key Difference from Web OAuth

| Aspect | Web OAuth | Extension OAuth |
|--------|-----------|-----------------|
| Auth window | `window.open` popup | `chrome.identity.launchWebAuthFlow` |
| Callback | `postMessage` from popup | `launchWebAuthFlow` returns redirect URL |
| Cancel handling | Window closed detection | Promise rejection from `launchWebAuthFlow` |
| Redirect URL | Must match registered OAuth callback | Uses `chrome-extension://id.chromiumapp.org/` domain |

### Verification

- `tsc --noEmit` passed (0 errors).
- `npm run build` passed.

## Task 5: Popup Cold-Start State Restoration

### Findings

- **Race condition in `ExtensionApp.load()`**: `super.load()` was called before tab capture. Since `super.load()` fires `stateChanged()`, and `stateChanged()` sends `state-changed` to background which triggers `application.reload()` (async), the popup was making routing decisions before the background had finished reloading.
- **Critical ordering bug**: `stateChanged()` fires during `super.load()` and reads `state.context.browser?.url` to compute matching items. The tab was captured AFTER `super.load()`, meaning `_matchingItems` returned empty on cold start even when there were items for the current tab.
- **Worker liveness**: MV3 service workers can be killed after ~30s inactivity. The popup had no way to know if the worker was alive and had finished initializing before making routing decisions.
- **`update()` fire-and-forget**: In `background.ts`, `update()` (which calls `updateBadgeAndContextMenu()`) was called without `await` in the message handler, creating race conditions on cold start where the badge/menu update happened after the popup had already made routing decisions.

### Implementation

- `packages/extension/src/app.ts`:
  - Moved `browser.tabs.query()` and `state.context.browser` assignment BEFORE `super.load()` to fix the race condition
  - Added `_waitForWorkerReady()` which pings the worker with a 100-500ms wait window to ensure cold start settlement
  - Added fallback to "vaults" when `routerState.path` is empty
- `packages/extension/src/background.ts`:
  - Added `case "ping": return { type: "pong" }` handler for worker liveness check
  - Changed all `update()` calls in message handler to `await update()`
- `packages/extension/src/message.ts`:
  - Added `| { type: "ping" }` and `| { type: "pong" }` to Message union
- `packages/extension/test/cold-start.ts`:
  - New test file covering: ping/pong worker liveness, router state restoration, matching items comparison, tab capture ordering, session key availability, background message handling, routing decision logic

### Verification

- `tsc --noEmit` passed (0 errors).
- `npm test` passed (all suites).
- `npm run build` passed.

## Task 6: Multi-Field Login Form Autofill

### Findings

- Current fill path (`content.ts:175`) fills a single value into the active input via `fillActive` message.
- `handleContextMenuClick` in `background.ts:119` parsed `item/{id}/{fieldIndex}` but had a bug: `parseInt(undefined)` returns `NaN`, so `isNaN(NaN)` is `true`, causing early return for the top-level `item/{id}` menu item — meaning the item-level menu click did nothing.
- Field classification is not on the item level but on the content-script level: `content.ts` detects field types by traversing the page DOM and classifying inputs by `type`, `name`, `id`, `autocomplete`, and `placeholder` attributes.
- `FieldType` enum from `core/src/item.ts` distinguishes `Username`, `Password`, and `Totp` — each with their own `transform()` method for getting the fill value.

### Implementation

- `packages/extension/src/message.ts`:
  - Added `FieldMappings` type (`{ username?: string; password?: string; totp?: string }`)
  - Added `fillFields` message type for multi-field orchestration
- `packages/extension/src/content.ts`:
  - Added `FieldRole` enum (`Username`, `Password`, `Totp`)
  - Added `_detectFieldTypes()` — traverses document and shadow roots, classifies each fillable input
  - Added `_classifyField()` — heuristic classification by type/name/id/autocomplete/placeholder
  - Added `_fillFields()` — fills multiple fields based on detected types, falls back to single-field on active input
  - Added `fillFields` case in `_handleMessage`
- `packages/extension/src/background.ts`:
  - Added import of `FieldType` from `@padloc/core/src/item`
  - Added `fillItemMultiField()` — extracts username/password/totp from item and sends `fillFields` message
  - Rewrote `handleContextMenuClick()` with two regex patterns: `item/{id}/{fieldIndex}` (single-field) and `item/{id}` (multi-field)
  - Menu item title appends `▸  Fill Login` when item has both username+password fields
- `packages/extension/src/app.ts`:
  - Enabled `field-clicked` event listener (was commented out)
  - Implemented `_fieldClicked()` — transforms field value and sends `fillActive` to content script
- `packages/extension/test/autofill.ts`:
  - New test suite covering: field classification, context menu ID parsing, multi-field orchestration, mappings, fallback

### Key Design Decisions

- **Content script field detection**: Field roles are determined by the content script scanning the live DOM, not by the item data. This handles any site's specific field naming/structuring.
- **Shadow DOM traversal**: `_detectFieldTypes()` walks shadow roots to handle Web Components.
- **Cascading fallback**: `_fillFields()` prioritizes dedicated TOTP fields, then password fields, then username fields for OTP fill.
- **Menu title UX**: Items with both username+password show `▸  Fill Login` to signal the multi-field action.
- **TOTP transform**: `Field.transform()` for `Totp` type calls `totp(base32ToBytes(value))` — returns the current OTP code.

### Verification

- `tsc --noEmit` passed (0 errors).
- `npm test` passed (all suites).
- `npm run build` passed.

## Task 7: Content Script Field Detection Reliability

### Findings

- **Label text is a strong signal**: `aria-labelledby`, `aria-label`, `<label for>`, and ancestor `<label>` text all reliably identify field purpose on modern SaaS login pages (Google, GitHub, Salesforce, Okta, Azure AD, Slack).
- **TOTP detection via pattern+maxLength**: Fields with `pattern="\d+"` and `maxLength` in [4,8] are almost always OTP inputs — catches sites that don't use `autocomplete="one-time-code"`.
- **inputmode as OTP signal**: `inputmode="numeric"` combined with `maxLength` in [4,8] catches numeric OTP inputs even without name/id/placeholder hints.
- **autocomplete=new-password/current-password**: Even on non-password-type inputs, these indicate password fields.
- **React/Vue/Angular fill**: Requires `beforeinput` (React 18+), `InputEvent` for `input` (not `Event`), and Enter-key `KeyboardEvent` dispatch for Angular.
- **Selection range preservation**: React/Vue controlled inputs gate on `selectionStart`/`selectionEnd` — restoring these after value assignment is required.
- **form attribute association**: Inputs with `form="id"` but rendered outside the `<form>` element are associated with that form — queried via `CSS.escape()`.
- **Shadow DOM traversal**: Recursive `element.shadowRoot` + `querySelectorAll("*")` pattern correctly finds all nested inputs.
- **MV3 CSP compliance**: No eval, no Function constructor, no dynamic code — all event dispatch uses native `InputEvent`/`KeyboardEvent`/`Event` constructors.

### Implementation

- `packages/extension/src/content.ts`:
  - Added `_getLabelText()` — resolves `aria-labelledby`, `aria-label`, `form.labels`, and ancestor `<label>` text
  - Expanded `_classifyField()` — adds `autocomplete` values (`current-password`, `new-password`, `username`, `one-time-code`), `data-field-type`/`data-field` dataset attrs, `labelText`, `pattern` (digit-only), `maxLength` (4-8 for OTP), `inputmode`, `aria-label`, and label text as classification signals
  - Added `verification_code`/`verification`/`identifier`/`screen_name` name patterns for common SaaS forms
  - Expanded TOTP signals: `labelText.includes("code")` catches generic "Enter code" labels
  - Strengthened `_fill()` — uses `InputEvent` for `beforeinput` and `input` (not plain `Event`), preserves selection range, adds Enter-key `keydown`/`keyup`/`keypress` sequence for Angular compatibility
  - Updated `_collectFields()` — collects `form` attribute IDs and queries external forms via `CSS.escape()`
- `packages/extension/test/content.ts`:
  - New test suite covering: plain DOM classification, modern SaaS patterns, TOTP pattern/maxLength/inputmode detection, aria-label/aria-labelledby resolution, label text resolution, shadow DOM traversal, form attribute association, fill event sequence, selection range preservation, multi-field orchestration ordering

### Key Design Decisions

- **Multi-signal TOTP detection**: TOTP classification requires either a name/id/autocomplete signal OR (digit-only pattern AND valid length) OR (numeric inputmode AND valid length). Handles sites that use only `maxLength` or only `inputmode`.
- **`beforeinput` as first event**: React 18+ reads `input.value` inside the `beforeinput` event handler before the value is set. Firing `beforeinput` first with `data=value` causes React to see the new value immediately.
- **CSS.escape for form IDs**: Form IDs may contain dots, colons, spaces — using `CSS.escape()` prevents selector injection.
- **Label resolution order**: `aria-labelledby` > `aria-label` > `form.labels[0]` > ancestor `<label>` — matches the HTML spec precedence.

### Verification

- `tsc --noEmit` passed (0 errors).
- `npm test` passed (all suites with tap reporter).
- `npm run build` passed.

