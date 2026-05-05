# ADR-007: Email Delivery via Resend

**Status**: Draft  
**Date**: 2026-05-04  
**Deciders**: Padloc Cloudflare Native Backend Team  
**Blocked By**: T1 (Worker scaffolding), T4 (D1 schema)

---

## Context

Padloc currently sends transactional email via `SMTPSender`
(`packages/server/src/email/smtp.ts`), which uses `nodemailer` and reads
HTML/TXT template files from disk at runtime via `readFileSync`. This approach
is incompatible with Cloudflare Workers:

- Workers run at the edge with no filesystem access.
- Workers cannot use `nodemailer` (Node.js-only, not Web Standard Fetch).
- Email templates must be bundled as TypeScript string constants at compile
  time.

This ADR defines the email subsystem for the Cloudflare Workers backend using
the [Resend API](https://resend.com/docs/api-reference/emails/send-email) via
standard `fetch`.

---

## Decision

### 1. Message Class → Resend Template Mapping

All 8 `Message` subclasses from `packages/core/src/messenger.ts` are mapped to
Resend dynamic email templates. Each template uses `{{variable}}` interpolation
syntax (Resend native).

| Message Class                    | Template Name               | Resend Template ID                          | Idempotency Key                                      | Description                              |
| -------------------------------- | --------------------------- | ------------------------------------------- | ---------------------------------------------------- | ---------------------------------------- |
| `EmailAuthMessage`               | `email-auth`                | `template_<hash>_email_auth`                | `email-auth:{{data.requestId}}`                      | Signup verification code                 |
| `JoinOrgInviteMessage`           | `join-org-invite`           | `template_<hash>_join_org_invite`           | `join-org-invite:{{data.acceptInviteUrl}}`           | Org invite email                         |
| `ConfirmMembershipInviteMessage` | `confirm-org-member-invite` | `template_<hash>_confirm_org_member_invite` | `confirm-org-member-invite:{{data.acceptInviteUrl}}` | Confirm membership after invite accepted |
| `JoinOrgInviteAcceptedMessage`   | `join-org-invite-accepted`  | `template_<hash>_join_org_invite_accepted`  | `join-org-invite-accepted:{{data.confirmMemberUrl}}` | Notify inviter that invite was accepted  |
| `JoinOrgInviteCompletedMessage`  | `join-org-invite-completed` | `template_<hash>_join_org_invite_completed` | `join-org-invite-completed:{{data.orgName}}`         | Notify invitee they successfully joined  |
| `FailedLoginAttemptMessage`      | `failed-login-attempt`      | `template_<hash>_failed_login_attempt`      | `failed-login-attempt:{{data.location}}`             | Security alert for failed login          |
| `NewLoginMessage`                | `new-login`                 | `template_<hash>_new_login`                 | `new-login:{{data.location}}`                        | New login notification                   |
| `PlainMessage`                   | `plain`                     | `template_<hash>_plain`                     | `plain:{{data.message}}`                             | Generic error/notification message       |

**Note on Template IDs**: Resend template IDs are created via the Resend
dashboard. The `template_<hash>` prefix is a placeholder. Actual IDs are stored
in `env.RESEND_TEMPLATE_*` env vars (see below).

---

### 2. Template Bundling: Compile-Time TypeScript Strings

Existing `assets/email/*.{html,txt}` files must be converted to TS string
constants exported from `packages/worker/src/email/templates.ts`.

**File**: `packages/worker/src/email/templates.ts`

```typescript
// THIS FILE IS GENERATED — DO NOT EDIT MANUALLY
// Run: npm run build:email-templates

export const emailAuthHtml = ``; // content from assets/email/email-auth.html
export const emailAuthTxt = ``; // content from assets/email/email-auth.txt
// ... one export pair per template

export type TemplateName =
    | "email-auth"
    | "join-org-invite"
    | "confirm-org-member-invite"
    | "join-org-invite-accepted"
    | "join-org-invite-completed"
    | "failed-login-attempt"
    | "new-login"
    | "plain";

export const templateStrings: Record<
    TemplateName,
    { html: string; txt: string }
> = {
    "email-auth": { html: emailAuthHtml, txt: emailAuthTxt },
    // ...
};
```

**Build script** (`scripts/build-email-templates.mjs`):

- Reads all `assets/email/*.{html,txt}` files at build time (Node.js build step,
  NOT runtime)
- Emits `packages/worker/src/email/templates.ts`
- Runs as part of `pnpm build` before Worker bundling
- Template variables use `{{varname}}` syntax (matches both Resend and current
  Padloc template format)

**Why**: This eliminates all runtime `fs` access in the Worker. The Worker
bundle contains only string constants — no `readFileSync`, no `fs` bindings.

---

### 3. Resend API Call

**File**: `packages/worker/src/email/resend-sender.ts`

```typescript
export interface ResendConfig {
    apiKey: string;
    from: string;
    // Per-template overrides (template IDs from env)
    templateIds: Record<string, string>;
}

export interface ResendPayload {
    from: string;
    to: string;
    subject: string;
    html: string;
    text: string;
    headers?: Record<string, string>;
}

export class ResendSender implements Messenger {
    constructor(private config: ResendConfig) {}

    async send<T extends MessageData>(
        email: string,
        msg: Message<T>,
    ): Promise<void> {
        const templateId = this.config.templateIds[msg.template];
        const { html, text } = interpolateTemplate(
            msg.template,
            msg.title,
            msg.data,
        );

        const payload: ResendPayload = {
            from: this.config.from,
            to: email,
            subject: msg.title,
            html,
            text,
            headers: {
                // Idempotency key prevents duplicate sends on retries
                "Idempotency-Key": `${msg.template}:${this._idempotencyValue(msg)}`,
            },
        };

        const response = await fetch("https://api.resend.com/emails", {
            method: "POST",
            headers: {
                Authorization: `Bearer ${this.config.apiKey}`,
                "Content-Type": "application/json",
            },
            body: JSON.stringify(payload),
        });

        if (!response.ok) {
            const error = await response.text();
            throw new Error(`Resend API error ${response.status}: ${error}`);
        }
    }

    private _idempotencyValue<T extends MessageData>(msg: Message<T>): string {
        // Derive stable, unique key from message data
        const d = msg.data;
        if ("requestId" in d) return d.requestId;
        if ("acceptInviteUrl" in d) return d.acceptInviteUrl;
        if ("confirmMemberUrl" in d) return d.confirmMemberUrl;
        if ("message" in d) return d.message;
        if ("location" in d) return d.location;
        return JSON.stringify(d);
    }
}
```

---

### 4. Idempotency Strategy

Resend supports `Idempotency-Key` header (up to 255 characters). We use:

```
{templateName}:{primaryKeyFromData}
```

Examples:

- `email-auth:req_abc123` — uses request ID
- `join-org-invite:https://app.padloc.app/invite/xyz` — uses invite URL
- `failed-login-attempt:New York, NY` — uses location (may repeat; acceptable)

This ensures retry-safe sends without duplicate delivery.

---

### 5. Preview/Mock Mode (`EMAIL_BACKEND=mock`)

When `EMAIL_BACKEND=mock` (or unset in local/dev):

- Emails are logged to console (`console.log`).
- No network calls to Resend.
- In tests: `StubMessenger` from `@padloc/core/src/messenger` is used directly.
- In Worker dev: a `MockResendSender` class returns `{ id: "mock_id_xxx" }`
  without making HTTP requests.

**Safe test recipient**: When `EMAIL_MOCK_RECIPIENT` is set, all emails are
redirected to this address. This allows safe testing in staging without risk of
sending to real addresses.

```typescript
// packages/worker/src/email/mock-sender.ts
export class MockResendSender implements Messenger {
    constructor(private testRecipient?: string) {}

    async send<T extends MessageData>(
        email: string,
        msg: Message<T>,
    ): Promise<void> {
        const recipient = this.testRecipient ?? email;
        console.log(`[MOCK EMAIL] to=${recipient} subject=${msg.title}`);
        console.log(
            `  template=${msg.template} data=${JSON.stringify(msg.data)}`,
        );
    }
}
```

---

### 6. Environment Variables

Replace `PL_EMAIL_SMTP_*` with:

| Variable                                    | Description                                          |
| ------------------------------------------- | ---------------------------------------------------- |
| `EMAIL_BACKEND`                             | `resend` \| `mock` \| `console` (default: `console`) |
| `RESEND_API_KEY`                            | Resend API key (required for `resend` backend)       |
| `EMAIL_FROM`                                | From address, e.g., `Padloc <no-reply@padloc.app>`   |
| `RESEND_TEMPLATE_EMAIL_AUTH`                | Resend template ID for `email-auth`                  |
| `RESEND_TEMPLATE_JOIN_ORG_INVITE`           | Resend template ID for `join-org-invite`             |
| `RESEND_TEMPLATE_CONFIRM_ORG_MEMBER_INVITE` | Resend template ID for `confirm-org-member-invite`   |
| `RESEND_TEMPLATE_JOIN_ORG_INVITE_ACCEPTED`  | Resend template ID for `join-org-invite-accepted`    |
| `RESEND_TEMPLATE_JOIN_ORG_INVITE_COMPLETED` | Resend template ID for `join-org-invite-completed`   |
| `RESEND_TEMPLATE_FAILED_LOGIN_ATTEMPT`      | Resend template ID for `failed-login-attempt`        |
| `RESEND_TEMPLATE_NEW_LOGIN`                 | Resend template ID for `new-login`                   |
| `RESEND_TEMPLATE_PLAIN`                     | Resend template ID for `plain`                       |
| `EMAIL_MOCK_RECIPIENT`                      | Redirect all emails to this address (mock/dev only)  |

---

### 7. Template Interpolation

Since Resend supports `{{variable}}` syntax natively in dynamic templates, and
the existing `assets/email/*.html` files already use `{{varname}}`, the HTML
templates can be uploaded to Resend as dynamic templates with matching variable
names.

For the `text` plain-text versions, variable substitution is performed
client-side before sending (matching the existing
`SMTPSender._getMessageContent` behavior):

```typescript
// packages/worker/src/email/interpolate.ts
export function interpolateTemplate(
    template: string,
    title: string,
    data: MessageData,
): { html: string; txt: string } {
    const { html, txt } = templateStrings[template as TemplateName];
    const vars = { title, ...data };

    const htmlResult = html.replace(/\{\{\s*(\w+)\s*\}\}/gi, (_, key) =>
        dompurify.sanitize(String(vars[key] ?? "")),
    );
    const txtResult = txt.replace(/\{\{\s*(\w+)\s*\}\}/gi, (_, key) =>
        String(vars[key] ?? ""),
    );

    return { html: htmlResult, txt: txtResult };
}
```

> **Note**: HTML sanitization via `dompurify` is applied to the `html` output
> only. Plain text is used as-is.

---

### 8. Error Handling & Retries

- **Transient failures** (5xx, network timeout): Worker retries up to 3 times
  with exponential backoff using `ctx.waitUntil()`.
- **Permanent failures** (4xx except 429): Log error, do not retry.
- **Rate limits** (429): Honor `Retry-After` header if present, else backoff
  60s.

---

### 9. Migration Path from SMTPSender

| Aspect             | Old (`SMTPSender`)              | New (`ResendSender`)                            |
| ------------------ | ------------------------------- | ----------------------------------------------- |
| Transport          | `nodemailer` + SMTP             | `fetch` + Resend REST API                       |
| Templates          | `readFileSync` at runtime       | TS string constants at compile time             |
| Idempotency        | None                            | `Idempotency-Key` header                        |
| Preview mode       | `console` backend (stdout only) | `mock` backend (redirect + log)                 |
| Auth               | SMTP username/password          | `RESEND_API_KEY` Bearer token                   |
| Template variables | `{{varname}}` via regex replace | Same — compatible with Resend dynamic templates |

The `SMTPSender` and all `PL_EMAIL_SMTP_*` config are **removed** from the
Worker path. Node.js server deployments can continue using `SMTPSender` if SMTP
is still needed.

---

## Consequences

### Positive

- No filesystem access in Workers — fully edge-compatible.
- Idempotency prevents duplicate emails on retry.
- Mock mode enables safe local/staging testing.
- Single API key (`RESEND_API_KEY`) instead of SMTP credentials.
- Resend handles delivery, reputation, and retry logic.

### Negative

- Resend is a third-party SaaS — adds external dependency.
- Template management requires uploading templates to Resend dashboard (or using
  Resend API).
- Migration of existing `assets/email/` HTML files to Resend templates requires
  a one-time setup.

### Neutral

- `PlainMessage` is a generic fallback — all other message types cover specific
  flows.

---

## References

- [Resend API Docs](https://resend.com/docs/api-reference/emails/send-email)
- [Resend Idempotency](https://resend.com/docs/api-reference/emails/send-email#idempotency)
- `packages/core/src/messenger.ts` — Message class hierarchy
- `packages/server/src/email/smtp.ts` — Existing SMTP implementation (to be
  replaced)
- `assets/email/` — Source-of-truth for email content (HTML + TXT)
