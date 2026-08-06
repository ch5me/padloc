---
type: client operations
title: Native clients and browser extension
description: Extension contexts, bridge security, autofill/passkey protocols, native builds, support truth, and generated-state constraints.
tags: [extension, native, passkeys, autofill]
---
# Native Clients and Browser Extension

The extension separates background, content, popup, page-bridge, autofill broker, message, passkey protocol/provider, request binding, approval, selection, and user-verification contexts under `packages/extension/src`. `ExtensionPlatform` supports browser OAuth/WebAuthn while `ExtensionWorkerPlatform` keeps the MV3 background path DOM-free. Cross-context messages must preserve request binding, origin/RP policy, runtime-port cancellation, and explicit approval; autofill and passkey flows fail closed and redact secrets from durable proof. Build uses `npm run web-extension:build`; `scripts/build-web-extension.cjs` injects `PL_SERVER_URL` and runs source/dist preflights that validate the manifest and generated output.

The MV3 background path must tolerate cold starts: `packages/extension/src/background.ts` handles runtime messages/ports, cancellation, and one-shot fallback without assuming a warm DOM or persistent in-memory request. Request binding and RP policy are checked before approval. Extension RP tests (`test:passkey-rp:extension`) prove browser/extension behavior; `test:passkey-rp:native` and `native-system-e2e.cjs` are separate native-system proof and do not prove vault-backed production integration. Tests are layered: `npm --prefix packages/extension test`, `npm run test:extension`, `test:passkey-rp`, extension RP, native-system RP, and readiness self-tests. Install Chromium with `npx playwright install chromium`; headful mode is visual debugging only. Cordova, Electron, and Tauri builds use the root `cordova:*`, `electron:*`, and `tauri:*` scripts.

`config/platform-support.json` is authoritative for support. Native passkey provider completion is not release proof because the Keychain broker does not yet use the real unlocked-vault/local-service boundary. Cordova changes under `packages/cordova/platforms/` are generated state and are lost when platforms are re-added.
