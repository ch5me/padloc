---
type: service architecture
title: Cloudflare Worker composition
description: Worker fetch entrypoint, special routes, lazy core server construction, bindings, and fallback behavior.
tags: [worker, cloudflare, composition]
---
# Cloudflare Worker Composition

`packages/worker/src/index.ts` exports the fetch handler and `AccountLockDO`. It initializes HQ instrumentation, builds receiver configuration, handles `/healthcheck`, `/public-releases/:key`, Firefly SSO, and seat sync, then lazily creates and caches the core `Server` for normal RPC. `server-factory.ts` installs `WorkerPlatform`, D1 storage, R2 attachments, email auth, TOTP auth, logging, and organization provisioning.

The Worker uses `DB`, `ATTACHMENTS`, `HINTS`, `EMAIL_KV`, and `ACCOUNT_LOCK` bindings. Live environments (`staging`/`production`/`preview`) throw at boot if `DB`, `ATTACHMENTS`, or `HINTS` is missing, and never install stub storage, default-allow rate limits, or idempotency no-ops. Missing email secrets throw in every environment; `MockMessenger` is allowed only with explicit `EMAIL_BACKEND=mock` in development/test/local. The cached server means the first environment seen by an isolate determines its composition.

Validate route composition with `npm --prefix packages/worker run test:transport-roundtrip`, health checks, and the relevant special-route runner. See [transport](worker-transport.md) and [configuration](../operations/configuration-and-secrets.md).
