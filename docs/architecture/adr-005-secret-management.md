# ADR-005: Secret Management

**Status**: Accepted  
**Date**: 2026-05-04  
**Context**: Padloc Cloudflare-native backend migration

## Decision

Cloudflare secrets are managed through Wrangler as the runtime mechanism.
Repo-local Hush v3 is the project source of truth for operator-managed secret
values and CI sync, while Cloudflare Workers Secrets remains authoritative at
runtime.

## Runtime Secrets

These secrets are injected into the worker `env` object at runtime:

| Secret Name          | Purpose                             | Required           | Environment |
| -------------------- | ----------------------------------- | ------------------ | ----------- |
| `RESEND_API_KEY`     | Resend email delivery auth          | Yes                | All         |
| `SESSION_SECRET`     | Session token HMAC/encryption key   | Yes                | All         |
| `EMAIL_FROM_ADDRESS` | Outbound email sender               | Yes                | All         |
| `WEBAUTHN_RP_ID`     | WebAuthn relying party domain       | If WebAuthn active | All         |
| `WEBAUTHN_RP_NAME`   | WebAuthn relying party display name | If WebAuthn active | All         |

Secrets are set per environment using:

```bash
wrangler secret put RESEND_API_KEY --env=production
wrangler secret put SESSION_SECRET --env=production
wrangler secret put EMAIL_FROM_ADDRESS --env=production
```

## Rules

1. **Never hardcoded.** Secrets are never embedded in source code, configuration
   files, or build artifacts.

2. **Environment-scoped.** Each environment gets its own secret values. The same
   secret name in dev and production points to different values.

3. **Wrangler is authoritative at runtime.** The worker reads secrets from
   `env.RESEND_API_KEY`, not from any local file, Hush projection, or CI
   variable.

4. **Hush is the project secret source of truth.** Hush stores the
   operator-managed values locally so developers do not need to look them up in
   the Cloudflare dashboard or 1Password each time. Hush values are synced to
   Cloudflare via `wrangler secret put` before or during deploy. Hush does not
   replace Cloudflare Secrets at runtime.

5. **No secrets in `wrangler.jsonc` or `wrangler.toml`.** Binding names for D1,
   R2, and KV go in Wrangler config. Actual secret values never do.

## Current Config Secrets Mapping

From `packages/server/src/config.ts`, the following `PL_*` environment variables
map to Cloudflare secrets:

| Current Variable           | Cloudflare Secret    | Notes                             |
| -------------------------- | -------------------- | --------------------------------- |
| `PL_EMAIL_SMTP_PASSWORD`   | `RESEND_API_KEY`     | Auth backend changes SMTP->Resend |
| `PL_EMAIL_FROM_ADDRESS`    | `EMAIL_FROM_ADDRESS` | Same concept, new name            |
| `PL_SERVER_SESSION_SECRET` | `SESSION_SECRET`     | Same concept, new name            |
| `PL_AUTH_WEBAUTHN_RP_ID`   | `WEBAUTHN_RP_ID`     | Deferred until WebAuthn parity    |
| `PL_AUTH_WEBAUTHN_RP_NAME` | `WEBAUTHN_RP_NAME`   | Deferred until WebAuthn parity    |

## CI/CD Secret Sync

For Forgejo Actions deployments:

1. Store the project-scoped `CLOUDFLARE_API_TOKEN` and `CLOUDFLARE_ACCOUNT_ID`
   in GitHub repository secrets.
2. Keep runtime secret values in repo-local Hush and sync them to Cloudflare
   before deploy when changed.
3. CI should deploy with the project-scoped Cloudflare token; it should not
   receive the global bootstrap token.

## Developer Onboarding

New developers can work locally without any secrets for basic functionality:

-   `wrangler dev` runs with local Miniflare emulation. Non-existent secrets
    return `undefined`, which the worker handles with stub/fallback behavior.
-   For email delivery, developers who want to test Resend integration set
    `RESEND_API_KEY` via `wrangler secret put` locally.
-   For team secret sharing, use 1Password and Hush. Do not paste secrets into
    Slack, email, or shared documents.

## Consequences

### Positive

-   Cloudflare secrets are encrypted at rest and only decrypted at worker
    execution time.
-   No secret files in the repository, even in `.gitignore`d paths (eliminates
    leakage risk).
-   Environment scoping prevents staging secrets from leaking into production.

### Negative

-   Wrangler secret management requires Cloudflare dashboard access or CI token
    permissions.
-   No built-in secret rotation audit trail. Rotation must be done manually.
-   Local developers without Cloudflare access cannot test integrations that
    require live secrets (e.g., Resend).

## References

-   `.sisyphus/plans/padloc-cloudflare-native-backend.md` lines 347
-   `packages/server/src/config.ts`
-   `hush-projection-contract` skill (optional Hush integration)
