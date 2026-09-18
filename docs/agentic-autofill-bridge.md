# Agentic Autofill Bridge

Padloc is the encrypted item and approval authority for personal autofill. Magic
Browser is the browser/session authority. The bridge between them must be
explicit, redacted, origin-bound, and approval-gated.

## Ownership

-   Padloc owns encrypted records, unlock, sync, sharing, item templates, and
    user approval UI.
-   Magic Browser owns live DOM inspection, role classification witnesses,
    browser fill execution, redacted proof, and guarded final submit.
-   Hush owns runtime/vendor/operator secrets only. It is not the personal
    autofill record store.

## Account Separation

Autonomous service tests use stage-specific identities backed by repo-local Hush
targets:

-   `runtime-staging`: `agent+padloc-staging-e2e@elf.dance`
-   `runtime-production`: `agent+padloc-production-e2e@elf.dance`

Each target provides `PADLOC_AGENT_EMAIL` and `PADLOC_AGENT_MASTER_PASSWORD`.
These no-forward inboxes and their test vaults contain synthetic fixtures only.
Run a complete fresh-profile registration or login proof with:

```bash
hush run -t runtime-staging -- npm run agent:test-identity -- staging
hush run -t runtime-production -- npm run agent:test-identity -- production
```

The production Crown account is `crownhassencs@gmail.com`. Its vault is the
canonical store for real third-party vendor passwords, passkeys, and OTPs used
by agentic workflows. Its master password enters only through the approved human
secret handoff and remains outside repo-local test targets.

Never copy Crown records or credentials into agent test accounts, Hush test
targets, fixtures, logs, CI output, or redacted proof artifacts.

## Current Padloc Roles

Core item metadata lives in `packages/core/src/item.ts`:

-   `AutofillItemKind.PersonProfile`
-   `AutofillItemKind.PostalAddress`
-   `AutofillItemKind.PaymentCardPolicy`
-   `AutofillItemKind.GiftRecipient`
-   `AutofillItemKind.MerchantProfile`

Field roles live in `AutofillFieldRole` and cover login, identity, address,
payment, merchant origin, and `payment.card.cvv_transient`.

CVV/CVC must stay transaction-only. It can be classified and passed through an
approved short-lived bundle, but it should not become a persistent default fill
value.

## Extension Classifier

The browser extension classifier lives in
`packages/extension/src/autofill-classifier.ts` and is pure enough for unit
tests. It classifies:

-   login: username, password, TOTP
-   identity: full name, first name, last name, email, phone
-   address: line 1, line 2, city, region, postal code, country
-   payment: cardholder, PAN, expiry, expiry month, expiry year, transient CVV

The content script uses the same classifier for live DOM fills. Legacy
username/password/TOTP mappings remain supported.

## Bridge Contract Direction

The production bridge should expose these steps:

1. `classify`: Magic Browser sends origin/session/frame/field metadata, no user
   values.
2. `plan-fill`: Padloc returns redacted role/item matches.
3. `approve`: user approves item, origin, roles, and transaction-only fields.
4. `mint-fill-bundle`: Padloc issues a short-lived nonce/TTL bundle scoped to
   origin, frame, and field hashes.
5. `apply-fill-bundle`: Padloc extension applies the still-memory-only bundle
   through its content script, then returns redacted counts/proof.
6. `revoke-fill-bundle`: Padloc revokes unused or failed bundles.

For passkeys, reuse same native-messaging request/response shape and bindings
instead of adding a parallel transport:

1. `enroll-passkey`: generate a vault-held credential, return only registration
   material, persist the encrypted private key in the vault.
2. `request-assertion`: require bound `flowId` + `ttl` + `topOrigin` + `rpId`,
   enforce credential policy, sign internally, return assertion only.

Logs must contain item ids, roles, counts, origins, and last4 only where useful.
No raw names, addresses, PAN, expiry, or CVV.

## Current Native Bridge Proof

-   Protocol types: `packages/extension/src/autofill-broker-protocol.ts`
-   Broker planner/bundler: `packages/extension/src/autofill-broker.ts`
-   Native host: `packages/extension/native-host/padloc-autofill-host.mjs`
-   Extension permission: `nativeMessaging`
-   Background message: `agenticAutofillBroker`
-   Popup approval prompt: `getAgenticAutofillApprovalPrompt` ->
    `approveAgenticAutofill`
-   CDP service-worker entrypoint: `globalThis.padlocAgenticAutofillBroker`
-   Service-worker prelude: fail-closed locked/redacted broker response before
    full Padloc app background initialization

