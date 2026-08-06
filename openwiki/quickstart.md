---
type: repository guide
title: CH5 Auth wiki quickstart
description: Entry map for CH5 Auth architecture, commands, configuration, testing, deployment, releases, and safe change routing.
tags: [quickstart, repository, navigation]
---
# CH5 Auth Wiki Quickstart

CH5 Auth is a CH5-maintained Padloc fork: encrypted vault and credential clients backed by a Cloudflare Worker API, with PWA, native, Admin, Node-server, and browser-extension surfaces. Start with [repository boundary](architecture/repository-boundary.md), then use [runtime architecture](architecture/runtime-architecture.md) to locate the owning layer. Neighbor boundaries are Firefly/ELF for shell/identity/billing/agent runtime, Magic Browser for browser execution and redacted proof, and Hush for operator/deployment secrets.

## Map

- [Core lifecycle](architecture/core-lifecycle.md) explains `App`, `AppState`, persistence, lock/unlock, and readiness.
- [Authentication](architecture/authentication.md) and [core domain/API](architecture/core-domain-api.md) explain protocol and authorization behavior.
- [Worker composition](architecture/worker-composition.md), [transport](architecture/worker-transport.md), and [storage](architecture/worker-storage.md) cover the Cloudflare service.
- [Node server](architecture/node-server.md), [Admin](architecture/admin-application.md), and [localization](architecture/localization.md) cover substantial package boundaries.
- [Configuration and secrets](operations/configuration-and-secrets.md), [local development](development/local-workflows.md), and [testing](development/testing-and-proof.md) provide exact operational commands.
- [Deployment](operations/deployment.md), [public releases](operations/public-releases.md), and [native/extension](operations/native-and-extension.md) describe release surfaces.
- [Security runtime](architecture/security-runtime.md), [Firefly integration](architecture/firefly-integration.md), and [sharp edges](operations/sharp-edges.md) capture boundaries and hazards.

## First commands

```bash
npm ci
ch5-svc up
ch5-svc status
npm run runtime-config:check
npm run format:check
npm run test:changed -- --since hq/main
```

Use `ch5-svc down` to stop only this repository's services. Do not guess ports or use box-wide supervisor commands.

## Task routing

| Intent | Canonical page | Entry points/symbols | Focused test | Minimal validation |
|---|---|---|---|---|
| Change client startup or readiness | [Core lifecycle](architecture/core-lifecycle.md) | `packages/pwa/src/index.ts`, `App.load`, `App.loaded` | Cypress signup/login | `npm run test:changed -- --files <csv>` |
| Change auth or passkeys | [Authentication](architecture/authentication.md) | `packages/core/src/auth`, `packages/worker/src/server-factory.ts` | Worker auth flow; extension RP tests | focused auth runner and crypto parity |
| Change vault/org/API behavior | [Core domain/API](architecture/core-domain-api.md) | `packages/core/src/api.ts`, `Server.handle` | vault CRUD, multi-org, seat quota | relevant Worker runner |
| Change Worker route or request handling | [Worker transport](architecture/worker-transport.md) | `packages/worker/src/index.ts`, `WorkerReceiver` | transport roundtrip/error semantics | `npm --prefix packages/worker run test:transport-roundtrip` |
| Change persistence, attachments, locks, migrations | [Worker storage](architecture/worker-storage.md) | `D1Storage`, `R2AttachmentStorage`, `AccountLockDO` | lifecycle/session/migration proof | local migration plus focused runner |
| Change env, binding, or secret wiring | [Configuration](operations/configuration-and-secrets.md) | `config/*`, `wrangler.toml`, `src/env.ts` | runtime contract | `npm run runtime-config:check` |
| Change local services | [Local workflows](development/local-workflows.md) | `pitchfork.toml`, `ch5-svc` | service config test | `ch5-svc status` plus HTTP check |
| Change CI, build, or test lanes | [Testing](development/testing-and-proof.md) | `.forgejo/workflows/`, `package.json` | affected workflow/lane | `npm run format:check` and narrow lane |
| Deploy staging or production | [Deployment](operations/deployment.md) | `scripts/deploy-staging`, `scripts/deploy-production` | staging canaries | exact-SHA deployment command |
| Publish client artifacts | [Public releases](operations/public-releases.md) | `scripts/release/*`, release schema | manifest/download canary | manifest validate and canary |
| Change extension/native behavior | [Native and extension](operations/native-and-extension.md) | `packages/extension/src`, native entrypoints | extension harness/RP tests | `npm run test:extension` |
| Change Firefly boundary | [Firefly integration](architecture/firefly-integration.md) | `firefly-sso.ts`, `firefly-seat-sync.ts` | SSO/seat-sync E2E | relevant Worker runner |

## Backlog

No source area was intentionally deferred. Generated artifacts, dependency directories, fixtures, screenshots, and transient handoffs are excluded except where they define a current runtime or release boundary.
