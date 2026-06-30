# Padloc Cloudflare Fork Strategy

## Overview

This document defines how the private Cloudflare-native fork of Padloc relates
to the upstream `padloc/padloc` repository, what features are deferred or
dropped, and how to stay rebase-friendly or intentionally diverge.

## Feature Disposition Matrix

All 39 API handlers from `packages/core/src/api.ts` are classified:

### Implemented (v1) — 39/39

Every API handler is implemented in the Worker backend:

| Category       | Methods                                                                                                                                       |
| -------------- | --------------------------------------------------------------------------------------------------------------------------------------------- |
| **Account**    | `createAccount`, `getAccount`, `updateAccount`, `deleteAccount`, `changeEmail`, `recoverAccount`, `getAuthInfo`, `updateAuth`, `listAccounts` |
| **Session**    | `startCreateSession`, `completeCreateSession`, `revokeSession`                                                                                |
| **Vault**      | `createVault`, `getVault`, `updateVault`, `deleteVault`                                                                                       |
| **Org**        | `createOrg`, `getOrg`, `updateOrg`, `deleteOrg`                                                                                               |
| **Invite**     | `getInvite`, `acceptInvite`                                                                                                                   |
| **Attachment** | `createAttachment`, `getAttachment`, `deleteAttachment`                                                                                       |
| **KeyStore**   | `createKeyStoreEntry`, `getKeyStoreEntry`, `deleteKeyStoreEntry`                                                                              |
| **MFA**        | `startRegisterAuthenticator`, `completeRegisterAuthenticator`, `deleteAuthenticator`, `removeTrustedDevice`                                   |
| **Auth**       | `startAuthRequest`, `completeAuthRequest`                                                                                                     |
| **Migration**  | `getLegacyData`, `deleteLegacyAccount`                                                                                                        |
| **Audit**      | `listChangeLogEntries`, `listRequestLogEntries`, `listOrgs`                                                                                   |

### Deferred (post-v1)

| Feature                    | Upstream Source                              | Rationale                                       | Follow-up                             |
| -------------------------- | -------------------------------------------- | ----------------------------------------------- | ------------------------------------- |
| **Stripe billing**         | `packages/server/src/provisioning/stripe.ts` | Personal fork — no billing needed               | Drop permanently unless multi-tenant  |
| **SCIM provisioning**      | `packages/server/src/scim.ts`                | Enterprise feature, not needed for personal use | Drop permanently                      |
| **OAuth/SAML SSO**         | `packages/server/src/auth/oauth.ts`          | Personal fork — no SSO needed                   | Drop permanently                      |
| **Admin dashboard**        | PWA admin routes                             | No admin UI needed for single-user              | Drop permanently                      |
| **Product analytics**      | Mixpanel/PostHog                             | Privacy-first password manager — no analytics   | Drop permanently                      |
| **Email templates (SMTP)** | `packages/server/src/email/smtp.ts`          | Replaced by Resend (T10/T16)                    | Kept in core for client compatibility |

### Dropped

| Feature                          | Rationale                                 |
| -------------------------------- | ----------------------------------------- |
| **Node.js server**               | Replaced by Cloudflare Worker (T6-T12)    |
| **LevelDB storage**              | Replaced by D1 (T8/T14)                   |
| **Postgres storage**             | Replaced by D1 (T8/T14)                   |
| **MongoDB storage**              | Replaced by D1 (T8/T14)                   |
| **S3 attachments**               | Replaced by R2 (T9/T15)                   |
| **Local filesystem attachments** | Replaced by R2 (T9/T15)                   |
| **Nodemailer SMTP**              | Replaced by Resend (T10/T16)              |
| **`nodejs_compat` fallback**     | Explicitly forbidden — Worker-native only |

## Fork Strategy

### Approach: Upstream-Rebase-Friendly

The private fork maintains compatibility with upstream `padloc/padloc` by:

