# Padloc Cloudflare Native Backend — Learnings

> Appended by Task 1 (API Contract Inventory)

## Patterns Discovered

### 1. Decorator-Driven API Definition

- API handlers are defined via `@Handler(ParamType, ResponseType)` decorator on methods of the `API` class.
- The decorator populates `API.handlerDefinitions[]` at decoration time — a reflection table used by the transport layer.
- `String` constructor is mapped to `undefined` in handlerDefinitions (line 433: `input: input === String ? undefined : ...`).
- Param types that are `Serializable` subclasses get auto-deserialized via `def.input().fromRaw(param)` in `Controller.process()`.

### 2. Transport Protocol

- Single HTTP POST endpoint serves all API methods.
- Request envelope: `{ method: string, params?: any[], auth?: RequestAuthentication, device?: DeviceInfo }`
- Response envelope: `{ result: any, error?: { code: string, message: string }, auth?: RequestAuthentication }`
- Request/response serialization via `marshal/unmarshal` in `@padloc/core/src/encoding`.
- Authentication via session-based signature verification (not HTTP headers/cookies).
- All errors returned in `Response.error` field with HTTP 200, except transport-level errors (400/405).

### 3. Error Handling Shape

- `Err.toRaw()` returns `{ code: string, message: string, stack?: string }`.
- Error codes are snake_case strings (e.g., `"invalid_session"`).
- Quota errors are commented out in error.ts — org/vault/member limits defined but not active.
- Provisioning errors exist: `PROVISIONING_QUOTA_EXCEEDED`, `PROVISIONING_NOT_ALLOWED`.
- MFA errors use email-specific naming: `"email_verification_required"`, `"email_verification_failed"`, `"email_verification_tries_exceeded"`.

### 4. Auth Flow

- Four-step SRP-based authentication with email verification:
  1. `startAuthRequest` → initiate with email, get request ID
  2. `completeAuthRequest` → submit code/proof, get verified token
  3. `startCreateSession` → get SRP params (B, srpId, keyParams)
  4. `completeCreateSession` → submit SRP proof (A, M), get Session
- Device trust model: trusted devices can skip email verification.
- `updateAuth` between auth and session steps allows password change.
- Admin login uses `asAdmin` flag in `startCreateSession`.

### 5. Handler Count

- Total: 39 handlers
- Account-related: ~10
- Org-related: ~4
- Vault-related: ~4
- Auth-related: ~9
- Admin/List: ~4
- Legacy/Migration: ~2
- Attachment: ~3
- KeyStore: ~3
