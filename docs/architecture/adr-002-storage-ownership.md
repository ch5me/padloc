# ADR-002: Storage Ownership

**Status**: Accepted  
**Date**: 2026-05-04  
**Context**: Padloc Cloudflare-native backend migration

## Decision

Each Cloudflare storage product owns specific data domains. No data domain is
stored in multiple authoritative stores. KV is never the source of truth for any
domain.

## Storage Ownership Table

| Domain                                 | Store                                                   | Ownership Rule                                                                                                                                  |
| -------------------------------------- | ------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------- |
| Accounts / auth metadata               | D1                                                      | Authoritative. Multi-row writes use `db.batch([...])` for atomicity.                                                                            |
| Sessions                               | D1                                                      | Authoritative. Session row carries `revoked_at`, `expires_at`. Validation reads D1 every request -- no KV cache for session truth.              |
| Email verification codes               | D1                                                      | Code + expiry stored in D1. KV optional for rate-limit hints only.                                                                              |
| Vault metadata / encrypted payloads    | D1                                                      | Authoritative encrypted blob rows. Per-row size kept under D1 10 MB row cap. Oversized payloads spill to R2 with a D1 pointer row.              |
| Organization / member / group metadata | D1                                                      | Membership writes batched via `db.batch`. Cross-account reshare flows use Durable Object locks (T11, T17).                                      |
| Attachments (binary)                   | R2                                                      | Object key: `att/<vault_id>/<attachment_id>`. Lifecycle gated by D1 metadata -- write D1 first, R2 second, delete R2 first, D1 second.          |
| Attachment metadata                    | D1                                                      | Includes size, hash, R2 key, owning vault. Prevents orphan or ghost ambiguity.                                                                  |
| Per-account / per-org locks            | Durable Objects (`AccountLockDO`)                       | Replaces in-memory `_requestQueue` from `packages/core/src/server.ts:2188`. One DO id per `AccountID`, one per `OrgID`. Required, not optional. |
| Rate-limit hints                       | KV                                                      | Non-authoritative, safe to be stale. Auth bypass is impossible because D1 is the truth surface.                                                 |
| Provisioner state                      | None (StubProvisioner)                                  | Personal fork has no billing or SCIM. Stub returns permissive `Provisioning` for all accounts.                                                  |
| Logs / audit events                    | D1 (security-critical), Cloudflare Logs / Logpush (ops) | `change_log`, `request_log` in D1 with configurable retention. Ops and debug data go to Workers Logs.                                           |

## Current Config Mapping

The existing `packages/server/src/config.ts` defines these backends that must be
replaced:

| Current Config Class      | Current Backends                             | Cloudflare Replacement |
| ------------------------- | -------------------------------------------- | ---------------------- |
| `DataStorageConfig`       | `leveldb`, `mongodb`, `postgres`             | D1                     |
| `AttachmentStorageConfig` | `fs`, `s3`                                   | R2                     |
| `LoggingConfig`           | `mongodb`, `postgres`, `leveldb`, `mixpanel` | D1 + CF Logs           |
| `ProvisioningConfig`      | `basic`, `directory`, `stripe`, `oauth`      | StubProvisioner        |
| `DirectoryConfig`         | `scim`                                       | Deferred               |
| `AuthConfig`              | `email`, `webauthn`, `totp`, `oauth`         | D1 + DO + Resend       |

## Rules

1. **D1 is authoritative for all metadata.** Sessions, accounts, vaults,
   organizations, and attachment metadata all live in D1 as the single source of
   truth.

2. **R2 owns binary attachments only.** R2 never holds metadata without a
   corresponding D1 row. The D1 `attachments` table gates the R2 object
   lifecycle.

3. **KV is advisory only.** Rate-limit counters, feature flags, and request
   deduplication tokens go in KV. Any system that skips D1 because it trusts KV
   alone is a security violation.

4. **Durable Objects own stateful coordination.** Per-account serialization
   locks, org-wide lockstep requests, and any cross-request consistency
   requirement goes through a DO.

5. **No cross-store authoritative reads.** When reading session validity, read
   D1. When reading attachment content, read R2 using a key from D1. Never
   decide truth from two stores.

## Consequences

### Positive

-   Clear ownership eliminates stale-cache security bugs.
-   D1 batched writes provide transactional guarantees that individual writes
    cannot.
-   DO locks replace the fragile in-memory `_requestQueue` that breaks on server
    restart or multi-instance deploys.

### Negative

-   D1 write throughput limits mean heavy vault operations must be batched.
-   KV rate-limit hints can drift from the truth surface, causing false
    positives under high load.
-   DO introduces per-DO serialization, so a single account making thousands of
    concurrent requests sees them queued.

## References

-   `packages/server/src/config.ts`
-   `.sisyphus/plans/padloc-cloudflare-native-backend.md` lines 334-348
