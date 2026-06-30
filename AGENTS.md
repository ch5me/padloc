# CH5 Auth

## Purpose

- CH5-branded fork of Padloc running as a Cloudflare Worker API plus a static
  PWA and native Cordova shells.
- Primary shipped surfaces today: `pad.ch5.me`, `api-pad.ch5.me`, and the iPhone
  app `CH5 Auth`.

## Repo Layout

- `packages/worker` - Cloudflare Worker API, D1/R2/KV/DO bindings, auth/email
  runtime.
- `packages/pwa` - static web client that bakes `PL_SERVER_URL` at build time.
- `packages/cordova` - iOS/Android shell around the web app.
- `packages/core` - shared auth, vault, crypto, and messaging logic.
- `assets/` - manifests, support docs, and email templates.
- `config/` - CH5 runtime target map and runtime requirements contract.
- `.hush/` - repo-local Hush v3 state. Runtime secrets live here for operator
  flows and are pushed to Cloudflare.

## Commands

- Install deps: `npm ci`
- Local worker only: `npm run worker:dev`
- Local web only: `npm run pwa:start`
- Legacy local stack: `npm run start`
- Changed-only tests/proofs: `npm run test:changed -- --since <ref>` or
  `npm run test:changed -- --files <csv>`; this wraps `ch5 plan padloc` and
  refuses broad fallback tasks unless `--allow-fallback` is explicit.
- Extension harness is headless by default. Use `PADLOC_EXTENSION_HEADFUL=1`
  or `npm run test:extension:headful` only for visual debugging.
- DevMux local status: `npm run svc:status`
- Runtime contract check: `npm run runtime-config:check`
- Worker dry-run: `npm run worker:deploy:dry-run`
- Staging deploy: `npm run deploy:staging`
- Production deploy: `npm run deploy:production`

## Secrets

- Cloudflare runtime is authoritative. Worker secrets must exist in Cloudflare
  even if Hush stores the source values.
- Repo-local Hush targets:
    - `runtime` - shared local/runtime compatibility target
    - `runtime-staging` - staging deploy/runtime target
    - `runtime-production` - production deploy/runtime target
- Do not create `.env`, `.dev.vars`, or plaintext secret files.
- Production email auth requires a valid `RESEND_API_KEY` and a verified
  `EMAIL_FROM_ADDRESS` sender domain. Current production sender is
  `support@ch5.me`.

## Hosting

- Production web: `https://pad.ch5.me`
- Production API: `https://api-pad.ch5.me`
- Staging web: `https://pad-staging.ch5.me`
- Staging API: `https://api-pad-staging.ch5.me`
- Local worker: `http://127.0.0.1:8787`
- Local web: `http://localhost:3000`

## Rules

- Treat `preview` as a legacy compatibility env. New stable pre-prod work should
  use `staging`.
- Personal autofill records are Padloc-owned encrypted items. Magic Browser owns
  browser execution/redacted proof. Bridge doctrine lives in
  `docs/agentic-autofill-bridge.md`.
- Do not reintroduce `process.env.PL_APP_NAME` assumptions into
  Worker/runtime-shared code; Workers do not provide `process`.
- Keep `clientUrl` on the app host (`pad.ch5.me` / `pad-staging.ch5.me`), never
  the API host.
- The PWA must always be built with an explicit `PL_SERVER_URL`; do not rely on
  runtime mutation.
- If email auth breaks, first verify the live Worker secret values and sender
  domain before changing app logic.
- Do not run the full Playwright extension harness headfully by default. Start
  with `npm run test:changed`; if a browser harness is needed, keep it headless
  unless a human-visible native/browser state is the thing being debugged.

## Sharp Edges

- `packages/worker/src/server-factory.ts` currently falls back to
  `MockMessenger` if either email secret is missing. That is useful locally and
  dangerous in production; keep an eye on it when changing auth.
- The repo-scoped Cloudflare deploy token currently lacks KV write for Worker
  deploys; production deploys may need the bootstrap/operator lane until that
  token is reminted correctly.
- `packages/worker/src/email/templates.ts` is generated from `assets/email/*`;
  regenerate after changing email copy.
- Cordova platform plugin fixes applied under `packages/cordova/platforms/` are
  generated-state only and will be lost if the platform is re-added.
