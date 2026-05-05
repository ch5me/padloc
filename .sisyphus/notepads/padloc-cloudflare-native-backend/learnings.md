# Learnings

## T2 — crypto/auth parity vectors

- Crypto parity must run as a Worker endpoint, not just as Mocha/Node tests. The
  lane is `packages/worker/test/crypto-parity.worker.ts`, with
  `test/run-crypto-parity-worker.mjs` only orchestrating `wrangler dev` and
  fetching the Worker result.
- WorkerCryptoProvider is intentionally a RED stub for T2. T13 should replace
  `packages/worker/src/crypto.ts` with Web Crypto (`crypto.getRandomValues`,
  `crypto.subtle.digest`, PBKDF2 `deriveBits`, AES-GCM, HMAC, RSA-OAEP, RSA-PSS)
  until every vector passes in Worker runtime.
- SRP parity uses fixed x/a/b inputs and asserts K/M1/M2 at the current 4096-bit
  default. The test also checks tampered M1 through `timingSafeEqual`; keep the
  inherited security finding visible when T13 fixes constant-time comparison
  behavior.
- TOTP needs HMAC-SHA-1 and HMAC-SHA-256 support. A Worker provider that only
  supports HMAC-SHA-256 is insufficient for current Padloc auth.
- RSA-OAEP encryption and RSA-PSS signing are probabilistic. Deterministic tests
  should verify known decrypt/verify fixtures and only round-trip fresh
  signatures.
- The crypto parity lane currently has the correct RED shape: Web Crypto runtime
  and WebAuthn input-shape vectors pass, while SRP, HMAC, PBES2/AES-GCM, RSA,
  and TOTP fail on the intentional WorkerCryptoProvider T13 stub.

## T5 — Proof lane design

- Proof lanes are shell scripts in `scripts/proof-lanes/`, wired to root
  `package.json` as `npm run proof:X`. Each script supports `--help`/`-h`
  listing required env vars and bindings.
- Five lanes: `proof:contract` (static analysis), `proof:crypto` (test parity),
  `proof:worker` (wrangler deploy --dry-run), `proof:client` (PWA build +
  connectivity), `proof:migration` (D1 SQL syntax validation).
- Missing env fails with exit code 2 and names the exact missing binding — no
  stack traces. Scripts with optional env exit gracefully (exit 2 for skipped
  connectivity, not 1) so CI can distinguish "not applicable" from "failed".
- Worker lane uses `wrangler deploy --dry-run` for config validation without
  pushing code; final runtime proof requires actual deploy when tokens exist.
- `npm run proof:all` chains all lanes sequentially — any failure stops the
  chain.
- T5 blocks T12-T24; all implementation tasks assume proof lanes are the
  verification gate.

## T10 — Email via Resend ADR

- All 8 `Message` subclasses in `packages/core/src/messenger.ts` map to Resend
  dynamic templates. Template variables already use `{{varname}}` syntax —
  compatible with Resend native interpolation.
- Existing `assets/email/*.html` and `*.txt` files must be converted to TS
  string constants in `packages/worker/src/email/templates.ts` via a build
  script that runs at compile time (Node.js), NOT at runtime. This eliminates
  all `readFileSync`/`fs` access in the Worker.
- `ResendSender` uses raw `fetch` to `https://api.resend.com/emails` with Bearer
  token auth. No nodemailer, no SMTP — fully Web Standard Fetch.
- Idempotency key format: `{templateName}:{primaryKeyFromData}` (e.g.,
  `email-auth:req_abc123`). This prevents duplicate sends on retry.
- `EMAIL_BACKEND=mock` activates `MockResendSender` (console.log only).
  `EMAIL_MOCK_RECIPIENT` redirects all emails to a safe test address.
- Env vars shift from `PL_EMAIL_SMTP_*` to `RESEND_API_KEY` + `EMAIL_FROM` +
  `RESEND_TEMPLATE_*` per template ID.
- `SMTPSender` in `packages/server/src/email/smtp.ts` stays for Node.js server
  deployments. Worker path only uses `ResendSender` or `MockResendSender`.
- ADR at `docs/architecture/adr-007-email.md` has full email flow table,
  template bundling spec, Resend API payload shape, idempotency strategy,
  mock/preview mode, env var schema, and migration path from SMTPSender.

## T9 — R2 attachment lifecycle and failure semantics

- Attachment lifecycle ADR at `docs/architecture/adr-006-attachments.md`.
- **Upload order**: D1 INSERT first → R2 PUT second. R2 failure after D1 commit
  requires compensating D1 DELETE (rollback). Up to 3 auto-rollbacks, then
  surface error to client.
- **Delete order**: R2 DELETE first → D1 DELETE second. D1 failure after R2 is
  clean records orphan for cron sweep. R2 DELETE is idempotent so retry is safe.
- **Object key scheme**: `att/<vault_id>/<attachment_id>` — provides partition
  isolation and URL-safe characters.
- **Size cap**: 25 MB single-request hard cap. Signed-URL upgrade path for large
  files (>5 MB) bypasses Worker memory limits.
- **Orphan cleanup**: Cron scans (a) D1 rows pointing to missing R2 keys and (b)
  R2 keys with no D1 pointer. D1 rows cleaned via DELETE; stray R2 objects
  deleted and logged to `orphan_log` table.
- **Contract decision**: Backend-mediated flow preserved as default for
  backward-compatible clients. Signed-URL path is opt-in upgrade, not a breaking
  change. Existing `POST/GET/DELETE /attachments` API remains functional.
- **Partial failure matrix** covers DB write fail, R2 write fail, delete fail,
  and retry behavior. No ambiguous attachment contract left unaddressed.

