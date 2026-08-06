---
type: test guide
title: Testing and proof lanes
description: Exact validation commands, focused test ownership, and Forgejo workflow coverage for all major surfaces.
tags: [testing, ci, proof, validation]
---
# Testing and Proof Lanes

Setup is `npm ci`; formatting is `npm run format:check`; runtime/theme checks are `npm run runtime-config:check` and `npm run theme:check`. Prefer changed-only validation: `npm run test:changed -- --since hq/main` or `npm run test:changed -- --files <csv>`. General suites are `npm run test` and `npm run test:e2e`.

Worker default CI is `npm --prefix packages/worker run test:ci`, covering logging redaction, session contract, crypto parity, transport roundtrip, and vault CRUD. Additional runners cover auth, errors, metrics, multi-org isolation, seat quota, Firefly sync, HQ instrumentation, and R2 lifecycle. Extension validation is `npm run test:extension`, with Node, Playwright harness, RP, native, readiness, and headful-debug variants. Proof lanes are `npm run proof:all` and the individual `proof:*` scripts.

The extension cache proof is `npm run cache-proof`: it first runs `node scripts/preflight-web-extension-source.cjs`, then hashes the bytes of existing `package.json`, `packages/extension/package.json`, and `packages/extension/manifest.json` in that order with SHA-256, and writes `.cache-proof/padloc-extension.json` containing the file list and digest. Missing listed files are omitted; source-preflight errors fail the command, and consumers must invalidate cache when the recorded digest changes. A complete ordered client-to-extension-to-E2E validation is: `npm ci`; `ch5-svc up`; `PL_SERVER_URL=<api> PL_PWA_URL=<app> npm run pwa:build`; `npm run web-extension:build`; `npm run cache-proof`; `npm run test:extension`; `npm run test:e2e`; then `ch5-svc down`. Forgejo workflows under `.forgejo/workflows/` own changed tests, branch regression, staging/production promotion, public release staging/promotion, extension, Cordova, Electron, Tauri, passkey, Docker, cache proof, and deployment updates. Record trigger, exact SHA, Hush/secret requirements, artifact, and canary behavior before changing a workflow. Native system/passkey lanes may require attended authorization.
