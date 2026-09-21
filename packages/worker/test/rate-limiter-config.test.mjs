import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "node:test";

import { RateLimiter } from "../src/rate-limiter.ts";

class MemoryKV {
    values = new Map();

    async get(key, type) {
        const value = this.values.get(key);
        return value === undefined ? null : type === "json" ? JSON.parse(value) : value;
    }

    async put(key, value) {
        this.values.set(key, value);
    }
}

const workerSource = await readFile(new URL("../src/index.ts", import.meta.url), "utf8");
const construction = workerSource.match(
    /new RateLimiter\(env\.HINTS,\s*\{\s*maxRequests:\s*([^,]+),\s*windowMs:\s*([^,]+),\s*required:\s*live,\s*\}\)/
);
assert.ok(construction, "Worker RateLimiter construction remains discoverable");

// Evaluate the production construction expressions rather than duplicating their
// coercion rules in this test. The resulting options are then exercised by the
// real RateLimiter implementation.
const constructFromWorkerEnv = Function(
    "RateLimiter",
    "env",
    `return new RateLimiter(env.HINTS, { maxRequests: ${construction[1]}, windowMs: ${construction[2]} });`
).bind(undefined, RateLimiter);

async function firstCheck(limiter) {
    return limiter.check("config-boundary");
}

test("RateLimiter constructor defaults only omitted options", async () => {
    assert.deepEqual(await firstCheck(new RateLimiter()), { allowed: true, remaining: 100 });
    assert.deepEqual(await firstCheck(new RateLimiter(undefined, {})), { allowed: true, remaining: 100 });

    const zero = await firstCheck(new RateLimiter(undefined, { maxRequests: 0, windowMs: 0 }));
    assert.deepEqual(zero, { allowed: true, remaining: 0 });

    const fractional = await firstCheck(new RateLimiter(undefined, { maxRequests: 2.5, windowMs: 0.25 }));
    assert.deepEqual(fractional, { allowed: true, remaining: 2.5 });
});

test("RateLimiter preserves non-finite, negative, and very large numeric options", async () => {
    const nan = await firstCheck(new RateLimiter(undefined, { maxRequests: Number.NaN }));
    assert.equal(nan.allowed, true);
    assert.equal(Number.isNaN(nan.remaining), true);

    assert.deepEqual(await firstCheck(new RateLimiter(undefined, { maxRequests: -7 })), {
        allowed: true,
        remaining: -7,
    });
    assert.deepEqual(await firstCheck(new RateLimiter(undefined, { maxRequests: Number.POSITIVE_INFINITY })), {
        allowed: true,
        remaining: Number.POSITIVE_INFINITY,
    });
    assert.deepEqual(await firstCheck(new RateLimiter(undefined, { maxRequests: Number.MAX_VALUE })), {
        allowed: true,
        remaining: Number.MAX_VALUE,
    });
});

test("zero and negative limits with KV consume once, then deny", async () => {
    for (const maxRequests of [0, -1]) {
        const limiter = new RateLimiter(new MemoryKV(), { maxRequests, windowMs: 60_000 });
        assert.deepEqual(await firstCheck(limiter), { allowed: true, remaining: maxRequests - 1 });
        const denied = await firstCheck(limiter);
        assert.equal(denied.allowed, false);
        assert.equal(denied.remaining, 0);
        assert.ok(denied.retryAfterMs > 0 && denied.retryAfterMs <= 60_000);
    }
});

test("Worker construction defaults absent and empty-string bindings", async () => {
    for (const env of [{}, { RATE_LIMIT_MAX_REQUESTS: "", RATE_LIMIT_WINDOW_MS: "" }]) {
        assert.deepEqual(await firstCheck(constructFromWorkerEnv(env)), { allowed: true, remaining: 100 });
    }
});

test("Worker construction pins Number coercion at configuration boundaries", async () => {
    const cases = [
        { value: "0", expected: 0 },
        { value: "-12", expected: -12 },
        { value: "2.75", expected: 2.75 },
        { value: "9007199254740993", expected: 9_007_199_254_740_992 },
        { value: "1e309", expected: Number.POSITIVE_INFINITY },
    ];

    for (const { value, expected } of cases) {
        const limiter = constructFromWorkerEnv({ RATE_LIMIT_MAX_REQUESTS: value });
        assert.deepEqual(await firstCheck(limiter), { allowed: true, remaining: expected }, value);
    }

    for (const value of ["NaN", "not-a-number"]) {
        const result = await firstCheck(constructFromWorkerEnv({ RATE_LIMIT_MAX_REQUESTS: value }));
        assert.equal(result.allowed, true, value);
        assert.equal(Number.isNaN(result.remaining), true, value);
    }
});

test("Worker construction applies the same coercion to window strings", async () => {
    const kv = new MemoryKV();
    const limiter = constructFromWorkerEnv({
        HINTS: kv,
        RATE_LIMIT_MAX_REQUESTS: "1",
        RATE_LIMIT_WINDOW_MS: "0.5",
    });

    assert.deepEqual(await firstCheck(limiter), { allowed: true, remaining: 0 });
    const denied = await firstCheck(limiter);
    assert.equal(denied.allowed, false);
    assert.equal(denied.remaining, 0);
    assert.ok(denied.retryAfterMs <= 0.5);
});

test("required RateLimiter throws without KV instead of default-allow", () => {
    assert.throws(
        () => new RateLimiter(undefined, { required: true }),
        /HINTS KV binding required for rate limiting in live environments/
    );
});
