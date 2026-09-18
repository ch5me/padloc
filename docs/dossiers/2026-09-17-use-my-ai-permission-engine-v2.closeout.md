# Use My AI Permission Engine v2 - Closeout

## Delivered

-   Deterministic per-operation permission engine with exact recipients,
    targets, representations, expiry, leases, revocation generations, parent
    bounds, reason codes, and replay-safe use reservations.
-   Secret-blind autofill plans that expose opaque source/field references and
    roles while keeping selectors, item metadata, source locators, previews, and
    values inside the extension.
-   Browser-derived tab/frame/document/form/field binding, target revalidation
    before each field, local value resolution after grant reservation, exact
    content-script writes, partial/outcome-unknown handling, and receipt-only
    responses.
-   Value-free exact origin/item/role standing policies; `plan`, `manual`,
    `auto`, `dontAsk`, and `bypassPrompts`; allow/deny once or until revoked;
    owner policy listing and revocation; monotonic revisions.
-   Session-persistent post-fill `potentially-private` state. Receipts and
    `privacy-status` require generic observation blocking. Reveal and submit
    contracts fail closed pending separate grants.

## Proof

-   `npm --prefix packages/extension test`: green, including permission, policy,
    observation, broker, passkey, and worker suites.
-   `npm --prefix packages/extension run check:source`: green, including strict
    TypeScript and readiness redaction self-test.
-   `PL_BUILD_ENV=production npm --prefix packages/extension run build`: green;
    webpack reports only existing asset-size warnings.
-   Focused production Playwright proof: exact secret-blind synthetic writes and
    stale-field refusal both pass.
-   Full production Playwright lane: 14 pass, 1 skipped, 1 unrelated passkey
    diagnostics timing failure. Default development build additionally emits the
    pre-existing Lit dev-mode warning.

## UNKNOWN

-   Live unlocked native-queue synthetic checkout proof, including
    popup/standing-policy approval and mid-batch remote revocation, is
    **UNKNOWN**; it requires an attended unlocked extension/native-host session.
-   Magic Browser enforcement of `genericObservation: blocked` is **UNKNOWN** in
    this repository; Padloc emits the boundary, but the consumer implementation
    is in the separate Magic Browser checkout.
-   Remote authenticated revocation transport, offline leases, model reveal,
    registered derivations, submit grants, MCP/ACP adapters, ELF transport, and
    assessor integration remain **UNKNOWN / not implemented** and fail closed
    where exposed.
-   `npm run test:changed -- --since 3f049a56` is **UNKNOWN** on this host
    because the required `ch5` CLI is unavailable.

🔐 AGENT PERMISSION ENGINE: implementation and focused browser proof complete
4d6a9159
