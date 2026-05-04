# ADR-006: R2 Attachment Lifecycle and Failure Semantics

**Status**: Accepted  
**Date**: 2026-05-04  
**Context**: Padloc Cloudflare-native backend migration — R2 attachment storage

---

## Decision

Adopt **backend-mediated attachment flow** as the primary contract, with a
**signed-URL upgrade path** for large files (>5 MB) to bypass Worker memory
limits. The backend is responsible for metadata management and orchestrating R2
operations. Clients receive either a backend-hosted proxy URL (small files) or a
time-limited signed R2 URL (large file direct-upload path).

---

## Object Key Scheme

```
att/<vault_id>/<attachment_id>
```

- `att/` is the R2 bucket prefix, separating attachments from any future bucket
  usage.
- `vault_id` provides partition isolation (no cross-vault enumeration).
- `attachment_id` is the Padloc-generated unique identifier.

**Constraint**: Characters must be URL-safe. Vault IDs and attachment IDs are
UUIDs / base64url — both safe.

---

## D1 Metadata Schema

Table: `attachments`

| Column             | Type             | Nullable | Notes                                        |
| ------------------ | ---------------- | -------- | -------------------------------------------- |
| `id`               | TEXT PRIMARY     | NO       | Attachment ID (UUID)                         |
| `vault_id`         | TEXT NOT NULL    | NO       | FK → `vaults.id`                             |
| `owner_account_id` | TEXT NOT NULL    | NO       | Account that owns this attachment            |
| `r2_key`           | TEXT NOT NULL    | NO       | Full R2 object key (e.g. `att/uuid/uuid`)    |
| `size_bytes`       | INTEGER NOT NULL | NO       | Unencrypted size in bytes                    |
| `hash`             | TEXT NOT NULL    | NO       | SHA-256 of encrypted bytes (for integrity)   |
| `created_at`       | INTEGER NOT NULL | NO       | Unix timestamp (ms) — for orphan sweep order |

Indexes:

- `idx_attachments_vault_id` on `vault_id`
- `idx_attachments_owner_account_id` on `owner_account_id`

---

## Size Limits

| Limit                   | Value  | Rationale                                 |
| ----------------------- | ------ | ----------------------------------------- |
| Single-request hard cap | 25 MB  | Worker 15s CPU / memory budget            |
| Recommended direct-path | >5 MB  | Avoid proxying large blobs through Worker |
| Signed URL validity     | 15 min | Balance security vs. upload retry window  |

Clients exceeding 25 MB must use the signed-URL upgrade path. 25 MB is the
absolute ceiling — R2 will reject objects exceeding this.

---

## Upload Flow

```
Client                      Worker                       D1                 R2
  |                            |                          |                  |
  |-- upload request --------->|                          |                  |
  |                            |-- INSERT attachments ---->|                  |
  |                            |<--- row created -----------|                  |
  |                            |                          |                  |
  |                            |-- PUT <key> -------------->|                  |
  |                            |<--- 200 OK --------------|                  |
  |                            |                          |                  |
  |<-- 201 Created -----------|                          |                  |
```

**Failure scenarios:**

| Step failed at                 | Partial state               | Recovery action                                                                                   |
| ------------------------------ | --------------------------- | ------------------------------------------------------------------------------------------------- |
| D1 INSERT fails                | None (atomic)               | Client retries. No orphan created.                                                                |
| R2 PUT fails                   | D1 row exists (orphan)      | **Roll back D1 row** (`DELETE WHERE id = ?`). Retry client.                                       |
| Worker crashes post-D1, pre-R2 | D1 row exists, no R2 object | Cron orphan sweep reconciles. Rollback via `DELETE WHERE r2_key NOT IN (SELECT key FROM R2 list)` |

**Rollback is required** when R2 PUT fails after D1 INSERT succeeds. The
implementation must catch R2 errors and issue the compensating DELETE before
returning a failure to the client.

---

## Download Flow

```
Client                      Worker                       D1                 R2
  |                            |                          |                  |
  |-- download request ------>|                          |                  |
  |                            |-- SELECT attachments --->|                  |
  |                            |<--- row + r2_key -------|                  |
  |                            |                          |                  |
  |                            |-- GET <r2_key> --------->|                  |
  |                            |<--- encrypted bytes -----|                  |
  |                            |                          |                  |
  |<-- encrypted blob --------|                          |                  |
```

**Failure scenarios:**

| Step failed at  | Partial state | Recovery action                                             |
| --------------- | ------------- | ----------------------------------------------------------- |
| D1 SELECT fails | None          | 404 to client. Retry.                                       |
| D1 row missing  | None          | 404 to client. Attachment is orphaned or never uploaded.    |
| R2 GET fails    | D1 row intact | Worker returns 502. Client retries. No compensating action. |

---

## Delete Flow

```
Client                      Worker                       D1                 R2
  |                            |                          |                  |
  |-- delete request -------->|                          |                  |
  |                            |                          |                  |
  |                            |-- DELETE FROM R2 ------->|                  |
  |                            |<--- 204 No Content -------|                  |
  |                            |                          |                  |
  |                            |-- DELETE attachments ---->|                  |
  |                            |<--- rows deleted ---------|                  |
  |                            |                          |                  |
  |<-- 204 No Content --------|                          |                  |
```

**Failure scenarios:**

| Step failed at  | Partial state                   | Recovery action                                      |
| --------------- | ------------------------------- | ---------------------------------------------------- |
| R2 DELETE fails | R2 object intact, D1 row intact | Return 502. Client retries. R2 DELETE is idempotent. |
| D1 DELETE fails | R2 object deleted, D1 row stale | **Record orphan for cron sweep**. R2 is clean.       |

