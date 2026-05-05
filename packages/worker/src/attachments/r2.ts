import { Attachment, AttachmentID, AttachmentStorage } from "@padloc/core/src/attachment";
import { VaultID } from "@padloc/core/src/vault";
import { Err, ErrorCode } from "@padloc/core/src/error";

export const MAX_ATTACHMENT_SIZE = 25 * 1024 * 1024;
export const SIGNED_URL_THRESHOLD = 5 * 1024 * 1024;
export const SIGNED_URL_TTL_MS = 15 * 60 * 1000;

const KEY_PREFIX = "att";

function r2Key(vaultId: VaultID, attachmentId: AttachmentID): string {
    return `${KEY_PREFIX}/${vaultId}/${attachmentId}`;
}

interface AttachmentMeta {
    id: string;
    vault_id: string;
    owner_account_id: string;
    r2_key: string;
    size_bytes: number;
    hash: string;
    created_at: string;
}

export interface R2AttachmentStorageConfig {
    bucket: R2Bucket;
    db: D1Database;
}

async function recordOrphan(db: D1Database, r2Key: string, reason: string): Promise<void> {
    await db
        .prepare(`INSERT OR IGNORE INTO orphan_log (r2_key, orphaned_at, reason) VALUES (?, ?, ?)`)
        .bind(r2Key, Date.now(), reason)
        .run();
}

export class R2AttachmentStorage implements AttachmentStorage {
    constructor(private config: R2AttachmentStorageConfig) {}

    private get bucket(): R2Bucket {
        return this.config.bucket;
    }

    private get db(): D1Database {
        return this.config.db;
    }

    async put(att: Attachment): Promise<void> {
        if (att.size > MAX_ATTACHMENT_SIZE) {
            throw new Err(ErrorCode.BAD_REQUEST, `Attachment size ${att.size} exceeds maximum ${MAX_ATTACHMENT_SIZE}`);
        }

        const key = r2Key(att.vault, att.id);
        const bytes = att.toBytes();
        const hashHex = await sha256Hex(bytes);

        await this.db
            .prepare(
                `INSERT INTO attachments (id, vault_id, owner_account_id, r2_key, size_bytes, hash, created_at)
                 VALUES (?, ?, ?, ?, ?, ?, ?)`,
            )
            .bind(att.id, att.vault, "", key, att.size, hashHex, new Date().toISOString())
            .run();

        try {
            await this.bucket.put(key, bytes, {
                httpMetadata: {
                    contentType: att.type || "application/octet-stream",
                },
                customMetadata: {
                    hash: hashHex,
                },
            });
        } catch (r2Err) {
            for (let attempt = 1; attempt <= 3; attempt++) {
                try {
                    await this.db.prepare(`DELETE FROM attachments WHERE id = ?`).bind(att.id).run();
                    break;
                } catch (rollbackErr) {
                    if (attempt === 3) {
                        await recordOrphan(this.db, key, "put_rollback_failed");
                        throw new Err(
                            ErrorCode.SERVER_ERROR,
                            `R2 upload failed and D1 rollback failed after 3 attempts: ${r2Err}`,
                        );
                    }
                }
            }
            throw new Err(ErrorCode.SERVER_ERROR, `R2 upload failed: ${r2Err}`);
        }
    }

    async get(vault: VaultID, id: AttachmentID): Promise<Attachment> {
        const row = await this.db
            .prepare(`SELECT * FROM attachments WHERE id = ? AND vault_id = ?`)
            .bind(id, vault)
            .first<AttachmentMeta>();

        if (!row) {
            throw new Err(ErrorCode.NOT_FOUND, `Attachment not found: ${id}`);
        }

        const object = await this.bucket.get(row.r2_key);
        if (!object) {
            throw new Err(ErrorCode.NOT_FOUND, `Attachment object not found in R2: ${row.r2_key}`);
        }

        const bytes = await object.arrayBuffer();
        const att = new Attachment().fromBytes(new Uint8Array(bytes));

        const computedHash = await sha256Hex(new Uint8Array(bytes));
        if (computedHash !== row.hash) {
            throw new Err(ErrorCode.SERVER_ERROR, "Attachment hash mismatch — possible corruption");
        }

        return att;
    }

    async delete(vault: VaultID, id: AttachmentID): Promise<void> {
        const row = await this.db
            .prepare(`SELECT r2_key FROM attachments WHERE id = ? AND vault_id = ?`)
            .bind(id, vault)
            .first<{ r2_key: string }>();

        if (!row) {
            return;
        }

        const key = row.r2_key;

        try {
            await this.bucket.delete(key);
        } catch (r2Err) {
            throw new Err(ErrorCode.SERVER_ERROR, `R2 delete failed for ${key}: ${r2Err}`);
        }

        try {
            await this.db.prepare(`DELETE FROM attachments WHERE id = ? AND vault_id = ?`).bind(id, vault).run();
        } catch (d1Err) {
            await recordOrphan(this.db, key, "delete_d1_failed");
            throw new Err(ErrorCode.SERVER_ERROR, `D1 delete failed after R2 delete: ${d1Err}`);
        }
    }