## T11 — Transactionality and consistency requirements

- The in-memory `_requestQueue: Map<AccountID | OrgID, Promise<void>>` at
  `server.ts:2188` serializes per-account and per-org handler invocations. This
  guarantee is **lost** on stateless Workers — replaced with `AccountLockDO`, a
  single Durable Object class keyed by identity string.
- Lock acquisition order **must** be sorted ID order across
  `[account.id, ...account.orgs.map(o => o.id)]` to prevent deadlocks when two
  concurrent requests overlap on the same org.
- **One DO class only** — no per-flow DO classes (SessionLockDO, OrgLockDO,
  etc.). One class keyed by `idFromName(id)` bounds DO sprawl and simplifies
  deployment.
- KV is **forbidden** as a consistency owner. All auth/session/vault/org/account
  state lives exclusively in D1. KV is hint-only (rate limits, ephemeral cache,
  presence hints).
- 10 multi-write flows documented in
  `docs/architecture/adr-008-transactionality.md` with consistency owner,
  atomicity level, and failure behavior for each.
- Cross-store operations (D1+R2 in attachment flows) are non-transactional and
  require explicit compensation: `createAttachment` does D1-first with D1
  rollback on R2 failure; `deleteAttachment` does R2-first with orphan recording
  on D1 failure.
- `acceptInvite` is the only flow requiring two locks (org AND account) — sorted
  ID order makes it deadlock-free.

## T7 — wrangler.toml / bindings

- `durable_objects` uses `[[env.<env>.durable_objects.bindings]]` with `name`
  and `class_name` fields. Not `binding` — the config field is `name`.
- D1/R2/KV bindings use array syntax with `binding` and resource name fields.
  Automatic provisioning omits `database_id`/`bucket_name`/`id` — resources are
  created on deploy and IDs written back.
- The "Missing entry-point" error from `--dry-run` with no Worker source is
  expected — it proves config parses correctly. Only happens because
  `src/index.ts` doesn't exist yet (T14).
- The "no migrations" warning is expected — `AccountLockDO` is T17; migrations
  added then.

## T8 — D1 schema and migrations

- Drizzle ORM (`drizzle-orm` + `drizzle-kit`) chosen for typed schema and
  generated migrations. Schema at `packages/worker/src/storage/schema.ts`;
  storage impl at `packages/worker/src/storage/d1.ts`.
- Blob-shaped storage: each Storable's full `toRaw()` JSON in a single `data`
  TEXT column — mirrors the Postgres backend's JSONB approach but adapted for
  SQLite's lack of native JSON operators.
- `wrangler.toml` needs `database_id` field even for local migrations — Wrangler
  4.x resolves D1 databases by ID, not just name. The `database_id` is obtained
  from `wrangler d1 create`.
- Migration SQL must start with `PRAGMA defer_foreign_keys=on` — D1's SQLite
  does not support `PRAGMA foreign_keys=OFF`.
- SQLite has no native regex. The StorageQuery `regex`/`negex` translator uses
  `simpleRegexToLike()` which maps `.*` → `%` and `.` → `_`. Complex patterns
  (character classes, alternation, quantifiers, anchors) throw
  `ErrorCode.NOT_IMPLEMENTED`. Callers must filter client-side for advanced
  regex.
- `IF NOT EXISTS` guards on all CREATE TABLE/INDEX statements provide
  idempotency. Wrangler's `_migrations` tracking prevents re-application.
- 12 domain tables + 2 audit tables created. 15 indexes including one UNIQUE
  constraint on `accounts.email`.
- D1 row-size limit of 10 MB means vault blobs exceeding this must spill to R2
  with a `vault-blob/` key prefix — the D1 pointer row remains with an R2 key
  reference.
- Composite primary key `(org_id, account_id)` on `org_members` replaces the
  Postgres approach of a synthetic id + unique constraint.
- Append-only audit tables (`change_log`, `request_log`) have no indexes —
  truncate by cron (T26) keeps them from growing unbounded.
- Schema ownership map links each D1 table to its `@padloc/core` domain type and
  source file, documented in `migrations/README.md`.

## T6 — Worker package and fetch transport bootstrap

- `packages/worker/` already existed from prior tasks with pre-created files. T6
  fixed a critical type bug: `Request` and `Response` imported from
  `@padloc/core/src/transport` shadow Web Fetch API `Request`/`Response`. Fix:
  rename imports to `PlRequest`/`PlResponse` so `new Response(...)` calls use
  the Web API constructor.
- `@padloc/core` transitively imports `@padloc/locale/src/translate`. Wrangler's
  esbuild cannot resolve this through tsconfig path aliases alone. Fix: symlink
  `@padloc/locale` into `packages/core/node_modules/@padloc/` so esbuild's
  node_modules resolution finds it.
- `wrangler dev --local` starts successfully on port 8787. `--local` is
  deprecated in wrangler 4.x but still works; plain `wrangler dev` is
  equivalent.
- Healthcheck pings D1 via `SELECT 1` (local SQLite works), R2 via
  `bucket.list({limit:0})`, and checks `RESEND_API_KEY` secret presence.
  Degraded status (not 500) when any dependency is unavailable — correct
  behavior.
- `server-factory.ts` remains a stub throwing `"not implemented"` — POST `/`
  will fail with this error once `createServer()` is wired. Healthcheck and
  OPTIONS do not touch it.
- `package.json` uses `"@padloc/core": "workspace:*"` and
  `"@padloc/locale": "workspace:*"` for pnpm workspace resolution. Removed
  pinned version `"4.3.0"` which pnpm tried to fetch from npm registry.

## T13 — Worker crypto adapter

