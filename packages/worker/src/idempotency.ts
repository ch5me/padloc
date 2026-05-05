/**
 * Simple idempotency store backed by KVNamespace (hint-only, non-blocking).
 *
 * Key format: `idem:<requestHash>`  → `{ code, message, status }`
 * TTL: 3600 seconds (1 hour) — long enough for retry windows.
 *
 * Idempotency is contract-level: the hash covers the full request body so
 * duplicate sends of the same marshalled request yield the cached response.
 */
export class IdempotencyStore {
    private kv?: KVNamespace;

    constructor(kv?: KVNamespace) {
        this.kv = kv;
    }

    async lookup(requestHash: string): Promise<Record<string, unknown> | null> {
        if (!this.kv) return null;
        return this.kv.get<Record<string, unknown>>(`idem:${requestHash}`, "json");
    }

    async store(requestHash: string, result: { code: string; message: string; status: number }): Promise<void> {
        if (!this.kv) return;
        await this.kv.put(`idem:${requestHash}`, JSON.stringify(result), {
            expirationTtl: 3600,
        });
    }
}

/**
 * Simple SHA-256 hex hash for request body content.
 * Uses the Web Crypto Subtle digest API — available in Workers.
 */
export async function hashRequestBody(body: string): Promise<string> {
    const data = new TextEncoder().encode(body);
    const digest = await crypto.subtle.digest("SHA-256", data.buffer as ArrayBuffer);
    return Array.from(new Uint8Array(digest))
        .map((b) => b.toString(16).padStart(2, "0"))
        .join("");
}
