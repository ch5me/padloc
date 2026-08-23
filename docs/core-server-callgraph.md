# Core Server authorization call graph

This note maps the request path implemented by `packages/core/src/server.ts` at
source commit `10f8e65bf56f095479ba46bc4d1afc17dafd7b93`. It describes observed
behavior, not an intended security policy. In particular, `@Handler` metadata
does **not** declare authorization requirements; authorization is imperative
code inside each `Controller` method.

## Handler metadata and dispatch

`@Handler(input, output)` in `api.ts` appends `{ method, input, output }` to the
API prototype's `handlerDefinitions`. Passing `String` is normalized to no
constructor. The output constructor is recorded but is not consulted by
`Controller.process`.

```text
API method decorated with @Handler(input, output)
  -> handlerDefinitions[] (method name plus constructors)
  -> transport decodes a Request
  -> Server.handle(req)
  -> V3Compat(Controller) instance
  -> Controller.process(req)
       find definition whose method === req.method
       take only req.params[0]
       if def.input and the parameter is truthy: new def.input().fromRaw(parameter)
       invoke this[def.method](input)
       convert Serializable result(s) with toRaw(client appVersion)
```

An unknown method becomes `INVALID_REQUEST`. The metadata is therefore an
allowlist and input conversion table, not an authorization table. The concrete
method must call `_requireAuth`, check an auth token, or deliberately implement
a pre-session flow. `V3Compat` contributes additional decorated legacy handlers
through the controller class returned by `makeController`.

## `Server.handle` lifecycle

```text
Server.handle(req)
  1. Create Response and Context { id: uuid() }; start response timer.
  2. Copy request device and location into Context.
  3. Best-effort loadLanguage(device.locale || "en").                 [empty catch]
  4. makeController(context); its Storage may be wrapped by ChangeLogger.
  5. Controller.authenticate(req, context).
  6. _addToQueue(context); wait for account/org locks when authenticated.
  7. Controller.process(req), with done() in finally to release locks.
  8. If a session exists, sign/authenticate the Response with that session.
  9. On any thrown error, _handleError maps it into res.error.
 10. Compute duration and call requestLogger?.log(req, duration, context).
 11. Return Response.
```

The outer catch calls async `_handleError` without `await`. Consequently
synchronous work before its first await (error normalization, `res.error`,
`console.error`, and starting the event log call) happens before return;
report-email completion and failures are not awaited by `Server.handle`. Also,
`requestLogger?.log` is not awaited or caught. A throw there can reject `handle`
after the response error was constructed. Logging happens after the
authorization/handler path, and the response is signed only on the success path
because signing is inside the outer `try` after processing.

## Authentication and Context population

`Controller.authenticate` returns immediately when `req.auth` is absent, leaving
the Context unauthenticated. With authentication metadata it:

1. Loads the `Session` named by `req.auth.session`; only storage `NOT_FOUND` is
   translated to `INVALID_SESSION`.
2. Rejects an expired session.
3. Verifies the request signature via `session.verify(req)`.
4. Rejects requests older than `maxRequestAge`. There is no symmetric
   future-time check here: a negative age does not exceed the maximum.
5. Loads the session's `Account`, loads/initializes its `Auth`, and sets
   `context.session`, `account`, `auth`, `location`, and then `provisioning`
   from `provisioner.getProvisioning(auth, session)`.
6. Updates last-used/device/location data and the auth session-info list, then
   saves `Session` and `Auth` together.

Thus authentication includes writes before the request enters its account/org
lock. Those session/auth writes can overlap other requests. A request without
`req.auth` reaches dispatch; pre-session handlers must establish their own
proof, while protected methods call `_requireAuth()`.

`_requireAuth()` requires all four of session, account, auth, and provisioning.
`_requireAuth(true)` also requires the account email in `config.admins` **and**
a session created with `asAdmin`; failing either produces an authorization error
(`INSUFFICIENT_PERMISSIONS` or `INVALID_SESSION`). Some owner checks fall back
to this server-admin path (for example cross-account access and deleting
organizations).

## Locking and concurrency

