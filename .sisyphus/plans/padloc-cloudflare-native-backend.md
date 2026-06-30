# Padloc Cloudflare-Native Backend Rewrite Plan

## TL;DR

> **Quick Summary**: Build a Worker-native replacement for Padloc's Node backend
> while preserving the current client/API contract as much as possible. This is
> a contract-preserving backend rewrite using D1, R2, KV, Durable Objects only
> where justified, Resend, and Wrangler-based Cloudflare deployment.
>
> **Deliverables**:
>
> -   Cloudflare Worker API compatible with Padloc PWA/Cordova clients
> -   D1 schema and storage adapters for authoritative metadata
> -   R2 attachment backend with orphan/partial-failure handling
> -   Resend email messenger replacement
> -   Worker-compatible crypto/auth parity harness and implementation
> -   Migration/import tooling for legacy server fixtures
> -   Cloudflare deployment, rollback, secrets, and verification lanes
>
> **Estimated Effort**: XL **Parallel Execution**: YES - 5 implementation
> waves + final verification **Critical Path**: T1 protocol inventory -> T2
> crypto vectors -> T5 proof lanes -> T6 Worker bootstrap -> T8 D1 schema -> T13
> Worker crypto -> T14 D1 storage -> T18 account/login -> T24 client proof ->
> Final verification

---

## Context

### Original Request

The user wants to create a private personal fork of Padloc and replace 1Password
wholesale, but with every hosted component on Cloudflare. The existing
VPS/LXC/Docker/DigitalOcean options are explicitly not desired. The target
architecture should use Resend for email, R2 for attachment storage, and
Cloudflare Worker-compatible data stores/APIs.

### Interview Summary

**Key Discussions**:

-   Existing Padloc server cannot be hosted on Cloudflare Workers unchanged.
-   Existing backend is Node 16.x TypeScript with custom HTTP transport, storage
    backends for LevelDB/MongoDB/Postgres, fs/S3 attachments, nodemailer SMTP,
    and Node platform/crypto code.
-   Existing frontend/mobile clients can probably be reused if the current RPC
    contract is preserved.
-   User prefers Cloudflare-native hosting cleanliness over easier self-hosted
    deployment.

**Research Findings**:

-   `packages/core/src/api.ts` is the API contract inventory.
-   `packages/core/src/server.ts` contains central controller logic and must be
    treated as the business-behavior reference.
-   `packages/core/src/transport.ts` defines Request/Response transport seams.
-   Existing Node backend wiring is in `packages/server/src/init.ts`.
-   Existing HTTP receiver uses Node `http` in
    `packages/server/src/transport/http.ts`.
-   Existing storage/attachment/email integrations live under
    `packages/server/src/storage`, `packages/server/src/attachments`, and
    `packages/server/src/email`.
-   Mobile is Cordova, not React Native, and wraps the web app; preserving
    server contract is the fastest mobile path.

### Metis Review

**Identified Gaps** (addressed):

-   Add feature scope matrix for v1/defer/drop.
-   Add storage decision record per domain object.
-   Add transactionality audit before assuming D1-only semantics.
-   Add crypto parity milestone before Worker implementation.
-   Add contract-proof, crypto-proof, client-proof, and migration-proof lanes.
-   Explicitly forbid hidden hybrid hosting and `nodejs_compat` as the main
    strategy.

---

## Critical Review Findings (Holes Plugged in Revision)

These were missing or under-specified in the prior version of the plan and are
load-bearing for the rewrite. Each is now wired into a concrete task below.

1. **In-memory `_requestQueue` at `packages/core/src/server.ts:2188`**. The
   current `Server.handle()` serializes per-account and per-org via a
   process-local `Map<AccountID | OrgID, Promise<void>>`. Cloudflare Workers are
   stateless across invocations — this lock is silently lost. The plan now
   commits to a Durable Object per `AccountID` and per `OrgID` as the
   serialization owner (see Storage Decision Record + T11 + T17), not a "maybe
   DO later" deferral.

2. **Provisioner is woven into the Controller at ~15 call sites**.
   `provisioner.getProvisioning()`, `accountEmailChanged()`, `accountDeleted()`,
   `orgDeleted()`, `orgOwnerChanged()` are called from authentication, account,
   and org flows in `packages/core/src/server.ts`. "Drop Stripe v1" is not
   enough — a `StubProvisioner` returning permissive defaults must be wired in,
   otherwise account creation/session completion fails. New task T11.5.

3. **PWA bakes `PL_SERVER_URL` at build time** (`packages/app/src/globals.ts:6`
   — `new AjaxSender(process.env.PL_SERVER_URL!)`). Pointing the PWA at a Worker
   preview is a **rebuild**, not a runtime env change. T24 now spells out the
   rebuild step.

4. **Reuse vs rewrite**. `packages/core/src/server.ts` is 2,307 lines and
   contains the `Controller` business logic. The Worker package **reuses**
   `Controller`/`Server`/SRP/encoding from `packages/core` and only swaps the
   injected dependencies (`Storage`, `Messenger`, `AttachmentStorage`,
   `CryptoProvider`, `Platform`). T6/T12/T13 now state this explicitly so a
   junior developer does not reimplement business logic.

5. **API is decorator-driven** (`@Handler(ParamType, ResponseType)` on
   `class API` in `packages/core/src/api.ts`). The contract inventory in T1 is
   produced by reading the `handlerDefinitions` reflection table, not by manual
   transcription. ~39–45 handlers expected.

6. **Worker CPU and body-size budgets**. PBKDF2 at 1M iterations + RSA-PSS + SRP
   runs per login. Workers Free CPU ≈ 10ms, Workers Paid wall clock 30s but CPU
   ≈ 30s. Free request body cap is 100MB; paid is higher. Padloc's current
   `maxRequestSize` default is 1GB. T13 now requires CPU budget measurement;
   T9/T15 commit to a 25MB single-request attachment cap with
   client-direct-to-R2 signed-URL upgrade path documented (no client breakage in
   v1, just a cap).

7. **Wrangler `compatibility_date` and flags must be pinned**. WebCrypto and
   `crypto.subtle.timingSafeEqual` availability vary by date. T7 now requires
   `compatibility_date` and the explicit flag set.

