---
type: service architecture
title: Cloudflare Worker composition
description: Worker fetch entrypoint, special routes, lazy core server construction, bindings, and fallback behavior.
tags: [worker, cloudflare, composition]
---
# Cloudflare Worker Composition

`packages/worker/src/index.ts` exports the fetch handler and `AccountLockDO`. It initializes HQ instrumentation, builds receiver configuration, handles `/healthcheck`, `/public-releases/:key`, Firefly SSO, and seat sync, then lazily creates and caches the core `Server` for normal RPC. `server-factory.ts` installs `WorkerPlatform`, D1 storage, R2 attachments, email auth, TOTP auth, logging, and organization provisioning.

The Worker uses `DB`, `ATTACHMENTS`, `HINTS`, `EMAIL_KV`, and `ACCOUNT_LOCK` bindings. Missing D1/R2 can install throwing stubs; missing email secrets currently falls back to shared `MockMessenger`, which is useful locally and dangerous in production. The cached server means the first environment seen by an isolate determines its composition.

Validate route composition with `npm --prefix packages/worker run test:transport-roundtrip`, health checks, and the relevant special-route runner. See [transport](worker-transport.md) and [configuration](../operations/configuration-and-secrets.md).