- WorkerCryptoProvider can satisfy all T2 parity vectors with Cloudflare Web
  Crypto only: SHA-1/SHA-256 digest, HMAC-SHA-1/SHA-256, AES-256-GCM, RSA-OAEP
  decrypt/encrypt, RSA-PSS sign/verify, RSA-PSS key generation with DER export,
  and constant-time byte comparison.
- RSA key DER exported from Web Crypto is import-compatible across RSA-PSS and
  RSA-OAEP in local workerd/Workers, so one generated RSA key pair still works
  for Padloc's signing and key-wrapping call sites.
- AES-CCM remains an explicit Worker v1 non-support case because Cloudflare Web
  Crypto does not expose AES-CCM. Do not silently route Worker AES-CCM through a
  Node/SJCL fallback.
- SRP docs/helpers should model M1/M2 checks as constant-time byte comparisons;
  byte-array identity (`===`/`!==`) is never a valid SRP proof check. The server
  path already uses `getCryptoProvider().timingSafeEqual()` for M1 verification.
- **Blocker:** Cloudflare remote Workers Web Crypto currently rejects PBKDF2
  `deriveBits` iteration counts above 100,000 (`requested 1000000`). T13 local
  benchmark passed at 128 ms for PBKDF2 1M + SRP-4096 + RSA-PSS verify, and the
  remote lane passed all T2 vectors, but the remote CPU-budget proof fails
  before timing because of the platform cap. Do not weaken Padloc's 1,000,000
  iterations to make Workers pass.

## T11.5 — PersonalProvisioner stub

- Provisioner interface defined in `packages/core/src/provisioning.ts`:
  `getProvisioning`, `accountDeleted`, `accountEmailChanged`, `orgDeleted`,
  `orgOwnerChanged` — 5 methods total.
- `StubProvisioner` in the same file returns empty `Provisioning {}` for all
  calls. It satisfies the contract but all quotas default to `undefined`.
- `PersonalProvisioner` extends the same contract with permissive defaults:
  `status = Active`, `quota.vaults = -1` (unlimited), `quota.storage = -1`,
  `billing.disabled = true` and `hidden = true`.
- `AccountID`, `OrgInfo`, and `Session` are NOT exported from
  `@padloc/core/src/provisioning` — they come from `account.ts`, `org.ts`, and
  `session.ts` respectively. Import path must be corrected per type.
- `Server` constructor signature:
  `(config, storage, messenger, logger, authServers, attachmentStorage, provisioner, changeLogger?, requestLogger?)`.
  All parameters after `provisioner` are optional.
- `server-factory.ts` now creates the full Server wiring with D1Storage,
  StubMessenger, VoidLogger, PersonalProvisioner, and stub attachmentStorage.
  `createServer(env: Env)` is the entry point.
- Bundle is clean: `wrangler deploy --dry-run` passes with 1172 KiB bundle, no
  stripe/pg/SCIMUser imports. Evidence at
  `.sisyphus/evidence/task-11.5-bundle-clean.txt`.
- The WorkerReceiver in `transport.ts` handles the POST `/` unmarshal/marshal
  flow — `index.ts` routes through `WorkerReceiver.handleFetch` which then calls
  the server handle. The `createServer(env)` call must pass `env`.
- Provisioner hook methods (accountDeleted, accountEmailChanged, orgDeleted,
  orgOwnerChanged) are no-op: they debug-log params and return `Promise<void>`
  without throwing. This ensures `createAccount` and related flows never get a
  provisioner rejection.

## T16 — ResendMessenger + MockMessenger

- Template bundler `scripts/bundle-templates.ts` reads
  `assets/email/*.{html,txt}` at compile time and writes
  `packages/worker/src/email/templates.ts`. Run with
  `npx tsx scripts/bundle-templates.ts`. Templates are TS string constants — no
  `readFileSync` at runtime.
- Template key mapping: `email-auth.html` → `email_auth_html` key (hyphens
  replaced with underscores). `getTemplate()` applies this conversion so callers
  use the original `{{ templateName }}` names like `email-auth`,
  `join-org-invite`.
- Interpolation vars: only spread `msg.data` — NOT `{ title, ...msg.data }`. The
  `{{ title }}` placeholder is already in the source HTML as literal copy, not a
  template variable.
- `ResendMessenger.send()` uses raw `fetch` to `https://api.resend.com/emails`
  with `Authorization: Bearer` + `Idempotency-Key` header. Maps non-2xx to
  `Err(ErrorCode.SERVER_ERROR)`.
- `createMessenger(env)` factory: returns `MockMessenger` when
  `env.EMAIL_BACKEND === "mock"`, otherwise `ResendMessenger` (requires
  `RESEND_API_KEY`).
- `EMAIL_KV` binding added to wrangler.toml for all envs
  (dev/preview/production). `EMAIL_FROM_ADDRESS` env var controls the `from`
  field.
- No nodemailer, no SMTP imports. No runtime FS access. Verification codes never
  logged in plain text.

## T15 — R2AttachmentStorage

- `R2AttachmentStorage` in `packages/worker/src/attachments/r2.ts` — implements
  `AttachmentStorage` interface using R2 bucket + D1 metadata per ADR-006. No
  fs/S3 SDK imports; Workers runtime `R2Bucket` API only.
- **Object key scheme**: `att/<vault_id>/<attachment_id>` — provides partition
  isolation and URL-safe characters.
- **Upload order**: D1 INSERT first → R2 PUT second. R2 failure triggers
  compensating D1 DELETE (up to 3 retries), then orphan logged to `orphan_log`.
- **Delete order**: R2 DELETE first (idempotent) → D1 DELETE second. D1 failure
  after R2 is clean records orphan for cron sweep.
