# CH5 Auth

## Purpose

-   CH5-branded fork of Padloc running as a Cloudflare Worker API plus a static
    PWA and native Cordova shells.
-   Primary shipped surfaces today: `pad.ch5.me`, `api-pad.ch5.me`, and the
    iPhone app `CH5 Auth`.

## Running this repo's dev services

`ch5-svc` is the one front door. `pitchfork.toml` in this repo declares the
services; you do not choose ports and you do not launch dev servers in a harness
pane.

```bash
ch5-svc up            # start this repo's services (serialized) and print URLs
ch5-svc status        # status, resolved port, measured liveness, URL
ch5-svc logs <name>   # tail one service
ch5-svc down          # stop this repo's services only
```

Services here: `api`, `web`, `v3`, `maildev`, `tauri`

URLs are `http://<service>.<tree>.localhost:7300/`, where `<tree>` is the
directory basename — the repo name in the canonical checkout, the Grove Tree name
in a Tree. So two Grove Trees of this repo are reachable at once, each at its own
hostname, and nobody types a port. `ch5-svc status` prints the exact URLs; do not
guess or hardcode them.

If a URL shows a "not answering" page, the service is declared but down — the page
has a button that starts it. Never `pitchfork stop --all` (box-wide) and never add
`--force` (`start` is already idempotent).

## Repo Layout

-   `packages/worker` - Cloudflare Worker API, D1/R2/KV/DO bindings, auth/email
    runtime.
-   `packages/pwa` - static web client that bakes `PL_SERVER_URL` at build time.
-   `packages/cordova` - iOS/Android shell around the web app.
-   `packages/core` - shared auth, vault, crypto, and messaging logic.
-   `assets/` - manifests, support docs, and email templates.
-   `config/` - CH5 runtime target map and runtime requirements contract.
-   `.hush/` - repo-local Hush v3 state. Runtime secrets live here for operator
    flows and are pushed to Cloudflare.

## Commands

-   Install deps: `npm ci`
-   Foreground one-off debug only, NOT the dev-service path (use `ch5-svc`):
    `npm run worker:dev`, `npm run pwa:start`, `npm run start`
-   Changed-only tests/proofs: `npm run test:changed -- --since <ref>` or
    `npm run test:changed -- --files <csv>`; this wraps `ch5 plan padloc` and
    refuses broad fallback tasks unless `--allow-fallback` is explicit.
-   Extension harness is headless by default. Use `PADLOC_EXTENSION_HEADFUL=1`
    or `npm run test:extension:headful` only for visual debugging.
-   Local dev services: `ch5-svc up` / `ch5-svc status` — see *Running this
    repo's dev services* above.
-   Runtime contract check: `npm run runtime-config:check`
-   Worker dry-run: `npm run worker:deploy:dry-run`
-   Staging deploy: `npm run deploy:staging`
-   Production deploy: `npm run deploy:production`

## Secrets

-   Cloudflare runtime is authoritative. Worker secrets must exist in Cloudflare
    even if Hush stores the source values.
-   Repo-local Hush targets:
    -   `runtime` - shared local/runtime compatibility target
    -   `runtime-staging` - staging deploy/runtime target
    -   `runtime-production` - production deploy/runtime target
    -   `wrangler-deploy-staging` - governed `ch5-padloc-staging` Cloudflare
        deploy token (least-priv for every staging binding). Consumed by
        `scripts/deploy-staging`.
    -   `wrangler-deploy-production` - governed `ch5-padloc-prod` Cloudflare
        deploy token (least-priv for every production binding). Consumed by
        `scripts/deploy-production`.
-   Cloudflare deploy-auth is **hush-in-CI** (company standard):
    `scripts/deploy-<stage>` is the self-contained entrypoint that resolves the
    governed token from Hush and runs migrations + worker deploy + PWA Pages
    deploy. The IDENTICAL command runs on a laptop, a harness, or CI. CI holds
    only `SOPS_AGE_KEY` (to unlock Hush) — never a Cloudflare API-token secret.
    Rotation = re-mint the token + push.
-   Do not create `.env`, `.dev.vars`, or plaintext secret files.
-   Production email auth requires a valid `RESEND_API_KEY` and a verified
    `EMAIL_FROM_ADDRESS` sender domain. Current production sender is
    `support@ch5.me`.

## Hosting

