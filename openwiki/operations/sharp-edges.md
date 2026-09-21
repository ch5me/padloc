---
type: operational cautions
title: Sharp edges and invariants
description: Non-obvious rules that prevent unsafe local development, deployment, auth, build, and release changes.
tags: [operations, hazards, invariants]
---
# Sharp Edges and Invariants

- Use `ch5-svc status` and HTTP liveness, not TCP readiness; the PWA web service can accept connections while serving no bundle.
- Build the PWA with explicit `PL_SERVER_URL` and keep `clientUrl` on the app host, never the API host.
- Worker email throws when `RESEND_API_KEY` or `EMAIL_FROM_ADDRESS` is missing. Explicit `EMAIL_BACKEND=mock` is development/test/local only; live environments refuse mock at boot.
- D1 sessions are authoritative; KV is only hints/idempotency/rate state. Do not add KV-based auth validity.
- Migrations are forward-only. D1/R2 attachment operations use compensating cleanup and can create orphan records.
- Platform setup must precede app import; `App.loaded` gates route dispatch and background sync.
- Do not use `process.env.PL_APP_NAME` in Worker/shared runtime code; Workers do not provide `process`.
- Email templates are generated from `assets/email/*`; regenerate `packages/worker/src/email/templates.ts` after copy changes.
- Binding changes require stage token scope updates. Never create plaintext secret files or document values.
- Do not treat native/passkey build success as release-complete proof; consult the support matrix and verification gates.

Repository policy says not to create pull requests for normal work, while the OpenWiki GitHub workflow creates an update PR; treat that as an explicit automation exception requiring owner reconciliation.