- **Size enforcement**: 25 MB `MAX_ATTACHMENT_SIZE` checked before any I/O. 5 MB
  `SIGNED_URL_THRESHOLD` triggers direct-to-R2 signed URL path for large files
  (>5 MB) to bypass Worker body-size limits.
- **SHA-256 hash**: computed from encrypted bytes, stored in both D1 `hash`
  column and R2 `customMetadata.hash` for O(1) integrity verification.
- **Signed URL methods** (`createUploadUrl`, `confirmUpload`,
  `createDownloadUrl`): use `bucket.createSignedUrl()` Workers runtime API with
  15 min TTL. `confirmUpload` is the D1-only step after client direct-to-R2 PUT
  completes.
- **Orphan handling**: `recordOrphan(db, r2Key, reason)` writes to `orphan_log`
  table. Reasons: `put_rollback_failed`, `delete_d1_failed`,
  `confirm_d1_failed`, `delete_all_d1_failed`. Schema at
  `packages/worker/src/storage/schema.ts`: `id` (AI PK), `r2_key`, `orphaned_at`
  (Unix ms), `reason`.
- **`orphan_log`** added to `DOMAIN_TABLES` in `d1.ts` for `clear()` support.
- `@cloudflare/workers-types` errors in LSP diagnostics are dev-environment
  missing deps — wrangler injects these types at runtime in actual Worker
  deployment.
- **WorkerCryptoProvider stub conflict**: the Worker package has a stub
  `crypto.ts` whose `sha256Hex` signature clashed with a local helper. Solved by
  making `sha256Hex` in `r2.ts` a local private function using
  `crypto.subtle.digest("SHA-256", buffer)` directly.
- **Uint8Array type widening**: `crypto.subtle.digest` accepts `BufferSource`
  but `Uint8Array<ArrayBufferLike>` (TypeScript 5.6+) is not assignable to
  `ArrayBufferView<ArrayBuffer>`. Fix:
  `sha256Hex(input: Uint8Array | ArrayBuffer)` extracts `.buffer as ArrayBuffer`
  to satisfy the type checker.
- **VaultID import**: `VaultID` is not re-exported from
  `@padloc/core/src/attachment` (only `AttachmentID`). Import from
  `@padloc/core/src/vault`.
- **ErrorCode.ERR_INTERNAL** does not exist in the codebase. Use
  `ErrorCode.SERVER_ERROR` for internal errors instead.
- **Lifecycle tests** in `test/r2-lifecycle.ts` + `r2-lifecycle.worker.ts`: 10
  cases covering 1 KB, 5 MB, 25 MB max-size, oversize rejection, delete
  idempotency, R2 failure D1 rollback, getUsage, and signed URL confirm flow.

## T12 follow-up — Worker transport type wiring

- `@cloudflare/workers-types` must be installed as a dev dependency and wired
  via `"types": ["@cloudflare/workers-types"]` in `tsconfig.json`. Without it,
  `D1Database`, `R2Bucket`, `KVNamespace`, `DurableObjectNamespace`, and
  `ExecutionContext` are all unresolved.
- `index.ts` had two bugs: (1) `createServer()` called with no `env` — must be
  `createServer(env)` to wire D1/R2/messenger into the Server. (2) Invalid
  `ExecutionContext` typing via `WorkerGlobalScopeEventMap["fetch"]` conditional
  — just use `ExecutionContext` directly (provided by
  `@cloudflare/workers-types`).
- `test/transport-roundtrip.worker.ts` also uses `ExecutionContext` — same fix
  applies once types are wired.
- `env.ts` requires no code changes — the `Env` interface is correct once
  Cloudflare ambient types are available.
- Transport contract behavior (OPTIONS/CORS, `/healthcheck`, POST `/`, malformed
  JSON error shape, request size limit) preserved unchanged.

## T12 follow-up — malformed tsconfig + missing devDependency

- The prior edit to `tsconfig.json` left a duplicated trailing block (lines
  17-20), making it invalid JSON. Fixed by rewriting the file cleanly.
- `package.json` was missing `@cloudflare/workers-types` in `devDependencies`
  even though `tsconfig.json` referenced it. Added
  `"@cloudflare/workers-types": "^4.20260505.0"` to `devDependencies`.
- Both files now validate as clean JSON. All three Worker target files
  (`index.ts`, `env.ts`, `test/transport-roundtrip.worker.ts`) have zero LSP
  diagnostics.

## T21 — Attachment lifecycle with account/vault flows

- Attachment API wired through
  `Controller.createAttachment/getAttachment/deleteAttachment` in
  `packages/core/src/server.ts`. All three methods call `_requireAuth()` before
  any storage access — unauthenticated requests rejected at transport layer.
- Access check pattern:
  `org ? org.canWrite/canRead(vault, account) : vault.owner === account.id` This
  means cross-account access is impossible: private vault's owner is always the
  account that created it, and org vaults gate on `canRead/canWrite`.
- `R2AttachmentStorage.delete()` is idempotent — early return when no D1 row
  exists (SELECT returns null), no exception thrown for missing attachments.
- Orphan recording covers both directions:
    - R2 exists + no D1 row: `d1_row_missing` reason
    - D1 row exists + no R2 object: `r2_object_missing` reason
    - D1 delete fails after R2 delete: `delete_d1_failed` reason
- Evidence file at `.sisyphus/evidence/task-21-attachment-lifecycle.txt` with 6
  integration tests covering full lifecycle, cross-account block, idempotent
  delete, and orphan cleanup scenarios.

## T22 — Error, idempotency, retry, and edge-case semantics

