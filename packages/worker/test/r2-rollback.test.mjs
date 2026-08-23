import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { build } from "esbuild";

const temporaryDirectory = await mkdtemp(path.join(tmpdir(), "padloc-r2-rollback-"));
const entry = path.join(temporaryDirectory, "entry.ts");
const bundle = path.join(temporaryDirectory, "bundle.mjs");

await writeFile(
    entry,
    `export { R2AttachmentStorage, MAX_ATTACHMENT_SIZE, SIGNED_URL_TTL_MS } from ${JSON.stringify(
        path.resolve("packages/worker/src/attachments/r2.ts")
    )};\nexport { Attachment } from ${JSON.stringify(path.resolve("packages/core/src/attachment.ts"))};\n`
);
await build({
    entryPoints: [entry],
    outfile: bundle,
    bundle: true,
    platform: "node",
    format: "esm",
    logLevel: "silent",
});

const { Attachment, MAX_ATTACHMENT_SIZE, R2AttachmentStorage, SIGNED_URL_TTL_MS } = await import(
    `${pathToFileURL(bundle).href}?${Date.now()}`
);

class Faults {
    counts = new Map();

    fail(operation, times = 1) {
        this.counts.set(operation, times);
    }

    hit(operation) {
        const remaining = this.counts.get(operation) ?? 0;
        if (remaining > 0) {
            this.counts.set(operation, remaining - 1);
            throw new Error(`injected ${operation} failure`);
        }
    }
}

function makeHarness() {
    const faults = new Faults();
    const rows = new Map();
    const orphans = [];
    const objects = new Map();
    const signedRequests = [];

    const db = {
        prepare(sql) {
            const normalized = sql.replace(/\s+/g, " ").trim();
            return {
                bind(...args) {
                    return {
                        async run() {
                            if (normalized.startsWith("INSERT INTO attachments")) {
                                faults.hit("d1.insert");
                                const [id, vault_id, owner_account_id, r2_key, size_bytes, hash, created_at] = args;
                                rows.set(id, { id, vault_id, owner_account_id, r2_key, size_bytes, hash, created_at });
                            } else if (normalized.startsWith("DELETE FROM attachments WHERE id = ? AND")) {
                                faults.hit("d1.delete");
                                const [id, vault] = args;
                                if (rows.get(id)?.vault_id === vault) rows.delete(id);
                            } else if (normalized.startsWith("DELETE FROM attachments WHERE id = ?")) {
                                faults.hit("d1.rollback");
                                rows.delete(args[0]);
                            } else if (normalized.startsWith("INSERT OR IGNORE INTO orphan_log")) {
                                faults.hit("d1.orphan");
                                orphans.push({ key: args[0], reason: args[2] });
                            } else {
                                throw new Error(`unexpected run SQL: ${normalized}`);
                            }
                            return { success: true };
                        },
                        async first() {
                            faults.hit("d1.select");
                            const [id, vault] = args;
                            const row = rows.get(id);
                            if (!row || row.vault_id !== vault) return null;
                            if (normalized.startsWith("SELECT r2_key")) return { r2_key: row.r2_key };
                            if (normalized.startsWith("SELECT hash")) return { hash: row.hash };
                            if (normalized.startsWith("SELECT *")) return { ...row };
                            throw new Error(`unexpected first SQL: ${normalized}`);
                        },
                    };
                },
            };
        },
    };

    const bucket = {
        async put(key, bytes, options) {
            faults.hit("r2.put");
            objects.set(key, { bytes: new Uint8Array(bytes), customMetadata: options.customMetadata });
        },
        async get(key) {
            faults.hit("r2.get");
            const value = objects.get(key);
            return (
                value && {
                    customMetadata: value.customMetadata,
                    async arrayBuffer() {
                        return value.bytes.slice().buffer;
                    },
                }
            );
        },
        async delete(key) {
            faults.hit("r2.delete");
            objects.delete(key);
        },
        createSignedUrl(options) {
            faults.hit("r2.sign");
            signedRequests.push(options);
            return `https://r2.invalid/${options.key}?method=${options.method}&signed=1`;
        },
    };

    return { faults, rows, orphans, objects, signedRequests, storage: new R2AttachmentStorage({ bucket, db }) };
}

function attachment(id = "attachment", vault = "vault") {
    const value = new Attachment({ id, vault, name: "proof.bin", size: 128, type: "application/octet-stream" });
    value.encryptedData = new Uint8Array([1, 2, 3, 4]);
    return value;
}

async function rejectsWith(promise, fragment) {
    await assert.rejects(promise, (error) => String(error).includes(fragment));
}

const tests = [];
function test(name, run) {
    tests.push({ name, run });
}

test("upload stops cleanly when the metadata insert fails", async () => {
    const h = makeHarness();
    h.faults.fail("d1.insert");
    await rejectsWith(h.storage.put(attachment()), "injected d1.insert failure");
    assert.equal(h.rows.size, 0);
    assert.equal(h.objects.size, 0);
});