8. **D1 transaction model**. D1 supports `db.batch([...])` for atomic batches
   and bookmarks for read-after-write, but **not** open multi-statement
   transactions held across awaits. T11 names this constraint. The
   `_requestQueue` need (#1) follows directly from this.

9. **Templates loaded via `readFileSync` at boot in
   `packages/server/src/email/smtp.ts`**. Workers have no filesystem; T16 now
   requires templates to be `import`-bundled as TS string constants by the
   Worker build, not loaded from disk.

10. **Existing security finding**: SRP M1 verification in
    `packages/core/src/srp.ts` uses `===` byte-string equality, not constant
    time. Worker rewrite must replace with `crypto.subtle.timingSafeEqual` (or a
    manual constant-time compare). Tracked in T13.

11. **Old WebAuthn dep**: `@simplewebauthn/server@5.4.3` is several majors
    behind. T20 now requires either a runtime smoke in Workers OR upgrading to
    the current major before declaring WebAuthn parity.

12. **Build pipeline**: Padloc is a Lerna monorepo with no TypeScript project
    references. The Worker package builds via Wrangler's bundler (esbuild) with
    `packages/core` consumed as a workspace dependency. T6 specifies this so the
    junior dev does not invent a new build chain.

---

## Concrete Architecture & Code Reuse Map

The Worker package is a **thin shell around `packages/core`**. Junior developers
should not rewrite the Padloc business logic — they should plug Worker-native
adapters into the existing core seams.

```
packages/worker/  (new)
├── src/
│   ├── index.ts             # fetch(request, env, ctx) entrypoint
│   ├── env.ts               # Env type for D1/R2/KV/DO bindings + secrets
│   ├── transport.ts         # Marshal Request/Response via core encoding
│   ├── platform.ts          # WorkerPlatform (extends core Platform)
│   ├── crypto.ts            # WorkerCryptoProvider (uses crypto.subtle)
│   ├── storage/
│   │   ├── d1.ts            # D1Storage implements core Storage interface
│   │   └── schema.ts        # Drizzle schema (or raw SQL migrations)
│   ├── attachments/
│   │   └── r2.ts            # R2AttachmentStorage implements AttachmentStorage
│   ├── email/
│   │   ├── resend.ts        # ResendMessenger implements core Messenger
│   │   └── templates.ts     # Bundled HTML/text templates as ts strings
│   ├── auth/
│   │   ├── webauthn.ts      # @simplewebauthn/server invocation
│   │   └── totp.ts          # TOTP via core
│   ├── provisioner/
│   │   └── personal.ts      # StubProvisioner with permissive defaults
│   ├── locks/
│   │   └── account-lock.ts  # Durable Object replacing _requestQueue
│   ├── logging.ts           # Workers-friendly Logger implementation
│   └── server-factory.ts    # Wires core Server with all adapters above
├── migrations/              # D1 SQL migrations (numbered)
├── wrangler.toml
├── package.json             # depends on @padloc/core via workspace
└── tsconfig.json
```

Reused unchanged from `packages/core`: `api.ts` (the `@Handler` contract),
`server.ts` (`Server` and `Controller` classes), `encoding.ts`
(marshal/unmarshal), `srp.ts` (with the `===` → constant-time fix), `vault.ts`,
`org.ts`, `account.ts`, `session.ts`, `auth.ts`, `attachment.ts`, `error.ts`,
`messenger.ts`, `storage.ts`, `platform.ts`, `crypto.ts`.

Replaced for Worker runtime: `packages/server/src/init.ts`, `transport/http.ts`,
`storage/*`, `attachments/*`, `email/*`, `platform/node.ts`, `crypto/node.ts`,
`provisioning/*`, `scim.ts`, `logging/*` (Cloudflare Logs / Logpush instead).

---

## Local Dev Bootstrap (Junior-Developer Quickstart)

Run these in order from repo root unless noted. Every command's expected
artifact or output is named so failure is unambiguous.

```bash
# 1. Workspace setup
nvm use 16                       # Padloc currently targets Node 16
npm install                      # Lerna bootstraps all packages
npx lerna bootstrap              # Symlink workspace deps

# 2. Confirm baseline tests pass before changing anything
cd packages/core && npm test     # core tests pass
cd ../server && npm test         # server tests pass

# 3. Cloudflare tooling
npm install -g wrangler          # or `npx wrangler`
wrangler --version               # >= 3.x required
wrangler login                   # opens browser; one-time

# 4. Create Worker package skeleton (T6)
mkdir -p packages/worker/{src,migrations}
# package.json, wrangler.toml, tsconfig.json — see T6

# 5. Create D1 + R2 + KV resources (T7)
wrangler d1 create padloc-dev
wrangler r2 bucket create padloc-attachments-dev
wrangler kv:namespace create PADLOC_HINTS_DEV
# Capture IDs into wrangler.toml [[d1_databases]] / [[r2_buckets]] / [[kv_namespaces]]

# 6. Apply migrations
wrangler d1 migrations apply padloc-dev --local   # local SQLite first
wrangler d1 migrations apply padloc-dev --remote  # then remote D1

# 7. Local dev loop
cd packages/worker
wrangler dev --local             # SQLite + local R2 — fast iteration
wrangler dev --remote            # real D1/R2 — required for proof lanes

# 8. Point PWA at Worker preview (T24)
cd ../pwa
PL_SERVER_URL=https://padloc-worker-dev.<acct>.workers.dev npm run build
# PL_SERVER_URL is baked at build time — there is no runtime override.
npm run serve                    # PWA at http://localhost:8080
```

---

## Work Objectives

### Core Objective

Create a Cloudflare-native Padloc backend fork that runs without Node server
hosting and remains compatible with existing Padloc clients wherever feasible.

### Concrete Deliverables

-   `packages/worker` or equivalent Worker backend package.
-   `wrangler.toml` and Cloudflare environment bindings for dev/staging/prod.
-   D1 migrations and schema ownership map.
-   R2-backed attachment implementation.
-   Resend-backed messenger/email implementation.
-   Worker-compatible crypto/platform/auth implementation.
-   Compatibility test harness around current Padloc API and existing clients.
-   Migration/import tooling from existing Padloc exports or server storage
    fixtures.
-   Runbooks for deploy, rollback, backup/export, schema migration, and secret
    rotation.

### Definition of Done

-   [x] Every API method in `packages/core/src/api.ts` has a disposition:
        implemented, deferred, or intentionally dropped.
-   [ ] Existing PWA can register, log in, create vault items, sync,
        upload/download/delete attachments, and log out against a Cloudflare
        preview Worker. **BLOCKED**: Requires deployed Worker preview URL.
-   [ ] Cordova client can perform login and vault CRUD against the Worker
        endpoint using scripted/mobile-safe checks or browser-equivalent proof
        where device build is unavailable. **BLOCKED**: Requires deployed Worker
        preview URL.
-   [x] Crypto/auth parity tests pass in Worker runtime, not just Node.
-   [x] D1/R2/KV/DO ownership and consistency semantics are documented and
        tested.
-   [x] No Node server, TCP DB driver, local filesystem, nodemailer SMTP,
        LevelDB, MongoDB, or Postgres runtime dependency remains in the
        Cloudflare backend.

### Must Have

-   Worker-native runtime, not Node backend behind Cloudflare.
-   Resend for transactional email.
-   R2 for attachments.
-   D1 as primary metadata store unless a specific flow requires Durable Object
    coordination.
-   KV only for non-authoritative short-lived data.
-   API compatibility harness before broad implementation.
-   Clear v1 feature cut line.

### Must NOT Have (Guardrails)

-   No VPS/LXC/Docker/sidecar backend dependency.
-   No `nodejs_compat`-only half-port of existing Node server.
-   No KV as source of truth for auth/session/vault metadata.
-   No untracked API contract drift.
-   No billing/SCIM/analytics rebuild in v1 unless explicitly reclassified.
-   No manual-only acceptance criteria.

---

## Feature Scope Matrix

| Feature Area                 | v1 Status             | Notes                                                                                                                                       |
| ---------------------------- | --------------------- | ------------------------------------------------------------------------------------------------------------------------------------------- |
| Account create/login/session | Required              | Preserve current client flow.                                                                                                               |
| Vault CRUD/sync              | Required              | Must work from PWA.                                                                                                                         |
| Organizations/shared vaults  | Required-core         | Implement the existing client-visible organization/shared-vault API paths needed for compatibility; defer enterprise admin/SCIM extensions. |
| Attachments                  | Required              | R2 backend, explicit max size and orphan cleanup.                                                                                           |
| Email verification/invites   | Required              | Resend API.                                                                                                                                 |
| TOTP                         | Required              | Include because it is part of password-manager replacement/MFA parity.                                                                      |
| WebAuthn                     | Required-parity-gated | Must pass parity proof; if library incompatibility blocks implementation, produce explicit client-safe deferral ADR before merging.         |
| OAuth auth/provisioning      | Defer                 | Avoid scope explosion.                                                                                                                      |
| SCIM/directory provisioning  | Defer                 | Enterprise feature.                                                                                                                         |
| Stripe/billing               | Drop-v1               | Private fork does not need commercial billing.                                                                                              |
| Mixpanel/analytics           | Drop-v1               | Prefer Cloudflare logs/observability.                                                                                                       |
| GeoIP local DB               | Drop-v1               | Use CF request metadata later only if needed.                                                                                               |
| Legacy v3 migration          | Defer                 | Migration fixtures required now; full real-data importer only after source data format is confirmed.                                        |

---

## Storage Decision Record

| Domain                             | Store                                                        | Ownership Rule                                                                                                                                                   |
| ---------------------------------- | ------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Accounts/auth metadata             | D1                                                           | Authoritative. Multi-row writes use `db.batch([...])` for atomicity.                                                                                             |
| Sessions                           | D1                                                           | Authoritative. Session row carries `revoked_at`, `expires_at`. Validation reads D1 every request — no KV cache for session truth.                                |
| Email verification codes           | D1                                                           | Code + expiry stored in D1. KV optional rate-limit hint only.                                                                                                    |
| Vault metadata/encrypted payloads  | D1                                                           | Authoritative encrypted blob rows. Per-row size kept under D1's 10 MB row cap; oversized payloads spill to R2 with a D1 pointer row.                             |
| Organization/member/group metadata | D1                                                           | Membership writes batched via `db.batch`. Cross-account reshare flows funneled through DO lock (see locks row).                                                  |
| Attachments binary                 | R2                                                           | Object key: `att/<vault_id>/<attachment_id>`. Lifecycle gated by D1 metadata — write D1 first, R2 second, delete R2 first, D1 second (audit in T9).              |
| Attachment metadata                | D1                                                           | Includes size, hash, R2 key, owning vault. Prevents orphan/ghost ambiguity.                                                                                      |
| Rate-limit hints                   | KV                                                           | Non-authoritative; safe to be stale. Auth bypass is impossible because D1 is the truth surface.                                                                  |
| **Per-account/per-org locks**      | **Durable Objects** (`AccountLockDO`)                        | **Replaces in-memory `_requestQueue` at `packages/core/src/server.ts:2188`. Required, not optional.** One DO id per `AccountID`, one per `OrgID`. See T11 + T17. |
| Provisioner state                  | None (StubProvisioner in code)                               | Personal fork has no billing/SCIM. Stub returns permissive `Provisioning` for all accounts. See T11.5.                                                           |
| Logs/audit events                  | D1 for security-critical events; Cloudflare Logs/Logpush ops | `change_log`, `request_log` in D1 (configurable retention). Ops/debug to Workers Logs.                                                                           |
| Secrets                            | Cloudflare secrets via `wrangler secret put`; Hush optional  | Never hardcoded. Secrets list in T7: `RESEND_API_KEY`, `EMAIL_FROM_ADDRESS`, `WEBAUTHN_RP_ID`, `WEBAUTHN_RP_NAME`.                                               |

---

## Verification Strategy (MANDATORY)

> **ZERO HUMAN INTERVENTION** — ALL verification is agent-executed. No
> exceptions.

### Test Decision

-   **Infrastructure exists**: YES (`npm run test`, package-level
    TypeScript/mocha/Cypress flows exist)
-   **Automated tests**: TDD for new Cloudflare backend and tests-after for
    integration parity where existing tests must be adapted
-   **Framework**: Existing npm/mocha/Cypress plus Wrangler Worker runtime
    tests. Executors may add Vitest/Miniflare only as helper tooling, but final
    Worker proof must run via Wrangler remote/preview, not Node-only mocks.
-   **If TDD**: Each major subsystem follows RED (failing parity/contract test)
    -> GREEN (minimal Worker-native implementation) -> REFACTOR

### QA Policy

Every task MUST include agent-executed QA scenarios. Evidence saved to
`.sisyphus/evidence/task-{N}-{scenario-slug}.{ext}`.

-   **Frontend/UI**: Cypress or Playwright against PWA pointed to Worker preview
    URL.
-   **API/Backend**: Bash/curl against `wrangler dev --remote` or preview
    deployment.
-   **Library/Module**: npm/bun/node test command selected from repo tooling.
-   **Cloudflare Runtime**: Wrangler remote/dev preview proof required for
    Worker-specific behavior.

---

## Execution Strategy

### Parallel Execution Waves

```
Wave 1 (Discovery + contract freeze):
├── T1 API/protocol inventory
├── T2 crypto/auth parity vector inventory
├── T3 Node-only dependency inventory
├── T4 Cloudflare scope/config ADRs
└── T5 test lane bootstrap

Wave 2 (Foundation scaffolding):
├── T6 Worker package/bootstrap
├── T7 Cloudflare runtime config + bindings
├── T8 D1 schema/migrations
├── T9 R2 attachment contract design
├── T10 Resend messenger contract design
└── T11 transactionality/consistency audit

Wave 3 (Core implementations):
├── T11.5 Personal-fork Provisioner stub
├── T12 Worker transport adapter
├── T13 Worker crypto/platform adapter
├── T14 D1 storage implementation
├── T15 R2 attachment implementation
├── T16 Resend email implementation
└── T17 session/rate-limit + AccountLockDO implementation

Wave 4 (Auth + product flows):
├── T18 account creation/login/session flow
├── T19 vault/org CRUD + sync flow
├── T20 WebAuthn/TOTP compatibility path
├── T21 attachment lifecycle integration
└── T22 error/idempotency/retry semantics

Wave 5 (Migration + client/deploy proof):
├── T23 migration/import/export tooling
├── T24 PWA/Cordova compatibility proof
├── T25 Cloudflare deploy/rollback/ops runbooks
├── T26 observability/security hardening
└── T27 deferred feature disposition cleanup

Wave FINAL:
├── F1 Plan compliance audit (oracle)
├── F2 Code quality review
├── F3 Real agent-executed QA
└── F4 Scope fidelity check
```

### Dependency Matrix

-   **T1**: blocks T12, T18, T19, T20, T22, T24
-   **T2**: blocks T13, T18, T20
-   **T3**: blocks T6, T13-T17
-   **T4**: blocks T7, T25, T27
-   **T5**: blocks all implementation tasks T12-T24
-   **T6**: blocked by T3; blocks T12-T17
-   **T7**: blocked by T4; blocks T14-T17, T25
-   **T8**: blocks T14, T18, T19, T21, T23
-   **T9**: blocks T15, T21
-   **T10**: blocks T16, T18
-   **T11**: blocks T14, T17, T18, T19, T22
-   **T12-T17**: block T18-T22
-   **T18-T22**: block T23-T24
-   **T23-T27**: block final verification

### Agent Dispatch Summary

-   **Wave 1**: 5 tasks — T1/T3/T5 `deep`, T2 `ultrabrain`, T4 `writing` +
    `cloudflare-workers-expert` skill
-   **Wave 2**: 6 tasks — T6/T7 `unspecified-high` + `cloudflare-workers-expert`
    skill, T8/T11 `deep`, T9/T10 `unspecified-high`
-   **Wave 3**: 6 tasks — T12/T13/T14 `deep`, T15/T16 `quick` or
    `unspecified-high`, T17 `deep`
-   **Wave 4**: 5 tasks — T18/T19/T20 `deep`, T21/T22 `unspecified-high`
-   **Wave 5**: 5 tasks — T23/T25 `unspecified-high`, T24 `visual-engineering` +
    browser QA, T26 `deep`, T27 `writing`

---

## TODOs

> Implementation + Test = ONE Task. Never separate. EVERY task MUST have
> agent-executed QA scenarios.

-   [x] 1. **Freeze API/protocol inventory from current Padloc core**

    **What to do**:

    -   The Padloc API is **decorator-driven**: every handler is decorated with
        `@Handler(ParamType, ResponseType)` on `class API` in
        `packages/core/src/api.ts`. The decorator populates a
        `handlerDefinitions` reflection table on the class. Generate the
        inventory by reading that table — DO NOT hand-transcribe method names.
        Expected count: ~39–45 handlers (sample: `createAccount`, `getAccount`,
        `updateAccount`, `getAuthInfo`, `startAuthRequest`,
        `completeAuthRequest`, `startCreateSession`, `completeCreateSession`,
        `revokeSession`, `updateAuth`, `createOrg`, `getOrg`, `updateOrg`,
        `deleteOrg`, `createVault`, `getVault`, `updateVault`, `deleteVault`,
        `createAttachment`, `getAttachment`, `deleteAttachment`, `getInvite`,
        `acceptInvite`, `createKeyStoreEntry`, `getKeyStoreEntry`,
        `deleteKeyStoreEntry`, `startRegisterAuthenticator`,
        `completeRegisterAuthenticator`, `deleteAuthenticator`,
        `removeTrustedDevice`, `recoverAccount`, `deleteAccount`, `changeEmail`,
        `getLegacyData`, `deleteLegacyAccount`, `listAccounts`, `listOrgs`,
        `listChangeLogEntries`, `listRequestLogEntries`).
    -   Write a small Node/Bun script (`scripts/inventory-api.ts`) that imports
        `@padloc/core/api` and emits `.sisyphus/contract/api-inventory.json`
        plus `docs/contract/api-inventory.md`. Each row: method name, ParamType,
        ResponseType, v1 disposition (`implemented` | `deferred` | `dropped`),
        rationale, and source line reference.
    -   Capture error shapes from `packages/core/src/error.ts` (the `ErrorCode`
        enum is the canonical list). Map current HTTP error JSON shape from
        `packages/server/src/transport/http.ts:38-50`.
    -   Auth flow inventory from `packages/core/src/server.ts` —
        `Controller.startAuthRequest` → `completeAuthRequest` →
        `startCreateSession` → `completeCreateSession`.

    **Must NOT do**:

    -   Do not change API behavior.
    -   Do not classify a handler as dropped without an explicit rationale
        cross-referenced in the Feature Scope Matrix.
    -   Do not transcribe method names manually — the script is the source of
        truth so drift is detectable on every run.

    **Recommended Agent Profile**:

    -   **Category**: `deep` — contract inventory affects all later work.
    -   **Skills**: [`api-design`]
    -   **Skills Evaluated but Omitted**: `cloudflare-workers-expert` — not yet
        designing runtime, only freezing contract.

    **Parallelization**:

    -   **Can Run In Parallel**: YES
    -   **Parallel Group**: Wave 1
    -   **Blocks**: T12, T18, T19, T20, T22, T24
    -   **Blocked By**: None

    **References**:

    -   `packages/core/src/api.ts` - API DTOs and method contract.
    -   `packages/core/src/server.ts` - Current server behavior and controller
        flow.
    -   `packages/core/src/transport.ts` - Request/Response marshal boundary.
    -   `packages/server/src/transport/http.ts` - Current HTTP POST/healthcheck
        behavior.

    **Acceptance Criteria**:

    -   [x] Contract inventory exists and lists 100% of API methods from
            `packages/core/src/api.ts`.
    -   [x] Each method has a v1 disposition and reference source.
    -   [x] Unknown disposition count is zero.

    **QA Scenarios**:

    ```
    Scenario: Contract inventory completeness
      Tool: Bash
      Preconditions: Repository dependencies available or static parser available.
      Steps:
        1. Extract exported API method/type names from packages/core/src/api.ts.
        2. Compare against the generated contract inventory.
        3. Assert every extracted method/type appears exactly once with disposition.
      Expected Result: Diff is empty and unknown count is 0.
      Failure Indicators: Missing method, duplicate method, or unknown disposition.
      Evidence: .sisyphus/evidence/task-1-contract-inventory.txt

    Scenario: Deferred/dropped endpoint guardrail
      Tool: Bash
      Preconditions: Contract inventory exists.
      Steps:
        1. Search inventory for status "deferred" or "dropped".
        2. Assert every matching row contains a rationale field and replacement/follow-up note.
      Expected Result: Every non-implemented disposition has rationale.
      Evidence: .sisyphus/evidence/task-1-deferred-guardrail.txt
    ```

    **Commit**: YES

    -   Message: `docs(contract): freeze padloc api compatibility inventory`

-   [x] 2. **Add crypto/auth parity vectors before implementation**

    **What to do**:

    -   Capture deterministic vectors for required crypto primitives and auth
        flows used by current Padloc server/client.
    -   Cover SRP/session negotiation, HMAC request signatures, PBES2/AES-GCM,
        RSA wrapping/signing where testable, TOTP, and WebAuthn verifier inputs
        where applicable.
    -   Make the tests fail until Worker-compatible providers pass them.

    **Must NOT do**:

    -   Do not rewrite crypto without parity tests.
    -   Do not accept Node-only tests as sufficient.

    **Recommended Agent Profile**:

    -   **Category**: `ultrabrain` — security-sensitive parity work.
    -   **Skills**: [`llm-evaluation`]
    -   **Skills Evaluated but Omitted**: `cloudflare-workers-expert` — runtime
        comes later; this task defines behavior.

    **Parallelization**:

    -   **Can Run In Parallel**: YES
    -   **Parallel Group**: Wave 1
    -   **Blocks**: T13, T18, T20
    -   **Blocked By**: None

    **References**:

    -   `packages/core/src/srp.ts` - SRP implementation contract.
    -   `packages/core/src/platform.ts` - Crypto provider seam.
    -   `packages/server/src/crypto/node.ts` - Existing Node implementation
        reference.
    -   `security.md` - Design intent for AES-GCM, PBKDF2, RSA, SRP.

    **Acceptance Criteria**:

    -   [x] Crypto parity tests exist and fail under missing Worker provider.
    -   [x] Test vectors are deterministic and documented.
    -   [x] Worker-runtime execution path is defined.

    **QA Scenarios**:

    ```
    Scenario: Crypto parity vector lane executes
      Tool: Bash
      Preconditions: Test files added.
      Steps:
        1. Run the crypto parity test command defined by the task.
        2. Assert output enumerates SRP, HMAC, PBES2/AES-GCM, RSA, and TOTP/WebAuthn dispositions.
        3. Assert failures are only expected RED failures before implementation.
      Expected Result: Tests run deterministically with explicit pass/fail list.
      Evidence: .sisyphus/evidence/task-2-crypto-vectors.txt

    Scenario: Node-only crypto is rejected
      Tool: Bash
      Preconditions: Worker-runtime lane configured or stubbed.
      Steps:
        1. Run the Worker-runtime crypto lane.
        2. Assert it does not import packages/server/src/crypto/node.ts.
      Expected Result: Worker lane proves no Node crypto provider dependency.
      Evidence: .sisyphus/evidence/task-2-no-node-crypto.txt
    ```

    **Commit**: YES

    -   Message: `test(crypto): add worker parity vector harness`

-   [x] 3. **Inventory Node-only dependencies and runtime blockers**

    **What to do**:

    -   Use AST/content search to find imports/usages of `http`, `https`, `fs`,
        `path` runtime access, `Buffer`, Node `crypto`, `stream`, `level`, `pg`,
        `mongodb`, `nodemailer`, AWS S3 SDK, and process/env assumptions.
    -   Produce blocker map: replace, isolate, delete, or keep only outside
        Worker runtime.

    **Must NOT do**:

    -   Do not rely on manual eyeballing only.
    -   Do not treat `nodejs_compat` as resolution.

    **Recommended Agent Profile**:

    -   **Category**: `deep` — whole-runtime coupling analysis.
    -   **Skills**: [`cloudflare-workers-expert`]
    -   **Skills Evaluated but Omitted**: `api-design` — not designing API here.

    **Parallelization**:

    -   **Can Run In Parallel**: YES
    -   **Parallel Group**: Wave 1
    -   **Blocks**: T6, T13-T17
    -   **Blocked By**: None

    **References**:

    -   `packages/server/src/init.ts` - Backend wiring with Node dependencies.
    -   `packages/server/package.json` - Node-only dependency list.
    -   `packages/server/src/storage/*` - DB driver implementations.
    -   `packages/server/src/attachments/*` - fs/S3 attachment implementations.

    **Acceptance Criteria**:

    -   [x] Blocker inventory lists every Node-only dependency and file
            reference.
    -   [x] Each blocker has replacement/disposition.

    **QA Scenarios**:

    ```
    Scenario: Node import inventory reproducible
      Tool: Grep/AST-grep + Bash
      Preconditions: Inventory file exists.
      Steps:
        1. Search for Node-only imports/usages in Worker target paths and legacy server paths.
        2. Compare search results to inventory.
        3. Assert no unclassified blocker remains.
      Expected Result: All found blockers have inventory entries.
      Evidence: .sisyphus/evidence/task-3-node-blockers.txt

    Scenario: Worker target forbids Node-only imports
      Tool: Bash
      Preconditions: Worker package exists or target path stub exists.
      Steps:
        1. Search Worker target for forbidden imports: fs, http, https, level, pg, mongodb, nodemailer.
        2. Assert zero matches except allowlisted dev/test files.
      Expected Result: Zero runtime forbidden imports.
      Evidence: .sisyphus/evidence/task-3-worker-forbidden-imports.txt
    ```

    **Commit**: YES

    -   Message: `docs(runtime): inventory node blockers for worker backend`

-   [x] 4. **Create Cloudflare architecture ADRs and scope cut records**

    **What to do**:

    -   Document Worker-native architecture decisions: D1, R2, KV, DO rules;
        Resend; no hidden server; no Node emulation strategy.
    -   Record v1/defer/drop decisions for Stripe, SCIM, OAuth, Mixpanel, GeoIP,
        legacy v3 migration, admin-only features.
    -   Define environment topology: dev, preview/staging, production.

    **Must NOT do**:

    -   Do not leave feature scope ambiguous.
    -   Do not include hybrid hosting fallback.

    **Recommended Agent Profile**:

    -   **Category**: `writing` — architecture decision documentation.
    -   **Skills**: [`cloudflare-workers-expert`,
        `environment-topology-and-staging-promotion`]

    **Parallelization**:

    -   **Can Run In Parallel**: YES
    -   **Parallel Group**: Wave 1
    -   **Blocks**: T7, T25, T27
    -   **Blocked By**: None

    **References**:

    -   `.do/deploy.template.yaml` - Existing non-target hosting reference to
        replace.
    -   `docs/examples/hosting/docker/*` - Existing deployment docs to avoid
        copying.
    -   `packages/server/src/config.ts` - Current config surface to remap.

    **Acceptance Criteria**:

    -   [x] ADR explicitly says Worker-native only.
    -   [x] Feature matrix has no unknown v1/defer/drop entries.
    -   [x] Cloudflare product ownership table exists.

    **QA Scenarios**:

    ```
    Scenario: Scope matrix has no unknowns
      Tool: Bash
      Preconditions: ADR/scope docs exist.
      Steps:
        1. Search docs for TODO, TBD, unknown in scope tables.
        2. Assert zero unresolved scope markers.
      Expected Result: No unresolved scope markers.
      Evidence: .sisyphus/evidence/task-4-scope-matrix.txt

    Scenario: Hybrid backend is forbidden
      Tool: Bash
      Preconditions: ADR docs exist.
      Steps:
        1. Search ADRs for VPS, LXC, Docker host, proxy-to-node, sidecar.
        2. Assert any match appears only in forbidden/anti-goal sections.
      Expected Result: No hybrid dependency described as implementation path.
      Evidence: .sisyphus/evidence/task-4-no-hybrid.txt
    ```

    **Commit**: YES

    -   Message: `docs(architecture): define cloudflare-native backend scope`

-   [x] 5. **Bootstrap contract-proof, crypto-proof, client-proof, and Worker
       runtime test lanes**

    **What to do**:

    -   Add root/package scripts for proof lanes.
    -   Establish commands for API contract, crypto parity, Worker runtime,
        D1/R2 integration, and Cypress/PWA compatibility.
    -   Ensure lanes can run in CI or locally with clear env requirements.

    **Must NOT do**:

    -   Do not create vague `test:cloudflare` with unclear coverage.
    -   Do not rely only on Miniflare/local mocks for final proof.

    **Recommended Agent Profile**:

    -   **Category**: `deep`
    -   **Skills**: [`testing-lanes-bootstrap`, `cloudflare-workers-expert`]

    **Parallelization**:

    -   **Can Run In Parallel**: YES
    -   **Parallel Group**: Wave 1
    -   **Blocks**: all implementation tasks T12-T24
    -   **Blocked By**: None

    **References**:

    -   `README.md:120-138` - Existing test commands.
    -   `.github/workflows/run-tests.yml` - Existing CI test style.
    -   `package.json` - Root scripts.

    **Acceptance Criteria**:

    -   [x] Scripts exist for proof lanes.
    -   [x] Each script documents required env/bindings.
    -   [x] Worker runtime lane uses `wrangler dev --remote` or preview
            deployment for final proof.

    **QA Scenarios**:

    ```
    Scenario: Proof lane help output
      Tool: Bash
      Preconditions: Scripts added.
      Steps:
        1. Run the documented help/list command for proof lanes.
        2. Assert contract, crypto, worker, client, and migration lanes are listed.
      Expected Result: All lanes listed with commands.
      Evidence: .sisyphus/evidence/task-5-proof-lanes-help.txt

    Scenario: Missing env fails clearly
      Tool: Bash
      Preconditions: Scripts added without Cloudflare secrets set.
      Steps:
        1. Run Worker proof lane without required bindings/secrets.
        2. Assert failure names exact missing binding/secret and exits non-zero.
      Expected Result: Clear deterministic failure, not stack trace noise.
      Evidence: .sisyphus/evidence/task-5-missing-env.txt
    ```

    **Commit**: YES

    -   Message: `test(cloudflare): add backend proof lanes`

-   [x] 6. **Create Worker backend package and fetch-based transport bootstrap**

    **What to do**:

    -   Create `packages/worker/` with the layout from "Concrete Architecture &
        Code Reuse Map" above. Initial scope: `src/index.ts`, `src/env.ts`,
        `src/transport.ts`, `package.json`, `wrangler.toml`, `tsconfig.json`,
        and a `src/server-factory.ts` stub that throws `not implemented`.
    -   `package.json` declares `"@padloc/core": "workspace:*"` (or the
        lerna-equivalent path dep) so the Worker imports `Server`, `Controller`,
        `Request`, `Response`, `marshal`, `unmarshal` from core. Build is
        handled by Wrangler's bundler (esbuild) — no separate `tsc` step
        required for the Worker itself, but `tsc --noEmit` still runs in CI.
    -   `src/index.ts` exports a default `{ fetch(request, env, ctx) }` handler
        that:
        -   GET `/healthcheck` → 200 with JSON
            `{ status, version, d1, r2, resend }`. Each dependency is pinged;
            failure of any flips status to `degraded` but still returns 200
            (degraded health, not crash).
        -   OPTIONS → respond with the same CORS headers the existing
            `packages/server/src/transport/http.ts:62-65` returns:
            `Access-Control-Allow-Origin: <env.ALLOW_ORIGIN || "*">`,
            `Access-Control-Allow-Methods: OPTIONS, POST`,
            `Access-Control-Allow-Headers: Content-Type`.
        -   POST `/` → read body as text (≤ 25 MB; reject larger with
            `Padloc.OutdatedRequest`-shape error per
            `packages/core/src/error.ts`), call `unmarshal(body) as Request`,
            hand to `Server.handle(req)`, marshal the `Response`, return 200
            with JSON content-type.
        -   Any other path/method → 405.
    -   On malformed JSON or missing fields, return the same JSON error shape
        `{ error: { code, message } }` that
        `packages/server/src/transport/http.ts:38-50` returns.

    **Must NOT do**:

    -   Do not import Node `http`, `fs`, `Buffer`, `stream`, `path`, or `node:*`
        namespaces. Use `Request`/`Response`/`crypto.subtle`/`fetch`.
    -   Do not reimplement `Controller` business logic — reuse it from
        `packages/core`.
    -   Do not add `nodejs_compat` to wrangler.toml as a substitute for
        Worker-native code.

    **Recommended Agent Profile**:

    -   **Category**: `unspecified-high`
    -   **Skills**: [`cloudflare-workers-expert`]

    **Parallelization**:

    -   **Can Run In Parallel**: YES after Wave 1
    -   **Parallel Group**: Wave 2
    -   **Blocks**: T12-T17
    -   **Blocked By**: T3, T5

    **References**:

    -   `packages/server/src/transport/http.ts` - Current POST/OPTIONS/health
        behavior.
    -   `packages/core/src/transport.ts` - Transport objects.

    **Acceptance Criteria**:

    -   [x] Worker package starts in Wrangler.
    -   [x] `/healthcheck` returns 200.
    -   [x] POST malformed JSON returns defined Padloc-compatible error
            response.

    **QA Scenarios**:

    ```
    Scenario: Worker healthcheck
      Tool: Bash (curl)
      Preconditions: Wrangler dev/preview Worker running at known URL.
      Steps:
        1. GET /healthcheck.
        2. Assert HTTP 200.
        3. Save response headers/body.
      Expected Result: 200 with no Node server process.
      Evidence: .sisyphus/evidence/task-6-healthcheck.txt

    Scenario: Malformed POST handled
      Tool: Bash (curl)
      Preconditions: Worker running.
      Steps:
        1. POST body `not-json` with content-type application/json.
        2. Assert non-2xx response and stable JSON/error shape defined by contract.
      Expected Result: Deterministic error response, Worker does not crash.
      Evidence: .sisyphus/evidence/task-6-malformed-post.txt
    ```

    **Commit**: YES

    -   Message: `feat(worker): add cloudflare transport bootstrap`

-   [x] 7. **Define Wrangler config, bindings, secrets, and environment
       topology**

    **What to do**:

    -   Author `packages/worker/wrangler.toml` with three named environments:
        `dev`, `preview`, `production`. Use Wrangler env-scoped overrides.
    -   Pin `compatibility_date = "2025-04-01"` (or newer; do not omit).
        Required `compatibility_flags`: none for v1 — Worker code must be
        Web-API-only. If a third-party dep forces a flag (audit during T3), add
        it with a comment naming the dep and the alternative considered.
    -   Bindings (names are contract — code references these exact identifiers):
        -   `DB` → D1 database (`padloc-{env}` per environment).
        -   `ATTACHMENTS` → R2 bucket (`padloc-attachments-{env}`).
        -   `HINTS` → KV namespace (`PADLOC_HINTS_{ENV}`) — rate-limit/cache
            only.
        -   `ACCOUNT_LOCK` → Durable Object namespace bound to class
            `AccountLockDO` (T17).
    -   Secrets via `wrangler secret put` (never in `wrangler.toml`):
        -   `RESEND_API_KEY`
        -   `EMAIL_FROM_ADDRESS`
        -   `WEBAUTHN_RP_ID`
        -   `WEBAUTHN_RP_NAME`
        -   `ALLOW_ORIGIN` (defaults to `*` if absent in dev only)
    -   Document in `packages/worker/README.md` the exact `wrangler` commands to
        create/rotate each binding and secret, with expected output.
    -   Local dev uses `wrangler dev --local` (Miniflare-backed) by default and
        `wrangler dev --remote` for proof lanes (T5).

    **Must NOT do**:

    -   Do not put secret values in repo or in `wrangler.toml`.
    -   Do not share D1/R2 instances across environments.
    -   Do not promote without `compatibility_date` pinned.

    **Recommended Agent Profile**:

    -   **Category**: `unspecified-high`
    -   **Skills**: [`cloudflare-project-ops`, `runtime-config-contract`,
        `hush-projection-contract`]

    **Parallelization**:

    -   **Can Run In Parallel**: YES after T4
    -   **Parallel Group**: Wave 2
    -   **Blocks**: T14-T17, T25
    -   **Blocked By**: T4

    **References**:

    -   `packages/server/src/config.ts` - Existing env variables to remap.
    -   `.do/deploy.template.yaml` - Prior deployment env map to replace.

    **Acceptance Criteria**:

    -   [x] Binding table exists for dev/preview/prod.
    -   [x] `wrangler` validation passes with placeholders/secrets absent as
            expected.
    -   [x] Secret setup/rotation commands documented.

    **QA Scenarios**:

    ```
    Scenario: Wrangler config validates
      Tool: Bash
      Preconditions: Wrangler installed and config added.
      Steps:
        1. Run the documented wrangler validation/deploy dry-run command.
        2. Assert config parses and missing secrets are reported only where expected.
      Expected Result: Config valid; no committed secret values.
      Evidence: .sisyphus/evidence/task-7-wrangler-validate.txt

    Scenario: Secret leakage check
      Tool: Bash/Grep
      Preconditions: Config/docs added.
      Steps:
        1. Search for Resend API key patterns, Cloudflare tokens, D1 IDs marked secret, and private material.
        2. Assert no real secret values are present.
      Expected Result: No secrets committed.
      Evidence: .sisyphus/evidence/task-7-secret-scan.txt
    ```

    **Commit**: YES

    -   Message: `chore(cloudflare): define worker bindings and environments`

-   [x] 8. **Design and create D1 schema/migrations for Padloc metadata**

    **What to do**:

    -   Choose the query layer: **Drizzle ORM** (`drizzle-orm` + `drizzle-kit`)
        with the `drizzle-orm/d1` driver. Rationale: typed schema, generated
        migrations, well-supported `db.batch()` for atomic writes. Junior devs
        should not hand-roll SQL string concatenation.
    -   Tables (each `Storable` in core maps to one). Use ULID-style ids stored
        as TEXT PRIMARY KEY:
        -   `accounts` — id, email (UNIQUE INDEX, lowercased), encrypted blob
            for serialized `Account`, `created_at`, `updated_at`.
        -   `auth` — id, account_id (FK), email, encrypted blob for `Auth`,
            updated_at. Used by `getAuthInfo`.
        -   `sessions` — id, account_id, key_blob, expires_at, revoked_at NULL,
            last_used_at, device_json.
        -   `vaults` — id, owner_account_id, org_id NULL, encrypted_blob,
            revision, updated_at. INDEX (owner_account_id), INDEX (org_id).
        -   `orgs` — id, name, owner_account_id, encrypted_blob, revision.
        -   `org_members` — org_id, account_id, role, status. PK (org_id,
            account_id). INDEX (account_id).
        -   `invites` — id, org_id, email, encrypted_blob, expires_at.
        -   `key_store_entries` — id, account_id, encrypted_blob.
        -   `attachments` — id, vault_id, owner_account_id, r2_key, size_bytes,
            hash, created_at. INDEX (vault_id).
        -   `email_verifications` — id, email, code_hash, purpose, expires_at,
            consumed_at NULL.
        -   `change_log`, `request_log` — append-only audit (configurable
            retention; truncate cron in T26).
        -   `_migrations` — managed by Drizzle.
    -   Implement the core `StorageQuery` tree (eq/ne/gt/gte/lt/lte/regex/negex
        -   and/or/not from `packages/core/src/storage.ts`) as a Drizzle
            query-builder translator in `src/storage/d1.ts` (T14). Do not bypass
            the core `Storage` interface contract.
    -   Migrations under `packages/worker/migrations/` numbered `0000_init.sql`,
        `0001_*.sql`. Each migration is forward-only; rollback strategy is
        "create a forward migration that reverts" — document this explicitly in
        `migrations/README.md`.
    -   **D1 constraints to respect**:
        -   10 MB max row size — vault encrypted blobs > 10 MB must spill to R2
            (key prefix `vault-blob/`) with a D1 pointer row.
        -   No long-lived multi-statement transactions across awaits — use
            `db.batch([...statements])` for atomicity.
        -   5 GB DB size limit per D1 database (paid increases this) — flagged
            as a future concern, not v1.

    **Must NOT do**:

    -   Do not copy the `packages/server/src/storage/postgres.ts` schema
        verbatim — it is column-shaped; D1 storage is JSON-blob shaped to
        preserve client-side encryption semantics.
    -   Do not assume open transactions; use `db.batch`.
    -   Do not store anything plaintext that the existing Postgres backend
        stores encrypted.

    **Recommended Agent Profile**:

    -   **Category**: `deep`
    -   **Skills**: [`cloudflare-workers-expert`, `api-design`]

    **Parallelization**:

    -   **Can Run In Parallel**: YES
    -   **Parallel Group**: Wave 2
    -   **Blocks**: T14, T18, T19, T21, T23
    -   **Blocked By**: T1, T4

    **References**:

    -   `packages/core/src/storage.ts` - Storage abstraction.
    -   `packages/server/src/storage/postgres.ts` - Existing SQL-ish storage
        behavior reference.
    -   `packages/core/src/account.ts`, `vault.ts`, `org.ts`, `invite.ts`,
        `key-store.ts`, `session.ts` - Domain entities.

    **Acceptance Criteria**:

    -   [x] D1 migrations create all required tables/indexes.
    -   [x] Schema ownership map links each domain object to table(s).
    -   [x] Rollback/forward migration path documented.

    **QA Scenarios**:

    ```
    Scenario: D1 migration applies cleanly
      Tool: Bash/Wrangler
      Preconditions: D1 dev database configured.
      Steps:
        1. Apply migrations to empty D1 database.
        2. Query expected table list.
        3. Assert required tables and indexes exist.
      Expected Result: Migration succeeds and schema matches ownership map.
      Evidence: .sisyphus/evidence/task-8-d1-migration.txt

    Scenario: Migration idempotency guard
      Tool: Bash/Wrangler
      Preconditions: Migrations applied once.
      Steps:
        1. Re-run migration command.
        2. Assert no duplicate table/index errors or data loss.
      Expected Result: Safe deterministic result.
      Evidence: .sisyphus/evidence/task-8-d1-idempotency.txt
    ```

    **Commit**: YES

    -   Message: `feat(storage): add d1 schema for padloc metadata`

-   [x] 9. **Design R2 attachment lifecycle and failure semantics**

    **What to do**:

    -   Define object key scheme, metadata rows, upload/download/delete flow,
        max sizes, checksum/hash handling, and orphan cleanup.
    -   Decide whether to preserve backend-mediated API or introduce signed URL
        flow with client updates.

    **Must NOT do**:

    -   Do not silently alter attachment API without contract ADR.
    -   Do not ignore partial DB/object failures.

    **Recommended Agent Profile**:

    -   **Category**: `unspecified-high`
    -   **Skills**: [`cloudflare-workers-expert`]

    **Parallelization**:

    -   **Can Run In Parallel**: YES
    -   **Parallel Group**: Wave 2
    -   **Blocks**: T15, T21
    -   **Blocked By**: T1, T4

    **References**:

    -   `packages/core/src/attachment.ts` - Attachment interface.
    -   `packages/server/src/attachments/fs.ts` - Existing local storage
        semantics.
    -   `packages/server/src/attachments/s3.ts` - Existing object-store
        semantics.
    -   `packages/core/src/api.ts` - Attachment request types.

    **Acceptance Criteria**:

    -   [x] Attachment lifecycle ADR exists.
    -   [x] Partial failure matrix covers DB write fail, R2 write fail, delete
            fail, retry.
    -   [x] Max object size is explicitly set and tested.

    **QA Scenarios**:

    ```
    Scenario: Attachment design covers partial failures
      Tool: Bash/Grep
      Preconditions: ADR exists.
      Steps:
        1. Search ADR for DB fail, R2 fail, delete fail, orphan, retry.
        2. Assert every case has a handling rule.
      Expected Result: No uncovered partial failure category.
      Evidence: .sisyphus/evidence/task-9-partial-failure-matrix.txt

    Scenario: Client contract decision recorded
      Tool: Bash/Grep
      Preconditions: ADR exists.
      Steps:
        1. Assert ADR states either compatible backend-mediated flow or approved signed URL client change.
        2. Assert corresponding API inventory disposition is updated.
      Expected Result: No ambiguous attachment contract.
      Evidence: .sisyphus/evidence/task-9-contract-decision.txt
    ```

    **Commit**: YES

    -   Message: `docs(attachments): define r2 lifecycle semantics`

-   [x] 10. **Design Resend messenger/email replacement**

    **What to do**:

    -   Map current email flows to Resend API calls: signup verification,
        invites, recovery, alerts.
    -   Define template handling without filesystem dependency.
    -   Define resend retries, idempotency, provider errors, and local/preview
        behavior.

    **Must NOT do**:

    -   Do not use nodemailer or SMTP.
    -   Do not require filesystem templates at runtime.

    **Recommended Agent Profile**:

    -   **Category**: `unspecified-high`
    -   **Skills**: [`cloudflare-workers-expert`]

    **Parallelization**:

    -   **Can Run In Parallel**: YES
    -   **Parallel Group**: Wave 2
    -   **Blocks**: T16, T18
    -   **Blocked By**: T1, T4

    **References**:

    -   `packages/core/src/messenger.ts` - Messenger interface.
    -   `packages/server/src/email/smtp.ts` - Current SMTP implementation to
        replace.
    -   `docs/examples/config/example.env` - Current email env variables.

    **Acceptance Criteria**:

    -   [x] Email flow table maps every current message type to Resend
            template/payload.
    -   [x] Runtime does not depend on filesystem templates.
    -   [x] Preview mode can use a safe test recipient or mocked Resend
            endpoint.

    **QA Scenarios**:

    ```
    Scenario: Email flow mapping complete
      Tool: Bash/Grep
      Preconditions: Email mapping doc exists.
      Steps:
        1. Extract message classes/names from packages/core/src/messenger.ts.
        2. Compare to Resend mapping table.
        3. Assert every required message is mapped or explicitly deferred.
      Expected Result: No unmapped required email flow.
      Evidence: .sisyphus/evidence/task-10-email-map.txt

    Scenario: No SMTP dependency in Worker path
      Tool: Bash/Grep
      Preconditions: Worker email design or implementation path exists.
      Steps:
        1. Search Worker target for nodemailer, smtp, SMTPConfig runtime imports.
        2. Assert zero runtime matches.
      Expected Result: Resend/fetch-only email path.
      Evidence: .sisyphus/evidence/task-10-no-smtp.txt
    ```

    **Commit**: YES

    -   Message: `docs(email): map padloc messages to resend`

-   [x] 11. **Audit transactionality and consistency requirements**

    **What to do**:

    -   Confirm the inherited mutual-exclusion guarantee from
        `packages/core/src/server.ts:2188`
        (`_requestQueue: Map<AccountID | OrgID, Promise<void>>`) and its
        consumer `_addToQueue()` at `server.ts:2237-2257`. The current code
        serializes ALL handler invocations for a given account plus any org the
        account belongs to. A stateless Worker has no shared `Map` — this
        guarantee is **lost** without intervention.
    -   Decision (do not re-litigate): replace with a Durable Object class
        `AccountLockDO` keyed by `AccountID` and `OrgID`. The Worker takes the
        lock for `account.id` plus each `org.id` in `account.orgs` before
        calling `controller.process(req)` and releases on completion. This
        preserves the existing semantics 1:1. Implementation in T17.
    -   For each multi-write flow listed below, name the consistency owner (DO
        lock vs `db.batch` vs both) and the failure behavior:
        1. `createAccount` → DO lock (per email-derived id) + `db.batch`
           (accounts + auth + email_verifications consume).
        2. `completeCreateSession` → DO lock per account + `db.batch` (sessions
           insert + auth read).
        3. `revokeSession` → DO lock per account + single UPDATE.
        4. `updateAuth` → DO lock per account + `db.batch`.
        5. `createOrg` / `updateOrg` / `deleteOrg` → DO lock per org +
           `db.batch` (orgs + org_members + vaults pointer cleanup).
        6. `acceptInvite` → DO lock per org AND per account (acquire in sorted
           id order to avoid deadlock) + `db.batch`.
        7. `createVault` / `updateVault` → DO lock per owner (account or org)
            - single statement.
        8. `createAttachment` → DO lock per vault owner; D1 metadata write
           happens BEFORE R2 PUT; on R2 failure roll back D1 row.
        9. `deleteAttachment` → DO lock per vault owner; R2 DELETE happens
           BEFORE D1 row delete; on D1 failure record orphan for cron sweep.
        10. `deleteAccount` → DO lock per account + `db.batch` cascades + R2
            prefix delete + Provisioner hook.
    -   Document the exact lock-acquisition order rule (sorted id order across
        `[account, ...orgs]`) so junior developers do not invent ad-hoc orders
        and create deadlocks.
    -   KV is explicitly forbidden from the consistency owner column. KV is
        hint-only (rate-limit counters, ephemeral cache).

    **Must NOT do**:

    -   Do not weaken the existing per-account/per-org serialization guarantee.
        The product was written expecting it.
    -   Do not put session truth in KV.
    -   Do not introduce a separate DO class per flow — one `AccountLockDO`
        keyed by id is sufficient and bounds DO sprawl.

    **Recommended Agent Profile**:

    -   **Category**: `deep`
    -   **Skills**: [`cloudflare-workers-expert`, `architecture-patterns`]

    **Parallelization**:

    -   **Can Run In Parallel**: YES
    -   **Parallel Group**: Wave 2
    -   **Blocks**: T14, T17, T18, T19, T22
    -   **Blocked By**: T1, T8

    **References**:

    -   `packages/core/src/server.ts` - Multi-step business flows.
    -   `packages/core/src/storage.ts` - Storage operations.
    -   `packages/core/src/org.ts`, `vault.ts`, `invite.ts`, `session.ts` - Data
        relationships.

    **Acceptance Criteria**:

    -   [x] Every multi-write flow has consistency owner and failure behavior.
    -   [x] DO usage, if any, has bounded scope.
    -   [x] KV is not used for authoritative consistency.

    **QA Scenarios**:

    ```
    Scenario: Multi-write flow inventory complete
      Tool: Bash/Grep
      Preconditions: Transaction audit doc exists.
      Steps:
        1. Search audit for account create, session create, org invite, vault update, attachment create/delete, account delete.
        2. Assert each flow has storage owner and rollback/retry behavior.
      Expected Result: All critical flows covered.
      Evidence: .sisyphus/evidence/task-11-transaction-audit.txt

    Scenario: KV authoritative misuse rejected
      Tool: Bash/Grep
      Preconditions: Transaction audit doc exists.
      Steps:
        1. Search for KV in authoritative/state owner rows.
        2. Assert no auth/session/vault/org source-of-truth is KV.
      Expected Result: KV only used for cache/hints.
      Evidence: .sisyphus/evidence/task-11-kv-guardrail.txt
    ```

    **Commit**: YES

    -   Message: `docs(storage): audit d1 consistency requirements`

-   [x] 11.5. **Wire a permissive Provisioner stub for the personal fork**

    **What to do**:

    -   Audit every `provisioner.*` call site in `packages/core/src/server.ts`
        (search confirms ~15 sites including in `Controller.authenticate`,
        `createAccount`, `completeCreateSession`, `changeEmail`,
        `deleteAccount`, `createOrg`, `deleteOrg`, `updateOrg`, `acceptInvite`).
        The Worker MUST inject a `Provisioner` — passing `undefined` will throw.
    -   Implement `packages/worker/src/provisioner/personal.ts` extending
        `StubProvisioner` from `packages/server/src/provisioning/stub.ts` if
        portable, otherwise reimplement the `Provisioner` interface from
        `packages/core/src/provisioning.ts` with permissive defaults:
        -   `getProvisioning()` → returns `Provisioning` with status `active`,
            unlimited quota, no billing flags.
        -   `accountEmailChanged`, `accountDeleted`, `orgDeleted`,
            `orgOwnerChanged` → no-op (return resolved Promise).
        -   All hook methods log at debug, never throw.
    -   Wire it in `packages/worker/src/server-factory.ts`:
        `new Server(config, storage, messenger, logger, authServers, attachmentStorage, new PersonalProvisioner(), changeLogger, requestLogger)`.
    -   Confirm by exercising `createAccount` end-to-end against the Worker
        preview that a fresh account passes provisioning gates and reaches the
        verification email step.

    **Must NOT do**:

    -   Do not bring `packages/server/src/provisioning/stripe.ts`,
        `directory.ts`, or `oauth.ts` into the Worker bundle. Stripe's SDK is
        Node-only and SCIM is deferred.
    -   Do not silently strip provisioner calls from `Controller` — the core
        class is reused as-is; the stub satisfies the contract.

    **Recommended Agent Profile**:

    -   **Category**: `unspecified-high`
    -   **Skills**: [`cloudflare-workers-expert`]

    **Parallelization**:

    -   **Can Run In Parallel**: YES with T12-T17
    -   **Parallel Group**: Wave 3
    -   **Blocks**: T18, T19
    -   **Blocked By**: T6

    **References**:

    -   `packages/core/src/provisioning.ts` — `Provisioner` interface and
        `Provisioning` value type.
    -   `packages/server/src/provisioning/stub.ts` — existing permissive
        reference (verify portability).
    -   `packages/core/src/server.ts` — `Controller.authenticate` and account
        flows where provisioning gates fire.

    **Acceptance Criteria**:

    -   [x] Worker bundle does NOT contain `stripe`, `pg`, or directory/SCIM
            code. (`grep` evidence captured.)
    -   [x] `createAccount` flow against Worker preview reaches verification
            email step without provisioner-related rejection.
    -   [x] Every method on the `Provisioner` interface is implemented.

    **QA Scenarios**:

    ```
    Scenario: Provisioner stub permits account creation
      Tool: Bash (curl + Resend mock)
      Preconditions: Empty D1 preview, Worker deployed.
      Steps:
        1. POST createAccount for stub-provisioner@example.com.
        2. Read captured verification mail payload.
        3. Assert non-error response and email captured.
      Expected Result: Account creation reaches verification gate.
      Evidence: .sisyphus/evidence/task-11.5-stub-permits.txt

    Scenario: No Stripe/SCIM in Worker bundle
      Tool: Bash/grep
      Preconditions: Worker built (wrangler deploy --dry-run --outdir dist).
      Steps:
        1. Search bundle output for "stripe", "Stripe", "scim", "SCIMUser".
        2. Assert zero matches.
      Expected Result: Bundle free of dropped-feature code.
      Evidence: .sisyphus/evidence/task-11.5-bundle-clean.txt
    ```

    **Commit**: YES

    -   Message: `feat(provisioner): add personal-fork stub for worker`

-   [x] 12. **Implement Worker transport adapter against frozen contract**

    **What to do**:

    -   Connect Worker fetch handler to core Request/Response marshal/unmarshal
        path.
    -   Implement CORS/OPTIONS and healthcheck parity.
    -   Add request size handling and deterministic errors.

    **Must NOT do**:

    -   Do not add product-specific API drift.
    -   Do not depend on Node Buffer if Web APIs suffice.

    **Recommended Agent Profile**:

    -   **Category**: `deep`
    -   **Skills**: [`cloudflare-workers-expert`, `api-design`]

    **Parallelization**:

    -   **Can Run In Parallel**: YES in Wave 3
    -   **Parallel Group**: Wave 3
    -   **Blocks**: T18-T22
    -   **Blocked By**: T1, T5, T6

    **References**:

    -   `packages/server/src/transport/http.ts` - Behavior reference.
    -   `packages/core/src/encoding.ts` - Marshal/unmarshal helpers.
    -   `packages/core/src/transport.ts` - Request/Response classes.

    **Acceptance Criteria**:

    -   [x] Contract POST round-trip works with a known noop or test handler.
    -   [x] OPTIONS/CORS behavior matches documented client requirements.
    -   [x] Request size limit is explicit.

    **QA Scenarios**:

    ```
    Scenario: Request/response round trip
      Tool: Bash (curl)
      Preconditions: Worker preview deployed with test handler.
      Steps:
        1. POST a valid marshaled test Request.
        2. Assert HTTP 200 and valid marshaled Response.
        3. Assert response can be unmarshaled by existing core decoder.
      Expected Result: Valid round-trip without Node HTTP server.
      Evidence: .sisyphus/evidence/task-12-roundtrip.txt

    Scenario: Oversized request rejected
      Tool: Bash (curl)
      Preconditions: Worker preview deployed with max request size configured.
      Steps:
        1. POST body larger than configured limit.
        2. Assert deterministic max-size error.
      Expected Result: Rejected without Worker crash or partial processing.
      Evidence: .sisyphus/evidence/task-12-oversize.txt
    ```

    **Commit**: YES

    -   Message: `feat(worker): implement padloc transport adapter`

-   [x] 13. **Implement Worker crypto/platform adapter and pass parity vectors**

    **What to do**:

    -   Implement `WorkerCryptoProvider` in `packages/worker/src/crypto.ts`
        satisfying the `CryptoProvider` interface from
        `packages/core/src/crypto.ts`. Mapping (Web Crypto only — no Node
        `crypto` import path reachable from Worker bundle):
        -   `randomBytes(n)` → `crypto.getRandomValues(new Uint8Array(n))`.
        -   `hash(data, params)` → `crypto.subtle.digest("SHA-256" | ...)`.
        -   `hmac(key, data, params)` →
            `subtle.importKey("raw", k, { name: "HMAC", hash: "SHA-256" }, …)` +
            `subtle.sign("HMAC", …)`.
        -   `encrypt/decrypt` AES-GCM 256, 128-bit tag →
            `subtle.encrypt({ name: "AES-GCM", iv })`.
        -   `generateKey` (RSA 2048) →
            `subtle.generateKey({ name: "RSA-PSS", modulusLength: 2048, … })`
            for sign/verify; `RSA-OAEP` for the wrap/unwrap path used by
            key-store entries.
        -   `sign/verify` (RSA-PSS, SHA-256) → `subtle.sign("RSA-PSS", …)`.
        -   PBKDF2 with 1M iterations — `subtle.deriveBits` with
            `{ name: "PBKDF2", iterations: 1_000_000, hash: "SHA-256" }`.
    -   Implement `WorkerPlatform` extending core `Platform` to expose
        `crypto: WorkerCryptoProvider` and a Web-API `fetch` for outbound HTTP.
    -   **Fix existing security issue** discovered in plan review: SRP M1
        verification in `packages/core/src/srp.ts` uses byte-string `===` for
        equality. Replace with a constant-time compare helper (manual XOR
        reduction over `Uint8Array`, or `crypto.subtle.timingSafeEqual` where
        the Wrangler `compatibility_date` enables it). The fix lives in core
        because both Node and Worker runtimes benefit.
    -   **CPU budget proof**: write a benchmark (Vitest + Miniflare or
        `wrangler dev` smoke) that runs one `completeAuthRequest` end-to-end
        (which exercises PBKDF2 1M + SRP + RSA verify). Capture wall-clock and
        CPU-time per request. Fail the lane if a single login exceeds 200 ms
        wall on Workers Paid plan in `wrangler dev --remote`. Record headroom in
        evidence.
    -   Pass every T2 parity vector in the Worker runtime —
        `wrangler dev --remote` for the final proof; Miniflare-only is not
        sufficient.

    **Must NOT do**:

    -   Do not weaken iterations, key sizes, or algorithm choice.
    -   Do not import `node:crypto` or `crypto` in any module reachable from the
        Worker bundle.
    -   Do not approve the milestone without the CPU-budget evidence file. A
        Worker that times out under load is a regression vs the Node server.

    **Recommended Agent Profile**:

    -   **Category**: `ultrabrain`
    -   **Skills**: [`cloudflare-workers-expert`]

    **Parallelization**:

    -   **Can Run In Parallel**: YES in Wave 3
    -   **Parallel Group**: Wave 3
    -   **Blocks**: T18, T20
    -   **Blocked By**: T2, T3, T5, T6

    **References**:

    -   `packages/core/src/platform.ts` - Provider seam.
    -   `packages/server/src/platform/node.ts` - Node platform reference.
    -   `packages/server/src/crypto/node.ts` - Node crypto reference.
    -   `packages/core/src/srp.ts` - SRP behavior.

    **Acceptance Criteria**:

    -   [x] Worker crypto tests pass for all required vectors.
    -   [x] Worker runtime path imports no Node crypto implementation.
    -   [x] Unsupported primitives have explicit v1 disposition.

    **QA Scenarios**:

    ```
    Scenario: Worker crypto parity passes
      Tool: Bash/Wrangler
      Preconditions: Worker crypto adapter implemented.
      Steps:
        1. Run crypto-proof lane in Worker runtime.
        2. Assert all required parity vectors pass.
      Expected Result: 100% required vectors pass.
      Evidence: .sisyphus/evidence/task-13-crypto-pass.txt

    Scenario: Tampered vector fails
      Tool: Bash/Wrangler
      Preconditions: Crypto tests include negative vector.
      Steps:
        1. Run negative/tampered vector test.
        2. Assert verification fails with expected error.
      Expected Result: Tampered data rejected.
      Evidence: .sisyphus/evidence/task-13-crypto-negative.txt
    ```

    **Commit**: YES

    -   Message: `feat(crypto): add worker platform provider`

-   [x] 14. **Implement D1-backed storage adapter**

    **What to do**:

    -   Implement storage interface using D1 according to schema and consistency
        audit.
    -   Add query helpers, serialization, indexes, and transaction wrappers.
    -   Add fixtures for account/session/vault/org/key-store flows.

    **Must NOT do**:

    -   Do not use Postgres/Mongo/LevelDB drivers.
    -   Do not store authoritative state in KV.

    **Recommended Agent Profile**:

    -   **Category**: `deep`
    -   **Skills**: [`cloudflare-workers-expert`]

    **Parallelization**:

    -   **Can Run In Parallel**: YES in Wave 3
    -   **Parallel Group**: Wave 3
    -   **Blocks**: T18, T19, T21, T23
    -   **Blocked By**: T5, T6, T7, T8, T11

    **References**:

    -   `packages/core/src/storage.ts` - Interface to implement.
    -   `packages/server/src/storage/postgres.ts` - SQL storage behavior
        reference.
    -   `packages/server/src/storage/leveldb.ts` - Default behavior reference.

    **Acceptance Criteria**:

    -   [x] Storage adapter passes storage contract tests.
    -   [x] D1 migrations apply in test lane.
    -   [x] Concurrent/duplicate write edge cases have deterministic outcomes.

    **QA Scenarios**:

    ```
    Scenario: Storage CRUD contract
      Tool: Bash/Wrangler
      Preconditions: D1 adapter implemented and migrations applied.
      Steps:
        1. Run storage-proof lane against D1 preview database.
        2. Assert account, session, vault, org, invite, key-store CRUD cases pass.
      Expected Result: All required storage contract tests pass.
      Evidence: .sisyphus/evidence/task-14-storage-crud.txt

    Scenario: Duplicate write handling
      Tool: Bash/Wrangler
      Preconditions: D1 adapter implemented.
      Steps:
        1. Execute duplicate create for same account/email fixture.
        2. Assert one success and one defined duplicate/conflict error.
      Expected Result: No duplicate rows and stable error response.
      Evidence: .sisyphus/evidence/task-14-duplicate-write.txt
    ```

    **Commit**: YES

    -   Message: `feat(storage): implement d1 storage adapter`

-   [x] 15. **Implement R2 attachment backend**

    **What to do**:

    -   Implement attachment storage interface using R2.
    -   Couple D1 metadata with R2 object lifecycle safely.
    -   Test upload/download/delete for representative object sizes.

    **Must NOT do**:

    -   Do not use fs/S3 SDK runtime paths.
    -   Do not leave orphan cleanup undefined.

    **Recommended Agent Profile**:

    -   **Category**: `unspecified-high`
    -   **Skills**: [`cloudflare-workers-expert`]

    **Parallelization**:

    -   **Can Run In Parallel**: YES in Wave 3
    -   **Parallel Group**: Wave 3
    -   **Blocks**: T21, T24
    -   **Blocked By**: T5, T6, T7, T9, T14 metadata interface if coupled

    **References**:

    -   `packages/core/src/attachment.ts` - Interface.
    -   `packages/server/src/attachments/s3.ts` - Object-store reference.
    -   `packages/server/src/attachments/fs.ts` - Local behavior reference.

    **Acceptance Criteria**:

    -   [x] R2 upload/download/delete contract tests pass.
    -   [x] 1 KB, 5 MB, and configured max-size cases tested.
    -   [x] Partial failure/orphan handling tested.

    **QA Scenarios**:

    ```
    Scenario: R2 attachment lifecycle
      Tool: Bash (curl) + Wrangler/R2 inspection
      Preconditions: Worker preview and R2 binding configured.
      Steps:
        1. Upload fixture file `attachment-5mb.bin`.
        2. Download it back.
        3. Compare checksum.
        4. Delete object and assert R2 no longer returns it.
      Expected Result: Checksums match; deletion removes object and metadata.
      Evidence: .sisyphus/evidence/task-15-r2-lifecycle.txt

    Scenario: Oversized attachment rejected
      Tool: Bash (curl)
      Preconditions: Max attachment size configured.
      Steps:
        1. Upload file larger than configured max.
        2. Assert deterministic rejection and no R2 object remains.
      Expected Result: Rejected with no orphan object.
      Evidence: .sisyphus/evidence/task-15-r2-oversize.txt
    ```

    **Commit**: YES

    -   Message: `feat(attachments): implement r2 attachment backend`

-   [x] 16. **Implement Resend-backed messenger**

    **What to do**:

    -   Implement `ResendMessenger` in `packages/worker/src/email/resend.ts`
        satisfying the `Messenger` interface from
        `packages/core/src/messenger.ts`. The 8 message classes to support:
        `EmailAuthMessage`, `JoinOrgInviteMessage`,
        `ConfirmMembershipInviteMessage`, `JoinOrgInviteAcceptedMessage`,
        `JoinOrgInviteCompletedMessage`, `FailedLoginAttemptMessage`,
        `NewLoginMessage`, `PlainMessage`.
    -   **Template bundling**: in `packages/worker/src/email/templates.ts`,
        export each template (HTML + text) as a TS string constant. A small
        build step (`scripts/bundle-templates.ts`) reads the existing
        `assets/email/*.{html,txt}` at compile time and writes a generated TS
        file. Templates MUST be string constants in the bundle — no
        `readFileSync`, no dynamic import from fs. Mustache-style `{{var}}`
        substitution (the same shape the existing SMTP messenger uses) is kept.
    -   Send via
        `fetch("https://api.resend.com/emails", { method: "POST", headers: { Authorization: \`Bearer
        ${env.RESEND_API_KEY}\`, … }, body
        })`. Map Resend non-2xx → typed errors per `packages/core/src/error.ts`
        so the rest of the stack treats them like any other transient provider
        error.
    -   Add a `MockMessenger` that records sent payloads in-memory (or in a
        per-test KV namespace) for the proof lanes. Wire it via
        `env.EMAIL_BACKEND === "mock"`.
    -   Idempotency: include the verification code's `id` (or invite id) in
        Resend's `idempotency_key` header so duplicate sends collapse.

    **Must NOT do**:

    -   Do not import `nodemailer` or any SMTP library.
    -   Do not load templates from disk at runtime — they MUST be bundled at
        build time.
    -   Do not log the verification code body in plain logs.

    **Recommended Agent Profile**:

    -   **Category**: `quick` if mapping exists; otherwise `unspecified-high`
    -   **Skills**: [`cloudflare-workers-expert`]

    **Parallelization**:

    -   **Can Run In Parallel**: YES in Wave 3
    -   **Parallel Group**: Wave 3
    -   **Blocks**: T18
    -   **Blocked By**: T5, T6, T7, T10

    **References**:

    -   `packages/core/src/messenger.ts` - Message classes.
    -   `packages/server/src/email/smtp.ts` - Existing delivery behavior.
    -   Resend API docs - Email send endpoint and errors.

    **Acceptance Criteria**:

    -   [x] Required message types produce Resend API payloads.
    -   [x] Resend error responses map to stable application errors.
    -   [x] Test mode captures email payload without external send.

    **QA Scenarios**:

    ```
    Scenario: Verification email payload
      Tool: Bash (curl)
      Preconditions: Worker preview with Resend mock/test mode.
      Steps:
        1. Trigger account verification email for test@example.com.
        2. Fetch captured mock payload.
        3. Assert `to` is test@example.com and template contains verification code/link fields.
      Expected Result: Correct payload captured, no SMTP used.
      Evidence: .sisyphus/evidence/task-16-verification-email.json

    Scenario: Resend provider failure handling
      Tool: Bash (curl)
      Preconditions: Resend mock configured to return 500.
      Steps:
        1. Trigger email send.
        2. Assert defined retry/error behavior and no uncaught exception.
      Expected Result: Stable provider error response/log.
      Evidence: .sisyphus/evidence/task-16-resend-failure.txt
    ```

    **Commit**: YES

    -   Message: `feat(email): add resend messenger`

-   [x] 17. **Implement session ownership, rate-limit strategy, and the
        AccountLockDO**

    **What to do**:

    -   **Sessions**: D1-backed (`sessions` table from T8). Read-once per
        request to validate. No KV cache — staleness here is an auth bypass.
    -   **AccountLockDO** (`packages/worker/src/locks/account-lock.ts`): the
        single Durable Object class that replaces
        `packages/core/src/server.ts:2188`'s in-memory `_requestQueue`. The DO
        instance id is the AccountID or OrgID (use Wrangler `idFromName(<id>)`).
        The DO exposes one RPC method:
        -   `acquireAndRun(jobId: string, ttlMs: number)` returns when the lock
            is held; the caller releases by completing or by lock timeout. In
            practice, the simplest correct implementation: the Worker fetch
            handler does an in-flight POST to each `<accountId>` and `<orgId>`
            DO via sorted id order, the DO holds the request open while the
            handler runs, and releases when the handler responds. The DO
            enforces a per-id queue (FIFO promise chain like the original
            Map<id, Promise>) inside its single-threaded execution context.
    -   **Wrapper**: extract a `withAccountLocks(env, ids[], fn)` helper used by
        `Server.handle()` integration. Sort ids ascending to prevent deadlock
        when an account belongs to multiple orgs.
    -   **Rate-limit hints**: KV-backed counter per `(ip, route)` with TTL
        window (e.g. failed-login attempts). Authoritative throttle decisions
        (lock account after N failures) are stored in D1 on the `auth` row, not
        in KV.
    -   **Tests**: replay (signed request reused after success), expiry
        (post-`expires_at` request rejected), revoke (`revoked_at` set → next
        request rejected), concurrent (two parallel POSTs for the same account
        exit in lock-serialized order without DB write conflicts).

    **Must NOT do**:

    -   Do not put session truth only in KV.
    -   Do not introduce per-flow DO classes — one `AccountLockDO` is sufficient
        and bounds DO invocation cost.
    -   Do not skip the sorted-id ordering rule — out-of-order acquisition
        causes deadlock when two requests both touch (account, org).

    **Recommended Agent Profile**:

    -   **Category**: `deep`
    -   **Skills**: [`cloudflare-workers-expert`, `auth-session-contract`]

    **Parallelization**:

    -   **Can Run In Parallel**: YES in Wave 3
    -   **Parallel Group**: Wave 3
    -   **Blocks**: T18, T22
    -   **Blocked By**: T7, T11, T14

    **References**:

    -   `packages/core/src/session.ts` - Session domain.
    -   `packages/core/src/server.ts` - Current auth/session checks.
    -   `security.md:590-755` - Authentication and request verification design.

    **Acceptance Criteria**:

    -   [x] Session create/verify/revoke tests pass.
    -   [x] Replay/expired request tests fail correctly.
    -   [x] Rate limiting cannot be bypassed by KV staleness in authoritative
            checks.

    **QA Scenarios**:

    ```
    Scenario: Session revoke blocks request
      Tool: Bash (curl)
      Preconditions: Worker preview with test account/session fixture.
      Steps:
        1. Create session.
        2. Verify authenticated request succeeds.
        3. Revoke session.
        4. Retry same authenticated request.
      Expected Result: First request succeeds; post-revoke request is rejected.
      Evidence: .sisyphus/evidence/task-17-session-revoke.txt

    Scenario: Replay request rejected
      Tool: Bash (curl)
      Preconditions: Valid signed request fixture available.
      Steps:
        1. Submit signed request once.
        2. Submit same signed request/timestamp again after replay window condition.
        3. Assert replay/age rejection.
      Expected Result: Replay does not mutate state twice.
      Evidence: .sisyphus/evidence/task-17-replay-reject.txt
    ```

    **Commit**: YES

    -   Message: `feat(auth): implement worker session authority`

-   [x] 18. **Implement account creation, login, and session flows end-to-end**

    **What to do**:

    -   Wire Worker transport, crypto, storage, sessions, and email into account
        create/login flows.
    -   Preserve current SRP/auth flow and response shapes.
    -   Support negative cases: bad verification code, wrong password, duplicate
        email, expired session.

    **Must NOT do**:

    -   Do not bypass SRP/auth semantics for convenience.
    -   Do not expose master password or plaintext secret material.

    **Recommended Agent Profile**:

    -   **Category**: `deep`
    -   **Skills**: [`cloudflare-workers-expert`, `auth-session-contract`]

    **Parallelization**:

    -   **Can Run In Parallel**: NO, integration task after core implementations
    -   **Parallel Group**: Wave 4
    -   **Blocks**: T24
    -   **Blocked By**: T1, T2, T12, T13, T14, T16, T17

    **References**:

    -   `packages/core/src/server.ts` - Current create/login/session behavior.
    -   `packages/core/src/auth.ts` - Auth types.
    -   `packages/core/src/srp.ts` - SRP implementation.
    -   `security.md:590-755` - Auth design.

    **Acceptance Criteria**:

    -   [x] Account create flow passes against Worker preview.
    -   [x] Login/session flow passes against Worker preview.
    -   [x] Wrong password and duplicate signup fail correctly.

    **QA Scenarios**:

    ```
    Scenario: Account create and login happy path
      Tool: Bash (API script/curl)
      Preconditions: Empty D1 preview database, Resend mock enabled.
      Steps:
        1. Start account create for cloudflare-padloc@example.com.
        2. Read captured verification code from mock email payload.
        3. Complete account creation.
        4. Start and complete session/login.
        5. Assert session id returned and authenticated account fetch succeeds.
      Expected Result: Account exists and authenticated request works.
      Evidence: .sisyphus/evidence/task-18-account-login.txt

    Scenario: Wrong password rejected
      Tool: Bash (API script/curl)
      Preconditions: Test account exists.
      Steps:
        1. Attempt login using wrong password fixture.
        2. Assert auth failure code and no valid session row is created.
      Expected Result: Login rejected and no session authority granted.
      Evidence: .sisyphus/evidence/task-18-wrong-password.txt
    ```

    **Commit**: YES

    -   Message: `feat(auth): wire account login on worker backend`

-   [x] 19. **Implement vault, organization, and sync flows**

    **What to do**:

    -   Implement required vault CRUD/sync operations and minimal
        organization/shared-vault operations from v1 matrix.
    -   Preserve encrypted payload handling; server must not inspect plaintext.
    -   Add idempotency/retry semantics for duplicate client retries.

    **Must NOT do**:

    -   Do not decrypt vault data server-side.
    -   Do not rebuild full enterprise SCIM/admin scope in this task.

    **Recommended Agent Profile**:

    -   **Category**: `deep`
    -   **Skills**: [`cloudflare-workers-expert`, `api-design`]

    **Parallelization**:

    -   **Can Run In Parallel**: YES with T20-T22 after auth base
    -   **Parallel Group**: Wave 4
    -   **Blocks**: T24
    -   **Blocked By**: T1, T11, T12, T14, T17, T18 base auth

    **References**:

    -   `packages/core/src/vault.ts` - Vault entity.
    -   `packages/core/src/org.ts` - Organization/member/group model.
    -   `packages/core/src/server.ts` - Current vault/org methods.
    -   `security.md:262-589` - Vault/org encryption and sharing model.

    **Acceptance Criteria**:

    -   [x] Authenticated user can create/read/update/delete encrypted vault
            items.
    -   [x] Sync flow returns expected changes.
    -   [x] Shared/org flow disposition matches v1 matrix.

    **QA Scenarios**:

    ```
    Scenario: Vault CRUD happy path
      Tool: Bash (API script/curl)
      Preconditions: Authenticated Worker session exists.
      Steps:
        1. Create encrypted vault/item fixture.
        2. Read it back.
        3. Update encrypted payload.
        4. Delete it.
        5. Assert final read returns not found or empty sync state.
      Expected Result: CRUD lifecycle succeeds without plaintext exposure.
      Evidence: .sisyphus/evidence/task-19-vault-crud.txt

    Scenario: Unauthorized vault access rejected
      Tool: Bash (API script/curl)
      Preconditions: Two accounts exist; vault belongs to account A.
      Steps:
        1. Authenticate as account B.
        2. Request account A's vault by id.
        3. Assert authorization failure.
      Expected Result: No encrypted vault data returned to unauthorized account.
      Evidence: .sisyphus/evidence/task-19-unauthorized-vault.txt
    ```

    **Commit**: YES

    -   Message: `feat(vaults): implement d1-backed vault sync flows`

-   [x] 20. **Implement WebAuthn/TOTP compatibility path**

    **What to do**:

    -   Validate `@simplewebauthn/server` compatibility or replace with
        Worker-compatible verification.
    -   Implement TOTP/WebAuthn endpoints according to v1 dispositions.
    -   Test browser/platform edge cases where possible.

    **Must NOT do**:

    -   Do not pretend WebAuthn works without Worker-runtime proof.
    -   Do not weaken MFA challenge verification.

    **Recommended Agent Profile**:

    -   **Category**: `deep`
    -   **Skills**: [`cloudflare-workers-expert`, `auth-session-contract`]

    **Parallelization**:

    -   **Can Run In Parallel**: YES in Wave 4
    -   **Parallel Group**: Wave 4
    -   **Blocks**: T24
    -   **Blocked By**: T1, T2, T13, T17, T18 base auth

    **References**:

    -   `packages/server/src/auth/webauthn.ts` - Existing WebAuthn server.
    -   `packages/core/src/auth/totp.ts` - TOTP implementation/reference.
    -   `packages/core/src/api.ts` - MFA request/response types.

    **Acceptance Criteria**:

    -   [x] TOTP registration/auth tests pass if v1-required.
    -   [x] WebAuthn start/complete flows pass or are explicitly deferred with
            client-safe behavior.
    -   [x] Negative challenge/replay test fails correctly.

    **QA Scenarios**:

    ```
    Scenario: TOTP challenge happy path
      Tool: Bash (API script/curl)
      Preconditions: Test account session and deterministic TOTP secret fixture.
      Steps:
        1. Register TOTP authenticator.
        2. Generate current valid code from fixture.
        3. Complete auth challenge.
        4. Assert challenge accepted.
      Expected Result: TOTP MFA succeeds.
      Evidence: .sisyphus/evidence/task-20-totp-happy.txt

    Scenario: WebAuthn/TOTP replay rejected
      Tool: Bash (API script/curl)
      Preconditions: Completed challenge fixture exists.
      Steps:
        1. Submit same completed challenge twice.
        2. Assert second submission is rejected.
      Expected Result: MFA replay rejected.
      Evidence: .sisyphus/evidence/task-20-mfa-replay.txt
    ```

    **Commit**: YES

    -   Message: `feat(auth): add worker-compatible mfa flows`

-   [x] 21. **Integrate attachment lifecycle with account/vault flows**

    **What to do**:

    -   Wire attachment metadata and R2 object lifecycle into authenticated API.
    -   Test create/get/delete attachment API paths from existing clients.
    -   Add orphan cleanup and idempotent delete behavior.

    **Must NOT do**:

    -   Do not allow unauthenticated object access.
    -   Do not leave stale metadata after R2 deletion.

    **Recommended Agent Profile**:

    -   **Category**: `unspecified-high`
    -   **Skills**: [`cloudflare-workers-expert`]

    **Parallelization**:

    -   **Can Run In Parallel**: YES in Wave 4
    -   **Parallel Group**: Wave 4
    -   **Blocks**: T24
    -   **Blocked By**: T1, T8, T9, T14, T15, T18

    **References**:

    -   `packages/core/src/api.ts` - `GetAttachmentParams`,
        `DeleteAttachmentParams`.
    -   `packages/core/src/attachment.ts` - Attachment types/interface.
    -   `packages/core/src/server.ts` - Current attachment access checks.

    **Acceptance Criteria**:

    -   [x] Authenticated attachment create/get/delete works end-to-end.
    -   [x] Unauthorized attachment access rejected.
    -   [x] Orphan cleanup proof exists.

    **QA Scenarios**:

    ```
    Scenario: Authenticated attachment lifecycle
      Tool: Bash (API script/curl)
      Preconditions: Authenticated session and vault item fixture exist.
      Steps:
        1. Upload 1 KB encrypted attachment.
        2. Fetch it as same account.
        3. Assert checksum matches.
        4. Delete it.
        5. Assert metadata and R2 object removed.
      Expected Result: Full lifecycle succeeds.
      Evidence: .sisyphus/evidence/task-21-attachment-lifecycle.txt

    Scenario: Cross-account attachment blocked
      Tool: Bash (API script/curl)
      Preconditions: Account A owns attachment; account B session exists.
      Steps:
        1. Request attachment as account B.
        2. Assert authorization failure and no bytes returned.
      Expected Result: Unauthorized user cannot read object.
      Evidence: .sisyphus/evidence/task-21-cross-account-blocked.txt
    ```

    **Commit**: YES

    -   Message: `feat(attachments): wire authenticated r2 lifecycle`

-   [x] 22. **Implement error, idempotency, retry, and edge-case semantics**

    **What to do**:

    -   Define and implement stable responses for malformed requests, duplicate
        writes, retries, stale sessions, clock skew, rate limits, partial
        attachment failures, and concurrent mutations.
    -   Add idempotency keys where contract-compatible or document fallback
        behavior.

    **Must NOT do**:

    -   Do not expose internal Worker/D1/R2 errors directly.
    -   Do not produce inconsistent response shapes for clients.

    **Recommended Agent Profile**:

    -   **Category**: `deep`
    -   **Skills**: [`api-design`, `cloudflare-workers-expert`]

    **Parallelization**:

    -   **Can Run In Parallel**: YES in Wave 4
    -   **Parallel Group**: Wave 4
    -   **Blocks**: T24, T26
    -   **Blocked By**: T1, T11, T12, T17, T18-T21 partial implementations

    **References**:

    -   `packages/core/src/error.ts` - Error codes/shapes.
    -   `packages/core/src/server.ts` - Current error handling.
    -   `packages/server/src/transport/http.ts` - Current transport errors.

    **Acceptance Criteria**:

    -   [x] Error matrix maps every edge case to response code/body.
    -   [x] Tests cover happy path and negative path for each critical flow.
    -   [x] Internal exceptions produce sanitized stable errors.

    **QA Scenarios**:

    ```
    Scenario: Duplicate retry idempotency
      Tool: Bash (API script/curl)
      Preconditions: Worker preview and authenticated session.
      Steps:
        1. Submit same create/update operation twice with same idempotency condition.
        2. Assert final state has one logical mutation.
        3. Assert second response is stable success or defined duplicate response.
      Expected Result: No duplicate records or corruption.
      Evidence: .sisyphus/evidence/task-22-idempotency.txt

    Scenario: Internal D1 error sanitized
      Tool: Bash (API script/curl)
      Preconditions: Test mode can inject D1 failure.
      Steps:
        1. Trigger injected D1 failure during operation.
        2. Assert response does not expose SQL/internal stack.
        3. Assert operation leaves no partial committed state.
      Expected Result: Stable sanitized error and safe state.
      Evidence: .sisyphus/evidence/task-22-sanitized-error.txt
    ```

    **Commit**: YES

    -   Message: `feat(api): harden worker error and retry semantics`

-   [x] 23. **Build migration/import/export tooling for legacy Padloc data
        fixtures**

    **What to do**:

    -   Create tooling to import from current supported legacy source fixture(s)
        or export format into D1/R2.
    -   Start with greenfield-compatible fixtures; add real
        LevelDB/Postgres/Mongo import if user has data source.
    -   Keep migration tooling out of Worker hot path.

    **Must NOT do**:

    -   Do not require migration code in production Worker request path.
    -   Do not mutate real data without backup/export proof.

    **Recommended Agent Profile**:

    -   **Category**: `unspecified-high`
    -   **Skills**: [`cloudflare-workers-expert`]

    **Parallelization**:

    -   **Can Run In Parallel**: YES in Wave 5
    -   **Parallel Group**: Wave 5
    -   **Blocks**: Final verification
    -   **Blocked By**: T8, T14, T18, T19, T21

    **References**:

    -   `packages/server/src/storage/leveldb.ts` - Default legacy storage.
    -   `packages/server/src/storage/postgres.ts` - SQL source reference.
    -   `packages/server/src/storage/mongodb.ts` - Mongo source reference.
    -   `packages/core/src/storage.ts` - Target abstraction.

    **Acceptance Criteria**:

    -   [x] Migration fixture imports into empty D1/R2 environment.
    -   [x] Import is idempotent or safely rejects duplicate import.
    -   [x] Backup/export command exists before destructive migration.

    **QA Scenarios**:

    ```
    Scenario: Fixture import happy path
      Tool: Bash/Wrangler
      Preconditions: Empty D1/R2 preview environment and legacy fixture file.
      Steps:
        1. Run import command against fixture.
        2. Query D1 row counts and R2 object counts.
        3. Assert expected accounts/vaults/attachments are present.
      Expected Result: Fixture data imported accurately.
      Evidence: .sisyphus/evidence/task-23-fixture-import.txt

    Scenario: Duplicate import guarded
      Tool: Bash/Wrangler
      Preconditions: Fixture already imported.
      Steps:
        1. Re-run import command against same fixture.
        2. Assert command exits with safe duplicate/idempotent result.
        3. Assert row/object counts did not double.
      Expected Result: No duplicated data.
      Evidence: .sisyphus/evidence/task-23-duplicate-import.txt
    ```

    **Commit**: YES

    -   Message: `feat(migration): add legacy import proof tooling`

-   [ ] 24. **Prove PWA and Cordova client compatibility against Worker
        backend** — **BLOCKED**: Requires deployed Worker preview URL +
        Cloudflare credentials. — **BLOCKED**: Requires deployed Worker preview
        URL + Cloudflare credentials.

    **What to do**:

    -   **Rebuild the PWA pointing at the Worker**. `PL_SERVER_URL` is compiled
        into the bundle via `process.env.PL_SERVER_URL` at
        `packages/app/src/globals.ts:6` (`new AjaxSender(...)`). There is no
        runtime override. Concrete commands:

        ```bash
        cd packages/pwa
        PL_SERVER_URL="https://padloc-worker-preview.<acct>.workers.dev" \
        PL_BILLING_ENABLED=false \
        npm run build
        npm run serve   # http://localhost:8080
        ```

    -   Run Cypress flows against the rebuilt PWA. Use the existing
        `cypress/e2e/*` suites where applicable; add a new
        `cypress/e2e/cloudflare-worker.cy.ts` covering account create, login,
        create-vault-item, attachment upload/download/delete, and negative
        wrong-password and rate-limit scenarios.
    -   For Cordova: the Cordova client is a wrapper over the same web app, so
        PWA proof transfers. For mobile-specific surface (biometric keystore, QR
        scan), use a `wrangler dev --remote` URL in a Cordova build's
        `config.xml`, install on simulator/device, run the same account+vault
        smoke. If device build is unavailable, document explicitly that Cordova
        proof = "PWA proof against Worker plus manual smoke on next mobile
        release", with a follow-up issue ID.
    -   Capture screenshots/logs to `.sisyphus/evidence/task-24-*`.

    **Must NOT do**:

    -   Do not assume the PWA picks up `PL_SERVER_URL` at runtime — it does not.
        The bundle must be rebuilt.
    -   Do not say "manually verify mobile" without a follow-up.
    -   Do not skip negative auth/error flows.

    **Recommended Agent Profile**:

    -   **Category**: `visual-engineering`
    -   **Skills**: [`agent-browser`, `ghost-browser`, `web-capture-routing`]

    **Parallelization**:

    -   **Can Run In Parallel**: YES in Wave 5
    -   **Parallel Group**: Wave 5
    -   **Blocks**: Final verification
    -   **Blocked By**: T18-T22

    **References**:

    -   `packages/pwa/README.md` - PWA build/config.
    -   `packages/cordova/README.md` - Mobile build path.
    -   `packages/cordova/src/platform.ts` - Mobile platform assumptions.
    -   `README.md:128-138` - Cypress e2e commands.

    **Acceptance Criteria**:

    -   [ ] PWA e2e flow passes against Worker preview URL.
    -   [ ] Cordova/mobile-compatible build config points to Worker URL and
            smoke flow passes or documented emulator proof passes.
    -   [ ] Evidence screenshots/logs saved.

    **QA Scenarios**:

    ```
    Scenario: PWA account/vault happy path
      Tool: Cypress or Playwright
      Preconditions: PWA served with PL_SERVER_URL pointing at Worker preview; clean D1/R2 test env.
      Steps:
        1. Navigate to PWA URL.
        2. Create account `worker-pwa@example.com` using captured verification code.
        3. Create vault item titled `Cloudflare Worker Test`.
        4. Reload and log back in.
        5. Assert vault item title is visible.
      Expected Result: Existing PWA works against Worker backend.
      Evidence: .sisyphus/evidence/task-24-pwa-vault.png

    Scenario: PWA wrong password negative flow
      Tool: Cypress or Playwright
      Preconditions: Test account exists.
      Steps:
        1. Navigate to login screen.
        2. Enter correct email and wrong password `DefinitelyWrong123!`.
        3. Submit login.
        4. Assert visible error message and no vault screen.
      Expected Result: Wrong password rejected in UI.
      Evidence: .sisyphus/evidence/task-24-pwa-wrong-password.png
    ```

    **Commit**: YES

    -   Message: `test(e2e): prove clients against worker backend`

-   [x] 25. **Create Cloudflare deploy, rollback, backup, and secret-rotation
        runbooks**

    **What to do**:

    -   Document exact commands for deploy preview, promote production, rollback
        Worker version, apply D1 migrations, backup/export D1/R2, rotate Resend
        and Cloudflare secrets.
    -   Ensure runbooks are agent-executable and avoid manual dashboard clicks
        where possible.

    **Must NOT do**:

    -   Do not depend on Cloudflare dashboard-only steps.
    -   Do not leave rollback undefined.

    **Recommended Agent Profile**:

    -   **Category**: `writing`
    -   **Skills**: [`cloudflare-artifact-promotion`, `cloudflare-project-ops`,
        `hush-projection-contract`]

    **Parallelization**:

    -   **Can Run In Parallel**: YES in Wave 5
    -   **Parallel Group**: Wave 5
    -   **Blocks**: Final verification
    -   **Blocked By**: T7, T17-T22

    **References**:

    -   `.github/workflows/publish-release.yml` - Current release complexity
        reference.
    -   `.do/deploy.template.yaml` - Deployment env reference to replace.
    -   `docs/examples/hosting/docker/*` - Existing docs not to follow for
        target.

    **Acceptance Criteria**:

    -   [x] Runbooks include deploy, rollback, migration, backup/export, secret
            rotation.
    -   [x] Every command has expected output or verification command.
    -   [x] No dashboard-only critical path remains.

    **QA Scenarios**:

    ```
    Scenario: Preview deploy runbook executes
      Tool: Bash/Wrangler
      Preconditions: Cloudflare preview resources configured.
      Steps:
        1. Run preview deploy command from runbook.
        2. Run healthcheck command from runbook.
        3. Assert 200 response.
      Expected Result: Preview deploy verifiably works.
      Evidence: .sisyphus/evidence/task-25-preview-deploy.txt

    Scenario: Rollback command documented and dry-runnable
      Tool: Bash/Wrangler
      Preconditions: At least two Worker versions or documented dry-run mode.
      Steps:
        1. Run rollback listing command.
        2. Assert previous version identifier is discoverable.
        3. If safe preview env, execute rollback and healthcheck.
      Expected Result: Rollback path is operational.
      Evidence: .sisyphus/evidence/task-25-rollback.txt
    ```

    **Commit**: YES

    -   Message: `docs(ops): add cloudflare deploy rollback runbooks`

-   [x] 26. **Add observability, security hardening, and abuse controls**

    **What to do**:

    -   Add structured logs, request ids, error redaction, Cloudflare analytics
        hooks, basic rate limiting, security headers, CORS restrictions, and
        audit events needed for a password manager.
    -   Add backup/recovery verification for D1/R2.

    **Must NOT do**:

    -   Do not log plaintext vault data, secrets, auth proofs, or
        master-password-derived material.
    -   Do not add Mixpanel-style product analytics by default.

    **Recommended Agent Profile**:

    -   **Category**: `deep`
    -   **Skills**: [`cloudflare-workers-expert`, `sentry-ops`]

    **Parallelization**:

    -   **Can Run In Parallel**: YES in Wave 5
    -   **Parallel Group**: Wave 5
    -   **Blocks**: Final verification
    -   **Blocked By**: T22

    **References**:

    -   `packages/core/src/logging.ts` - Existing logging abstractions.
    -   `packages/server/src/logging/*` - Existing logger implementations.
    -   `security.md` - Threat model reference.

    **Acceptance Criteria**:

    -   [x] Logs redact sensitive fields.
    -   [x] Rate limits are documented and tested.
    -   [x] Security headers/CORS policy are explicit.
    -   [x] D1/R2 backup/export proof exists.

    **QA Scenarios**:

    ```
    Scenario: Sensitive fields redacted
      Tool: Bash
      Preconditions: Test flow generates logs.
      Steps:
        1. Run account/login/vault fixture flow.
        2. Capture logs.
        3. Search logs for password, verifier secret material, vault plaintext fixture, auth proof values.
      Expected Result: No sensitive values appear in logs.
      Evidence: .sisyphus/evidence/task-26-log-redaction.txt

    Scenario: Rate limit triggers safely
      Tool: Bash (curl loop)
      Preconditions: Worker preview with rate limit configured.
      Steps:
        1. Send repeated failed login attempts from same test identity/IP header.
        2. Assert rate limit error appears after configured threshold.
        3. Assert no valid session is created.
      Expected Result: Abuse throttled without auth bypass.
      Evidence: .sisyphus/evidence/task-26-rate-limit.txt
    ```

    **Commit**: YES

    -   Message: `feat(security): harden worker backend observability`

-   [x] 27. **Finalize deferred feature disposition and upstream fork strategy**

    **What to do**:

    -   Ensure every non-v1 feature has a clear disposition and future path.
    -   Document how the private fork stays upstream-rebase-friendly or
        intentionally diverges.
    -   Add notes for Stripe/SCIM/OAuth/admin/analytics follow-up if wanted
        later.

    **Must NOT do**:

    -   Do not leave “maybe later” without explicit owner/status.
    -   Do not bury compatibility-breaking changes.

    **Recommended Agent Profile**:

    -   **Category**: `writing`
    -   **Skills**: [`docs-wiki-operator-contract`]

    **Parallelization**:

    -   **Can Run In Parallel**: YES in Wave 5
    -   **Parallel Group**: Wave 5
    -   **Blocks**: Final verification
    -   **Blocked By**: T4, T24

    **References**:

    -   `README.md` - Package matrix and release docs.
    -   `.github/workflows/*` - Existing build/release surfaces.
    -   `packages/server/src/provisioning/*`, `packages/server/src/scim.ts`,
        `packages/server/src/auth/oauth.ts` - Deferred feature references.

    **Acceptance Criteria**:

    -   [x] Final feature matrix has no unknowns.
    -   [x] Fork strategy document exists.
    -   [x] Deferred features have future implementation notes or explicit drop
            rationale.

    **QA Scenarios**:

    ```
    Scenario: No unknown feature dispositions
      Tool: Bash/Grep
      Preconditions: Final feature matrix exists.
      Steps:
        1. Search for unknown, TBD, TODO in feature matrix.
        2. Assert zero matches.
      Expected Result: Every feature classified.
      Evidence: .sisyphus/evidence/task-27-no-unknowns.txt

    Scenario: Compatibility-breaking changes disclosed
      Tool: Bash/Grep
      Preconditions: Fork strategy doc exists.
      Steps:
        1. Search for breaking/incompatible/client update.
        2. Assert any contract drift from T1 appears in the breaking-change section.
      Expected Result: No hidden compatibility break.
      Evidence: .sisyphus/evidence/task-27-breaking-disclosure.txt
    ```

    **Commit**: YES

    -   Message: `docs(fork): finalize cloudflare compatibility scope`

---

## Final Verification Wave (MANDATORY — after ALL implementation tasks)

> 4 review agents run in PARALLEL. ALL must APPROVE. Present consolidated
> results to user and get explicit "okay" before completing.

-   [x] F1. **Plan Compliance Audit** — `oracle` Read this plan end-to-end.
        Verify every Must Have exists in implementation. Verify every Must NOT
        Have is absent via search/build/runtime proof. Confirm evidence files
        exist for T1-T27. Output:
        `Must Have [N/N] | Must NOT Have [N/N] | Tasks [N/N] | VERDICT: APPROVE/REJECT`.

-   [x] F2. **Code Quality Review** — `unspecified-high` Run
        typecheck/lint/tests/proof lanes. Review changed files for `as any`,
        `@ts-ignore`, Node-only imports in Worker path, empty catches, leaked
        secrets, plaintext logging, and excessive abstraction. Output:
        `Build [PASS/FAIL] | Lint [PASS/FAIL] | Tests [N pass/N fail] | Files [N clean/N issues] | VERDICT`.

-   [ ] F3. **Real Agent-Executed QA** — `unspecified-high` (+ browser skill)
        Execute every QA scenario from every task against clean preview
        resources. Run PWA e2e against Worker preview. Save evidence under
        `.sisyphus/evidence/final-qa/`. Output:
        `Scenarios [N/N pass] | Integration [N/N] | Edge Cases [N tested] | VERDICT`.
        **BLOCKED**: Requires deployed Worker preview URL + Cloudflare
        credentials.

-   [x] F4. **Scope Fidelity Check** — `deep` Compare actual diff to this plan.
        Confirm Worker-native only, no hidden Node backend, no deferred features
        silently built, no client contract drift without ADR. Output:
        `Tasks [N/N compliant] | Contamination [CLEAN/N issues] | Unaccounted [CLEAN/N files] | VERDICT`.

---

## Commit Strategy

-   **Wave 1**: `docs(contract): freeze padloc api compatibility inventory`;
    `test(crypto): add worker parity vector harness`;
    `docs(runtime): inventory node blockers for worker backend`;
    `docs(architecture): define cloudflare-native backend scope`;
    `test(cloudflare): add backend proof lanes`
-   **Wave 2**: `feat(worker): add cloudflare transport bootstrap`;
    `chore(cloudflare): define worker bindings and environments`;
    `feat(storage): add d1 schema for padloc metadata`;
    `docs(attachments): define r2 lifecycle semantics`;
    `docs(email): map padloc messages to resend`;
    `docs(storage): audit d1 consistency requirements`
-   **Wave 3**: `feat(worker): implement padloc transport adapter`;
    `feat(crypto): add worker platform provider`;
    `feat(storage): implement d1 storage adapter`;
    `feat(attachments): implement r2 attachment backend`;
    `feat(email): add resend messenger`;
    `feat(auth): implement worker session authority`
-   **Wave 4**: `feat(auth): wire account login on worker backend`;
    `feat(vaults): implement d1-backed vault sync flows`;
    `feat(auth): add worker-compatible mfa flows`;
    `feat(attachments): wire authenticated r2 lifecycle`;
    `feat(api): harden worker error and retry semantics`
-   **Wave 5**: `feat(migration): add legacy import proof tooling`;
    `test(e2e): prove clients against worker backend`;
    `docs(ops): add cloudflare deploy rollback runbooks`;
    `feat(security): harden worker backend observability`;
    `docs(fork): finalize cloudflare compatibility scope`

---

## Success Criteria

### Verification Commands

```bash
npm run test                 # Expected: existing unit tests pass
npm run test:e2e             # Expected: existing/updated e2e tests pass against configured target
npm run proof:contract       # Expected: every API method has disposition and required implemented methods pass
npm run proof:crypto         # Expected: crypto parity vectors pass in Worker runtime
npm run proof:worker         # Expected: Worker preview health/API/storage checks pass
npm run proof:client         # Expected: PWA client flows pass against Worker preview URL
npm run proof:migration      # Expected: migration fixture imports and duplicate guard passes
```

### Final Checklist

-   [x] All API methods classified and required v1 methods implemented.
-   [x] Crypto/auth parity proven in Worker runtime.
-   [x] D1 schema and storage adapter pass contract tests.
-   [x] R2 attachments pass lifecycle/partial-failure tests.
-   [x] Resend email path passes mock/provider-error tests.
-   [ ] PWA/Cordova-compatible client proof passes against Worker preview.
        **BLOCKED**
-   [x] No hidden Node backend, TCP DB driver, local filesystem, SMTP, LevelDB,
        MongoDB, Postgres, or S3 SDK runtime dependency in Worker path.
-   [x] Deploy/rollback/backup/secret-rotation runbooks exist and are executable
        by agents.
