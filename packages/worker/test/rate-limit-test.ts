/**
 * Rate limiter tests for Task 26.
 *
 * Tests cover:
 * - Token bucket algorithm correctness
 * - KV unavailable → no-op behavior
 * - Configurable limits
 * - Identity-based limiting
 * - Retry-After calculation
 */

import { RateLimiter } from "../src/rate-limiter";

interface RateLimitResult {
    allowed: boolean;
    remaining: number;
    retryAfterMs?: number;
}

class InMemoryKV {
    private store = new Map<string, { value: string; expiration?: number }>();

    async get<T>(key: string, type?: "json"): Promise<T | null> {
        const entry = this.store.get(key);
        if (!entry) return null;
        if (entry.expiration && Date.now() > entry.expiration * 1000) {
            this.store.delete(key);
            return null;
        }
        if (type === "json") return JSON.parse(entry.value) as T;
        return entry.value as unknown as T;
    }

    async put(key: string, value: string, opts?: { expirationTtl?: number }): Promise<void> {
        const entry: { value: string; expiration?: number } = { value };
        if (opts?.expirationTtl) {
            entry.expiration = Math.floor(Date.now() / 1000) + opts.expirationTtl;
        }
        this.store.set(key, entry);
    }
}

interface RateLimitTestResult {
    name: string;
    ok: boolean;
    detail: string;
}

interface RateLimitTestReport {
    ok: boolean;
    runtime: "node-js";
    generatedAt: string;
    summary: { total: number; passed: number; failed: number };
    results: RateLimitTestResult[];
    documentation: {
        description: string;
        defaultLimits: { maxRequests: number; windowMs: number };
        behavior: string[];
    };
}

function assertTrue(value: boolean, label: string) {
    if (!value) throw new Error(label);
}

function assertEqual<T>(actual: T, expected: T, label: string) {
    if (actual !== expected) throw new Error(`${label}: expected ${expected}, got ${actual}`);
}

