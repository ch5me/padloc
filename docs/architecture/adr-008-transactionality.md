# ADR-008: Transactionality and Consistency Requirements

**Status**: Accepted **Date**: 2026-05-04 **Task**: T11 **Plan**:
`.sisyphus/plans/padloc-cloudflare-native-backend.md` §1192–1284

## Problem

The current server (`packages/core/src/server.ts:2188`) serializes per-account
and per-org request handling via an in-memory `Map`:

```typescript
private _requestQueue = new Map<AccountID | OrgID, Promise<void>>();
```

In a stateless Cloudflare Worker deployment, this per-isolate `Map` is **not
shared** across invocations. Two concurrent requests touching the same account
(or overlapping orgs) would execute in parallel, breaking the mutual-exclusion
guarantee the product was written against.

### Evidence: Current Implementation

`server.ts:2237–2257` — `_addToQueue`:

```typescript
for (const { id } of [account, ...account.orgs]) {
    const promise = this._requestQueue.get(id);
    if (promise) {
        promises.push(promise);
    }
    this._requestQueue.set(
        id,
        new Promise((resolve) => resolveFuncs.push(resolve)),
    );
}
await Promise.all(promises);
return () => resolveFuncs.forEach((resolve) => resolve());
```

This pattern:

1. Iterates `[account, ...account.orgs]` in identity order
2. Chains onto any existing deferred promise per identity
3. Replaces the queued promise with a new placeholder
4. Returns a resolver invoked in `finally` after `controller.process(req)`

In a multi-Worker world, this in-memory chain is lost.

## Decision

### Consistency Owner: Durable Object `AccountLockDO`

Replace the in-memory `_requestQueue` with a single Durable Object class
`AccountLockDO`, keyed by identity string (`AccountID` or `OrgID`). **One DO
class, one DO instance per identity.**

The Worker acquires the lock for `account.id` plus each `org.id` in
`account.orgs` before calling `controller.process(req)` and releases on
completion. This preserves the existing 1:1 semantics.

### Lock Acquisition Order: Sorted ID Order

To prevent deadlocks when two concurrent requests both touch overlapping
identities (e.g., request A touches `[account_A, org_X]` and request B touches
`[account_B, org_X]`), locks **must** be acquired in **sorted ID order** across
the full set `[account.id, ...account.orgs.map(o => o.id)]`.

```typescript
const ids = [account.id, ...account.orgs.map((o) => o.id)].sort();
for (const id of ids) {
    await acquireLock(id); // via AccountLockDO
}
```

This is equivalent to the classic "acquire resources in fixed global order"
deadlock prevention strategy. The current Node server iterates in declaration
order (account first, then orgs) which is de-facto sorted by insertion but not
guaranteed — the Cloudflare migration makes this explicit and deterministic.

### KV is Forbidden as Consistency Owner

KV is **explicitly forbidden** from the consistency owner column. The single
source of truth (SSOT) for all authoritative state is D1. KV is only permitted
for:

- **Hint-only**: rate-limit counters, ephemeral cache entries
- **Performance optimization**: reducing cold-start cache misses
- **Non-critical observability**: request counting, session presence hints

**Never use KV as the authoritative store for:** auth records, session records,
vault state, org membership, account data, or attachment metadata.

## Multi-Write Flows: Consistency Map

### Flow 1: `createAccount`

| Aspect               | Detail                                                                                                                                                     |
| -------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Writes**           | `accounts` table, `auth` table, `email_verifications` table                                                                                                |
| **Consistency Lock** | DO lock per email-derived identity (pre-account ID derived from the invitation/verification token)                                                         |
| **Atomicity**        | `db.batch()` across all three tables in a single D1 transaction                                                                                            |
| **Failure Behavior** | D1 transaction rolls back all writes if any statement fails. DO lock released on completion. Provisioner hook called post-batch (non-critical, retriable). |
| **KV Usage**         | **None.** Email verification tokens stored in D1 `email_verifications` only.                                                                               |

### Flow 2: `completeCreateSession`

| Aspect               | Detail                                                                                                                                                            |
| -------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Writes**           | `sessions` table (insert), `auth` table (read for verification)                                                                                                   |
| **Consistency Lock** | DO lock per `account.id`                                                                                                                                          |
| **Atomicity**        | `db.batch()` — sessions insert + auth read within same transaction to prevent TOCTOU race on session limit checks                                                 |
| **Failure Behavior** | Rollback on D1 failure. DO lock released. No KV fallback for session truth.                                                                                       |
| **KV Usage**         | **None forbidden.** Session presence hints in KV optional (for dashboard "active sessions" display) but never authoritative. The D1 `sessions` table is the SSOT. |

### Flow 3: `revokeSession`