- New error codes added to `packages/core/src/error.ts`: `DUPLICATE_OPERATION`,
  `RATE_LIMITED`, `STALE_SESSION`, `CLOCK_SKEW`, `PARTIAL_FAILURE`,
  `SERVICE_UNAVAILABLE`.
- `Err` class now has a `status: number` property with `defaultStatus()` mapping
  each code to an HTTP status. `toResponse()` returns sanitized
  `{code, message}` without stack traces; `toRaw()` still includes stack for
  server-side logging.
- `packages/worker/src/error.ts` — `sanitizeError()` wraps unknown exceptions
  into stable `Err` values. SQLite/D1 errors are classified: UNIQUE →
  `DUPLICATE_OPERATION` (409), FK/NOT NULL → `BAD_REQUEST` (400), missing table
  → `SERVER_ERROR` (500). Fetch/network errors → `SERVICE_UNAVAILABLE` (503).
  Rate limit patterns → `RATE_LIMITED` (429). Everything else → generic
  `SERVER_ERROR` with `report: true`.
- `packages/worker/src/error.ts` — `errorResponse()` builds consistent
  `{error: {code, message}}` JSON shape with correct HTTP status. Never exposes
  stack traces or internal details.
- `packages/worker/src/idempotency.ts` — `IdempotencyStore` backed by
  KVNamespace with SHA-256 body hash. 1-hour TTL. Returns cached response with
  `Idempotency-Replayed: true` header on duplicate. No-op when KV unavailable.
- `packages/worker/src/transport.ts` — `WorkerReceiver` now: (1) validates
  request age with configurable `maxRequestAgeMs` + `clockSkewToleranceMs`,
  rejecting stale requests with `CLOCK_SKEW` (400); (2) checks idempotency store
  before handler execution; (3) catches `Err` instances and uses their `status`
  property for HTTP response; (4) sanitizes all other exceptions.
- `packages/worker/src/rate-limiter.ts` — token-bucket rate limiter backed by
  KVNamespace. Per-identity with configurable `maxRequests` (default 100) and
  `windowMs` (default 60s). No-op when KV unavailable.
- 20/20 tests pass in `test/error-semantics.ts` covering: Err passthrough,
  SQLite error classification, unknown error sanitization, fetch error mapping,
  consistent JSON shape, idempotency store/retrieve/miss, malformed JSON
  rejection, Err thrown with correct status, unknown exception sanitization,
  OPTIONS/204, wrong method/405, duplicate request idempotency, clock skew
  rejection, fresh request acceptance, hash determinism, `toResponse()` vs
  `toRaw()` behavior.
- Evidence files: `.sisyphus/evidence/task-22-idempotency.txt`,
  `.sisyphus/evidence/task-22-sanitized-error.txt`,
  `.sisyphus/evidence/task-22-error-semantics.txt`.

## T22 — Error, idempotency, retry, and edge-case semantics

- New error codes added to `packages/core/src/error.ts`: `DUPLICATE_OPERATION`,
  `RATE_LIMITED`, `STALE_SESSION`, `CLOCK_SKEW`, `PARTIAL_FAILURE`,
  `SERVICE_UNAVAILABLE`.
- `Err` class now has a `status: number` property with `defaultStatus()` mapping
  each code to an HTTP status. `toResponse()` returns sanitized
  `{code, message}` without stack traces; `toRaw()` still includes stack for
  server-side logging.
- `packages/worker/src/error.ts` — `sanitizeError()` wraps unknown exceptions
  into stable `Err` values. SQLite/D1 errors are classified: UNIQUE →
  `DUPLICATE_OPERATION` (409), FK/NOT NULL → `BAD_REQUEST` (400), missing table
  → `SERVER_ERROR` (500). Fetch/network errors → `SERVICE_UNAVAILABLE` (503).
  Rate limit patterns → `RATE_LIMITED` (429). Everything else → generic
  `SERVER_ERROR` with `report: true`.
- `packages/worker/src/error.ts` — `errorResponse()` builds consistent
  `{error: {code, message}}` JSON shape with correct HTTP status. Never exposes
  stack traces or internal details.
- `packages/worker/src/idempotency.ts` — `IdempotencyStore` backed by
  KVNamespace with SHA-256 body hash. 1-hour TTL. Returns cached response with
  `Idempotency-Replayed: true` header on duplicate. No-op when KV unavailable.
- `packages/worker/src/transport.ts` — `WorkerReceiver` now: (1) validates
  request age with configurable `maxRequestAgeMs` + `clockSkewToleranceMs`,
  rejecting stale requests with `CLOCK_SKEW` (400); (2) checks idempotency store
  before handler execution; (3) catches `Err` instances and uses their `status`
  property for HTTP response; (4) sanitizes all other exceptions.
- `packages/worker/src/rate-limiter.ts` — token-bucket rate limiter backed by
  KVNamespace. Per-identity with configurable `maxRequests` (default 100) and
  `windowMs` (default 60s). No-op when KV unavailable.
- 20/20 tests pass in `test/error-semantics.ts` covering: Err passthrough,
  SQLite error classification, unknown error sanitization, fetch error mapping,
  consistent JSON shape, idempotency store/retrieve/miss, malformed JSON
  rejection, Err thrown with correct status, unknown exception sanitization,
  OPTIONS/204, wrong method/405, duplicate request idempotency, clock skew
  rejection, fresh request acceptance, hash determinism, `toResponse()` vs
  `toRaw()` behavior.
- Evidence files: `.sisyphus/evidence/task-22-idempotency.txt`,
  `.sisyphus/evidence/task-22-sanitized-error.txt`,
  `.sisyphus/evidence/task-22-error-semantics.txt`.

