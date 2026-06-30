# Padloc Testing Lanes — Cloudflare Backend

This document defines the verification lanes for the Cloudflare-native backend
migration.

Each lane proves a specific contract, has a clear command to run, and documents
required environment.

## Lane Reference

| Lane      | Command                   | CI Gate? | Status                         |
| --------- | ------------------------- | -------- | ------------------------------ |
| Contract  | `npm run proof:contract`  | Yes      | Gap (T1 inventory pending)     |
| Crypto    | `npm run proof:crypto`    | Yes      | Gap (T2 crypto parity pending) |
| Worker    | `npm run proof:worker`    | Yes      | Gap (T6 Worker impl pending)   |
| Client    | `npm run proof:client`    | Manual   | Gap (requires deployed Worker) |
| Migration | `npm run proof:migration` | Yes      | Gap (T8 migration pending)     |

## Lane Details

### proof:contract

**What it proves**: All planned Cloudflare Worker API methods have explicit
dispositions (implemented, deferred, or rejected). No method is left unaccounted
for.

**Command**: `npm run proof:contract`

**Evidence**: Exit 0 with summary showing 0 undispositioned methods.

**Required env**: None (static analysis).

**Known gaps**:

-   Depends on T1 inventory script
    (`scripts/proof-lanes/inventory-api-methods.sh`).
-   Dispositions file (`.sisyphus/outputs/api-method-dispositions.json`) must be
    maintained as implementation progresses.

### proof:crypto

**What it proves**: `@padloc/core` crypto primitives are compatible with
Cloudflare Workers runtime (subtlecrypto API, argon2id availability,
HMAC-SHA256).

**Command**: `npm run proof:crypto`

**Evidence**: Exit 0 with all crypto test suites passing.

**Required env**: `NODE_ENV=test`

**Known gaps**:

-   Argon2id may not be available in Workers runtime — may need WebAssembly
    polyfill or alternative KDF.
-   Core crypto tests currently target Node.js runtime; Worker-specific crypto
    parity tests need T2 implementation.

### proof:worker

**What it proves**: The Worker package deploys successfully to Cloudflare's edge
and responds to health checks.

**Command**: `npm run proof:worker`

**Evidence**: Exit 0 with `wrangler deploy --dry-run` passing and health
endpoint returning 200.

**Required env/bindings**:

-   `CLOUDFLARE_API_TOKEN` — Account-scoped token with Workers Write permission
-   `CLOUDFLARE_ACCOUNT_ID` — Pinned in wrangler.jsonc or set as env var

**Known gaps**:

-   Full health endpoint requires T6 Worker implementation (Server, Controller,
    transport).
-   D1/R2/Resend dependency checks require T7-T9 binding configurations.
-   Uses `--dry-run` for initial validation; final proof requires actual
    `wrangler deploy` to a staging project.

### proof:client

**What it proves**: The PWA client builds successfully and can communicate with
the deployed Worker backend.

**Command**: `npm run proof:client`

**Evidence**: Exit 0 with PWA build succeeding and health endpoint at
`PL_SERVER_URL/healthcheck` returning 200.

**Required env**:

-   `PL_SERVER_URL` — Deployed Worker URL (optional; omitting skips connectivity
    check with exit 2)
-   `NODE_ENV=production` — Ensures production build paths

**Known gaps**:

-   Requires Worker to be deployed first (blocks on `proof:worker`).
-   PWA client rebuild requires `PL_SERVER_URL` baked in at build time.
-   Full E2E with authentication requires T12+ implementation.

### proof:migration

**What it proves**: D1 migration SQL files are syntactically valid and
compatible with Cloudflare D1 (SQLite).

**Command**: `npm run proof:migration`

**Evidence**: Exit 0 with all SQL files passing `wrangler d1 execute --dry-run`.

**Required env/bindings**:

-   `CLOUDFLARE_API_TOKEN` — For wrangler D1 operations
-   `MIGRATIONS_DIR` — Optional, defaults to `packages/worker/migrations`

**Known gaps**:

-   Depends on T8 migration implementation for SQL fixture files.
-   `PRAGMA foreign_keys=OFF` is incompatible with D1; migrations must use
    `PRAGMA defer_foreign_keys=on`.
-   No automatic rollback support; manual backup/export required before
    production apply.

## Pre-Deploy Gate

All stable lanes must pass before deploying to staging:

```bash
npm run typecheck
npm run test
npm run proof:contract
npm run proof:crypto
npm run proof:worker
npm run proof:migration
```

For full local proof including client connectivity:

```bash
PL_SERVER_URL=https://your-worker.your-subdomain.workers.dev npm run proof:client
```

## Running All Lanes

```bash
npm run proof:all
```

Note: This requires all env variables to be set. Individual lanes can be run
separately with `SKIP` outcomes for missing dependencies.
