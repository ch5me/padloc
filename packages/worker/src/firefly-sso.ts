import { createElfVerifier } from "@ch5me/elf-auth-client";
import type { ElfTokenPayload, ElfVerifier } from "@ch5me/elf-auth-client";
import type { Env } from "./env";

/**
 * Firefly SSO token verification — see docs/native-messaging-host-manifest.md's sibling design
 * doc (TENANCY-AND-AGENT-PRINCIPALS-ADR.md in firefly-cloud) and G013 of
 * magic-browser-multitenant-cloud-ralplan.md.
 *
 * This is deliberately verification-only. It proves a Firefly-issued RS256 token can be verified
 * against the real JWKS from inside this Worker and maps it to `organizationId`/`elfUserId`,
 * WITHOUT touching account creation, login, or any crypto/vault-key material. Padloc's E2E
 * guarantee depends on the account master key being derived from a password (or an
 * enrolled-device/key-recovery path) — SSO authenticating a *session* is not the same thing as
 * supplying that key, and wiring this into the actual account/login flow without deciding how the
 * vault key is supplied would silently weaken that guarantee. That decision is explicitly NOT
 * made here; see the ADR's "Open question" section. This module only answers "can we verify a
 * Firefly token inside this Worker at all" — a prerequisite for any future login integration, not
 * the integration itself.
 *
 * padloc's Worker uses its own raw fetch-based Server/WorkerReceiver transport (see
 * packages/worker/src/index.ts, packages/worker/src/transport.ts) rather than Hono, so this uses
 * @ch5me/elf-auth-client's base entrypoint (createElfVerifier), not the /hono middleware —
 * correcting an earlier assumption in firefly-cloud's TENANCY-AND-AGENT-PRINCIPALS-ADR.md that
 * the /hono entrypoint would drop in unmodified; padloc is not a Hono Worker.
 */

let cachedVerifier: ElfVerifier | undefined;

export function fireflySsoConfigured(env: Env): boolean {
    return Boolean(env.FIREFLY_JWKS_URL && env.FIREFLY_ISSUER && env.FIREFLY_AUDIENCE);
}

function getVerifier(env: Env): ElfVerifier {
    if (!fireflySsoConfigured(env)) {
        throw new Error(
            "Firefly SSO is not configured: FIREFLY_JWKS_URL, FIREFLY_ISSUER, and FIREFLY_AUDIENCE are all required"
        );
    }
    if (!cachedVerifier) {
        cachedVerifier = createElfVerifier({
            jwksUrl: env.FIREFLY_JWKS_URL!,
            issuer: env.FIREFLY_ISSUER!,
            audience: env.FIREFLY_AUDIENCE!,
        });
    }
    return cachedVerifier;
}

/** Exposed for tests that need to force a fresh verifier against a different env. */
export function clearFireflySsoVerifierCache(): void {
    cachedVerifier = undefined;
}

export type FireflySsoVerifyResult =
    | { ok: true; payload: ElfTokenPayload }
    | { ok: false; error: string };

export async function verifyFireflySsoToken(env: Env, token: string): Promise<FireflySsoVerifyResult> {
    if (!token) return { ok: false, error: "missing_token" };
    const verifier = getVerifier(env);
    const result = await verifier.verify(token);
    if (!result.valid) return { ok: false, error: result.error };
    return { ok: true, payload: result.payload };
}

/**
 * Diagnostic-only route handler: verifies a bearer token and returns the tenancy claims it
 * carries. Never touches storage, accounts, or vault key material — see this module's doc
 * comment for why that boundary matters here specifically.
 */
export async function handleFireflySsoVerifyRoute(request: Request, env: Env): Promise<Response> {
    if (!fireflySsoConfigured(env)) {
        return new Response(JSON.stringify({ ok: false, error: "firefly_sso_not_configured" }), {
            status: 501,
            headers: { "Content-Type": "application/json; charset=utf-8" },
        });
    }
    const authorization = request.headers.get("authorization") || "";
    const token = authorization.startsWith("Bearer ") ? authorization.slice("Bearer ".length) : "";
    const result = await verifyFireflySsoToken(env, token);
    if (!result.ok) {
        return new Response(JSON.stringify({ ok: false, error: result.error }), {
            status: 401,
            headers: { "Content-Type": "application/json; charset=utf-8" },
        });
    }
    return new Response(
        JSON.stringify({
            ok: true,
            elfUserId: result.payload.elfUserId,
            organizationId: result.payload.organizationId ?? null,
            organizationRole: result.payload.organizationRole ?? null,
            botId: result.payload.botId ?? null,
        }),
        { status: 200, headers: { "Content-Type": "application/json; charset=utf-8" } }
    );
}
