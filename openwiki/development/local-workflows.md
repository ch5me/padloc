---
type: development guide
title: Local development workflows
description: Node setup, repository-local services, dynamic URLs, PWA/Worker operation, and readiness diagnostics.
tags: [development, local, services]
---
# Local Development Workflows

Use Node 24 and npm 11 as declared by `.nvmrc` and package engines. Install with `npm ci`. The normal service front door is `ch5-svc`, backed by `pitchfork.toml`: `ch5-svc up`, `ch5-svc status`, `ch5-svc logs <name>`, and `ch5-svc down`. Services are `api`, `web`, `v3`, `maildev`, and `tauri`; status output is authoritative for dynamic per-tree URLs.

The Worker runs Wrangler local dev with `npm run worker:dev`; the PWA must be built with explicit `PL_SERVER_URL` and `PL_PWA_URL`. Local Worker defaults use mock email and disabled verification. `npm start` and `npm run dev` retain compatibility but should not replace the service supervisor.

The web service can be false-green: webpack middleware may accept TCP while never serving a bundle. Diagnose with `ch5-svc status` and an HTTP request, not port readiness or stale startup output. Never use `pitchfork stop --all`, guessed ports, hand-started persistent servers, or plaintext secret files.