1. **`packages/core` is untouched** — all core types, API definitions, crypto
   contracts, and transport interfaces remain identical to upstream. This means
   `packages/core` can be rebased from upstream without conflicts.

2. **`packages/worker` is a new package** — the Cloudflare Worker backend lives
   in its own package directory. No modifications to `packages/server` are
   required for the Worker to function.

3. **`packages/pwa` and `packages/cordova` are untouched** — clients point at
   the Worker via `PL_SERVER_URL` build-time env var. No client code changes.

4. **`packages/server` is preserved but unused** — the Node.js server remains in
   the repo for reference and potential fallback, but is not deployed.

### Branch Strategy

```
upstream/padloc:main
    │
    ├── packages/core/      ← rebased from upstream (no local changes)
    ├── packages/server/    ← preserved but unused
    ├── packages/pwa/       ← preserved, PL_SERVER_URL points to Worker
    ├── packages/cordova/   ← preserved, same as PWA
    │
    └── packages/worker/    ← NEW: Cloudflare Worker backend (local only)
```

### Rebase Procedure

When upstream releases a new version:

```bash
# 1. Fetch upstream
git fetch upstream main

# 2. Rebase core (should be clean — no local changes)
git rebase upstream/main -- packages/core

# 3. Resolve any conflicts in packages/core (expected: none)
# 4. Verify Worker still builds
cd packages/worker && npx wrangler deploy --dry-run --env=dev

# 5. Run proof lanes
npm run proof:all
```

### Intentional Divergence Points

The following areas intentionally diverge from upstream:

| Area              | Upstream               | Fork                   | Impact                           |
| ----------------- | ---------------------- | ---------------------- | -------------------------------- |
| **Runtime**       | Node.js 16.x           | Cloudflare Workers     | No Node imports in Worker path   |
| **Storage**       | LevelDB/Postgres/Mongo | D1 (SQLite)            | Blob-shaped data in TEXT columns |
| **Attachments**   | fs/S3                  | R2                     | Signed URL path for large files  |
| **Email**         | SMTP/nodemailer        | Resend API             | Fetch-based, no SMTP             |
| **Locking**       | In-memory Map          | Durable Objects        | Cross-request serialization      |
| **Rate limiting** | None                   | KV-backed token bucket | Per-identity throttling          |
| **Deployment**    | Docker/DigitalOcean    | Wrangler/Cloudflare    | CLI-only, no dashboard           |

## Compatibility-Breaking Changes

The following changes break compatibility with the upstream Node.js server:

1. **D1 blob storage** — vault data stored as JSON in TEXT columns, not native
   JSONB. Clients are unaffected (they send/receive encrypted blobs).

2. **R2 attachment keys** — key scheme `att/<vault_id>/<attachment_id>` differs
   from S3 key patterns. Clients are unaffected (they use attachment IDs).

3. **Resend email templates** — template variable format matches upstream HTML
   templates. No client impact.

4. **Durable Object locking** — replaces in-memory `_requestQueue`. Behavior is
   identical (per-account/per-org serialization), but implementation differs.

5. **No `nodejs_compat`** — the Worker does not use Node.js compatibility flags.
   All code is Web Standard / Worker-native.

## Future Implementation Notes

### If Multi-Tenant Becomes Desired

-   Stripe billing can be added via `packages/worker/src/provisioning/stripe.ts`
    using Resend for receipt emails
-   SCIM provisioning would require a new Worker route
-   OAuth/SAML would need Cloudflare Access integration

### If Upstream Adds New Features

-   New API handlers in `packages/core/src/api.ts` will be automatically
    detected by the contract inventory script (`scripts/inventory-api.ts`)
-   Each new handler needs a disposition: `implemented`, `deferred`, or
    `dropped`
-   Run `npm run proof:contract` to detect drift

## Evidence

-   API inventory: `.sisyphus/contract/api-inventory.json` (39 handlers, 0
    unknown)
-   Feature scope matrix: `docs/architecture/adr-*` files
-   All deferred features have explicit rationale above
-   No "maybe later" entries without owner/status
