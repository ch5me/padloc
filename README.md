# CH5 Auth

[![](https://git.ch5.me/ch5/padloc/actions/workflows/run-tests.yml/badge.svg?branch=main)](https://git.ch5.me/ch5/padloc/actions)

CH5 Auth is CH5's encrypted credential, passkey, and personal-autofill vault. It
is a CH5-maintained fork of Padloc with a Cloudflare-native backend, web and
native clients, and a security-gated bridge to Magic Browser.

CH5 Auth is a federated service in the Firefly/ELF product ecosystem. Firefly
owns the shared product shell, identity, billing, and agent runtime; CH5 Auth
keeps its own security boundary, encrypted product data, deployment, and release
cadence. Magic Browser owns browser execution and redacted proof. Hush stores
operator and deployment secrets, not users' vault records.

## Use CH5 Auth

-   **Web app:** [pad.ch5.me](https://pad.ch5.me)
-   **Native app:** CH5 Auth for iPhone
-   **Service API:** [api-pad.ch5.me](https://api-pad.ch5.me)

The product supports encrypted vaults, credentials, secure notes and structured
autofill records, attachments, organizations and sharing, account MFA, browser
autofill, and CH5-owned passkeys. Passkey and agentic-autofill integrations are
deliberately fail-closed and keep raw secrets out of logs, command arguments,
screenshots, and durable browser proof.

## Product Status

CH5 Auth is in **maintenance mode**: security fixes, dependency/runtime upkeep,
upstream compatibility, and regression-proof maintenance continue, while broad
new product development belongs in Firefly/ELF or the appropriate federated
sub-app.

Production deployment is human-gated. Staging deployment and automated proof may
run through CH5-owned Forgejo CI, but production requires an explicit human
release action after the exact commit has passed its required checks.

The native passkey provider is not yet a release-complete Padloc vault
integration: its Keychain broker does not currently use the real unlocked-vault
or local-service boundary. This remains a release blocker and must not be
described as biometric or vault-backed production proof. See the
[native vault boundary ADR](docs/adr-passkey-native-vault-boundary.md) and
[verification matrix](docs/passkey-provider-verification-matrix.md).

## Repository

This repo is split into multiple packages:

| Package Name                            | Description                                                                                      |
| --------------------------------------- | ------------------------------------------------------------------------------------------------ |
| [@padloc/core](packages/core)           | Core Logic                                                                                       |
| [@padloc/app](packages/app)             | Web-based UI components                                                                          |
| [@padloc/worker](packages/worker)       | The Cloudflare Worker backend                                                                    |
| [@padloc/pwa](packages/pwa)             | The Web Client, a [Progressive Web App](https://developers.google.com/web/progressive-web-apps). |
| [@padloc/locale](packages/locale)       | Package containing translations and other localization-related things                            |
| [@padloc/electron](packages/electron)   | The Desktop App, built with Electron                                                             |
| [@padloc/cordova](packages/cordova)     | Cordova project for building iOS and Android app.                                                |
| [@padloc/tauri](packages/tauri)         | Cross-platform native app, powered by [Tauri](https://github.com/tauri-apps/tauri)               |
| [@padloc/extension](packages/extension) | Padloc browser extension                                                                         |

## Run Locally

The minimum local stack is the [Cloudflare Worker backend](packages/worker) and
the [web client](packages/pwa):

```sh
git clone git@git.ch5.me:ch5/padloc.git
cd padloc
npm ci
npm start
```

The current local web client is available at `http://localhost:3000`, backed by
the Worker at `http://127.0.0.1:8787`.

## Maintenance and Contributions

This repository does not use pull requests. Changes go to a topic branch, pass
exact-SHA branch CI, and are fast-forwarded to `main`. Maintenance changes
should preserve the upstream-compatible package structure where practical and
must retain the security boundaries documented in
[the fork strategy](docs/fork-strategy.md),
[the agentic-autofill bridge](docs/agentic-autofill-bridge.md), and
[the passkey test plan](docs/passkey-provider-test-plan.md).

## Security

For a security design overview, check out the
[security whitepaper](security.md).

## HQ Observability

CH5 Padloc Worker HQ instrumentation lives in
`packages/worker/src/hq-instrumentation.ts`. Runtime contract uses Hush-backed
Worker secrets `HQ_SENTRY_DSN` and `HQ_OTLP_ENDPOINT`, plus derived vars
`HQ_ENVIRONMENT`, `HQ_RELEASE`, and `HQ_SERVICE_NAME`. Internal CH5 HQ hosts
only: `logs.ch5.me` or `staging.logs.ch5.me`. `sentry.io` is rejected on
startup.

Telemetry surface:

-   Sentry-compatible envelopes for reportable Worker errors
-   OTLP JSON traces for request/lifecycle spans
-   Fail-loud mis-wire, visible-warn graceful degrade on HQ outage

## Development

### Setup

Set up the development environment with:

```sh
git clone git@git.ch5.me:ch5/padloc.git
cd padloc
npm ci
```

This may take a minute, so maybe grab a cup of ☕️.

### Dev Mode

To start "dev mode", simply run

```sh
npm run dev
```

from the root of the project. This will start the Cloudflare Worker backend on
`http://127.0.0.1:8787`, as well as the PWA (available on
`http://localhost:3000`) by default.

The worker and PWA port can be changed via the `PL_WORKER_PORT` and
`PL_PWA_PORT` environment variables, respectively. For more configuration
options, check out the worker config in `packages/worker/wrangler.toml` and the
[pwa](packages/pwa#configuration).

### Formatting

This project is formatted with [Prettier](https://prettier.io/). To re-format
all files using our [.prettierrc.json](.prettierrc.json) specification, run the
following from the root of the project.

```sh
npm run format
```

To simply check whether everything is formatted correctly, you can use the
following command:

```sh
npm run format:check
```

### Testing

To run unit tests, use:

```sh
npm run test
```

Cypress end-to-end tests can be run via:

```sh
npm run test:e2e
```

And to start cypress tests in "dev mode":

```ssh
npm run test:e2e:dev
```

### Browser Extension

To build the unpacked extension:

```sh
npm run web-extension:build
```

The resulting `dist/` folder can be loaded as an unpacked Chrome extension. See
[packages/extension/README.md](packages/extension/README.md) for build options
and full feature documentation.

To build and run the extension Playwright test harness (runtime smoke tests):

```sh
npm run test:extension
```

For iteration, use changed-only CH5 planning first:

```sh
npm run test:changed -- --since hq/main
```

The extension harness is headless by default. For visual debugging only:

```sh
PADLOC_EXTENSION_HEADFUL=1 npm run test:extension
```

The extension harness requires Chromium. Install it via:

```sh
cd packages/extension && npx playwright install chromium
```

### Adding / removing dependencies

Since this is a monorepo consisting of multiple packages, adding/removing
to/from a single package can be less than straightforward. The following
commands are meant to make this easier.

To add a dependency to a package, run:

```sh
scope=[package_name] npm run add [dependency]
```

And to remove one:

```sh
scope=[package_name] npm run remove [dependency]
```

For example, here is how you would add `typescript` to the `@padloc/server`
package:

```sh
scope=server npm run add typescript
```

**Note**: Keep the number and size of third-party dependencies to a minimum.
Prefer the standard library and existing dependencies; additions need a clear
maintenance and security justification.

### Updating The Version

The Padloc project consists of many different subpackages. To simplify
versioning, we use a global version for all them. This means that when releasing
a new version, the version of all subpackages needs to be updated, regardless of
whether there have been changes in them or not. To update the global version
accross the project, you can use the following command:

```sh
npm run version [semver_version]
```

### Deployment / Publishing

CH5 Auth deploys the Worker API and static PWA through CH5-owned Forgejo
workflows. Staging is the stable pre-production target. Production releases are
human-gated: update the version, verify the exact commit in branch and staging
CI, then explicitly run the authorized production release workflow.

## Licensing

This software is published under the
[GNU Affero General Public License](LICENSE). CH5 Auth derives from Padloc; see
the repository history and license notices for upstream attribution.