## T25 — Cloudflare Runbooks

### Runbook Document

Created `docs/ops/cloudflare-runbooks.md` — agent-executable runbooks for:

- **Deploy Preview**: `wrangler deploy --env=preview` + health verification
- **Promote Production**: `wrangler deploy --env=production` with pre-promotion
  health gate
- **Rollback**: `wrangler rollback --env=production --version=<id>` or re-deploy
  previous commit
- **D1 Migrations**: `wrangler d1 migrations apply <db> --remote --env=<env>`
- **D1 Backup**: `wrangler d1 export` → upload to R2 `d1-backups/` prefix
- **R2 Backup**: `wrangler r2 object list/get/put` for attachment objects
- **Resend Rotation**:
  `echo "key" | wrangler secret put RESEND_API_KEY --env=production`
- **Cloudflare Secrets**: `wrangler secret put <NAME> --env=production` for all
  secrets

### Runbook Design Principles

- Every command includes expected output or verification step
- Rollback is never undefined — always has either `wrangler rollback` or git
  re-deploy path
- No dashboard-only critical paths — all operations use wrangler CLI
- Migration forward-only; rollback via new revert migration
- Secrets reload on next request (no restart required)
- Pre-deploy health gate prevents bad production promotion

### Secrets Inventory (Production)

| Secret               | Purpose                    | Rotation Command                                                                 |
| -------------------- | -------------------------- | -------------------------------------------------------------------------------- |
| `RESEND_API_KEY`     | Resend transactional email | `echo "key" \| wrangler secret put RESEND_API_KEY --env=production`              |
| `EMAIL_FROM_ADDRESS` | From address for email     | `echo "addr" \| wrangler secret put EMAIL_FROM_ADDRESS --env=production`         |
| `WEBAUTHN_RP_ID`     | WebAuthn RP ID             | `echo "padloc.app" \| wrangler secret put WEBAUTHN_RP_ID --env=production`       |
| `WEBAUTHN_RP_NAME`   | WebAuthn RP name           | `echo "Padloc" \| wrangler secret put WEBAUTHN_RP_NAME --env=production`         |
| `ALLOW_ORIGIN`       | CORS origin (optional)     | `echo "https://padloc.app" \| wrangler secret put ALLOW_ORIGIN --env=production` |

### Rollback Mechanics

Cloudflare Workers are immutable once deployed. `wrangler rollback` redirects
traffic to a previous deployment without re-uploading code. The deployment
history is retained and can be listed via
`wrangler deployments list --env=production`. If `wrangler rollback` is
unavailable (older wrangler), re-deploy from previous git commit:
`git checkout <sha> && wrangler deploy --env=production && git checkout -`.

### D1 Export + R2 Storage Pattern

D1 exports are SQLite database dumps created via `wrangler d1 export`. Upload to
R2 via `wrangler r2 object put`. Backup prefix: `d1-backups/`. Nightly backup
can be automated via Cloudflare Cron triggering a Worker endpoint.

### Evidence

Evidence file: `.sisyphus/evidence/task-25-cloudflare-runbooks.txt`

## T25 — Cloudflare Worker Runbooks

- Runbooks document all critical ops: deploy preview, promote production,
  rollback, D1 migrations, D1/R2 backup, secret rotation.
- Every command includes expected output and verification step.
- `wrangler versions rollback` is the agent-executable rollback mechanism — no
  dashboard required.
- `wrangler d1 export` creates SQL dump files for D1 backup.
- `wrangler secret put` accepts stdin
  (`printf "key" | wrangler secret put SECRET --env=production`) enabling
  non-interactive secret rotation in CI.
- R2 backup requires S3-compatible API via AWS CLI — `wrangler r2 object list`
  captures object keys for inventory, but full bucket sync needs `aws s3 sync`.
- Preview deploy must pass health check before promotion to production.
- Secrets: `RESEND_API_KEY`, `EMAIL_FROM_ADDRESS`, `WEBAUTHN_RP_ID`,
  `WEBAUTHN_RP_NAME`, `ALLOW_ORIGIN`.
- Worker deployment via `wrangler deploy --env=production` — no GitHub Actions
  Worker step exists yet in `publish-release.yml`.
- Runbooks at `docs/ops/cloudflare-runbooks.md`.
- Evidence at `.sisyphus/evidence/task-25-cloudflare-runbooks.txt`.

## T26 — Observability, Security Hardening, Abuse Controls

### Log Redaction

Created `packages/worker/src/observability/log-redaction.ts` implementing:

- Field-level redaction using regex patterns for sensitive data
- Redacts: passwords, verifiers, SRP values (x, a, b, A, B, K, M1, M2),
  private/public keys, session keys, HMAC keys, encryption keys, vault data,
  encrypted data, ciphertext, auth proofs, session tokens, attachment data
- `[REDACTED]` sentinel for all sensitive values
- Recursive traversal of nested objects/arrays
- `redact()`, `structuredLog()`, `redactRequest()`, `redactError()` utilities
- Error messages always redacted to `[REDACTED]` — internal messages never
  exposed

**Key design**: Redacts at the field level, preserving structure for debugging.
Never log plaintext vault data, secrets, auth proofs, or master-password-derived
material.

### Security Headers

Created `packages/worker/src/observability/security-headers.ts` providing:

- `DEFAULT_SECURITY_HEADERS`: X-Content-Type-Options, X-Frame-Options,
  X-XSS-Protection, Referrer-Policy, Permissions-Policy, CSP, HSTS,
  Cache-Control
