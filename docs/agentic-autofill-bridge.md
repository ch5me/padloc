# Agentic Autofill Bridge

Padloc is the encrypted item and approval authority for personal autofill.
Magic Browser is the browser/session authority. The bridge between them must be
explicit, redacted, origin-bound, and approval-gated.

## Ownership

- Padloc owns encrypted records, unlock, sync, sharing, item templates, and user
  approval UI.
- Magic Browser owns live DOM inspection, role classification witnesses, browser
  fill execution, redacted proof, and guarded final submit.
- Hush owns runtime/vendor/operator secrets only. It is not the personal
  autofill record store.

## Current Padloc Roles

Core item metadata lives in `packages/core/src/item.ts`:

- `AutofillItemKind.PersonProfile`
- `AutofillItemKind.PostalAddress`
- `AutofillItemKind.PaymentCardPolicy`
- `AutofillItemKind.GiftRecipient`
- `AutofillItemKind.MerchantProfile`

Field roles live in `AutofillFieldRole` and cover login, identity, address,
payment, merchant origin, and `payment.card.cvv_transient`.

CVV/CVC must stay transaction-only. It can be classified and passed through an
approved short-lived bundle, but it should not become a persistent default fill
value.

## Extension Classifier

The browser extension classifier lives in
`packages/extension/src/autofill-classifier.ts` and is pure enough for unit
tests. It classifies:

- login: username, password, TOTP
- identity: full name, first name, last name, email, phone
- address: line 1, line 2, city, region, postal code, country
- payment: cardholder, PAN, expiry, expiry month, expiry year, transient CVV

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
5. `apply-fill-bundle`: Magic Browser fills values locally and returns redacted
   counts/proof.
6. `revoke-fill-bundle`: Padloc revokes unused or failed bundles.

Logs must contain item ids, roles, counts, origins, and last4 only where useful.
No raw names, addresses, PAN, expiry, or CVV.

## Current Native Bridge Proof

- Protocol types: `packages/extension/src/autofill-broker-protocol.ts`
- Broker planner/bundler: `packages/extension/src/autofill-broker.ts`
- Native host: `packages/extension/native-host/padloc-autofill-host.mjs`
- Extension permission: `nativeMessaging`
- Background message: `agenticAutofillBroker`
- Popup approval prompt: `getAgenticAutofillApprovalPrompt` ->
  `approveAgenticAutofill`
- CDP service-worker entrypoint: `globalThis.padlocAgenticAutofillBroker`

The current host supports a metadata-only `status` handshake for Chrome native
messaging discovery. The extension background owns the unlocked broker path:
`plan-fill` matches requested field roles to unlocked Padloc item fields,
stores a pending plan, popup approval converts that plan into a short-lived
approval, and `mint-fill-bundle` returns a short-lived bundle. Values exist only
inside the bundle response path; UI/status/audit responses stay redacted.
The extension publishes redacted plan/approval/bundle metadata to the native
host cache through `sendNativeMessage`; the host refuses any cached response
with non-empty `bundleFields[].value`.

Magic Browser installs the host wrapper and Chrome manifest with:

```bash
node dist/cli.js setup-agentic-chromium --tier canary --padloc-root /Users/hassoncs/src/ch5/padloc --write
```

Magic Browser consumer code must reject any Padloc broker response that contains
non-empty `bundleFields[].value` in a printable/status path.

Magic Browser can call the extension-owned broker through the extension
service-worker CDP target for redacted plan/status requests. Printable/status
paths must reject non-empty bundle values.

Remaining production step: replace the CDP service-worker entrypoint for live
bundle retrieval with a full Chrome native-messaging port handoff from extension
to host for a stable local transport.