`_addToQueue` does nothing for an unauthenticated Context. Otherwise it creates
one promise for the account ID and for every organization currently listed in
`account.orgs`, replacing each map entry and then awaiting the previously stored
promises. The returned `done` resolves all newly installed promises, and
`Controller.process` releases them in a `finally` block.

This is an in-process FIFO-style barrier over the authenticated account and its
known organizations, not a storage/distributed lock. The map entries are never
deleted. It does not lock unauthenticated flows, objects absent from the
account's current org list, or authentication's preceding session/auth writes.
Locks are acquired as a batch after entries are installed; overlapping requests
wait for prior promises and release all their IDs together. Handler errors still
release the locks.

## Authorization inside handlers

Authorization is layered and resource-specific:

-   Account/authenticator/session/auth-info mutation normally begins with
    `_requireAuth`. Account reads, updates, deletes, and org reads allow a
    configured admin session in explicitly coded fallback paths; ordinary
    authenticated users are constrained to their own account or membership.
-   Pre-session signup/login/recovery/legacy flows populate `context.auth` and
    provisioning explicitly and prove an `AuthRequest` token, SRP exchange,
    authenticator response, or equivalent method-specific evidence. They do not
    become protected merely by having `@Handler` metadata.
-   Organization reads require membership (otherwise frequently `NOT_FOUND`,
    concealing existence). Updates require admin for ordinary changes and owner
    for owner-only fields; owner transfer invokes the provisioner.
    Suspended/member state and revision continuity add further gates. Deletes
    require owner or a server-admin session.
-   Vault reads require ownership for private vaults or `org.canRead`;
    unauthorized reads often return `NOT_FOUND`. Updates additionally require
    `org.canWrite`, a non-frozen applicable provisioning record, and the current
    revision. Shared-vault creation/deletion requires org admin; private vault
    creation is implicit rather than exposed through `createVault`.
-   Invite access is limited to the recipient or the coded organization
    authority; acceptance requires the recipient. Attachment reads use the vault
    read predicate, while creation/deletion use the write predicate;
    private-vault access compares the owner ID.
-   Key-store entry operations require auth and check entry ownership/purpose in
    their method-specific paths. The four list endpoints require
    `_requireAuth(true)` and therefore both configured-admin identity and an
    admin session.

These checks occur after dispatch selection. Reviewers adding a handler must add
authorization inside the implementation; copying only the decorator exposes the
method to unauthenticated dispatch.

## Provisioning and quota call graph

Provisioning enters authenticated requests during `authenticate`; several
pre-session flows obtain it directly. It is both returned to clients and used as
a policy input.

```text
provisioner.getProvisioning(auth[, session])
  -> context.provisioning
  -> _requireAuth insists it exists
  -> account feature/status checks
  -> organization provisioning lookup by orgId
  -> frozen/update restrictions
  -> member, group, vault, and attachment-storage quota checks
```

Observed quota enforcement points are:

-   `createOrg`: account status must be active and `features.createOrg` enabled.
    (There is no numeric organization-count comparison in this method.)
-   `updateOrg`: the matching org provisioning must exist; member count and
    group count may not exceed finite (`!== -1`) quotas. The checks apply when
    members/groups were added as coded.
-   `createVault`: after tentatively adding its info to the in-memory org, total
    vault count may not exceed the finite org vault quota.
-   `createAttachment`: sums attachment usage across all org vaults and compares
    bytes after upload size against `quota.storage * 1e6`; private storage
    compares main-vault usage the same way. `-1` means unlimited. For an org
    with no matching provisioning, `prov?.quota.storage || 0` makes the
    effective quota zero rather than throwing the more explicit
    missing-provisioning error.
-   `changeEmail` checks the account `changeEmail` feature; `updateVault`
    rejects frozen account/org provisioning.

Provisioner side effects include account email change/deletion, organization
owner change/deletion, and provisioning retrieval. These calls are in the
handler transaction path: failures generally abort and become response errors
rather than being swallowed.

## Logging paths

