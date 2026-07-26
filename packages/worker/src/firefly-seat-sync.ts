import { OrgAwareProvisioner } from "./provisioner/org-aware";
import { D1Storage } from "./storage/d1";
import type { Env } from "./env";

/**
 * Firefly seat-sync admin route — G020 of magic-browser-multitenant-cloud-ralplan.md.
 *
 * Elf Vault (padloc) seat billing routes through Firefly's existing Teams/Enterprise seat
 * machinery (`organization_seats_purchases`, firefly-cloud's
 * `apps/web/src/lib/organizations/vault-seat-sync.ts`), not a new Stripe provisioner. This is the
 * receiving end of that sync: firefly-cloud calls this route, from within its own real Stripe
 * subscription-event consumer, whenever a linked organization's seat count changes. It is a thin
 * shim over `OrgAwareProvisioner.setOrgSeats` (padloc@111e298f3,
 * `packages/worker/src/provisioner/org-aware.ts`) — this module has no billing knowledge, exactly
 * as `setOrgSeats`'s own doc comment anticipates.
 *
 * Auth: a shared bearer secret (`FIREFLY_SEAT_SYNC_SECRET`), compared in constant time — this is a
 * service-to-service call, not a user-facing route, and carries no user session. Absent secret
 * configuration disables the route entirely (501), matching `firefly-sso.ts`'s
 * `fireflySsoConfigured` pattern for the same reason: a route that silently no-ops without its
 * secret is worse than one that fails loud as "not configured."
 */

export function fireflySeatSyncConfigured(env: Env): boolean {
    return Boolean(env.FIREFLY_SEAT_SYNC_SECRET);
}

/** `crypto.subtle.timingSafeEqual` isn't available in Workers; compare byte-for-byte without early exit. */
function constantTimeEqual(a: string, b: string): boolean {
    const enc = new TextEncoder();
    const aBytes = enc.encode(a);
    const bBytes = enc.encode(b);
    const length = Math.max(aBytes.length, bBytes.length);
    let diff = aBytes.length ^ bBytes.length;
    for (let i = 0; i < length; i++) {
        diff |= (i < aBytes.length ? aBytes[i] : 0) ^ (i < bBytes.length ? bBytes[i] : 0);
    }
    return diff === 0;
}

type SetOrgSeatsBody = { orgId: string; seats: number };

function parseBody(raw: unknown): SetOrgSeatsBody | undefined {
    if (!raw || typeof raw !== "object") return undefined;
    const { orgId, seats } = raw as Record<string, unknown>;
    if (typeof orgId !== "string" || !orgId) return undefined;
    if (typeof seats !== "number" || !Number.isInteger(seats)) return undefined;
    // -1 means "unlimited" (see OrgSeatAllocation.seats) and is a legitimate value to set
    // explicitly (e.g. clearing an allocation); anything else must be non-negative.
    if (seats < -1) return undefined;
    return { orgId, seats };
}

function jsonResponse(status: number, body: Record<string, unknown>): Response {
    return new Response(JSON.stringify(body), {
        status,
        headers: { "Content-Type": "application/json; charset=utf-8" },
    });
}

export async function handleSetOrgSeatsRoute(request: Request, env: Env): Promise<Response> {
    if (!fireflySeatSyncConfigured(env)) {
        return jsonResponse(501, { ok: false, error: "firefly_seat_sync_not_configured" });
    }

    const authorization = request.headers.get("authorization") || "";
    const presentedSecret = authorization.startsWith("Bearer ") ? authorization.slice("Bearer ".length) : "";
    if (!presentedSecret || !constantTimeEqual(presentedSecret, env.FIREFLY_SEAT_SYNC_SECRET!)) {
        return jsonResponse(401, { ok: false, error: "invalid_secret" });
    }

    let raw: unknown;
    try {
        raw = await request.json();
    } catch {
        return jsonResponse(400, { ok: false, error: "invalid_json" });
    }

    const body = parseBody(raw);
    if (!body) {
        return jsonResponse(400, { ok: false, error: "invalid_body" });
    }

    if (!env.DB) {
        return jsonResponse(500, { ok: false, error: "storage_unavailable" });
    }

    const provisioner = new OrgAwareProvisioner(new D1Storage(env.DB));
    await provisioner.setOrgSeats(body.orgId, body.seats);

    return jsonResponse(200, { ok: true });
}
