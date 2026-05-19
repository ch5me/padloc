## 2026-05-19 launch topology freeze

- Live runtime source of truth checked first: `packages/worker/src/env.ts`,
  `packages/worker/wrangler.toml`, and `packages/pwa/webpack.config.js`.
- Freeze production split-host topology as `pad.ch5.me` for the PWA and
  `api-pad.ch5.me` for the Worker API. This fits the current runtime contract
  because the PWA already consumes a full backend origin via `PL_SERVER_URL`,
  and the Worker only exposes a direct CORS allowlist via `ALLOW_ORIGIN`; no
  same-origin proxy is required.
- No `/server` proxy path exists in `packages/worker` or `packages/pwa`. Any
  `/server` references found by repo grep live in deferred legacy docs/examples
  outside today's implementation lane and must not be reintroduced into runtime
  config.
- Do not use `padloc.app` hosted infrastructure for runtime. Current
  `padloc.app` hits in assets, emails, legacy docs, support links, and mobile
  identity remain deferred unless they block the shipped PWA+Worker path.
- Fresh-account bootstrap path is the launch proof path. Do not spend scope on
  continuity or migration work for existing accounts in this lane.
- Deep-link scheme is frozen to `ch5`. Current read-only identity sources still
  show legacy values (`assets/manifest.json` has `appId: app.padloc` and
  `scheme: padloc`; `packages/cordova/config.xml` has widget id `app.padloc`).
  Those rename surfaces are package-scope follow-up work, not part of this
  freeze unless a downstream runtime task proves blocking.
- TOTP proof stays in scope with one real base32 seed and two consecutive
  windows. Worker test coverage already exercises TOTP flows; this freeze keeps
  TOTP as the proof lane and does not expand auth surface.
- No passkey continuity work for launch. Worker/package references to WebAuthn
  remain non-blocking unless a runtime task explicitly needs them for a shipped
  path.
- Note: inherited planning text mentioned `api-pad.ch3.me`; treat that as
  stale/typo. Repo freeze for today is `api-pad.ch5.me`.

## 2026-05-19 bundle identity rename (T1 follow-through)

### Changes made

**`assets/manifest.json`** — identity source:

- `name`: "Padloc" → "CH5 Auth"
- `appId`: "app.padloc" → "me.ch5"
- `scheme`: "padloc" → "ch5"

**`packages/cordova/update-config-xml.js`** — Cordova updater:

- Added `scheme` to destructured import from manifest.json
- Added idempotent `<allow-intent scheme="ch5" launchExternal="true"/>`
  insertion
- Handles re-run deduplication (array/scalar normalization, filter before push)
- Regenerated `packages/cordova/config.xml` with `id="me.ch5"`,
  `<name>CH5 Auth</name>`

**Electron (`packages/electron/prepare-build.js`)** and **Tauri
(`packages/tauri/build-tauri-conf.js`)** already read `name`, `appId`, `scheme`
from manifest.json at build time — no changes needed; they will pick up the new
values automatically.

### QA verification

```
rg -n "app\.padloc|me\.ch5|CH5 Auth|scheme" assets/ packages/cordova/
```

→ `me.ch5` and `CH5 Auth` present in manifest.json, config.xml, and updater
script; `scheme: "ch5"` confirmed.

```
rg -n "me\.ch5:|scheme.*me\.ch5" packages/ assets/
```

→ Zero matches (no dotted scheme anywhere).

```
rg -n "app\.padloc" assets/manifest.json packages/cordova/config.xml
```

→ Zero matches (old identity gone from bundle surfaces).

## 2026-05-19 shipped identity surface rename (support/email/branding)

### Changes made

- `packages/pwa/webpack.config.js`: `PL_SUPPORT_EMAIL` → `support@ch5.ai`
- `packages/cordova/webpack.config.js`: `PL_SUPPORT_EMAIL` → `support@ch5.ai`
- `assets/support.md`: All `padloc.app` URLs replaced with `ch5.ai` equivalents:
    - Website → `https://ch5.ai/`
    - Blog → `https://ch5.ai/blog/`
    - TOS → `https://ch5.ai/tos/`
    - Privacy → `https://ch5.ai/privacy/`
    - Contact Support → `mailto:support@ch5.ai`
    - User Manual → `https://docs.ch5.ai/manual/`
    - FAQ → `https://docs.ch5.ai/faq/`
- `assets/email/*.html` and `*.txt` source templates: Email footers updated from
  `Padloc (https://padloc.app) support@padloc.app` →
  `CH5 (https://ch5.ai) support@ch5.ai`
- `assets/email/*.html` and `*.txt`: Body text references to "Padloc
  organization" and "in Padloc" changed to "CH5 organization" / "in CH5"
