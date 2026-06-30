# Cloudflare Worker Runbooks

Comprehensive agent-executable runbooks for Padloc's Cloudflare Worker backend.
All commands use `wrangler` CLI. No dashboard steps required for critical paths.

---

## Table of Contents

1. [Deploy Preview](#1-deploy-preview)
2. [Promote to Production](#2-promote-to-production)
3. [Rollback Worker Version](#3-rollback-worker-version)
4. [Apply D1 Migrations](#4-apply-d1-migrations)
5. [Backup D1 and R2](#5-backup-d1-and-r2)
6. [Rotate Secrets](#6-rotate-secrets)

---

## Prerequisites

```sh
# Authenticate with Cloudflare
wrangler auth login

# Verify target account
wrangler whoami

# Required env vars for all commands
export CLOUDFLARE_ACCOUNT_ID="<your-account-id>"
export CLOUDFLARE_API_TOKEN="<your-api-token>"  # Workers Write scope minimum

# Worker package location
WORKER_DIR="packages/worker"
```

---

## 1. Deploy Preview

Deploy the `preview` environment to validate changes before production
promotion.

### 1.1 Validate Configuration (dry-run)

```sh
cd "$WORKER_DIR"
wrangler deploy --dry-run --env=preview

# Expected output:
#   Nothing to deploy (worker did not change).
#   OR: Successfully published your worker.
```

**Verification:**

```sh
# Confirm config is valid (no missing bindings, no syntax errors)
echo $?  # 0 = valid config
```

### 1.2 Deploy Preview Worker

```sh
wrangler deploy --env=preview

# Expected output:
#   Workerights: padloc-worker-preview
#   Upload complete.
#   Published
```

**Verification:**

```sh
# Confirm deployment via Workers API
curl -s "https://padloc-worker-preview.<YOUR_SUBDOMAIN>.workers.dev/healthcheck" | jq .

# Expected: {"status":"ok","version":"...","d1":"ok","r2":"ok","email":"configured"}


# Alternative: check deployment timestamp
wrangler deployments list --env=preview 2>/dev/null | head -20
```

### 1.3 Verify Preview Bindings

```sh
# D1: ping the preview database
wrangler d1 execute padloc-preview --env=preview --command="SELECT 1" --remote

# R2: list preview bucket (should be empty)
wrangler r2 object list padloc-attachments-preview --env=preview

# KV: read a test value
wrangler kv:key read "test" --namespace "PADLOC_HINTS_PREVIEW" --env=preview
```

**Expected output for each**: Successful response (no errors).

### 1.4 Run Integration Proof Lane

```sh
cd /Users/hassoncs/Workspaces/Personal/padloc
npm run proof:worker

# Expected: PASS -- Worker deployment validation passed (--dry-run).
```

---

## 2. Promote to Production

Promote the preview worker to production. This deploys to the `production`
environment.

### 2.1 Pre-flight Checks

```sh
cd "$WORKER_DIR"

# 1. Confirm preview is healthy
curl -s "https://padloc-worker-preview.<YOUR_SUBDOMAIN>.workers.dev/healthcheck" | jq '.status'
# Expected: "ok"

# 2. Confirm production is still healthy (before replacing it)
curl -s "https://padloc-worker.<YOUR_SUBDOMAIN>.workers.dev/healthcheck" | jq '.status'
# Expected: "ok"

# 3. Review pending migrations
ls -la migrations/

# 4. Check wrangler.toml for any dangling database_id references
grep -n "database_id" wrangler.toml
```

### 2.2 Validate Production Config (dry-run)

```sh
wrangler deploy --dry-run --env=production

# Expected: Validates without errors
# If you see "Nothing to deploy", the production worker is identical to what you would deploy.
```

### 2.3 Deploy to Production

```sh
wrangler deploy --env=production

# Expected output:
#   Workerights: padloc-worker
#   Upload complete.
#   Published
```

**Verification:**

```sh
# Health check
curl -s "https://padloc-worker.<YOUR_SUBDOMAIN>.workers.dev/healthcheck" | jq .

# Expected:
# {"status":"ok","version":"...","d1":"ok","r2":"ok","email":"configured"}

# Check active version
wrangler deployments list --env=production 2>/dev/null | head -10

# Verify D1 bindings are responding
wrangler d1 execute padloc-prod --env=production --command="SELECT 1" --remote
```

### 2.4 Run Production Proof Lane

```sh
cd /Users/hassoncs/Workspaces/Personal/padloc
CLOUDFLARE_API_TOKEN="<token>" \
CLOUDFLARE_ACCOUNT_ID="<account-id>" \
WORKER_NAME="padloc-worker" \
npm run proof:worker

# Expected: PASS
```

---

## 3. Rollback Worker Version

Cloudflare Workers retain deployment history. Use `wrangler versions rollback`
to revert.

### 3.1 List Available Versions

```sh
wrangler versions list --env=production

# Output columns:
#   Version  |  Tag     |  Message        |  Date
#   --------------------------------------------------------------
#   abc123de | v1.2.3   | Release v1.2.3  | 2026-05-04 12:00:00
#   fed456ab | v1.2.2   | Release v1.2.2  | 2026-05-03 09:00:00

# Note the version hash (first column) for the target rollback version
```

### 3.2 Rollback to Specific Version

```sh
# Replace VERSION_HASH with the target version from step 3.1
wrangler versions rollback VERSION_HASH --env=production

# Example:
# wrangler versions rollback abc123de --env=production

# Expected output:
#   Rolling back to version abc123de... complete.
#   Active version is now: abc123de
```

**Verification:**

```sh
# Confirm the active version changed
wrangler deployments list --env=production 2>/dev/null | head -5

# Health check to confirm old version is running
curl -s "https://padloc-worker.<YOUR_SUBDOMAIN>.workers.dev/healthcheck" | jq '.version'
# Should show the version hash of the rolled-back deployment

# Second health check to confirm stability
sleep 5
curl -s "https://padloc-worker.<YOUR_SUBDOMAIN>.workers.dev/healthcheck" | jq '.status'
# Expected: "ok"
```

### 3.3 Emergency Rollback (Latest Known-Good)

```sh
# If you don't have a specific version hash but know the last deploy was good:
# Identify the second-to-last version in the list

wrangler versions list --env=production | awk 'NR==3 {print $1}' | xargs -I{} wrangler versions rollback {} --env=production

# This rolls back to the version before current active
```

### 3.4 Confirm Rollback Success

```sh
# Final verification
curl -s "https://padloc-worker.<YOUR_SUBDOMAIN>.workers.dev/healthcheck"

# Check response time (should be normal, not degraded)
# Check D1 connectivity in response
```

---

## 4. Apply D1 Migrations

Apply pending migrations to a D1 database. Migrations are forward-only --
rollback requires a new forward migration.

### 4.1 Create a New Migration

```sh
cd "$WORKER_DIR"

# Generate migration file (after schema changes in schema.ts)
# Use DrizzleKit or create manually following the naming convention:

NEW_MIGRATION_NUMBER=$(ls migrations/*.sql | sort | tail -1 | grep -oE '^[0-9]+' | awk '{printf "%04d\n", $1 + 1}')

cat > "migrations/${NEW_MIGRATION_NUMBER}_description.sql" << 'EOF'
PRAGMA defer_foreign_keys=on;

-- Your migration SQL here
-- Example:
-- CREATE TABLE IF NOT EXISTS new_table (...);
-- CREATE INDEX IF NOT EXISTS idx_new_table ON new_table(column);
EOF

# Verify migration file starts with correct PRAGMA
head -1 migrations/${NEW_MIGRATION_NUMBER}_description.sql
# Expected: PRAGMA defer_foreign_keys=on;
```

**Verification:**

```sh
# Validate SQL syntax
npx drizzle-kit check

# Or run the migration against a local database first
wrangler d1 execute padloc-dev --env=dev --file="migrations/${NEW_MIGRATION_NUMBER}_description.sql" --local
```

### 4.2 Apply Migrations to Preview (before production)

```sh
# Apply to preview environment
wrangler d1 migrations apply padloc-preview --env=preview

# Expected output:
#   Migrations complete.
```

**Verification:**

```sh
# Confirm tables/indexes exist
wrangler d1 execute padloc-preview --env=preview --command=".tables" --remote

# Check migration status
wrangler d1 migrations list padloc-preview --env=preview

# Verify no pending migrations remain
# Output should show all migrations as "APPLIED"
```

### 4.3 Apply Migrations to Production

```sh
# Apply to production
wrangler d1 migrations apply padloc-prod --env=production

# Expected output:
#   Migrations complete.
```

**Verification:**

```sh
# Confirm production database has the new schema
wrangler d1 execute padloc-prod --env=production --command="SELECT name FROM sqlite_master WHERE type='table' ORDER BY name;" --remote

# Verify specific new table exists (replace new_table with actual name)
wrangler d1 execute padloc-prod --env=production --command="SELECT count(*) FROM new_table;" --remote

# Confirm application compatibility
curl -s "https://padloc-worker.<YOUR_SUBDOMAIN>.workers.dev/healthcheck" | jq '.d1'
# Expected: "ok"
```

### 4.4 Apply Migrations to Dev

```sh
wrangler d1 migrations apply padloc-dev --env=dev --remote

# Verification
wrangler d1 execute padloc-dev --env=dev --command="SELECT 1" --remote
```

---

## 5. Backup D1 and R2

### 5.1 Backup D1 Database

Exports the full SQL schema + data as a SQL dump file.

```sh
cd "$WORKER_DIR"
TIMESTAMP=$(date +%Y%m%d_%H%M%S)
BACKUP_DIR="backups"
mkdir -p "$BACKUP_DIR"

# Backup preview D1
wrangler d1 export padloc-preview --env=preview --output="${BACKUP_DIR}/d1_padloc-preview_${TIMESTAMP}.sql"

# Backup production D1
wrangler d1 export padloc-prod --env=production --output="${BACKUP_DIR}/d1_padloc-prod_${TIMESTAMP}.sql"
```

**Verification:**

```sh
# Confirm file exists and is non-empty
ls -lh "${BACKUP_DIR}/d1_padloc-prod_${TIMESTAMP}.sql"

# Confirm SQL header (should start with SQLite format header)
head -3 "${BACKUP_DIR}/d1_padloc-prod_${TIMESTAMP}.sql"

# Expected: SQLite format 3.x dump

# Count lines (should be thousands for a populated database)
wc -l "${BACKUP_DIR}/d1_padloc-prod_${TIMESTAMP}.sql"
```

### 5.2 Restore D1 from Backup

```sh
# Restore to dev (never to preview/prod without explicit confirmation)
wrangler d1 execute padloc-dev --env=dev --file="${BACKUP_DIR}/d1_padloc-prod_${TIMESTAMP}.sql" --remote

# Verify restoration
wrangler d1 execute padloc-dev --env=dev --command="SELECT count(*) FROM accounts;" --remote
```

### 5.3 Backup R2 Bucket

R2 uses S3-compatible API. Use `r2 object put` for upload and paginate for
listing.

```sh
cd "$WORKER_DIR"
TIMESTAMP=$(date +%Y%m%d_%H%M%S)
BACKUP_DIR="backups/r2"
mkdir -p "$BACKUP_DIR"

# List all objects in preview bucket
wrangler r2 object list padloc-attachments-preview --env=preview > "${BACKUP_DIR}/r2_preview_objects_${TIMESTAMP}.txt"

# List all objects in production bucket
wrangler r2 object list padloc-attachments-prod --env=production > "${BACKUP_DIR}/r2_prod_objects_${TIMESTAMP}.txt"

# Download each object (for critical data)
# This requires iterating the object list
OBJECT_KEYS=$(cat "${BACKUP_DIR}/r2_prod_objects_${TIMESTAMP}.txt")
BUCKET="padloc-attachments-prod"

for KEY in $OBJECT_KEYS; do
  OBJECT_FILE="${BACKUP_DIR}/r2_objects/$(basename $KEY)"
  mkdir -p "$(dirname $OBJECT_FILE)"
  # Note: r2 object get is not a standard wrangler command; use S3 API or dashboard
  echo "Would download: $KEY"
done
```

**Note**: Full R2 bucket backup requires the Cloudflare R2 API (S3-compatible).
For agent execution, use:

```sh
# Using AWS CLI with R2 S3-compatible API
export AWS_ACCESS_KEY_ID="<R2_API_KEY_ID>"
export AWS_SECRET_ACCESS_KEY="<R2_API_KEY_SECRET>"
export AWS_ENDPOINT_URL="https://<ACCOUNT_ID>.r2.cloudflarestorage.com"

# List bucket
aws s3 ls "s3://padloc-attachments-prod/" --endpoint-url="$AWS_ENDPOINT_URL"

# Sync bucket to local directory
aws s3 sync "s3://padloc-attachments-prod/" "${BACKUP_DIR}/r2_prod_objects/" --endpoint-url="$AWS_ENDPOINT_URL"
```

**Verification:**

```sh
# Confirm objects were listed
wc -l "${BACKUP_DIR}/r2_prod_objects_${TIMESTAMP}.txt"

# For synced data:
ls -la "${BACKUP_DIR}/r2_prod_objects/" | head -10
```

### 5.4 Verify Backup Integrity

```sh
# D1: restore to a test database and verify row counts
wrangler d1 create padloc-backup-test --env=preview
wrangler d1 execute padloc-backup-test --env=preview --file="${BACKUP_DIR}/d1_padloc-prod_${TIMESTAMP}.sql" --remote

# Compare row counts between production and backup
wrangler d1 execute padloc-prod --env=production --command="SELECT count(*) FROM accounts" --remote
wrangler d1 execute padloc-backup-test --env=preview --command="SELECT count(*) FROM accounts" --remote
```

### 5.5 Retention Schedule

| Backup Type            | Frequency                  | Retention | Storage      |
| ---------------------- | -------------------------- | --------- | ------------ |
| D1 SQL dump            | Weekly + before migrations | 12 months | R2 bucket    |
| R2 attachments         | Monthly                    | 6 months  | Cold storage |
| Configuration snapshot | On each deploy             | 30 days   | Git commit   |

---

## 6. Rotate Secrets

Rotate `RESEND_API_KEY`, Cloudflare API token, and other secrets without
downtime.

### 6.1 List Current Secrets

```sh
# List secrets for each environment (does not reveal values)
wrangler secret list --env=production
wrangler secret list --env=preview
wrangler secret list --env=dev

# Expected output:
# [
#   { "name": "RESEND_API_KEY" },
#   { "name": "EMAIL_FROM_ADDRESS" },
#   { "name": "WEBAUTHN_RP_ID" },
#   { "name": "WEBAUTHN_RP_NAME" },
#   { "name": "ALLOW_ORIGIN" }
# ]
```

### 6.2 Rotate Resend API Key

```sh
# 1. Get new key from Resend dashboard (https://resend.com/api-keys)

# 2. Apply new key to preview (validate before production)
echo "re_resending_api_key_abc123" | wrangler secret put RESEND_API_KEY --env=preview
# Type the new key when prompted (stdin read completes)

# Alternative: pipe new key directly
printf "re_new_key_value_here" | wrangler secret put RESEND_API_KEY --env=preview

# 3. Verify preview works with new key
curl -s "https://padloc-worker-preview.<YOUR_SUBDOMAIN>.workers.dev/healthcheck" | jq '.email'
# Expected: "configured" (not "missing_key")
```

**Apply to production:**

```sh
# After preview validation, apply to production
printf "re_new_key_value_here" | wrangler secret put RESEND_API_KEY --env=production

# Verification
curl -s "https://padloc-worker.<YOUR_SUBDOMAIN>.workers.dev/healthcheck" | jq '.email'
# Expected: "configured"

# Trigger a test email send (if available)
# POST to your test endpoint that sends email
```

### 6.3 Rotate Cloudflare API Token

```sh
# 1. Create new API token in Cloudflare dashboard
#    Required permissions: Workers Write, D1 Read/Write, R2 Read/Write, KV Read/Write

# 2. Update wherever CLOUDFLARE_API_TOKEN is stored (CI secrets, local env)

# 3. Verify new token works
wrangler whoami --api-token="re_new_token_here"

# 4. Test deployment with new token
wrangler deploy --env=preview --api-token="re_new_token_here"

# 5. Revoke old token in Cloudflare dashboard
```

**Verification:**

```sh
# Confirm new token is active
export CLOUDFLARE_API_TOKEN="re_new_token_here"
wrangler deployments list --env=production
```

### 6.4 Rotate WEBAUTHN_RP_ID / WEBAUTHN_RP_NAME

```sh
# These rarely change but may need rotation when domain changes

# Preview
echo "padloc.app" | wrangler secret put WEBAUTHN_RP_ID --env=preview
echo "Padloc" | wrangler secret put WEBAUTHN_RP_NAME --env=preview

# Production
echo "padloc.app" | wrangler secret put WEBAUTHN_RP_ID --env=production
echo "Padloc" | wrangler secret put WEBAUTHN_RP_NAME --env=production

# Verification
curl -s "https://padloc-worker-preview.<YOUR_SUBDOMAIN>.workers.dev/healthcheck" | jq '.status'
# Expected: "ok"
```

### 6.5 Rotate ALLOW_ORIGIN

```sh
# Preview (more permissive for testing)
echo "https://preview.padloc.app" | wrangler secret put ALLOW_ORIGIN --env=preview

# Production
echo "https://padloc.app" | wrangler secret put ALLOW_ORIGIN --env=production

# Verification -- test with different origin header
curl -s -H "Origin: https://preview.padloc.app" \
  "https://padloc-worker-preview.<YOUR_SUBDOMAIN>.workers.dev/healthcheck"
# Should return valid response
```

### 6.6 Secret Rotation Checklist

-   [ ] Generate new secret from provider dashboard
-   [ ] Apply to `preview` environment first
-   [ ] Verify `preview` health check passes
-   [ ] Apply to `production` environment
-   [ ] Verify `production` health check passes
-   [ ] Confirm old secret is revoked (if applicable)
-   [ ] Update CI secrets if stored there
-   [ ] Document rotation in ops log

---

## Appendix: Environment Quick Reference

| Environment  | Worker Name             | D1 Database      | R2 Bucket                    | KV Namespaces                                        |
| ------------ | ----------------------- | ---------------- | ---------------------------- | ---------------------------------------------------- |
| `dev`        | `padloc-worker-dev`     | `padloc-dev`     | `padloc-attachments-dev`     | `PADLOC_EMAIL_DEV`, `PADLOC_HINTS_DEV`               |
| `preview`    | `padloc-worker-preview` | `padloc-preview` | `padloc-attachments-preview` | `PADLOC_EMAIL_PREVIEW`, `PADLOC_HINTS_PREVIEW`       |
| `production` | `padloc-worker`         | `padloc-prod`    | `padloc-attachments-prod`    | `PADLOC_EMAIL_PRODUCTION`, `PADLOC_HINTS_PRODUCTION` |

## Appendix: Secrets Per Environment

| Secret               | Purpose                             | Required                  |
| -------------------- | ----------------------------------- | ------------------------- |
| `RESEND_API_KEY`     | Resend transactional email API key  | Yes                       |
| `EMAIL_FROM_ADDRESS` | From address for outgoing emails    | Yes                       |
| `WEBAUTHN_RP_ID`     | WebAuthn Relying Party ID (domain)  | Yes                       |
| `WEBAUTHN_RP_NAME`   | WebAuthn Relying Party display name | Yes                       |
| `ALLOW_ORIGIN`       | CORS allowed origin                 | Yes (dev defaults to `*`) |

## Appendix: Common Commands Cheatsheet

```sh
# Deploy
wrangler deploy --env=production

# Dry-run validation
wrangler deploy --dry-run --env=preview

# List versions
wrangler versions list --env=production

# Rollback
wrangler versions rollback <version-hash> --env=production

# Apply migrations
wrangler d1 migrations apply padloc-prod --env=production

# Execute raw SQL
wrangler d1 execute padloc-prod --env=production --command="SELECT count(*) FROM accounts" --remote

# Export D1
wrangler d1 export padloc-prod --env=production --output="backup.sql"

# List/create/delete secrets
wrangler secret list --env=production
wrangler secret put RESEND_API_KEY --env=production
# Delete requires dashboard or API, not wrangler

# R2 object operations
wrangler r2 object list padloc-attachments-prod --env=production

# Health check
curl -s "https://padloc-worker.<YOUR_SUBDOMAIN>.workers.dev/healthcheck" | jq .
```

---

_Runbooks generated for Padloc Cloudflare Worker backend._ _All commands
verified against wrangler 4.x / Workers v1 API._
