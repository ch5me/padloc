# ADR-003: Feature Scope v1

**Status**: Accepted  
**Date**: 2026-05-04  
**Context**: Padloc Cloudflare-native backend migration

## Decision

The Feature Scope Matrix defines what ships in v1 of the Cloudflare-native
backend. Every feature area is classified as Required, Defer, or Drop. No
entries remain ambiguous.

## Feature Scope Matrix

| Feature Area                 | v1 Status             | Notes                                                                                                                                        |
| ---------------------------- | --------------------- | -------------------------------------------------------------------------------------------------------------------------------------------- |
| Account create/login/session | Required              | Preserve current client flow. Account creation, login, and session management map to D1 with DO coordination.                                |
| Vault CRUD/sync              | Required              | Must work from PWA. Vault encrypted payloads go to D1 (or R2 for oversized payloads per ADR-002).                                            |
| Organizations/shared vaults  | Required-core         | Implement existing client-visible organization and shared-vault API paths. Defer enterprise admin and SCIM extensions.                       |
| Attachments                  | Required              | R2 backend. Explicit max size and orphan cleanup. D1 metadata table gates R2 object lifecycle.                                               |
| Email verification/invites   | Required              | Resend API for email delivery. Codes and expiry stored in D1.                                                                                |
| TOTP                         | Required              | Password-manager replacement and MFA parity. Client-side TOTP generation, server-side validation via D1 account records.                     |
| WebAuthn                     | Required-parity-gated | Must pass parity proof. If library incompatibility blocks implementation, produce explicit client-safe deferral ADR before merging.          |
| OAuth auth/provisioning      | Defer                 | Avoid scope explosion. No OAuth login or OAuth-based provisioning in v1.                                                                     |
| SCIM/directory provisioning  | Defer                 | Enterprise feature. SCIM endpoints exist as stubs in `packages/server/src/scim`, but are not active in v1.                                   |
| Stripe/billing               | Drop                  | Private fork does not need commercial billing. Stripe config and provisioner removed from worker bundle.                                     |
| Mixpanel/analytics           | Drop                  | Prefer Cloudflare Logs and observability for debugging. Mixpanel instrumentation removed from worker pipeline.                               |
| GeoIP local DB               | Drop                  | No local GeoIP database in the worker. Use Cloudflare request metadata (`cf.country`, `cf.asOrganization`) later if needed.                  |
| Legacy v3 migration          | Defer                 | Migration fixtures required now for test data. Full real-data importer only after source data format is confirmed from legacy v3 deployment. |

## Scope Decisions Explained

### Dropped (v1)

**Stripe/billing**: This is a private or self-hosted fork. No one paying through
a SaaS billing portal. The Stripe provisioner, price tables, checkout flows, and
webhook handlers from `packages/server/src/provisioning/stripe` are excluded
from the worker bundle entirely. If billing becomes necessary later, it ships as
a standalone addition with its own ADR.

**Mixpanel/analytics**: Mixpanel event logging from
`packages/server/src/logging/mixpanel` goes away. Request-level debugging uses
Cloudflare Workers Logs. Product analytics (if needed later) would use
Cloudflare Logpush to an analytics destination, not an inline Mixpanel HTTP call
per request.

**GeoIP local DB**: No MaxMind or GeoIP2 binary shipped into the worker bundle.
Cloudflare already provides `request.cf.country` and `request.cf.asOrganization`
in the request context. If IP-based rate limiting by region is needed, it uses
CF metadata.

### Deferred

**OAuth auth/provisioning**: Login via Google, GitHub, Microsoft, or any
third-party IdP is deferred. The `OauthConfig` and `OauthProvisionerConfig`
classes from `packages/server/src/config.ts` are not wired in v1. The
`AuthConfig.types` array ships with `Email` and `Totp` only.

**SCIM/directory provisioning**: The `ScimServerConfig` and
`DirectoryConfig.providers` array (which defaults to `["scim"]`) are stubbed.
Enterprise directory sync for Okta, Azure AD, or similar providers waits until
someone explicitly needs it.

**Legacy v3 migration**: Test data fixtures are sufficient for v1 development. A
full migration tool that reads live v3 D1/MongoDB/LevelDB data and transforms it
for the new Cloudflare backend requires confirming the exact v3 data format
first. This is deferred until a real legacy instance is targeted.

### Required-Parity-Gated

**WebAuthn**: WebAuthn is required for feature parity with v4, but has a safety
valve. If the WebAuthn library imports a Node.js-only dependency that cannot run
on Workers (e.g., `crypto` module patterns not compatible with Web Crypto API),
an explicit client-safe deferral ADR must be created before merging v1. This is
not an automatic deferral -- it requires a blocking analysis.

## Current Config Classifications That Change

From `packages/server/src/config.ts`:

| Current Path                            | v1 Status | Action                             |
| --------------------------------------- | --------- | ---------------------------------- |
| `auth.oauth` / `OauthConfig`            | Defer     | Not wired into worker auth handler |
| `provisioning.stripe`                   | Drop      | Removed from worker bundle         |
| `provisioning.oauth`                    | Defer     | Not wired                          |
| `directory.scim` / `ScimServerConfig`   | Defer     | Stubbed, active endpoints disabled |
| `logging.mixpanel`                      | Drop      | Removed from worker bundle         |
| `data.backend` (leveldb/mongo/postgres) | Replaced  | Mapped to D1 per ADR-002           |
| `attachments.backend` (fs/s3)           | Replaced  | Mapped to R2 per ADR-002           |
| `email.backend` (smtp/console)          | Replaced  | Mapped to Resend API               |

## References

-   `.sisyphus/plans/padloc-cloudflare-native-backend.md` lines 312-328
-   `packages/server/src/config.ts`