A controller logger is derived with the request Context. Handler audit events
call `Controller.log` after (or around) successful mutations and include
selected identifiers/metadata. When a `ChangeLogger` exists, it wraps controller
storage at construction, so storage changes made through that controller storage
are contextualized. `RequestLogger` receives the raw request, measured time, and
Context after the main try/catch.

`_handleError` preserves an `Err` or wraps an unknown exception as reportable
`SERVER_ERROR`, assigns only code/message to the response, and for reportable
errors prints the original exception, emits an `error` event (including method
and params), and optionally sends an operator email. Parameters are placed in
the event for every reportable error; the email includes params only for
`completeRegisterAuthenticator`. The optional error-report email has an empty
catch.

## Catch inventory

Every `catch` in `server.ts` is listed here. **Empty catch** means the exception
is deliberately ignored with no log or response mutation.

| Location/path                                                                 | Behavior                                                                                                                                       |
| ----------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------- |
| `authenticate`: load session                                                  | Converts storage `NOT_FOUND` to `INVALID_SESSION`; rethrows everything else.                                                                   |
| `completeAuthRequest`                                                         | Increments tries, saves auth, logs failed completion data, then rethrows.                                                                      |
| `completeCreateSession`: remove trusted device after five failed SRP attempts | **Empty catch**; failure to remove the trusted device is ignored.                                                                              |
| `completeCreateSession`: failed-login notification                            | **Empty catch**; message construction/send initiation failure is ignored. The send call is not awaited.                                        |
| `completeCreateSession`: new-login notification                               | **Empty catch**; message construction/send initiation failure is ignored. The send call is not awaited.                                        |
| `updateOrg`: send a newly created invite                                      | **Empty catch**; invite/auth persistence continues and email failure is ignored.                                                               |
| `updateOrg`: remove invite from invitee auth                                  | Ignores only `NOT_FOUND`; rethrows other failures.                                                                                             |
| `updateOrg`: remove org from removed member account                           | Ignores only `NOT_FOUND`; rethrows other failures.                                                                                             |
| `updateOrg`: notify an added member                                           | **Empty catch**; notification failure is ignored.                                                                                              |
| `acceptInvite`: notify inviter                                                | **Empty catch**; notification failure is ignored.                                                                                              |
| `updateMetaData`: refresh referenced vault                                    | Treats `NOT_FOUND` as a deleted vault and rethrows other errors.                                                                               |
| `updateMetaData`: refresh referenced member account                           | Treats `NOT_FOUND` as a deleted member and rethrows other errors.                                                                              |
| `_getAuth`: hashed-ID lookup                                                  | Treats `NOT_FOUND` as absence and rethrows other errors.                                                                                       |
| `_getAuth`: legacy plain-email lookup/migration                               | **Empty catch**; any read, initialization, save, or delete error is treated as absence, after which a new in-memory `Auth` may be initialized. |
| `Server.handle`: language load                                                | **Empty catch**; processing continues with localization load failure ignored.                                                                  |
| `Server.handle`: main request path                                            | Converts all thrown errors through `_handleError`; because that async call is not awaited, later asynchronous reporting is detached.           |
| `_handleError`: operator report email                                         | **Empty catch**; report-delivery failure is ignored.                                                                                           |

The empty catches are therefore concentrated in optional
localization/notifications/reporting, plus two security-relevant exceptions:
best-effort trusted-device removal after repeated SRP failure and the legacy
auth-record migration path that suppresses every migration error.

## Scoping checklist for changes

1. Locate the `@Handler` definition and concrete controller method; do not infer
   authorization from the decorator or API comments.
2. Identify when Context auth/provisioning is established and whether the
   request is locked.
3. Enumerate resource predicates (`isOwner`, `isAdmin`, `canRead`, `canWrite`),
   concealment behavior (`NOT_FOUND`), provisioning status/features, revision
   checks, and quota comparisons.
4. Check persistence order relative to provisioner calls and audit logging;
   there is no general rollback.
5. Audit every best-effort branch and empty catch so a newly swallowed failure
   is explicit.
6. Remember that the queue is process-local and excludes authentication writes
   and unauthenticated handlers; storage-level concurrency still matters.
