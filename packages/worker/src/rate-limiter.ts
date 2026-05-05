/**
 * Token-bucket rate limiter backed by KVNamespace.
 *
 * Per-identity (IP or account ID) with configurable:
 * - maxRequests: tokens per window
 * - windowMs: refill window in milliseconds
 *
 * Returns { allowed: boolean, remaining: number, retryAfterMs?: number }.
 *
 * When KV is unavailable (no binding), rate limiting is a no-op and always
 * allows — this prevents the limiter from becoming a single point of failure.
 */
export class RateLimiter {
    private kv?: KVNamespace;
    private maxRequests: number;
    private windowMs: number;

    constructor(kv?: KVNamespace, opts?: { maxRequests?: number; windowMs?: number }) {
        this.kv = kv;
        this.maxRequests = opts?.maxRequests ?? 100;
        this.windowMs = opts?.windowMs ?? 60_000;
    }

    async check(identity: string): Promise<{ allowed: boolean; remaining: number; retryAfterMs?: number }> {
        if (!this.kv) {
            return { allowed: true, remaining: this.maxRequests };
        }

        const key = `rl:${identity}`;
        const raw = await this.kv.get<{ tokens: number; windowStart: number }>(key, "json");
        const now = Date.now();

        if (!raw || now - raw.windowStart >= this.windowMs) {
            await this.kv.put(key, JSON.stringify({ tokens: this.maxRequests - 1, windowStart: now }), {
                expirationTtl: Math.ceil(this.windowMs / 1000) + 60,
            });
            return { allowed: true, remaining: this.maxRequests - 1 };
        }

        if (raw.tokens <= 0) {
            const retryAfterMs = this.windowMs - (now - raw.windowStart);
            return { allowed: false, remaining: 0, retryAfterMs };
        }

        raw.tokens -= 1;
        await this.kv.put(key, JSON.stringify(raw), {
            expirationTtl: Math.ceil(this.windowMs / 1000) + 60,
        });
        return { allowed: true, remaining: raw.tokens };
    }
}