-   Production web: `https://pad.ch5.me`
-   Production API: `https://api-pad.ch5.me`
-   Staging web: `https://pad-staging.ch5.me`
-   Staging API: `https://api-pad-staging.ch5.me`
-   Local web/API: `ch5-svc up`, then the hostnames `ch5-svc status` prints —
    never a guessed port. See *Running this repo's dev services* above.

## Rules

-   Do not create pull requests for this repository. Push work to a topic
    branch, require exact-SHA branch CI, then fast-forward the verified commit
    to `main`; close any accidentally created pull request without merging it.
-   Treat `preview` as a legacy compatibility env. New stable pre-prod work
    should use `staging`.
-   Personal autofill records are Padloc-owned encrypted items. Magic Browser
    owns browser execution/redacted proof. Bridge doctrine lives in
    `docs/agentic-autofill-bridge.md`.
-   Do not reintroduce `process.env.PL_APP_NAME` assumptions into
    Worker/runtime-shared code; Workers do not provide `process`.
-   Keep `clientUrl` on the app host (`pad.ch5.me` / `pad-staging.ch5.me`),
    never the API host.
-   The PWA must always be built with an explicit `PL_SERVER_URL`; do not rely
    on runtime mutation.
-   `pitchfork.toml` declares local services and `ch5-svc` drives them. Do not
    use `concurrently`, raw persistent server commands, or a dev server started
    by hand in a harness pane.
-   If email auth breaks, first verify the live Worker secret values and sender
    domain before changing app logic.
-   For user-authorized local Chrome testing, hand off between the Chrome
    control surface and Computer Use when ordinary visible browser UI (including
    toolbar, extension, or internal management UI) is not addressable by the
    first tool. This authorization covers normal reversible UI operation only;
    it does not override required human-presence, confirmation, credential,
    CAPTCHA, security, or other higher-priority safety boundaries.

## Sharp Edges

-   `packages/worker/src/server-factory.ts` currently falls back to
    `MockMessenger` if either email secret is missing. That is useful locally
    and dangerous in production; keep an eye on it when changing auth.
-   The governed `ch5-padloc-{staging,prod}` deploy tokens are least-privilege
    for every binding across their stage (Workers Scripts / D1 / KV / R2 Storage
    Write, Pages Write, Account Settings Read, Workers Tail Read). Add or remove
    a binding in `packages/worker/wrangler.toml` → re-mint that stage's token
    (`cf-mint-project-token --project padloc --stage <staging|prod> --dir . --hush-file env/project/<staging|production>`)
    so the token stays complete; an under-scoped token breaks the deploy.
-   `packages/worker/src/email/templates.ts` is generated from `assets/email/*`;
    regenerate after changing email copy.
-   Cordova platform plugin fixes applied under `packages/cordova/platforms/`
    are generated-state only and will be lost if the platform is re-added.

## Local services — first runtime pass (2026-07-29)

Measured in a clean Grove Tree after `npm install`, in the pinned-port era that
preceded `ch5-svc`. The port column is what was measured then; ports are no
longer pinned or typed, but the findings below still hold.

| daemon | port then | result |
|---|---|---|
| api | 8787 | `GET /healthcheck` **200** |
| web | 3000 | **binds but never serves** — see below |
| v3 | 8081 | EADDRINUSE — sprite-foundry's vite (another repo's Tree) held it |
| maildev | 1080 | EADDRINUSE — a long-lived `ssh -N -D 127.0.0.1:1080` SOCKS tunnel held it |
| tauri | — | not started (desktop shell) |

**`web` is the sharpest false green found in the whole fleet pass, and no
automated check catches it.** webpack-dev-middleware accepts the TCP connection
on 3000 immediately and then answers every request with
`wait until bundle finished: /` forever — measured for **11 minutes** without a
single response, alongside a repeating
`ENOENT ... packages/pwa/dist/index.html`. So:

- the readiness port check is satisfied — the supervisor calls it ready.
- `pitchfork-suspect-daemons` clears it — its verdict is a TCP connect, and the
  connect succeeds.
- `curl` returns `000` on a 40s timeout, ten times running.

A TCP connect proves a listener exists, not that anything is served. For this
daemon the only honest check is an HTTP response, and it does not currently
produce one. That bundle failure is pre-existing and unrelated to the supervisor.

Two ports were held by processes outside this repo. Those were collisions, not
defects — the supervisor refused loudly and named the holding PID — but it named
the wrong *daemon*: it reported `maildev` blocked on 8081 (v3's port) and `v3`
blocked on 1080 (maildev's). So never diagnose from start-time console output;
read `ch5-svc status`, which reports resolved port and measured liveness.