| Aspect               | Detail                                                                                                                                                                         |
| -------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| **Writes**           | `sessions` table (single UPDATE — `expires = NOW()` or `deleted`)                                                                                                              |
| **Consistency Lock** | DO lock per `account.id`                                                                                                                                                       |
| **Atomicity**        | Single statement (implicitly atomic in D1)                                                                                                                                     |
| **Failure Behavior** | Retry on transient D1 error. DO lock released. If D1 succeeds but response fails to client, client retries are idempotent (revocation is a no-op on already-revoked sessions). |
| **KV Usage**         | **None.**                                                                                                                                                                      |

### Flow 4: `updateAuth`

| Aspect               | Detail                                                                                                                            |
| -------------------- | --------------------------------------------------------------------------------------------------------------------------------- |
| **Writes**           | `auth` table (key rotation, password change, 2FA enable/disable)                                                                  |
| **Consistency Lock** | DO lock per `account.id`                                                                                                          |
| **Atomicity**        | `db.batch()` — may involve auth record update + session audit log entry                                                           |
| **Failure Behavior** | Full rollback on failure. DO lock released. Old auth credentials remain valid until new write succeeds (no partial key rotation). |
| **KV Usage**         | **None.**                                                                                                                         |

### Flow 5: `createOrg` / `updateOrg` / `deleteOrg`

| Aspect               | Detail                                                                                                                                      |
| -------------------- | ------------------------------------------------------------------------------------------------------------------------------------------- |
| **Writes**           | `orgs` table, `org_members` table, `vaults` table (pointer cleanup on delete)                                                               |
| **Consistency Lock** | DO lock per `org.id`                                                                                                                        |
| **Atomicity**        | `db.batch()` across affected tables                                                                                                         |
| **Failure Behavior** | Rollback all writes on failure. DO lock released. For `deleteOrg`, vault pointer cleanup runs in same batch — no orphaned vault references. |
| **KV Usage**         | **None.** Org membership truth in D1 only.                                                                                                  |

### Flow 6: `acceptInvite`

| Aspect                  | Detail                                                                                                                                                                                                |
| ----------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Writes**              | `org_members` table (insert), `invites` table (consume/delete), `vaults` table (accessor assignment)                                                                                                  |
| **Consistency Lock**    | DO lock per **both** `org.id` AND `account.id`, acquired in **sorted ID order**                                                                                                                       |
| **Acquisition Order**   | `const ids = [accountId, orgId].sort();` then acquire each in sequence                                                                                                                                |
| **Atomicity**           | `db.batch()` — member insert + invite consume + vault assignment in single D1 transaction                                                                                                             |
| **Failure Behavior**    | Rollback all writes. Both DO locks released. If invite was consumed by a concurrent request, this request fails with `INVITE_ALREADY_USED` (detected at DB level via unique constraint on invite ID). |
| **KV Usage**            | **None.**                                                                                                                                                                                             |
| **Deadlock Prevention** | Sorted ID ordering ensures that concurrent accepts for the same account-to-same-org always acquire locks in the same order. The invite consume is the linearization point.                            |

### Flow 7: `createVault` / `updateVault`

| Aspect               | Detail                                                                                                                                                                         |
| -------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| **Writes**           | `vaults` table (insert or update)                                                                                                                                              |
| **Consistency Lock** | DO lock per vault **owner** identity (`account.id` for private vaults, `org.id` for shared vaults)                                                                             |
| **Atomicity**        | Single D1 statement (implicitly atomic)                                                                                                                                        |
| **Failure Behavior** | Retry on transient error. DO lock released. `updateVault` uses `revision` field for optimistic concurrency — if revision mismatch, client receives conflict and must re-fetch. |
| **KV Usage**         | **None.**                                                                                                                                                                      |

### Flow 8: `createAttachment`

