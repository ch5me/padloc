import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

import { build } from "esbuild";

const temporaryDirectory = await mkdtemp(join(tmpdir(), "padloc-idempotency-"));
const bundlePath = join(temporaryDirectory, "idempotency.mjs");

await build({
    entryPoints: [new URL("../src/idempotency.ts", import.meta.url).pathname],
    outfile: bundlePath,
    bundle: true,
    format: "esm",
    platform: "node",
    target: "node24",
});

const { IdempotencyStore, hashRequestBody } = await import(pathToFileURL(bundlePath));

class FakeKV {
    constructor(now = 0) {
        this.now = now;
        this.entries = new Map();
        this.puts = [];
    }

    advance(seconds) {
        this.now += seconds;
    }

    async get(key, type) {
        const entry = this.entries.get(key);
        if (!entry) return null;
        if (entry.expiresAt <= this.now) {
            this.entries.delete(key);
            return null;
        }
        return type === "json" ? JSON.parse(entry.value) : entry.value;
    }

    async put(key, value, options = {}) {
        await Promise.resolve();
        this.puts.push({ key, value, options });
        this.entries.set(key, {
            value,
            expiresAt: this.now + (options.expirationTtl ?? Number.POSITIVE_INFINITY),
        });
    }
}

const result = (message) => ({ code: "bad_request", message, status: 400 });
const cases = [];

function test(name, run) {
    cases.push({ name, run });
}

test("a missing key returns null, including when KV is not configured", async () => {
    assert.equal(await new IdempotencyStore(new FakeKV()).lookup("missing"), null);
    assert.equal(await new IdempotencyStore().lookup("missing"), null);
    await new IdempotencyStore().store("ignored", result("ignored"));
});

test("required IdempotencyStore throws without KV instead of no-op", () => {
    assert.throws(
        () => new IdempotencyStore(undefined, { required: true }),
        /HINTS KV binding required for idempotency in live environments/
    );
});

test("a stored response is replayed and receives the one-hour TTL", async () => {
    const kv = new FakeKV(100);
    const store = new IdempotencyStore(kv);
    const response = result("cached");

    await store.store("request", response);

    assert.deepEqual(await store.lookup("request"), response);
    assert.deepEqual(kv.puts[0], {
        key: "idem:v2:request",
        value: JSON.stringify(response),
        options: { expirationTtl: 3600 },
    });
});

test("a cached response expires exactly at the TTL boundary", async () => {
    const kv = new FakeKV(10_000);
    const store = new IdempotencyStore(kv);
    await store.store("expiring", result("temporary"));

    kv.advance(3599);
    assert.equal((await store.lookup("expiring")).message, "temporary");
    kv.advance(1);
    assert.equal(await store.lookup("expiring"), null);
});

test("concurrent independent writes remain independently addressable", async () => {
    const kv = new FakeKV();
    const store = new IdempotencyStore(kv);
    await Promise.all(Array.from({ length: 32 }, (_, index) => store.store(`request-${index}`, result(`${index}`))));

    const reads = await Promise.all(Array.from({ length: 32 }, (_, index) => store.lookup(`request-${index}`)));
    assert.deepEqual(
        reads.map(({ message }) => message),
        Array.from({ length: 32 }, (_, index) => `${index}`)
    );
});

test("same-key collisions share one scoped slot rather than duplicating entries", async () => {
    const kv = new FakeKV();
    const store = new IdempotencyStore(kv);
    await Promise.all([store.store("collision", result("first")), store.store("collision", result("second"))]);

    assert.equal(kv.entries.size, 1);
    assert.equal(kv.entries.has("idem:v2:collision"), true);
    assert.ok(["first", "second"].includes((await store.lookup("collision")).message));
});

test("idempotency keys cannot collide with unscoped or legacy KV data", async () => {
    const kv = new FakeKV();
    kv.entries.set("shared", { value: JSON.stringify(result("other subsystem")), expiresAt: Infinity });
    kv.entries.set("idem:shared", { value: JSON.stringify(result("legacy idempotency")), expiresAt: Infinity });
    const store = new IdempotencyStore(kv);
    await store.store("shared", result("idempotency"));

    assert.equal(JSON.parse(await kv.get("shared")).message, "other subsystem");
    assert.equal(JSON.parse(await kv.get("idem:shared")).message, "legacy idempotency");
    assert.equal((await store.lookup("shared")).message, "idempotency");
});

test("malformed cached JSON is rejected instead of being replayed", async () => {
    const kv = new FakeKV();
    kv.entries.set("idem:v2:broken", { value: "{not-json", expiresAt: Infinity });

    await assert.rejects(() => new IdempotencyStore(kv).lookup("broken"), SyntaxError);
});

test("request hashes are fixed-size and distinguish key/body boundaries", async () => {
    const short = await hashRequestBody("x");
    const maximumKey = await hashRequestBody("k".repeat(1024));
    const largeBody = await hashRequestBody("b".repeat(2 * 1024 * 1024));
    const firstBoundary = await hashRequestBody(JSON.stringify({ key: "ab", body: "c" }));
    const secondBoundary = await hashRequestBody(JSON.stringify({ key: "a", body: "bc" }));

    for (const hash of [short, maximumKey, largeBody, firstBoundary, secondBoundary]) {
        assert.match(hash, /^[0-9a-f]{64}$/);
    }
    assert.notEqual(short, maximumKey);
    assert.notEqual(maximumKey, largeBody);
    assert.notEqual(firstBoundary, secondBoundary);
});

let failures = 0;
try {
    for (const { name, run } of cases) {
        try {
            await run();
            console.log(`ok - ${name}`);
        } catch (error) {
            failures += 1;
            console.error(`not ok - ${name}`);
            console.error(error);
        }
    }
} finally {
    await rm(temporaryDirectory, { recursive: true, force: true });
}

console.log(`${cases.length - failures}/${cases.length} idempotency boundary cases passed`);
if (failures > 0) process.exitCode = 1;
