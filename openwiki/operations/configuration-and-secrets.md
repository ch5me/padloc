---
type: operations reference
title: Configuration and secrets
description: Environment targets, runtime versus build-time variables, source precedence, Cloudflare bindings, and Hush topology without secret values.
tags: [configuration, secrets, hush, cloudflare]
---
# Configuration and Secrets

`config/environment-targets.json` is the target map for local, staging, and production app/API URLs. `config/runtime-requirements.json` declares required surfaces; `packages/worker/src/env.ts` and `wrangler.toml` show actual Worker consumption and bindings. Treat runtime code and Wrangler as authoritative for behavior, and use `npm run runtime-config:check` to detect contract drift. Declared future or currently unconsumed names must not be presented as active behavior.

`ALLOW_ORIGIN`, `CLIENT_URL`, and Worker resource bindings are runtime configuration. `PL_SERVER_URL`, `PL_PWA_URL`, and support email are build-time web inputs; the PWA does not support runtime mutation. `clientUrl` must remain the app host. Staging and production require email, HQ, and WebAuthn configuration by the runtime contract; values are never documented here.

Hush targets are `runtime`, `runtime-staging`, `runtime-production`, `wrangler-deploy-staging`, and `wrangler-deploy-production`. CI should hold only `SOPS_AGE_KEY` to unlock Hush, not a persistent Cloudflare token. Use `bash scripts/ci-setup-hush.sh <target>` and deployment scripts; do not create `.env`, `.dev.vars`, or plaintext secret files. Adding a Worker binding requires re-minting the stage deploy token.
