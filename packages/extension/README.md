# @padloc/extension <!-- oc:id=sec_aa -->

The Padloc browser extension — a Chrome MV3 unpacked extension with full auth parity,
multi-field autofill, save/update credential prompts, and biometric re-unlock.

## Parity Feature Set <!-- oc:id=sec_ab -->

| Feature | Status |
|---------|--------|
| Email + TOTP auth | Complete |
| WebAuthn / Passkey auth | Complete |
| OAuth (Google, GitHub, etc.) | Complete |
| Biometric re-unlock (MV3 session key) | Complete |
| Multi-field login form autofill | Complete |
| Save / update credential prompts | Complete |
| Content script login/identity/address/payment field detection | Complete |
| Popup cold-start state restoration | Complete |
| Playwright runtime test harness | Complete |

## Setup <!-- oc:id=sec_ac -->

The `@padloc/extension` package is meant to be used from within the
[Padloc monorepo](../../README.md).

```sh
git clone git@github.com:padloc/padloc.git
cd padloc
npm ci
cd packages/extension
```

## Building <!-- oc:id=sec_ad -->

To build an unpacked version of the web extension, run from the monorepo root:

```sh
npm run web-extension:build
```

Or from the extension package directory:

```sh
cd packages/extension
npm run build
```

The resulting build is in `packages/extension/dist/`.

### Build Options <!-- oc:id=sec_ae -->

All build options are provided as environment variables:

| Variable Name   | Description                                   | Default                  |
| --------------- | --------------------------------------------- | ------------------------ |
| `PL_SERVER_URL` | URL to the Worker backend                     | `http://127.0.0.1:8787` |
| `PL_BUILD_ENV`  | Build environment label (e.g. `staging`)      | unset                    |

`PL_SERVER_URL` is baked into the extension at build time via webpack
`DefinePlugin`. The extension does not read this value at runtime.

### Installing an Unpacked Extension <!-- oc:id=sec_af -->

Google Chrome:

1. Open `chrome://extensions` <!-- oc:id=item_aa -->
1. Enable **Developer mode** (top right) <!-- oc:id=item_ab -->
1. Click **Load unpacked** <!-- oc:id=item_ac -->
1. Select `packages/extension/dist` <!-- oc:id=item_ad -->

Firefox is not yet in CI — see [packages/extension/NOTES.md](NOTES.md) for
known gaps.

## Testing <!-- oc:id=sec_ag -->

### Unit Tests (mocha) <!-- oc:id=sec_ah -->

```sh
cd packages/extension
npm test
```

Tests live in `test/*.ts` and cover: field classification, cold-start state
machines, OAuth stubs, biometric gating, save/update message types, and
autofill orchestration.

### Runtime Smoke Tests (Playwright) <!-- oc:id=sec_ai -->

These tests load the actual built extension in a headless Chromium, verify
popup load, background message routing, content script attachment, and worker
liveness.

```sh
npm run test:extension
```

Run changed-only proof first when iterating:

```sh
npm run test:changed -- --since hq/main
```

This runs `web-extension:build` followed by the Playwright harness. Equivalent
to:

```sh
npm run web-extension:build
cd packages/extension && npx playwright test
```

The harness is headless by default so it does not steal focus. Use
`PADLOC_EXTENSION_HEADFUL=1 npm run test:extension` only for visual debugging.

**First run**: Install the Chromium browser for Playwright:

```sh
cd packages/extension && npx playwright install chromium
```

The harness requires the extension to be built first (`dist/manifest.json` must
exist). The `globalSetup` in `playwright.config.ts` validates this before
running tests.

### CI Coverage <!-- oc:id=sec_aj -->

Both test lanes run in CI:

- `run-tests.yml` — runs unit tests on every PR and main push
- `build-web-extension.yml` — runs the Playwright harness after building on
  feature/fix branches and main push; archive the built extension as a
  `.crx` artifact

## Development <!-- oc:id=sec_ak -->

The extension dev workflow assumes the Padloc worker is running locally:

```sh
# From monorepo root
npm run worker:dev
```

Then build with your local API URL:

```sh
PL_SERVER_URL=http://127.0.0.1:8787 npm run web-extension:build
```

Load the `dist/` folder as an unpacked extension in Chrome. Reload the
extension in `chrome://extensions` after each build.

For hot-reload development, rebuild manually or use a file watcher.

## Architecture Notes <!-- oc:id=sec_al -->

- **MV3 session key**: Raw master key is stored in `browser.storage.session`
  (volatile, survives worker restarts). The worker and popup both restore from
  session storage after cold start.
- **No master-key relay**: The popup does not send the raw master key to the
  background worker. Both independently restore from session storage.
- **Content script field detection**: Field roles are determined by the content
  script scanning the live DOM, not from item data. Handles shadow DOM, aria
  labels, login, identity, address, payment, and transient CVV roles.
- **Agentic autofill bridge**: Padloc owns encrypted items and approval; Magic
  Browser owns browser execution and redacted proof. See
  [docs/agentic-autofill-bridge.md](../../docs/agentic-autofill-bridge.md).
- **`PL_SERVER_URL` is build-time only**: The extension connects to the API URL
  that was active when it was built. Change the env var and rebuild to point
  to a different environment.

## Contributing <!-- oc:id=sec_am -->

For info on contributing to Padloc, please refer to the
[monorepo readme](../../README.md#contributing).
