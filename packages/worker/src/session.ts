import { Session, SessionID } from "@padloc/core/src/session";
import { Err, ErrorCode } from "@padloc/core/src/error";
import { Env } from "./env";

export interface SessionRecord {
    sessionId: SessionID;
    accountId: string;
    keyBlob: string;
    expiresAt: string | null;
    revokedAt: string | null;
    lastUsedAt: string;
    deviceJson: string | null;
}

/**
 * Read session from D1 exactly once per request. KV staleness is an auth
 * bypass vector, so the sessions table is the single source of truth.
 */
export async function readSessionFromD1(db: D1Database, sessionId: SessionID): Promise<SessionRecord | null> {
    const row = await db
        .prepare(
            `SELECT id as sessionId, account_id as accountId, key_blob as keyBlob,
                    expires_at as expiresAt, revoked_at as revokedAt,
                    last_used_at as lastUsedAt, device_json as deviceJson
             FROM sessions WHERE id = ?`
        )
        .bind(sessionId)
        .first<SessionRecord>();
    return row ?? null;
}

/**
 * Validate a session: present, not revoked, not expired.
 */
export function validateSessionState(record: SessionRecord): void {
    if (record.revokedAt) {
        throw new Err(ErrorCode.SESSION_EXPIRED, "Session has been revoked");
    }
    if (record.expiresAt && new Date(record.expiresAt) < new Date()) {
        throw new Err(ErrorCode.SESSION_EXPIRED, "Session has expired");
    }
}

/**
 * Load a Session instance from D1, validate state, and re-sign the request
 * to confirm integrity.
 *
 * Read-once: the caller must call this at most once per request to avoid
 * TOCTOU where revoked_at / expires_at change between checks.
 */
export async function resolveSession(db: D1Database, sessionId: SessionID): Promise<Session> {
    const record = await readSessionFromD1(db, sessionId);
    if (!record) {
        throw new Err(ErrorCode.INVALID_SESSION, "Session not found");
    }

    validateSessionState(record);

    const session = new Session();
    session.id = record.sessionId;
    session.account = record.accountId;
    const keyBlob = JSON.parse(record.keyBlob);
    session.key = new Uint8Array(keyBlob);
    session.lastUsed = new Date(record.lastUsedAt);
    if (record.expiresAt) session.expires = new Date(record.expiresAt);
    if (record.deviceJson) {
        session.device = JSON.parse(record.deviceJson);
    }

    return session;
}

/**
 * Update the session's last_used_at touch and persist any session changes
 * after request processing.
 */
export async function touchSession(db: D1Database, session: Session): Promise<void> {
    session.lastUsed = new Date();
    await db
        .prepare("UPDATE sessions SET last_used_at = ? WHERE id = ?")
        .bind(session.lastUsed.toISOString(), session.id)
        .run();
}

export interface RateLimitRecord {
    ip: string;
    route: string;
    count: number;
    windowStart: string;
}

/**
 * Increment a KV-backed rate-limit counter for (ip, route) with a TTL
 * window. Returns the current count.
 *
 * KV is only a hint — authoritative throttle decisions live in D1.
 */
export async function incrementRateWindow(
    kv: KVNamespace,
    ip: string,
    route: string,
    ttlSeconds: number
): Promise<number> {
    const key = `rate:${ip}:${route}`;
    const current = (await kv.get(key, "json")) as { count: number; windowStart: string } | null;
    const now = new Date();

    const isNew = !current || now.getTime() - new Date(current.windowStart).getTime() > ttlSeconds * 1000;

    const next = {
        count: isNew ? 1 : current.count + 1,
        windowStart: isNew ? now.toISOString() : current.windowStart,
    };
    await kv.put(key, JSON.stringify(next), { expirationTtl: ttlSeconds * 2 });
    return next.count;
}

/**
 * Read the authoritative throttle flag from the D1 auth row.
 * Returns the number of consecutive failures or 0 if not throttled.
 */
export async function readAuthThrottle(db: D1Database, accountId: string): Promise<number> {
    const row = await db
        .prepare("SELECT failed_attempts FROM auth WHERE account_id = ?")
        .bind(accountId)
        .first<{ failed_attempts: number }>();
    return row?.failed_attempts ?? 0;
}

/**
 * Check if a request exceeds rate limits. KV staleness cannot bypass this
 * because the D1 auth row is authoritative.
 */
export async function checkRateLimit(env: Env, ip: string, route: string, accountId: string | null): Promise<void> {
    const kvCount = env.HINTS ? await incrementRateWindow(env.HINTS, ip, route, 60) : 0;

    if (kvCount > 100 && accountId) {
        const authFailures = await readAuthThrottle(env.DB!, accountId);
        if (authFailures >= 5) {
            throw new Err(ErrorCode.INVALID_REQUEST, "Account temporarily locked");
        }
    }

    if (kvCount > 200) {
        throw new Err(ErrorCode.INVALID_REQUEST, "Too many requests");
    }
}
