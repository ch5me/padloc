# Padloc API Contract Inventory

> Generated: 2026-05-04T20:27:28.936Z
> Source: `packages/core/src/api.ts`
> Total handlers: 39

## Auth Flow

The authentication & session establishment flow consists of 4 steps:

**Step 1: `startAuthRequest`**
Client initiates authentication with email, auth type, and purpose (Login/Signup/Recover). Server creates an AuthRequest, checks device trust, returns request ID and token.

**Step 2: `completeAuthRequest`**
Client submits authenticator response (e.g., email code, TOTP). Server verifies via AuthServer, marks request as Verified. Returns accountStatus, deviceTrusted, provisioning, and legacyData.

**Step 3: `startCreateSession`**
Client requests SRP session init. Requires authToken from step 2 unless device is trusted. Server creates SRPSession, returns accountId, keyParams, SRP B value, and srpId.

**Step 4: `completeCreateSession`**
Client submits SRP A, M values for verification. Server validates SRP proof, creates Session object, stores session key. Returns Session (with key stripped). Optionally adds device to trusted devices.

## Error Codes

From `packages/core/src/error.ts`:

| Code | Value |
| --- | --- |
| invalid_encryption_params | `invalid_encryption_params` |
| decryption_failed | `decryption_failed` |
| encryption_failed | `encryption_failed` |
| not_supported | `not_supported` |
| missing_access | `missing_access` |
| verification_error | `verification_error` |
| failed_connection | `failed_connection` |
| unexpected_redirect | `unexpected_redirect` |
| bad_request | `bad_request` |
| invalid_session | `invalid_session` |
| session_expired | `session_expired` |
| insufficient_permissions | `insufficient_permissions` |
| invalid_credentials | `invalid_credentials` |
| account_exists | `account_exists` |
| invalid_response | `invalid_response` |
| invalid_request | `invalid_request` |
| outdated_revision | `merge_conflict` |
| max_request_size_exceeded | `max_request_size_exceeded` |
| max_request_age_exceeded | `max_request_age_exceeded` |
| provisioning_quota_exceeded | `provisioning_quota_exceeded` |
| provisioning_not_allowed | `provisioning_not_allowed` |
| client_error | `client_error` |
| server_error | `server_error` |
| unknown_error | `unknown_error` |
| encoding_error | `encoding_error` |
| unsupported_version | `unsupported_version` |
| not_found | `not_found` |
| invalid_csv | `invalid_csv` |
| invalid_1pux | `invalid_1pux` |
| invalid_bitwarden | `invalid_bitwarden` |
| billing_error | `billing_error` |
| authentication_required | `email_verification_required` |
| authentication_failed | `email_verification_failed` |
| authentication_tries_exceeded | `email_verification_tries_exceeded` |

## HTTP Error Shape

From `packages/server/src/transport/http.ts` (lines 78-106):

- **Success (200)**: `Content-Type: application/json; charset=utf-8`. Body is `marshal(Response.toRaw())`.
- **Bad Request (400)**: Returned on any exception during request processing, including parse/decode failures.
- **Method Not Allowed (405)**: For unsupported HTTP methods.
- **Max Request Size**: Stream destroyed mid-read when exceeding `config.maxRequestSize` (default 1GB).
- **Error envelope**: `{ code: string, message: string, stack?: string }` — via `Err.toRaw()`.

## API Handlers

