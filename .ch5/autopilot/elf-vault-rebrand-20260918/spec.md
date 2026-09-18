# Elf Vault Rebrand Specification

## Destination

Rebrand all current customer-facing CH5 Auth and current-product Padloc surfaces to **Elf Vault**.
Use the approved Elf/Firefly master visual language for the initial icon: dark aurora, violet/cyan
orb, and swept-back wing forms. Preserve internal Padloc identifiers where changing them would
break package, storage, native bridge, import, protocol, or release compatibility.

## Public hosts

| Surface | Production | Staging |
| --- | --- | --- |
| PWA | `https://vault.elf.dance` | `https://staging.vault.elf.dance` |
| Worker API | `https://api.vault.elf.dance` | `https://staging.api.vault.elf.dance` |

Keep the existing `pad*.ch5.me` app and API hosts operating during the compatibility window.
Do not redirect the old PWA until browser-origin state migration is separately proved. Do not
redirect old API POST clients; retain direct routes to the same Worker.

## Required behavior

- Customer-facing name, manifests, PWA, extension, current native surfaces, email templates,
  product docs, support/terms links, and release labels say Elf Vault.
- Existing legacy Padlock v2 import labels and v3 compatibility fixtures remain explicitly legacy.
- Existing `@padloc/*`, `PL_*`, `PADLOC_*`, repository ID, Pages projects, D1/R2/KV/DO names,
  native bridge IDs, bundle ID, and URL scheme remain compatible unless a dedicated migration is
  implemented.
- PWA CSP and Worker links use the stage-specific Elf Vault hosts.
- Worker CORS supports the exact old and new app origins during overlap, echoes only an allowed
  request origin, and sends `Vary: Origin`.
- Static email templates and generated Worker templates use Elf Vault and the stage-configured
  client URL.
- The approved Firefly master icon is reused as the first Elf Vault identity source; product
  differentiation can follow after launch. Source:
  `/Users/hassoncs/src/ch5/firefly-cloud/.ch5/assets/master/icon.png`, SHA-256
  `49a9e9ee59666624c3282f8829f1f52fbbfbaca94257d5d49d3b9b3ad0aece6a`.
- Hush remains operator/deployment secret authority.

## Deployment

- Reuse existing Worker, Pages, D1, R2, KV, and Durable Object resources.
- Add new `elf.dance` Worker routes and Pages custom domains without removing old hosts.
- DNS and Pages-domain operations use existing authorized operator lanes; no token mutation.
- Deploy and prove staging first.
- Production deploy is authorized by the user's direct request, but only after exact-SHA staging
  proof and the existing production promotion checks.
- The production deployment entrypoint itself must reject a non-current-main candidate or a
  candidate without exact staging proof before loading production credentials.
- The PWA artifact must publish candidate-SHA provenance and content hashes separately from the
  Worker health version.

## Acceptance

1. Local PWA/API render Elf Vault and pass focused Worker, extension, runtime, service, PWA, and
   brand-surface checks.
2. Customer-surface check finds no current-product Padloc/CH5 Auth names outside an explicit
   compatibility allowlist.
3. Staging Elf hosts resolve, serve exact commit, return healthy D1/R2/email status, correct CSP,
   exact CORS for old/new app origins, and branded PWA assets.
4. Old staging hosts still operate.
5. Production Elf hosts resolve and serve the staging-proved exact commit after promotion.
6. Old production hosts still operate.
7. No credential was rotated, reissued, revoked, or printed.
8. The old-origin PWA remains functionally usable: an existing browser can load, unlock, and sync;
   service-worker CSP is origin-safe instead of pinning registration to only the new hostname.
9. Native source/config/generated branding is complete and focused native build checks pass.
   Signed installed/store distribution is a separate release lane and is not claimed here.

## Operational proof contracts

- Old-origin functional smoke uses the existing stage-specific Hush targets
  `runtime-staging` and `runtime-production`, which already expose `PADLOC_AGENT_EMAIL` and
  `PADLOC_AGENT_MASTER_PASSWORD`. Provision with
  `hush run -t runtime-<stage> -- npm run agent:test-identity -- <stage>`, then run
  `hush run -t runtime-<stage> -- node scripts/proof-old-origin-pwa.mjs --stage <stage>`.
  Do not create or mutate credentials. The smoke must use a dedicated
  test vault, never customer data, and prove login, unlock, server sync, reload, and item
  visibility on the old origin. The provisioner email matcher must use Elf Vault branding after
  the email-template rebrand.
- Every PWA build emits `/build-provenance.json` with schema
  `elf-vault.pwa-provenance.v1`, stage, full Git SHA, app URL, API URL, build time, and
  SHA-256 hashes of `index.html`, the generated manifest, service worker, favicon, and entry
  JavaScript. The deployed-surface canary fetches this file. `scripts/deploy-production`
  requires staging API health and staging PWA provenance to report the exact candidate before
  loading production Hush credentials.
- Domain operations use the existing CH5 infrastructure owners:
  - Worker custom domains/routes: repo Wrangler deployment, preserving existing routes.
  - Pages domains and DNS: `ch5-infra` Terraform at `cloudflare/pages/domains.tf` and
    `cloudflare/dns/dns_explicit.tf`, using its canonical plan/apply entrypoint.
  Receipts are written to
  `.ch5/autopilot/elf-vault-rebrand-20260918/domain-receipts/<stage>.json`.
- Exact domain additions, no deletes:
  `staging.vault.elf.dance`, `staging.api.vault.elf.dance`, `vault.elf.dance`,
  `api.vault.elf.dance`. Pages projects remain `padloc-pwa-staging` and `padloc-pwa`;
  Worker environments remain `staging` and `production`.

## Explicitly deferred

- Removing old hosts.
- Changing sender address from `support@ch5.me`.
- Renaming internal packages, resources, metrics, repository, bundle ID, scheme, or native bridge.
- Migrating browser local state across origins.
- Claiming Worker WebAuthn login or cross-domain passkey continuity.
- Signed native/store publication.
