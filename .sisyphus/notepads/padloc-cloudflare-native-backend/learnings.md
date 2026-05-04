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
