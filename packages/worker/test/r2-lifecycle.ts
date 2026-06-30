import { R2AttachmentStorage, MAX_ATTACHMENT_SIZE } from "../src/attachments/r2";
import { Attachment } from "@padloc/core/src/attachment";
import { VaultID } from "@padloc/core/src/vault";

export interface R2LifecycleResult {
    name: string;
    ok: boolean;
    detail: string;
}

export interface R2LifecycleReport {
    ok: boolean;
    runtime: "cloudflare-worker";
    generatedAt: string;
    summary: {
        total: number;
        passed: number;
        failed: number;
    };
    results: R2LifecycleResult[];
}

interface MockBucket {
    store: Map<
        string,
        { data: Uint8Array; httpMetadata?: Record<string, string>; customMetadata?: Record<string, string> }
    >;
    createSignedUrl: (opts: object) => string;
}

interface MockDB {
    attachments: Map<
        string,
        {
            id: string;
            vault_id: string;
            owner_account_id: string;
            r2_key: string;
            size_bytes: number;
            hash: string;
            created_at: string;
        }
    >;
    orphanLog: Map<string, { r2_key: string; orphaned_at: number; reason: string }>;
    prepare: (sql: string) => {
        bind: (...args: unknown[]) => {
            run: () => Promise<{ meta?: { changes?: number } }>;
            first: <T>() => Promise<T | null>;
        };
    };
}

function createMockBucket(): MockBucket {
    const store = new Map();
    return {
        store,
        createSignedUrl: ({ key }: { key: string }) => `https://mock-r2.example.com/${key}?signed=true`,
    };
}

function createMockDB(): MockDB {
    const db: MockDB = {
        attachments: new Map(),
        orphanLog: new Map(),
        prepare: (sql: string) => {
            return {
                bind: (...args: unknown[]) => {
                    return {
                        run: async () => {
                            if (sql.includes("INSERT INTO attachments")) {
                                const [id, vault_id, owner_account_id, r2_key, size_bytes, hash, created_at] = args as [
                                    string,
                                    string,
                                    string,
                                    string,
                                    number,
                                    string,
                                    string
                                ];
                                db.attachments.set(id, {
                                    id,
                                    vault_id,
                                    owner_account_id,
                                    r2_key,
                                    size_bytes,
                                    hash,
                                    created_at,
                                });
                                return { meta: { changes: 1 } };
                            }
                            if (sql.includes("DELETE FROM attachments WHERE id")) {
                                const [id] = args as [string];
                                db.attachments.delete(id);
                                return { meta: { changes: 1 } };
                            }
                            if (sql.includes("DELETE FROM attachments WHERE vault_id")) {
                                const [vault_id] = args as [string];
                                for (const [key, val] of db.attachments.entries()) {
                                    if (val.vault_id === vault_id) db.attachments.delete(key);
                                }
                                return { meta: { changes: 1 } };
                            }
                            if (sql.includes("INSERT OR IGNORE INTO orphan_log")) {
                                const [r2_key, orphaned_at, reason] = args as [string, number, string];
                                db.orphanLog.set(r2_key, { r2_key, orphaned_at, reason });
                                return { meta: { changes: 1 } };
                            }
                            return { meta: { changes: 0 } };
                        },
                        first: <T>() => {
                            if (sql.includes("SELECT * FROM attachments WHERE id")) {
                                const [id, vault_id] = args as [string, string];
                                for (const val of db.attachments.values()) {
                                    if (val.id === id && val.vault_id === vault_id) return val as T;
                                }
                                return null as T;
                            }
                            if (sql.includes("SELECT r2_key FROM attachments WHERE id")) {
                                const [id, vault_id] = args as [string, string];
                                for (const val of db.attachments.values()) {
                                    if (val.id === id && val.vault_id === vault_id) return { r2_key: val.r2_key } as T;
                                }
                                return null as T;
                            }
                            if (sql.includes("SELECT COALESCE")) {
                                const [vault_id] = args as [string];
                                let total = 0;
                                for (const val of db.attachments.values()) {
                                    if (val.vault_id === vault_id) total += val.size_bytes;
                                }
                                return { total } as T;
                            }
                            return null as T;
                        },
                    };
                },
            };
        },
    };
    return db;
}

function makeAttachment(id: string, vault: VaultID, data: Uint8Array, type = "application/octet-stream"): Attachment {
    const att = new Attachment();
    att.id = id;
    att.vault = vault;
    att.name = `test-${id}.bin`;
    att.size = data.length;
    att.type = type;
    att.encryptedData = data;
    return att;
}

function assertTrue(value: boolean, label: string) {
    if (!value) throw new Error(label);
}

function assertEqual<T>(actual: T, expected: T, label: string) {
    if (actual !== expected) throw new Error(`${label}: expected ${expected}, got ${actual}`);
}

