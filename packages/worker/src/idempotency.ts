/**
 * Simple idempotency store backed by KVNamespace (hint-only, non-blocking).
 *
 * Key format: `idem:v2:<requestHash>` → complete marshalled response
 * TTL: 3600 seconds (1 hour) — long enough for retry windows.
 *
 * Callers opt in with an Idempotency-Key header. The stored hash covers the
 * caller key and full request body so one key cannot replay a different RPC.
 */
export class IdempotencyStore {
    private kv?: KVNamespace;
    private required: boolean;

    constructor(kv?: KVNamespace, opts?: { required?: boolean }) {
        this.required = opts?.required === true;
        if (this.required && !kv) {
            throw new Error("HINTS KV binding required for idempotency in live environments");
        }
        this.kv = kv;
    }

    async lookup(requestHash: string): Promise<Record<string, unknown> | null> {
        if (!this.kv) {
            if (this.required) {
                throw new Error("HINTS KV binding required for idempotency in live environments");
            }
            return null;
        }
        return this.kv.get<Record<string, unknown>>(`idem:v2:${requestHash}`, "json");
    }

    async store(requestHash: string, response: Record<string, unknown>): Promise<void> {
        if (!this.kv) {
            if (this.required) {
                throw new Error("HINTS KV binding required for idempotency in live environments");
            }
            return;
        }
        await this.kv.put(`idem:v2:${requestHash}`, JSON.stringify(response), {
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