| # | Method | ParamType | ReturnType | Disposition | Rationale | Line |
| --- | --- | --- | --- | --- | --- | --- |
| 1 | `startRegisterAuthenticator` | `StartRegisterAuthenticatorParams` | `StartRegisterAuthenticatorResponse` | implemented | MFA authenticator registration lifecycle | L473 |
| 2 | `completeRegisterAuthenticator` | `CompleteRegisterMFAuthenticatorParams` | `CompleteRegisterMFAuthenticatorResponse` | implemented | MFA authenticator registration lifecycle | L480 |
| 3 | `deleteAuthenticator` | `string` | `undefined` | implemented | MFA authenticator registration lifecycle | L487 |
| 4 | `startAuthRequest` | `StartAuthRequestParams` | `StartAuthRequestResponse` | implemented | Implemented in server.ts:Controller | L492 |
| 5 | `completeAuthRequest` | `CompleteAuthRequestParams` | `CompleteAuthRequestResponse` | implemented | Implemented in server.ts:Controller | L497 |
| 6 | `startCreateSession` | `StartCreateSessionParams` | `StartCreateSessionResponse` | implemented | Implemented in server.ts:Controller | L506 |
| 7 | `updateAuth` | `UpdateAuthParams` | `undefined` | implemented | Implemented in server.ts:Controller | L515 |
| 8 | `completeCreateSession` | `CompleteCreateSessionParams` | `Session` | implemented | Implemented in server.ts:Controller | L523 |
| 9 | `revokeSession` | `string` | `undefined` | implemented | Implemented in server.ts:Controller | L531 |
| 10 | `createAccount` | `CreateAccountParams` | `Account` | implemented | Implemented in server.ts:Controller | L539 |
| 11 | `getAccount` | `string` | `Account` | implemented | Implemented in server.ts:Controller | L549 |
| 12 | `getAuthInfo` | `undefined` | `AuthInfo` | implemented | Implemented in server.ts:Controller | L555 |
| 13 | `updateAccount` | `Account` | `Account` | implemented | Implemented in server.ts:Controller | L565 |
| 14 | `changeEmail` | `ChangeEmailParams` | `Account` | implemented | Implemented in server.ts:Controller | L575 |
| 15 | `recoverAccount` | `RecoverAccountParams` | `Account` | implemented | Implemented in server.ts:Controller | L583 |
| 16 | `deleteAccount` | `string` | `undefined` | implemented | Implemented in server.ts:Controller | L591 |
| 17 | `createOrg` | `Org` | `Org` | implemented | Implemented in server.ts:Controller | L601 |
| 18 | `getOrg` | `undefined` | `Org` | implemented | Implemented in server.ts:Controller | L613 |
| 19 | `updateOrg` | `Org` | `Org` | implemented | Implemented in server.ts:Controller | L626 |
| 20 | `deleteOrg` | `string` | `undefined` | implemented | Implemented in server.ts:Controller | L631 |
| 21 | `createVault` | `Vault` | `Vault` | implemented | Implemented in server.ts:Controller | L643 |
| 22 | `getVault` | `string` | `Vault` | implemented | Implemented in server.ts:Controller | L657 |
| 23 | `updateVault` | `Vault` | `Vault` | implemented | Implemented in server.ts:Controller | L672 |
| 24 | `deleteVault` | `string` | `undefined` | implemented | Implemented in server.ts:Controller | L685 |
| 25 | `getInvite` | `GetInviteParams` | `Invite` | implemented | Implemented in server.ts:Controller | L698 |
| 26 | `acceptInvite` | `Invite` | `undefined` | implemented | Used during org onboarding flow | L710 |
| 27 | `createAttachment` | `Attachment` | `string` | implemented | Creates attachment metadata; returns attachment ID for blob upload | L715 |
| 28 | `getAttachment` | `GetAttachmentParams` | `Attachment` | implemented | Implemented in server.ts:Controller | L720 |
| 29 | `deleteAttachment` | `DeleteAttachmentParams` | `undefined` | implemented | Implemented in server.ts:Controller | L725 |
| 30 | `getLegacyData` | `GetLegacyDataParams` | `PBES2Container` | implemented | V3 migration helper — retrieves legacy PBES2Container for account migration | L730 |
| 31 | `deleteLegacyAccount` | `undefined` | `undefined` | implemented | V3 migration helper — deletes v3 account after migration to v4 | L735 |
| 32 | `createKeyStoreEntry` | `CreateKeyStoreEntryParams` | `KeyStoreEntry` | implemented | Implemented in server.ts:Controller | L740 |
| 33 | `getKeyStoreEntry` | `GetKeyStoreEntryParams` | `KeyStoreEntry` | implemented | Implemented in server.ts:Controller | L745 |
| 34 | `deleteKeyStoreEntry` | `string` | `undefined` | implemented | Implemented in server.ts:Controller | L750 |
| 35 | `removeTrustedDevice` | `string` | `undefined` | implemented | Removes a trusted device from auth.mfaOrder/trustedDevices list | L755 |
| 36 | `listAccounts` | `ListParams` | `ListResponse` | implemented | Admin/debug endpoint — lists all accounts with pagination | L760 |
| 37 | `listOrgs` | `ListParams` | `ListResponse` | implemented | Admin/debug endpoint — lists all organizations with pagination | L765 |
| 38 | `listChangeLogEntries` | `ListParams` | `ListResponse` | implemented | Admin/audit endpoint — retrieves change log with pagination | L770 |
| 39 | `listRequestLogEntries` | `ListParams` | `ListResponse` | implemented | Admin/audit endpoint — retrieves request log with pagination | L775 |

## Notes

- `String` param type maps to `string` in inventory; decorator converts `String` → `undefined` in handlerDefinitions.
- Handlers with `undefined` param type use no input (e.g., `getAuthInfo()`).
- Handlers with `undefined` return type return `void` (no serialized output).
- The `@Handler` decorator populates `API.handlerDefinitions[]` at decoration time for reflection.