async function runLifecycleTests(): Promise<R2LifecycleReport> {
    const results: R2LifecycleResult[] = [];

    // Test 1: Small file upload + get (1 KB)
    try {
        const bucket = createMockBucket();
        const db = createMockDB();
        const storage = new R2AttachmentStorage({ bucket: bucket as unknown as any, db: db as unknown as any });

        const data = new Uint8Array(1024);
        crypto.getRandomValues(data);
        const vault = "vault-001" as VaultID;
        const att = makeAttachment("att-1kb", vault, data);

        await storage.put(att);
        assertEqual(db.attachments.size, 1, "D1 row created after put");
        assertEqual(bucket.store.has("att/vault-001/att-1kb"), true, "R2 object created");

        const retrieved = await storage.get(vault, "att-1kb");
        assertEqual(new Uint8Array(retrieved.toBytes()).length, data.length, "Retrieved attachment size matches");
        assertEqual(retrieved.id, "att-1kb", "Retrieved attachment ID matches");

        results.push({ name: "1 KB upload/get", ok: true, detail: "passed" });
    } catch (e) {
        results.push({ name: "1 KB upload/get", ok: false, detail: String(e) });
    }

    // Test 2: 5 MB file upload (at threshold)
    try {
        const bucket = createMockBucket();
        const db = createMockDB();
        const storage = new R2AttachmentStorage({ bucket: bucket as unknown as any, db: db as unknown as any });

        const data = new Uint8Array(5 * 1024 * 1024);
        crypto.getRandomValues(data);
        const vault = "vault-002" as VaultID;
        const att = makeAttachment("att-5mb", vault, data);

        await storage.put(att);
        assertEqual(db.attachments.size, 1, "D1 row created for 5 MB");
        assertEqual(bucket.store.has("att/vault-002/att-5mb"), true, "R2 object created for 5 MB");

        const retrieved = await storage.get(vault, "att-5mb");
        assertEqual(retrieved.size, 5 * 1024 * 1024, "Retrieved 5 MB size matches");

        results.push({ name: "5 MB upload/get", ok: true, detail: "passed" });
    } catch (e) {
        results.push({ name: "5 MB upload/get", ok: false, detail: String(e) });
    }

    // Test 3: Max size file upload (25 MB)
    try {
        const bucket = createMockBucket();
        const db = createMockDB();
        const storage = new R2AttachmentStorage({ bucket: bucket as unknown as any, db: db as unknown as any });

        const data = new Uint8Array(MAX_ATTACHMENT_SIZE);
        crypto.getRandomValues(data);
        const vault = "vault-003" as VaultID;
        const att = makeAttachment("att-25mb", vault, data);

        await storage.put(att);
        assertEqual(db.attachments.size, 1, "D1 row created for 25 MB");
        assertEqual(bucket.store.has("att/vault-003/att-25mb"), true, "R2 object created for 25 MB");

        results.push({ name: "25 MB max-size upload/get", ok: true, detail: "passed" });
    } catch (e) {
        results.push({ name: "25 MB max-size upload/get", ok: false, detail: String(e) });
    }

    // Test 4: Oversized file rejected (no orphan)
    try {
        const bucket = createMockBucket();
        const db = createMockDB();
        const storage = new R2AttachmentStorage({ bucket: bucket as unknown as any, db: db as unknown as any });

        const data = new Uint8Array(MAX_ATTACHMENT_SIZE + 1);
        crypto.getRandomValues(data);
        const vault = "vault-004" as VaultID;
        const att = makeAttachment("att-oversize", vault, data);

        let threw = false;
        try {
            await storage.put(att);
        } catch (e: any) {
            threw = e.code === "bad_request";
        }

        assertTrue(threw, "Oversized attachment rejected");
        assertEqual(db.attachments.size, 0, "No D1 row for oversized");
        assertEqual(bucket.store.size, 0, "No R2 object for oversized");

        results.push({ name: "Oversized (>25 MB) rejected", ok: true, detail: "passed" });
    } catch (e) {
        results.push({ name: "Oversized (>25 MB) rejected", ok: false, detail: String(e) });
    }

    // Test 5: Delete single attachment
    try {
        const bucket = createMockBucket();
        const db = createMockDB();
        const storage = new R2AttachmentStorage({ bucket: bucket as unknown as any, db: db as unknown as any });

        const data = new Uint8Array(512);
        crypto.getRandomValues(data);
        const vault = "vault-005" as VaultID;
        const att = makeAttachment("att-delete", vault, data);

        await storage.put(att);
        assertEqual(db.attachments.size, 1, "Row exists before delete");

        await storage.delete(vault, "att-delete");
        assertEqual(db.attachments.size, 0, "D1 row deleted");
        assertEqual(bucket.store.has("att/vault-005/att-delete"), false, "R2 object deleted");

        results.push({ name: "Single attachment delete", ok: true, detail: "passed" });
    } catch (e) {
        results.push({ name: "Single attachment delete", ok: false, detail: String(e) });
    }

    // Test 6: Delete non-existent is idempotent (no throw)
    try {
        const bucket = createMockBucket();
        const db = createMockDB();
        const storage = new R2AttachmentStorage({ bucket: bucket as unknown as any, db: db as unknown as any });

        await storage.delete("vault-none" as VaultID, "att-nonexistent");
        results.push({ name: "Delete non-existent is idempotent", ok: true, detail: "passed" });
    } catch (e) {
        results.push({ name: "Delete non-existent is idempotent", ok: false, detail: String(e) });
    }

    // Test 7: Upload R2 failure → D1 rollback
    try {
        const bucket = createMockBucket();
        const db = createMockDB();
        const storage = new R2AttachmentStorage({ bucket: bucket as unknown as any, db: db as unknown as any });

        // Monkey-patch bucket.put to fail
        (storage as any).bucket.put = async () => {
            throw new Error("R2 is down");
        };

        const data = new Uint8Array(256);
        crypto.getRandomValues(data);
        const vault = "vault-006" as VaultID;
        const att = makeAttachment("att-rollback", vault, data);

        let threw = false;
        try {
            await storage.put(att);
        } catch (e: any) {
            threw = true;
        }

        assertTrue(threw, "Upload with R2 failure throws");
        assertEqual(db.attachments.size, 0, "D1 row rolled back after R2 failure");

        results.push({ name: "R2 failure → D1 rollback", ok: true, detail: "passed" });
    } catch (e) {
        results.push({ name: "R2 failure → D1 rollback", ok: false, detail: String(e) });
    }

    // Test 8: getUsage vault
    try {
        const bucket = createMockBucket();
        const db = createMockDB();
        const storage = new R2AttachmentStorage({ bucket: bucket as unknown as any, db: db as unknown as any });

        const vault = "vault-007" as VaultID;

        const d1 = new Uint8Array(100);
        crypto.getRandomValues(d1);
        await storage.put(makeAttachment("att-a", vault, d1));

        const d2 = new Uint8Array(200);
        crypto.getRandomValues(d2);
        await storage.put(makeAttachment("att-b", vault, d2));

        const usage = await storage.getUsage(vault);
        assertEqual(usage, 300, "getUsage sums attachment sizes for vault");

        results.push({ name: "getUsage vault sum", ok: true, detail: "passed" });
    } catch (e) {
        results.push({ name: "getUsage vault sum", ok: false, detail: String(e) });
    }

    // Test 9: createUploadUrl / confirmUpload signed URL flow
    try {
        const bucket = createMockBucket();
        const db = createMockDB();
        const storage = new R2AttachmentStorage({ bucket: bucket as unknown as any, db: db as unknown as any });

        const vault = "vault-008" as VaultID;
        const size = 10 * 1024 * 1024;
        const { uploadUrl, r2Key } = await storage.createUploadUrl(vault, "att-signed", size, "image/png");

        assertTrue(uploadUrl.includes("signed=true"), "uploadUrl is signed");
        assertEqual(r2Key, "att/vault-008/att-signed", "r2Key follows scheme");

        // Simulate direct R2 upload by putting the object directly in bucket
        const data = new Uint8Array(size);
        crypto.getRandomValues(data);
        bucket.store.set(r2Key, { data, httpMetadata: { contentType: "image/png" } });

        // Now confirm upload (D1 INSERT only, no R2 write)
        await storage.confirmUpload(vault, "att-signed", size, "abc123hash", "account-xyz", "image/png");
        assertEqual(db.attachments.size, 1, "D1 row created by confirmUpload");
        assertEqual(db.attachments.get("att-signed")?.hash, "abc123hash", "Hash stored correctly");

        results.push({ name: "createUploadUrl/confirmUpload flow", ok: true, detail: "passed" });
    } catch (e) {
        results.push({ name: "createUploadUrl/confirmUpload flow", ok: false, detail: String(e) });
    }

    // Test 10: getUsage for vault with no attachments
    try {
        const bucket = createMockBucket();
        const db = createMockDB();
        const storage = new R2AttachmentStorage({ bucket: bucket as unknown as any, db: db as unknown as any });

        const usage = await storage.getUsage("empty-vault" as VaultID);
        assertEqual(usage, 0, "getUsage returns 0 for empty vault");

        results.push({ name: "getUsage empty vault", ok: true, detail: "passed" });
    } catch (e) {
        results.push({ name: "getUsage empty vault", ok: false, detail: String(e) });
    }

    const passed = results.filter((r) => r.ok).length;
    return {
        ok: passed === results.length,
        runtime: "cloudflare-worker",
        generatedAt: new Date().toISOString(),
        summary: { total: results.length, passed, failed: results.length - passed },
        results,
    };
}

export { runLifecycleTests };
