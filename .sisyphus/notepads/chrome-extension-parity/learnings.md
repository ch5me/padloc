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