    async deleteAll(vault: VaultID): Promise<void> {
        const prefix = `${KEY_PREFIX}/${vault}/`;
        const listed = await this.bucket.list({ prefix });
        const keys = listed.objects.map((o) => o.key);

        if (keys.length > 0) {
            try {
                await Promise.all(keys.map((key) => this.bucket.delete(key)));
            } catch (r2Err) {
                throw new Err(ErrorCode.SERVER_ERROR, `R2 bulk delete failed for vault ${vault}: ${r2Err}`);
            }
        }

        try {
            await this.db.prepare(`DELETE FROM attachments WHERE vault_id = ?`).bind(vault).run();
        } catch (d1Err) {
            for (const key of keys) {
                await recordOrphan(this.db, key, "delete_all_d1_failed");
            }
            throw new Err(ErrorCode.SERVER_ERROR, `D1 bulk delete failed for vault ${vault}: ${d1Err}`);
        }
    }

    async getUsage(vault: VaultID): Promise<number> {
        const result = await this.db
            .prepare(`SELECT COALESCE(SUM(size_bytes), 0) as total FROM attachments WHERE vault_id = ?`)
            .bind(vault)
            .first<{ total: number }>();

        return result?.total ?? 0;
    }

    async createUploadUrl(
        vault: VaultID,
        id: AttachmentID,
        size: number,
        contentType: string,
    ): Promise<{ uploadUrl: string; r2Key: string }> {
        if (size > MAX_ATTACHMENT_SIZE) {
            throw new Err(ErrorCode.BAD_REQUEST, `Attachment size ${size} exceeds maximum ${MAX_ATTACHMENT_SIZE}`);
        }

        const key = r2Key(vault, id);

        const uploadUrl = (this.bucket as unknown as { createSignedUrl: (opts: object) => string }).createSignedUrl({
            key,
            method: "PUT",
            expiresIn: SIGNED_URL_TTL_MS,
            httpMetadata: { contentType },
        });

        return { uploadUrl, r2Key: key };
    }

    async confirmUpload(
        vault: VaultID,
        id: AttachmentID,
        size: number,
        hash: string,
        ownerAccountId: string,
        _contentType: string,
    ): Promise<void> {
        if (size > MAX_ATTACHMENT_SIZE) {
            throw new Err(ErrorCode.BAD_REQUEST, `Attachment size ${size} exceeds maximum ${MAX_ATTACHMENT_SIZE}`);
        }

        const key = r2Key(vault, id);

        try {
            await this.db
                .prepare(
                    `INSERT INTO attachments (id, vault_id, owner_account_id, r2_key, size_bytes, hash, created_at)
                     VALUES (?, ?, ?, ?, ?, ?, ?)`,
                )
                .bind(id, vault, ownerAccountId, key, size, hash, new Date().toISOString())
                .run();
        } catch (d1Err) {
            await recordOrphan(this.db, key, "confirm_d1_failed");
            throw new Err(ErrorCode.SERVER_ERROR, `D1 confirm failed: ${d1Err}`);
        }
    }

    async createDownloadUrl(vault: VaultID, id: AttachmentID): Promise<string> {
        const row = await this.db
            .prepare(`SELECT r2_key FROM attachments WHERE id = ? AND vault_id = ?`)
            .bind(id, vault)
            .first<{ r2_key: string }>();

        if (!row) {
            throw new Err(ErrorCode.NOT_FOUND, `Attachment not found: ${id}`);
        }

        const downloadUrl = (this.bucket as unknown as { createSignedUrl: (opts: object) => string }).createSignedUrl({
            key: row.r2_key,
            method: "GET",
            expiresIn: SIGNED_URL_TTL_MS,
        });

        return downloadUrl;
    }

    async verify(vault: VaultID, id: AttachmentID): Promise<boolean> {
        const row = await this.db
            .prepare(`SELECT hash FROM attachments WHERE id = ? AND vault_id = ?`)
            .bind(id, vault)
            .first<{ hash: string }>();

        if (!row) {
            throw new Err(ErrorCode.NOT_FOUND, `Attachment not found: ${id}`);
        }

        const object = await this.bucket.get(r2Key(vault, id));
        if (!object) {
            throw new Err(ErrorCode.NOT_FOUND, `R2 object missing for ${id}`);
        }

        const metaHash = object.customMetadata?.hash as string | undefined;
        if (metaHash && metaHash === row.hash) {
            return true;
        }

        const bytes = await object.arrayBuffer();
        const computed = await sha256Hex(new Uint8Array(bytes));
        return computed === row.hash;
    }
}

async function sha256Hex(input: Uint8Array | ArrayBuffer): Promise<string> {
    const buffer = input instanceof ArrayBuffer ? input : input.buffer;
    const digest = await crypto.subtle.digest("SHA-256", buffer as ArrayBuffer);
    const buf = new Uint8Array(digest);
    return Array.from(buf)
        .map((b) => b.toString(16).padStart(2, "0"))
        .join("");
}
