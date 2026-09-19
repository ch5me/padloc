---
type: wiki skeleton
title: OpenWiki documentation skeleton
description: Planned source-grounded concept pages for CH5 Auth.
tags: [skeleton, repository]
---

# OpenWiki Skeleton

Planned generated pages. All listed Markdown files are concept pages with OKF front matter; `index.md` is generated later and is intentionally omitted.

- `architecture/repository-boundary.md` — Product purpose, ownership boundaries with Firefly/ELF, Magic Browser, and Hush, maintenance-mode scope, and package/runtime map.
- `architecture/runtime-architecture.md` — PWA/native/extension-to-Worker composition, core/app/platform contracts, Cloudflare resource topology, and request flow.
- `architecture/core-lifecycle.md` — `App`, persisted `AppState`, load/save/reload, lock/unlock, synchronization, and UI readiness invariants.
- `architecture/authentication.md` — Email, TOTP, WebAuthn/passkey, public-key, OAuth, recovery, provisioning, device trust, session issuance, and authentication-flow tests.
- `architecture/core-domain-api.md` — Core RPC/API methods and authorization-sensitive account, vault, organization, invite, provisioning, seat, and synchronization behavior.
- `architecture/localization.md` — `@elf-vault/locale` runtime translations, extraction, generated artifacts, wordlists, consumers, and drift validation.
- `architecture/admin-application.md` — Admin application entrypoint, guarded routes, account/org/log surfaces, shared package relationships, and build/runtime checks.
- `architecture/firefly-integration.md` — Firefly SSO verification and vault-organization seat synchronization, route security, data flow, and ownership boundary.
- `architecture/worker-composition.md` — Cloudflare Worker entrypoint, lazy server construction, special routes, `server-factory.ts`, and dependency fallbacks.
- `architecture/worker-transport.md` — HTTP/RPC route contract, framing, CORS, timestamp/body/idempotency checks, rate limiting, errors, and metrics.
- `architecture/worker-storage.md` — D1Storage object/blob model, schema ownership, query semantics, migrations, partial failure, KV/DO lifecycle, and D1/R2 boundaries.
- `architecture/node-server.md` — Node server entrypoints, backend selection, HTTP transport differences, Docker Compose, nginx, persistence, SCIM/directory, OAuth/Stripe provisioning, email/logging integrations, legacy paths, and server tests.
- `architecture/security-runtime.md` — Session authority, account locks, crypto provider compatibility, attachment integrity, and fail-closed security invariants.
- `development/local-workflows.md` — Node/npm setup, `ch5-svc`/pitchfork services, dynamic URLs, PWA/Worker local operation, and readiness sharp edges.
- `development/testing-and-proof.md` — Exact unit, integration, E2E, Worker, extension, native, and proof-lane commands, focused test ownership, and the complete Forgejo workflow matrix.
- `operations/configuration-and-secrets.md` — Environment target matrix, runtime/build-time variables, source-of-truth and precedence across manifests/Wrangler/Hush/process environment, Cloudflare bindings, and prohibited secret handling.
- `operations/deployment.md` — Staging deployment, exact-SHA production promotion, migrations, canaries, CI workflow gates, and rollback boundaries.
- `operations/public-releases.md` — Release manifest schema, staging/stable channels, immutable artifact records, extension packaging, canaries, and pointer rollback.
- `operations/native-and-extension.md` — Extension execution contexts, message/bridge and autofill/passkey approval invariants, build/test harness, Cordova/Electron/Tauri support, release truth, and generated-state constraints.
- `operations/sharp-edges.md` — Consolidated non-obvious invariants, false-green services, stale/contradictory operational docs, and safe editing rules.
- `quickstart.md` — Final entrypoint: high-level map and task-routing table linking intent to canonical pages, source symbols, focused tests, and narrow validation commands.