test("R2 upload failure compensates by deleting D1 metadata", async () => {
    const h = makeHarness();
    h.faults.fail("r2.put");
    await rejectsWith(h.storage.put(attachment()), "R2 upload failed");
    assert.equal(h.rows.size, 0);
    assert.equal(h.objects.size, 0);
    assert.deepEqual(h.orphans, []);
});

test("upload compensation retries rollback and records exhausted rollback", async () => {
    const retry = makeHarness();
    retry.faults.fail("r2.put");
    retry.faults.fail("d1.rollback", 2);
    await rejectsWith(retry.storage.put(attachment()), "R2 upload failed");
    assert.equal(retry.rows.size, 0);

    const exhausted = makeHarness();
    exhausted.faults.fail("r2.put");
    exhausted.faults.fail("d1.rollback", 3);
    await rejectsWith(exhausted.storage.put(attachment()), "rollback failed after 3 attempts");
    assert.equal(exhausted.rows.size, 1);
    assert.deepEqual(exhausted.orphans, [{ key: "att/vault/attachment", reason: "put_rollback_failed" }]);
});

test("delete lookup, R2 delete, and D1 delete failures preserve recoverable state", async () => {
    const lookup = makeHarness();
    lookup.faults.fail("d1.select");
    await rejectsWith(lookup.storage.delete("vault", "attachment"), "injected d1.select failure");

    const r2 = makeHarness();
    await r2.storage.put(attachment());
    r2.faults.fail("r2.delete");
    await rejectsWith(r2.storage.delete("vault", "attachment"), "R2 delete failed");
    assert.equal(r2.rows.size, 1);
    assert.equal(r2.objects.has("att/vault/attachment"), true);

    const d1 = makeHarness();
    await d1.storage.put(attachment());
    d1.faults.fail("d1.delete");
    await rejectsWith(d1.storage.delete("vault", "attachment"), "D1 delete failed after R2 delete");
    assert.equal(d1.rows.size, 1);
    assert.equal(d1.objects.has("att/vault/attachment"), false);
    assert.deepEqual(d1.orphans, [{ key: "att/vault/attachment", reason: "delete_d1_failed" }]);
});

test("direct and signed reads return the uploaded object and exact key", async () => {
    const h = makeHarness();
    const original = attachment();
    await h.storage.put(original);
    const read = await h.storage.get("vault", "attachment");
    assert.equal(read.id, original.id);
    assert.equal(read.vault, original.vault);
    assert.deepEqual(read.toBytes(), original.toBytes());

    const url = await h.storage.createDownloadUrl("vault", "attachment");
    assert.equal(url, "https://r2.invalid/att/vault/attachment?method=GET&signed=1");
    assert.deepEqual(h.signedRequests.at(-1), {
        key: "att/vault/attachment",
        method: "GET",
        expiresIn: SIGNED_URL_TTL_MS,
    });
});

test("the exact size boundary is accepted and one byte over is side-effect free", async () => {
    const h = makeHarness();
    const exact = attachment("exact");
    exact.size = MAX_ATTACHMENT_SIZE;
    await h.storage.put(exact);
    assert.equal(h.rows.get("exact").size_bytes, MAX_ATTACHMENT_SIZE);
    assert.equal(h.objects.has("att/vault/exact"), true);

    const signed = await h.storage.createUploadUrl("vault", "signed-exact", MAX_ATTACHMENT_SIZE, "video/mp4");
    assert.equal(signed.r2Key, "att/vault/signed-exact");
    assert.deepEqual(h.signedRequests.at(-1), {
        key: signed.r2Key,
        method: "PUT",
        expiresIn: SIGNED_URL_TTL_MS,
        httpMetadata: { contentType: "video/mp4" },
    });

    const over = attachment("over");
    over.size = MAX_ATTACHMENT_SIZE + 1;
    await rejectsWith(h.storage.put(over), "exceeds maximum");
    await rejectsWith(
        h.storage.createUploadUrl("vault", "signed-over", MAX_ATTACHMENT_SIZE + 1, "x/test"),
        "exceeds maximum"
    );
    assert.equal(h.rows.has("over"), false);
    assert.equal(h.objects.has("att/vault/over"), false);
});

test("missing metadata and missing R2 objects fail closed", async () => {
    const h = makeHarness();
    await rejectsWith(h.storage.get("vault", "missing"), "Attachment not found");
    await rejectsWith(h.storage.createDownloadUrl("vault", "missing"), "Attachment not found");
    await h.storage.delete("vault", "missing");

    await h.storage.put(attachment());
    h.objects.delete("att/vault/attachment");
    await rejectsWith(h.storage.get("vault", "attachment"), "object not found in R2");
    await rejectsWith(h.storage.verify("vault", "attachment"), "R2 object missing");
});

let failures = 0;
try {
    for (const { name, run } of tests) {
        try {
            await run();
            console.log(`ok - ${name}`);
        } catch (error) {
            failures++;
            console.error(`not ok - ${name}`);
            console.error(error);
        }
    }
} finally {
    await rm(temporaryDirectory, { recursive: true, force: true });
}

if (failures) {
    console.error(`${failures} of ${tests.length} fault cases failed`);
    process.exitCode = 1;
} else {
    console.log(`all ${tests.length} fault cases passed`);
}