The host supports `status`, `latest-redacted-response`, `broker-request`,
`claim-broker-request`, and `broker-response`. Magic Browser enqueues redacted
broker requests through the native host. The extension background claims pending
requests with `sendNativeMessage`, handles them against the unlocked vault, and
publishes redacted responses back to the host cache. The extension background
owns the unlocked broker path. `plan-fill` first asks the bound content frame to
validate each proposed selector and role, then binds the plan to the
browser-reported tab, frame, document, form, target revision, and
SHA-256-derived field references. Its model-facing response contains only opaque
field/source references, roles, recipient origins, and target identity; item
ids, item names, field names, selectors, previews, and values remain in the
trusted extension path.

Popup approval can allow or deny once or create an exact origin/item/role
standing policy. The owner UI exposes `plan`, `manual`, `auto`, `dontAsk`, and
`bypassPrompts` modes plus policy listing and revocation. Policies persist only
authorization metadata with monotonic policy/revocation revisions. Hard denies,
`alwaysAsk`, target checks, vault lock, and revocation remain effective in
`bypassPrompts`; missing authority fails closed in `dontAsk` and
`bypassPrompts`.

`mint-fill-bundle` creates a short-lived execution grant but does not resolve
values. `apply-fill-bundle` revalidates the exact browser target and reserves a
grant use for each field before resolving that one value inside the extension.
The content script revalidates the complete approved field set immediately
before each exact DOM write. Agent/native responses contain only receipts and
never bundle values.

Before a value-bearing content-script write is attempted, Padloc persists a
session-scoped `potentially-private` document marker. Receipts and
`privacy-status` report `genericObservation: blocked`; unknown documents do not
claim to be clean. `request-reveal`, `read-approved`, and `submit` currently
fail closed because their separate disclosure/action grants are not yet
implemented. UI/status/audit/native responses stay redacted. The host refuses
any cached response or queued request with any non-empty nested `value`,
`secret`, or `privateKey` property.

For fake-data dogfood, unlock Padloc and seed fixture items from extension UI:

```js
chrome.runtime.sendMessage({ type: "seedAgenticAutofillFixtures" });
```

The response returns item names/counts only. It must not print field values.

Magic Browser installs the host wrapper and Chrome manifest with:

```bash
node dist/cli.js setup-agentic-chromium --tier chromium --padloc-root /Users/hassoncs/src/ch5/padloc --extension-id <id> --write
```

Use `--tier chromium` for Magic Browser's downloaded Chrome for Testing profile.
Use `--tier canary` only when the live session is actually Chrome Canary.

Magic Browser consumer code must reject any Padloc broker response that contains
any non-empty nested `value` property in a printable/status path. After a fill
receipt or `privacy-status` returns `genericObservation: blocked`, it must stop
generic screenshots, accessibility/page-text snapshots, script evaluation,
network/body capture, and equivalent model-facing observation for that exact
document until a separate disclosure grant exists. Padloc now emits and persists
this boundary, but enforcement in Magic Browser is **UNKNOWN** in this
repository because its consumer implementation lives outside this checkout.

Magic Browser should call the extension-owned broker through the native host for
redacted plan/status requests. The extension service-worker CDP target is
diagnostic-only and must be selected explicitly.

Live smoke commands:

```bash
cd /Users/hassoncs/src/ch5/padloc
npm --prefix packages/extension run build

cd /Users/hassoncs/src/ch5/magic-browser
pnpm run build
node dist/cli.js setup-agentic-chromium --tier chromium --padloc-root /Users/hassoncs/src/ch5/padloc --extension-id <id> --write
MAGIC_BROWSER_LOAD_EXTENSION=/Users/hassoncs/src/ch5/padloc/packages/extension/dist node dist/cli.js session start example.public_smoke --adapter local-cdp
node dist/cli.js session extension-status <session-id> --extension-id <id> --native-host me.ch5.padloc
node dist/cli.js session padloc-broker-request <session-id> --transport native --extension-id <id> --native-host me.ch5.padloc --request-json '{"type":"status","protocolVersion":1}'
node dist/cli.js session padloc-broker-request <session-id> --transport native --extension-id <id> --native-host me.ch5.padloc --request-file <redacted-broker-request.json> --wait-ms 65000
```

Run focused package tests from `packages/extension`, not the repo root:

```bash
cd /Users/hassoncs/src/ch5/padloc/packages/extension
./node_modules/.bin/mocha --ui tdd --require ts-node/register test/autofill-classifier.ts test/autofill-broker-protocol.ts
TS_NODE_TRANSPILE_ONLY=1 TS_NODE_COMPILER_OPTIONS='{"module":"commonjs"}' ./node_modules/.bin/mocha --ui tdd --require ts-node/register test/autofill-broker.ts
./node_modules/.bin/tsc --noEmit --target es2020 --module commonjs --strict --skipLibCheck test/autofill-broker.ts
```

Remaining proof step: run live unlocked synthetic checkout dogfood through the
native queue, popup approval/standing-policy paths, grant mint, exact
content-script apply, revocation, worker restart, and redacted Magic Browser
proof. Until that is captured, live end-to-end browser behavior is **UNKNOWN**.