- `corsHeaders()`: configurable allowOrigin, allowMethods, allowHeaders, maxAge
- `securityHeaders()`: overridable HSTS and CSP directives
- `responseHeaders()`: combines CORS + security + extra headers
- `generateRequestId()`: `${Date.now()}-${random}` format for audit trails
- `CfAnalytics` interface for Cloudflare analytics hooks (request, security,
  audit events)
- `VoidCfAnalytics`: no-op implementation

### Rate Limiting

Token-bucket rate limiter already existed at
`packages/worker/src/rate-limiter.ts`:

- Backed by KVNamespace, per-identity with configurable `maxRequests`
  (default 100) and `windowMs` (default 60000ms)
- Returns `{ allowed, remaining, retryAfterMs? }`
- No-op when KV unavailable (always allows)
- Created `packages/worker/test/rate-limit-test.ts`: 7/7 tests pass covering:
  first request allowed, exhaustion, independent buckets, window reset, no-KV
  behavior, defaults, retry-after bounds

**Rate limit documentation** at `.sisyphus/evidence/task-26-rate-limit.txt`:

- Integration checklist: wire into WorkerReceiver, apply to sensitive endpoints,
  consider account+IP dual-keying, add rate limit headers to all responses
- Security notes: not protection against distributed attacks (use Cloudflare
  DDoS protection)

### Security Headers Documentation

Evidence at `.sisyphus/evidence/task-26-security-headers.txt`:

- Default headers: nosniff, DENY, 1; mode=block,
  strict-origin-when-cross-origin, disabled features
- CSP: default-src 'self', script-src 'self', frame-ancestors 'none'
- Production: ALLOW_ORIGIN should be specific domain (not "\*")
- Verification checklist: headers present, CORS locked, request IDs correlated

### Backup/Recovery Proof

Created `scripts/proof-lanes/proof-backup-recovery.sh`:

- Verifies D1 schema: accounts, auth, sessions, vaults, orgs, org_members,
  invites, key_store_entries, attachments, email_verifications
- Tests D1 data integrity (SELECT COUNT)
- Verifies R2 bucket connectivity (object listing)
- Checks audit tables exist (change_log, request_log)
- Optional KV namespace verification
- Output: evidence file at `.sisyphus/evidence/task-26-backup-recovery.txt`
- Usage:
  `./proof-backup-recovery.sh --env dev --d1 padloc-dev --r2 padloc-attachments-dev`

### Evidence Files

- `.sisyphus/evidence/task-26-redaction-test.txt` — redaction patterns and test
  results
- `.sisyphus/evidence/task-26-rate-limit.txt` — rate limiting spec and
  integration checklist
- `.sisyphus/evidence/task-26-security-headers.txt` — security headers and CORS
  policy
- `.sisyphus/evidence/task-26-backup-recovery.txt` — generated by
  proof-backup-recovery.sh (when run)

### Implementation Notes

- D1 storage currently logs `console.log` with raw data including email in stack
  traces (d1.ts:159) — must be updated to use `redact()` before production
- Rate limiter is defined but not yet wired into WorkerReceiver middleware
- `ChangeLogger` and `RequestLogger` from core exist but not wired in
  server-factory
- Cloudflare analytics hooks are interface-only (VoidCfAnalytics) — real
  implementation would send to Cloudflare Analytics API or external service
- No Mixpanel-style analytics added (per MUST NOT requirements)

## T26 — Observability, Security Hardening, and Abuse Controls

### Log Redaction (`packages/worker/src/observability/log-redaction.ts`)

- Deep field-level redaction using regex patterns for sensitive fields
- Covers: passwords, verifiers, SRP values (x, a, b, A, B, K, M1/M2), salts, all
  key types (private, public, signing, HMAC, AES, RSA, session), vault data
  (encrypted/plaintext), ciphertext, auth proofs, session/srpsession
- `redact()` recursively traverses objects/arrays, replaces sensitive values
  with `[REDACTED]`
- `structuredLog()` for safe audit logging with request context (requestId,
  accountId, sessionId, ipAddress)
- `redactError()` always returns `[REDACTED]` for error messages to prevent user
  input leakage
- Null-safe, handles null/undefined gracefully

### Rate Limiter (`packages/worker/src/rate-limiter.ts`)

- Token-bucket algorithm backed by KVNamespace
- Per-identity with configurable `maxRequests` (default 100) and `windowMs`
  (default 60s)
- Key format: `rl:{identity}`, TTL: `windowMs/1000 + 60`
- Fail-open: no-op when KV unavailable (prevents limiter from being a SPOF)
- Returns `{ allowed, remaining, retryAfterMs? }`
- Test coverage: 7/7 tests at `packages/worker/test/rate-limit-test.ts` covering
  exhaustion, window reset, no-KV behavior, independent buckets

### Security Headers (`packages/worker/src/observability/security-headers.ts`)

- CORS: configurable allowOrigin, methods [OPTIONS, POST], headers
  [Content-Type], maxAge 86400
- Security headers: X-Content-Type-Options, X-Frame-Options, X-XSS-Protection,
  Referrer-Policy, Permissions-Policy, CSP (strict allowlist), HSTS (1 year +
  includeSubDomains), Cache-Control/Pragma for no-store
- `generateRequestId()` for audit trail: `timestamp-random` format
- CfAnalytics interface for Cloudflare Analytics hooks (VoidCfAnalytics no-op
  default)
- Event types: request, security (rate_limited/blocked/suspicious), audit

### Transport Layer (`packages/worker/src/transport.ts`)

- CORS headers via `corsHeaders()` on all responses
- `Idempotency-Replayed` header on cache hits
- Request age validation via `validateRequestAge()` with `maxRequestAgeMs` +
  `clockSkewToleranceMs`
- `sanitizeError()` in `error.ts` prevents internal error details leakage