- `packages/worker/src/email/templates.ts`: Regenerated from updated source
  templates

### Deferred (not user-visible today)

- `assets/manifest.json`: `terms_of_service: "https://padloc.app/tos"` —
  webpack-injected at build time via `PL_TERMS_OF_SERVICE` env var; env var not
  hardcoded in shipped webpack configs, so deferred
- `packages/worker/src/email/resend.ts:121`: Fallback sender
  `"Padloc <noreply@padloc.app>"` — email FROM address set via
  `EMAIL_FROM_ADDRESS` env var at runtime
- `packages/app/src/elements/login-signup.ts`: Migration help URLs to
  `padloc.app/help/*`
- `packages/app/src/elements/report-errors-dialog.ts`: Error report subject/body
  "Padloc"
- `packages/app/src/elements/settings-security.ts:473`: "Padloc app" in session
  help text
- SVG logo IDs (`id="Padloc"`) — not user-visible text, deferred
- Cordova config.xml author URL — not shown to users in shipped app

## 2026-05-19 T2: Cloudflare resource bootstrap

### Actions taken

- Verified bootstrap token via `cf-project.sh whoami` — account
  `25bb5f8d9ec4a36106f0ff6b519133b1` (Hassoncs@gmail.com)
- Minted project-scoped deploy token (`padloc-deploy`) via
  `cf-project.sh mint-deploy-token padloc`
- Stored `CLOUDFLARE_API_TOKEN` and `CLOUDFLARE_ACCOUNT_ID` in repo-local Hush
  (`.hush/` v3, bootstrapped today)
- Pinned `account_id = "25bb5f8d9ec4a36106f0ff6b519133b1"` at top level of
  `packages/worker/wrangler.toml`
- Created missing R2 bucket `padloc-attachments-dev` (was absent from account)

### Resource verification (deploy token + wrangler confirmed)

| Resource                                | Binding        | ID                                     | Status                           |
| --------------------------------------- | -------------- | -------------------------------------- | -------------------------------- |
| D1 `padloc-prod`                        | `DB`           | `f443b7e5-861e-4a4f-9c67-1a33acf5677d` | EXISTS (created 2026-05-05)      |
| D1 `padloc-preview`                     | `DB`           | `426f172f-8117-48c6-849b-1b26901b89e6` | EXISTS (created 2026-05-05)      |
| D1 `padloc-dev`                         | `DB`           | `e2bf5126-0913-48a1-831d-531606f398c9` | EXISTS (created 2026-05-04)      |
| R2 `padloc-attachments-prod`            | `ATTACHMENTS`  | —                                      | EXISTS (bootstrap API confirmed) |
| R2 `padloc-attachments-preview`         | `ATTACHMENTS`  | —                                      | EXISTS (bootstrap API confirmed) |
| R2 `padloc-attachments-dev`             | `ATTACHMENTS`  | —                                      | CREATED today (was missing)      |
| KV `production-PADLOC_EMAIL_PRODUCTION` | `EMAIL_KV`     | `0231a8c22d1b4a54a3c4b9e72a68165d`     | EXISTS                           |
| KV `production-PADLOC_HINTS_PRODUCTION` | `HINTS`        | `0abcb21cdf5541b9a7f8c2c35e922a7b`     | EXISTS                           |
| KV `preview-PADLOC_EMAIL_PREVIEW`       | `EMAIL_KV`     | `9dbdc747eeb4472681e9f081eb9e8269`     | EXISTS                           |
| KV `preview-PADLOC_HINTS_PREVIEW`       | `HINTS`        | `f868962679c74a33886cff584f37d18d`     | EXISTS                           |
| DO `AccountLockDO`                      | `ACCOUNT_LOCK` | —                                      | DECLARED in wrangler.toml        |

### Key observations

- `wrangler d1 list` requires `memberships:read` scope — not included in project
  deploy token. Use `wrangler d1 info <name> --env=<env>` for targeted
  verification instead.
- `wrangler r2 bucket list` paginates (20/page); padloc buckets appear on
  page 2. Creation attempt returns "already exists" confirming presence.
- Deploy token stored in repo Hush;
  `hush run -- bash -c 'CLOUDFLARE_API_TOKEN="$CLOUDFLARE_API_TOKEN" wrangler ...'`
  resolves correctly.
- wrangler.toml env sections use `[env.production]` (hyphen); deploy token
  verification warns "No environment found with name 'production'" but still
  returns correct DB info.
- Repo was not Hush-enabled; bootstrapped fresh v3 repo. Old `hush.yaml`
  references in status were stale — no actual legacy files existed.
- `cf-project.sh whoami` with repo-local Hush token succeeds — confirms token is
  usable for deploy operations.
