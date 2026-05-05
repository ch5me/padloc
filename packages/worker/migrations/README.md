# D1 Migrations

## Rollback Strategy

D1 migrations are **forward-only**. There is no automatic rollback mechanism.

### To undo a migration:

1. **Create a new migration** (e.g., `0002_undo_foo.sql`) that reverts the
   changes made by the migration you want to undo.
2. **Apply it** with `wrangler d1 migrations apply <db> --local` (or
   `--remote`).

### Examples

To drop a table:

```sql
DROP TABLE IF EXISTS my_table;
```

To remove a column (SQLite doesn't support `DROP COLUMN` in older versions):

1. Create a new table without the column
2. Copy data from the old table
3. Drop the old table
4. Rename the new table

### Local vs Remote

- `--local`: Applies to Miniflare's local SQLite, stored in `.wrangler/state/`
- `--remote`: Applies to your Cloudflare D1 instance (requires auth)

Always test migrations locally before applying remotely.

## Running Migrations

```sh
# Local
wrangler d1 migrations apply --local DB

# Remote (dev environment)
wrangler d1 migrations apply --remote DB --env=dev

# Remote (production)
wrangler d1 migrations apply --remote DB --env=production
```

## Schema Ownership Map

| Table                 | Domain Object         | Core File                        |
| --------------------- | --------------------- | -------------------------------- |
| `accounts`            | `Account`             | `packages/core/src/account.ts`   |
| `auth`                | `Auth` metadata       | `getAuthInfo` flow               |
| `sessions`            | `Session`             | `packages/core/src/session.ts`   |
| `vaults`              | `Vault`               | `packages/core/src/vault.ts`     |
| `orgs`                | `Org`                 | `packages/core/src/org.ts`       |
| `org_members`         | `OrgMember`           | `packages/core/src/org.ts`       |
| `invites`             | `Invite`              | `packages/core/src/invite.ts`    |
| `key_store_entries`   | `KeyStoreEntry`       | `packages/core/src/key-store.ts` |
| `attachments`         | `Attachment` metadata | R2-backed payloads               |
| `email_verifications` | Verification codes    | Email flow                       |
| `change_log`          | Audit events          | Append-only                      |
| `request_log`         | HTTP request audit    | Append-only                      |

## Naming Convention

- `NNNN_description.sql` where `NNNN` is a zero-padded sequence number
- Each migration is applied exactly once; Wrangler tracks applied migrations in
  the `_migrations` table