| Aspect               | Detail                                                                                                                     |
| -------------------- | -------------------------------------------------------------------------------------------------------------------------- |
| **Writes**           | D1 `attachments` table (metadata), R2 bucket (binary blob)                                                                 |
| **Consistency Lock** | DO lock per vault owner (same as vault — determines who can write)                                                         |
| **Write Order**      | **D1 metadata write FIRST, then R2 PUT**.                                                                                  |
| **Atomicity**        | **Non-transactional** (cross-store: D1 + R2).                                                                              |
| **Failure Behavior** | **On R2 failure: roll back D1 row.** Delete the just-inserted attachment metadata record. On D1 failure: skip R2 entirely. |
| **Compensation**     | If R2 fails after D1 succeeds (shouldn't with correct ordering), the D1 rollback removes the orphan metadata.              |
| **KV Usage**         | **None.** Attachment metadata in D1, blobs in R2.                                                                          |

### Flow 9: `deleteAttachment`

| Aspect                                                                                                                                                                                                                                                                                                                                                                         | Detail                                                                                                                                                                                                                    |
| ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Writes**                                                                                                                                                                                                                                                                                                                                                                     | R2 bucket (DELETE binary blob), D1 `attachments` table (DELETE metadata row)                                                                                                                                              |
| **Consistency Lock**                                                                                                                                                                                                                                                                                                                                                           | DO lock per vault owner                                                                                                                                                                                                   |
| **Write Order**                                                                                                                                                                                                                                                                                                                                                                | **R2 DELETE first, then D1 DELETE.** This ensures that if D1 fails, the blob is already gone and we record the orphan rather than leaving a dangling pointer.                                                             |
| **Atomicity**                                                                                                                                                                                                                                                                                                                                                                  | **Non-transactional** (cross-store: D1 + R2)                                                                                                                                                                              |
| **Failure Behavior**                                                                                                                                                                                                                                                                                                                                                           | **On D1 failure after R2 DELETE: record orphan.** Write the attachment ID to a `orphaned_attachments` table (or equivalent tombstone). A scheduled cron job sweeps the orphan table and verifies R2 blobs are truly gone. |
| **Why R2-first:** If we deleted D1 first and R2 failed, the metadata would point to a blob that still exists — a "ghost reference." If we delete R2 first and D1 fails, the blob is gone but we have a record in the D1 table pointing at nothing — the orphan table captures this for cleanup. Both failure modes are recoverable, but ghost references are harder to detect. |
| **KV Usage**                                                                                                                                                                                                                                                                                                                                                                   | **None.**                                                                                                                                                                                                                 |

### Flow 10: `deleteAccount`

| Aspect               | Detail                                                                                                                                                                                                                                   |
| -------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Writes**           | D1 cascading deletes (`accounts`, `auth`, `sessions`, `vaults`, `org_members`, `attachments`), R2 prefix delete (all attachment blobs for user's vaults), Provisioner hook (external system cleanup)                                     |
| **Consistency Lock** | DO lock per `account.id`                                                                                                                                                                                                                 |
| **Atomicity**        | `db.batch()` for all D1 cascading deletes. R2 and Provisioner runs post-batch.                                                                                                                                                           |
| **Write Order**      | 1. Acquire DO lock. 2. `db.batch()` all D1 cascades. 3. R2 prefix delete. 4. Provisioner hook.                                                                                                                                           |
| **Failure Behavior** | D1 batch rollbacks entirely on failure. If R2 fails after D1 succeeds, a background cron detects orphaned blobs (no matching D1 attachment records). If Provisioner fails, the hook is retriable — account is logically deleted already. |
| **KV Usage**         | **None.**                                                                                                                                                                                                                                |

## Lock Acquisition Architecture

```
                    ┌─────────────────────────────────┐
                    │      Cloudflare Worker           │
                    │                                  │
                    │  1. Extract account.id           │
                    │  2. Extract account.orgs[].id    │
                    │  3. Sort all ids                 │
                    │  4. For each id:                 │
                    │     → stubFromId(id).fetch(lock) │
                    └──────────────┬──────────────────┘
                                   │
                    ┌──────────────▼──────────────────┐
                    │  AccountLockDO (one class)      │
                    │                                  │
                    │  - Internal mutex (Promise)     │
                    │  - await → process → release    │
                    │  - keyed by AccountID/OrgID      │
                    └──────────────┬──────────────────┘
                                   │
                    ┌──────────────▼──────────────────┐
                    │  controller.process(req)         │
                    │  (business logic, db.batch)      │
                    └──────────────────────────────────┘
```

### Why one DO class

- **Bounded scope**: One class means one deployment unit, one billing surface,
  simpler testing
- **No per-flow DOs**: `SessionLockDO`, `OrgLockDO`, `VaultLockDO` are
  anti-patterns — they multiply DO instances, increase cold starts, and make
  ordering harder
- **Keyed by identity**: The DO stub is created with
  `env.ACCOUNT_LOCK_DO.new(env.ACCOUNT_LOCK_DO.idFromName(id))`, giving one
  instance per unique `AccountID` or `OrgID`
- **Internal stateless lock**: The DO maintains an in-memory `Promise<void>`
  chain (same pattern as the current Node `_requestQueue`), but now shared
  across all Workers that route to this DO

## KV Anti-Pattern: What NOT to Do

```
FORBIDDEN:  KV put("session:" + id, sessionData) ← session truth
FORBIDDEN:  KV put("vault:" + id, vaultData)      ← vault state
FORBIDDEN:  KV put("org:" + id, orgData)          ← org membership
FORBIDDEN:  KV put("auth:" + id, authData)        ← auth credentials

ALLOWED:    KV put("rate:account:" + id, count)   ← rate limit hint
ALLOWED:    KV get("cache:vault:" + id)           ← ephemeral cache
ALLOWED:    KV put("presence:" + id, ts)          ← session presence hint
```

## Related ADRs

- **ADR-001**: Cloudflare-native backend migration
- **ADR-006**: D1 as primary storage
- **ADR-007**: R2 for attachment storage
