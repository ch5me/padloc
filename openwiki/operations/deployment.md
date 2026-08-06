---
type: release operations
title: Deployment and promotion
description: Staging deployment, exact-SHA production promotion, migrations, canaries, workflow gates, and rollback boundaries.
tags: [deployment, staging, production, ci]
---
# Deployment and Promotion

Staging is deployed with `npm run deploy:staging` after Hush setup; the script requires a full SHA, validates runtime configuration, applies staging D1 migrations, deploys the Worker with SHA release metadata, builds the PWA with staging URLs, deploys Pages, and canaries API/PWA health. Production is human-gated through `.forgejo/workflows/promote-production.yml` or `PADLOC_DEPLOY_SHA=<sha> bash scripts/deploy-production`.

Production rejects missing/short/stale/arbitrary SHAs. The candidate must equal the checked-out current `main` commit and have passed staging health checks with the same SHA. Promotion applies production migrations, deploys Worker and Pages, then checks `/healthcheck` and the public app. Migrations are forward-only; rollback uses a new corrective migration and deployment, not destructive history editing.

Forgejo workflows are the operational authority for exact-SHA checks, Hush use, approvals, artifacts, and canaries. Existing legacy docs describing direct Wrangler login are not equivalent to the Hush contract. Production deployment rebuilds Worker and PWA from the exact checkout rather than promoting one combined immutable artifact.