**Order is deliberate**: R2 DELETE first because it is idempotent and safe to
retry. If D1 DELETE fails after R2 is clean, we record the orphan rather than
attempt a compensating action on R2 (which could re-create the orphan in the
other direction).

---

## Partial Failure Matrix

### Upload failures

| #   | D1 INSERT | R2 PUT  | Result                      | Rollback needed? |
| --- | --------- | ------- | --------------------------- | ---------------- |
| 1   | ❌ fail   | —       | No DB row, no R2 object     | No               |
| 2   | ✅ pass   | ❌ fail | DB row exists, no R2 object | **Yes** → DELETE |
| 3   | ✅ pass   | ✅ pass | DB row + R2 object          | No               |

**Retry behavior for case 2**: Up to 3 automatic rollbacks, then surface error
to client with the D1 row as a known orphan (for manual/cron cleanup).

### Delete failures

| #   | R2 DELETE | D1 DELETE | Result                 | Cleanup needed?   |
| --- | --------- | --------- | ---------------------- | ----------------- |
| 1   | ❌ fail   | —         | R2 intact, D1 intact   | Retry DELETE      |
| 2   | ✅ pass   | ❌ fail   | R2 clean, D1 row stale | **Record orphan** |
| 3   | ✅ pass   | ✅ pass   | Both clean             | No                |

**Retry behavior for case 2**: Orphan is recorded in `orphan_log` table (see
below) for cron processing. Do not attempt R2 re-upload.

### Download failures

| #   | D1 SELECT | R2 GET  | Result                 | Action      |
| --- | --------- | ------- | ---------------------- | ----------- |
| 1   | ❌ fail   | —       | No data transferred    | 404 + retry |
| 2   | ✅ pass   | ❌ fail | D1 row stale / R2 miss | 502 + retry |

No compensating actions for download failures.

---

## Orphan Cleanup

### Tables

**`orphan_log`** — records partial-failure orphans for cron processing.

| Column        | Type             | Nullable | Notes                           |
| ------------- | ---------------- | -------- | ------------------------------- |
| `id`          | INTEGER AI PK    | NO       | Auto-increment                  |
| `r2_key`      | TEXT             | NO       | R2 key that has no D1 row       |
| `orphaned_at` | INTEGER NOT NULL | NO       | Unix timestamp (ms)             |
| `reason`      | TEXT             | NO       | `delete_d1_failed` / `stray_r2` |

### Cron sweep logic

```
1. Scan D1 rows where r2_key NOT IN (list R2 keys with prefix "att/")
   → These are D1 rows pointing to deleted/missing R2 objects.
   → Action: DELETE D1 row (metadata-only, nothing to clean in R2).

2. Scan R2 keys with prefix "att/" where key NOT IN (SELECT r2_key FROM attachments)
   → These are R2 objects with no D1 pointer (stray objects).
   → Action: DELETE R2 object + insert orphan_log entry.
```

Cron should run daily. `orphan_log` entries older than 7 days can be pruned
after confirmation.

---

## Signed URL Upgrade Path (Large Files)

For attachments >5 MB, the client requests a **direct-to-R2 upload path**:

```
Client                      Worker                       R2
  |                            |                          |
  |-- POST /attachments/upload-url ->|                          |
  |                            |-- Generate signed PUT URL -->|
  |                            |<-- signed URL -------------|  (15 min TTL)
  |<-- { uploadUrl, r2Key } --|                          |
  |                            |                          |
  |-- PUT directly to R2 -----+-------------------------->|
  |<-- 200 OK -----------------+---------------------------|
  |                            |                          |
  |-- POST /attachments/confirm -->|                          |
  |                            |-- INSERT attachments ---->|  (D1 metadata only)
  |                            |<--- row created -----------|  (no R2 write from Worker)
```

**Confirm step failure**: Client has already uploaded to R2 but D1 INSERT fails.
In this case, the R2 object is a **stray** — the orphan cron will clean it up.
No manual rollback needed from the client.

This path bypasses the Worker 25 MB memory limit by never proxying the bytes
through the Worker. The Worker only generates credentials and records metadata.

---

## API Contract Decision

**Chosen**: Backend-mediated flow (Worker proxies attachment bytes) for
backwards-compatible client behavior. Signed-URL path available as an upgrade
for clients that need it.

**Rationale**:

- Existing Padloc clients expect `POST /attachments` / `GET /attachments/:id` /
  `DELETE /attachments/:id` — no client changes required for the base flow.
- Signed-URL path is an opt-in performance optimization for large files, not a
  breaking change.
- Worker memory limit (25 MB) makes direct proxying safe for small files.
- If client library is updated, it can detect file size and route large files
  through the signed-URL path automatically.

---

## Consequences

### Positive

- Clear partial-failure contract eliminates silent data loss.
- D1-first-then-R2 ordering keeps metadata as the source of truth.
- Idempotent R2 operations ensure delete retries are safe.
- Orphan cron provides eventual consistency without urgent manual intervention.
- Backward-compatible API preserves existing client behavior.

### Negative

- R2 failures after D1 INSERT require compensating writes — adds latency on the
  error path.
- Two-phase cleanup (D1 vs R2) means a brief window where the metadata DB and
  object store are out of sync after a failed delete.
- Signed-URL path requires client library updates to activate — not automatic.

---

## References

- `.sisyphus/plans/padloc-cloudflare-native-backend.md` lines 1071–1129
- `packages/core/src/attachment.ts` — `AttachmentInfo`, `AttachmentStorage`
  interface
- `packages/server/src/attachments/s3.ts` — existing S3 semantics (key pattern
  `vault/id`)
- `packages/server/src/attachments/fs.ts` — existing local fs semantics