### Backup/Recovery Proof (`scripts/proof-lanes/proof-backup-recovery.sh`)

- Verifies D1 schema integrity (10+ tables including audit tables)
- Tests R2 bucket connectivity via `bucket.list()`
- Checks KV namespace accessibility for rate limiter
- Generates evidence at `.sisyphus/evidence/task-26-backup-recovery.txt`
- Usage:
  `--env dev --d1 padloc-dev --r2 padloc-attachments-dev [--kv KV_NAMESPACE]`

### What Was NOT Done (Per Task Constraints)

- No Mixpanel-style product analytics
- No Mixpanel/telemetry SDK added
- Logs never contain plaintext vault data, secrets, auth proofs, or
  master-password-derived material

### Evidence Files

- `.sisyphus/evidence/task-26-log-redaction.txt` — log redaction patterns and
  API
- `.sisyphus/evidence/task-26-rate-limiting.txt` — rate limiter algorithm and
  test results
- `.sisyphus/evidence/task-26-security-headers.txt` — CORS, security headers, CF
  analytics
- `.sisyphus/evidence/task-26-backup-recovery.txt` — D1/R2 backup proof script

## T19 — Vault, organization, and sync flows

### D1Storage Upsert Bug

Drizzle ORM's `onConflictDoUpdate({ target: "id", ... })` generates
`ON CONFLICT("id")` which D1's SQLite rejects with
`ON CONFLICT clause does not match any PRIMARY KEY or UNIQUE constraint: SQLITE_ERROR`.
The fix uses raw SQL `INSERT INTO ... ON CONFLICT(id) DO UPDATE SET ...` via the
underlying D1 client (`db.session.client.prepare().bind().run()`).

### Denormalized Column Extraction

The D1 schema has denormalized columns (email, created_at, owner_account_id,
etc.) for indexed lookups. The raw SQL upsert must extract these from the
`toRaw()` JSON and include them in the INSERT/UPDATE. Each table has its own SQL
template with the correct column set.

### AccountLockDO Export

The `AccountLockDO` class must be exported from `packages/worker/src/index.ts`
for wrangler to find it. Without the export, wrangler fails with
`AccountLockDO not exported in your entrypoint file`.

### Email Verification for Testing

`EMAIL_VERIFY_ON_SIGNUP = "false"` in `[env.dev.vars]` allows test account
creation without email verification tokens. Production should keep this enabled.

### SRP Auth Flow

The full SRP flow requires: (1) account.initialize → (2) auth.getAuthKey → (3)
SRPClient.initialize(authKey) → (4) createAccount with verifier → (5)
startCreateSession → (6) derive x from password+salt → (7)
SRPClient.initialize(x) + setB → (8) completeCreateSession with A, M1. The SRP
Client's A, M1, K getters already return Uint8Array via the internal `i2b()`
conversion — no manual BigInteger-to-bytes needed.

### PBKDF2 Performance

Default Padloc uses 1M PBKDF2 iterations which takes ~128ms per call in Worker
runtime. For E2E tests, reduce to 10k iterations by setting
`account.keyParams.iterations` and `auth.keyParams.iterations` BEFORE calling
`initialize()`/`getAuthKey()`.

### Evidence Files

- `.sisyphus/evidence/task-19-vault-crud.txt` — vault CRUD implementation and D1
  fix
- `.sisyphus/evidence/task-19-unauthorized-vault.txt` — authorization model and
  test coverage

## T19 — Vault, organization, and sync flows

### D1Storage Upsert Bug

Drizzle ORM's `onConflictDoUpdate({ target: "id", ... })` generates
`ON CONFLICT("id")` which D1's SQLite rejects with
`ON CONFLICT clause does not match any PRIMARY KEY or UNIQUE constraint: SQLITE_ERROR`.
The fix uses raw SQL `INSERT INTO ... ON CONFLICT(id) DO UPDATE SET ...` via the
underlying D1 client (`db.session.client.prepare().bind().run()`).

### Denormalized Column Extraction

The D1 schema has denormalized columns (email, created_at, owner_account_id,
etc.) for indexed lookups. The raw SQL upsert must extract these from the
`toRaw()` JSON and include them in the INSERT/UPDATE. Each table has its own SQL
template with the correct column set.

### AccountLockDO Export

The `AccountLockDO` class must be exported from `packages/worker/src/index.ts`
for wrangler to find it. Without the export, wrangler fails with
`AccountLockDO not exported in your entrypoint file`.

### Email Verification for Testing

`EMAIL_VERIFY_ON_SIGNUP = "false"` in `[env.dev.vars]` allows test account
creation without email verification tokens. Production should keep this enabled.

### SRP Auth Flow

The full SRP flow requires: (1) account.initialize → (2) auth.getAuthKey → (3)
SRPClient.initialize(authKey) → (4) createAccount with verifier → (5)
startCreateSession → (6) derive x from password+salt → (7)
SRPClient.initialize(x) + setB → (8) completeCreateSession with A, M1. The SRP
Client's A, M1, K getters already return Uint8Array via the internal `i2b()`
conversion — no manual BigInteger-to-bytes needed.

### PBKDF2 Performance

Default Padloc uses 1M PBKDF2 iterations which takes ~128ms per call in Worker
runtime. For E2E tests, reduce to 10k iterations by setting
`account.keyParams.iterations` and `auth.keyParams.iterations` BEFORE calling
`initialize()`/`getAuthKey()`.

### Evidence Files

- `.sisyphus/evidence/task-19-vault-crud.txt` — vault CRUD implementation and D1
  fix
- `.sisyphus/evidence/task-19-unauthorized-vault.txt` — authorization model and
  test coverage