async function runRateLimitTests(): Promise<RateLimitTestReport> {
    const results: RateLimitTestResult[] = [];

    // --- 1. First request is allowed, tokens consumed ---
    try {
        const kv = new InMemoryKV() as unknown as KVNamespace;
        const limiter = new RateLimiter(kv, { maxRequests: 10, windowMs: 60000 });

        const result = await limiter.check("test-identity");
        assertTrue(result.allowed, "First request allowed");
        assertEqual(result.remaining, 9, "One token consumed");

        results.push({ name: "First request allowed", ok: true, detail: "passed" });
    } catch (e) {
        results.push({ name: "First request allowed", ok: false, detail: String(e) });
    }

    // --- 2. All tokens exhausted → denied with retryAfterMs ---
    try {
        const kv = new InMemoryKV() as unknown as KVNamespace;
        const limiter = new RateLimiter(kv, { maxRequests: 3, windowMs: 60000 });

        // Consume all tokens
        for (let i = 0; i < 3; i++) {
            await limiter.check("exhausted-identity");
        }

        const result = await limiter.check("exhausted-identity");
        assertTrue(!result.allowed, "Request denied when exhausted");
        assertEqual(result.remaining, 0, "No tokens remaining");
        assertTrue(result.retryAfterMs !== undefined && result.retryAfterMs > 0, "retryAfterMs set");
        assertTrue(result.retryAfterMs! <= 60000, "retryAfterMs within window");

        results.push({ name: "Tokens exhausted → denied with retryAfterMs", ok: true, detail: "passed" });
    } catch (e) {
        results.push({ name: "Tokens exhausted → denied with retryAfterMs", ok: false, detail: String(e) });
    }

    // --- 3. Different identities have independent buckets ---
    try {
        const kv = new InMemoryKV() as unknown as KVNamespace;
        const limiter = new RateLimiter(kv, { maxRequests: 2, windowMs: 60000 });

        await limiter.check("identity-a");
        await limiter.check("identity-a");
        const resultA = await limiter.check("identity-a");
        assertTrue(!resultA.allowed, "identity-a exhausted");

        // identity-b should still have tokens
        const resultB = await limiter.check("identity-b");
        assertTrue(resultB.allowed, "identity-b still has tokens");
        assertEqual(resultB.remaining, 1, "identity-b has remaining tokens");

        results.push({ name: "Different identities have independent buckets", ok: true, detail: "passed" });
    } catch (e) {
        results.push({ name: "Different identities have independent buckets", ok: false, detail: String(e) });
    }

    // --- 4. Window expires → tokens refill ---
    try {
        const kv = new InMemoryKV() as unknown as KVNamespace;
        // Use a 100ms window for testing
        const limiter = new RateLimiter(kv, { maxRequests: 2, windowMs: 100 });

        await limiter.check("window-reset");
        await limiter.check("window-reset");

        const result = await limiter.check("window-reset");
        assertTrue(!result.allowed, "Should be denied immediately after exhausting");

        // Wait for window to expire
        await new Promise((resolve) => setTimeout(resolve, 150));

        const resultAfterReset = await limiter.check("window-reset");
        assertTrue(resultAfterReset.allowed, "Should be allowed after window reset");
        assertEqual(resultAfterReset.remaining, 1, "One token consumed after reset");

        results.push({ name: "Window expires → tokens refill", ok: true, detail: "passed" });
    } catch (e) {
        results.push({ name: "Window expires → tokens refill", ok: false, detail: String(e) });
    }

    // --- 5. No KV → always allowed (no-op) ---
    try {
        const limiter = new RateLimiter(undefined, { maxRequests: 1, windowMs: 1000 });

        const result1 = await limiter.check("any-identity");
        const result2 = await limiter.check("any-identity");
        const result3 = await limiter.check("any-identity");

        assertTrue(result1.allowed, "No-KV: first allowed");
        assertTrue(result2.allowed, "No-KV: second allowed");
        assertTrue(result3.allowed, "No-KV: third allowed");
        assertEqual(result1.remaining, 100, "No-KV: reports configured max"); // No-op returns maxRequests

        results.push({ name: "No KV → always allowed (no-op)", ok: true, detail: "passed" });
    } catch (e) {
        results.push({ name: "No KV → always allowed (no-op)", ok: false, detail: String(e) });
    }

    // --- 6. Default configuration values ---
    try {
        const kv = new InMemoryKV() as unknown as KVNamespace;
        const limiter = new RateLimiter(kv);

        assertEqual((limiter as any).maxRequests, 100, "Default maxRequests is 100");
        assertEqual((limiter as any).windowMs, 60000, "Default windowMs is 60000");

        results.push({ name: "Default configuration values", ok: true, detail: "passed" });
    } catch (e) {
        results.push({ name: "Default configuration values", ok: false, detail: String(e) });
    }

    // --- 7. Retry-After is within window bounds ---
    try {
        const kv = new InMemoryKV() as unknown as KVNamespace;
        const limiter = new RateLimiter(kv, { maxRequests: 5, windowMs: 60000 });

        // Exhaust tokens
        for (let i = 0; i < 5; i++) {
            await limiter.check("retry-bound");
        }

        const result = await limiter.check("retry-bound");
        assertTrue(result.retryAfterMs !== undefined, "retryAfterMs defined");
        assertTrue(result.retryAfterMs! > 0, "retryAfterMs positive");
        assertTrue(result.retryAfterMs! <= 60000, "retryAfterMs <= windowMs");

        results.push({ name: "Retry-After is within window bounds", ok: true, detail: "passed" });
    } catch (e) {
        results.push({ name: "Retry-After is within window bounds", ok: false, detail: String(e) });
    }

    const passed = results.filter((r) => r.ok).length;

    return {
        ok: passed === results.length,
        runtime: "node-js",
        generatedAt: new Date().toISOString(),
        summary: { total: results.length, passed, failed: results.length - passed },
        results,
        documentation: {
            description:
                "Token-bucket rate limiter backed by KVNamespace. Per-identity with configurable maxRequests (default 100) and windowMs (default 60000ms). KV unavailable → no-op (always allows).",
            defaultLimits: { maxRequests: 100, windowMs: 60000 },
            behavior: [
                "First request in window: allowed, remaining = maxRequests - 1",
                "Requests until tokens exhausted: allowed, remaining decrements",
                "No tokens remaining: denied with retryAfterMs = windowMs - (time since window start)",
                "Window expired: bucket refills to maxRequests",
                "Different identities: independent buckets",
                "KV unavailable: no-op, always allows",
            ],
        },
    };
}

export { runRateLimitTests };
