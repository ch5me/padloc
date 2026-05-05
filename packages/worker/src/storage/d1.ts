import { D1Database } from "@cloudflare/workers-types";
import { Storable, StorableConstructor, Storage, StorageListOptions, StorageQuery } from "@padloc/core/src/storage";
import { Err, ErrorCode } from "@padloc/core/src/error";

const DOMAIN_TABLES = [
    "account",
    "session",
    "vault",
    "org",
    "orgmember",
    "invite",
    "keystoreentry",
    "attachment",
    "emailverification",
    "auth",
];

/**
 * Best-effort conversion of simple regex patterns to SQLite LIKE patterns.
 * Returns null for patterns that cannot be safely converted.
 *
 * Handles:
 *   - `.*` → `%`
 *   - literal characters
 * Rejects: character classes `[...]`, alternation `|`, quantifiers `+?{}`,
 * anchors `^$`, groups `()`.
 */
function simpleRegexToLike(regex: string): string | null {
    if (/[([{|^$+?{}]/.test(regex) || /\[\^?/.test(regex) || /\|/.test(regex)) {
        return null;
    }
    const likePattern = regex.replace(/\.\*/g, "%").replace(/\./g, "_");
    return `%${likePattern}%`;
}

function queryToSqlWhere(query: StorageQuery): { sql: string; params: (string | number | boolean)[] } {
    switch (query.op) {
        case "and": {
            const parts = query.queries.map(queryToSqlWhere);
            return {
                sql: `(${parts.map((p) => p.sql).join(" AND ")})`,
                params: parts.flatMap((p) => p.params),
            };
        }
        case "or": {
            const parts = query.queries.map(queryToSqlWhere);
            return {
                sql: `(${parts.map((p) => p.sql).join(" OR ")})`,
                params: parts.flatMap((p) => p.params),
            };
        }
        case "not": {
            const inner = queryToSqlWhere(query.query);
            return { sql: `NOT (${inner.sql})`, params: inner.params };
        }
        case "regex": {
            const pattern = query.value as string;
            const likePattern = simpleRegexToLike(pattern);
            if (likePattern !== null) {
                return { sql: `${query.path} LIKE ?`, params: [likePattern] };
            }
            throw new Err(
                ErrorCode.NOT_SUPPORTED,
                `D1 storage: regex pattern "${pattern}" cannot be translated to SQLite LIKE`,
            );
        }
        case "negex": {
            const pattern = query.value as string;
            const likePattern = simpleRegexToLike(pattern);
            if (likePattern !== null) {
                return { sql: `${query.path} NOT LIKE ?`, params: [likePattern] };
            }
            throw new Err(
                ErrorCode.NOT_SUPPORTED,
                `D1 storage: negex pattern "${pattern}" cannot be translated to SQLite LIKE`,
            );
        }
        default: {
            const op = {
                eq: "=",
                ne: "!=",
                gt: ">",
                gte: ">=",
                lt: "<",
                lte: "<=",
            }[query.op || "eq"];
            const value = query.value;
            if (value === null || value === undefined) {
                const check = query.op === "eq" ? "IS NULL" : "IS NOT NULL";
                return { sql: `${query.path} ${check}`, params: [] };
            }
            return {
                sql: `${query.path} ${op} ?`,
                params: [value as string | number | boolean],
            };
        }
    }
}

export class D1Storage implements Storage {
    constructor(private db: D1Database) {}

    private tableFor(kind: string): string {
        return kind
            .replace(/([A-Z])/g, "_$1")
            .toLowerCase()
            .replace(/^_/, "");
    }

    private serializeColumns(kind: string): string {
        switch (kind) {
            case "Account":
                return "id, data, created_at, updated_at";
            case "Session": {
                return "id, data, expires_at, revoked_at, last_used_at, device_json";
            }
            case "Vault":
                return "id, data, owner_account_id, org_id, revision, updated_at";
            case "Org":
                return "id, data, name, owner_account_id, revision";
            case "Invite":
                return "id, data, org_id, email, expires_at";
            case "KeyStoreEntry":
                return "id, data, account_id";
            case "Attachment":
                return "id, vault_id, owner_account_id, r2_key, size_bytes, hash, created_at";
            case "Auth":
                return "id, account_id, email, data, updated_at";
            default:
                return "";
        }
    }

    private serializeParams(obj: Storable): (string | number | boolean | null)[] {
        const raw = obj.toRaw();
        const kind = obj.kind;

        switch (kind) {
            case "Account":
                return [
                    obj.id,
                    JSON.stringify(raw),
                    raw.created?.toISOString?.() ?? raw.created,
                    raw.updated?.toISOString?.() ?? raw.updated,
                ];
            case "Session":
                return [
                    obj.id,
                    JSON.stringify(raw),
                    raw.expires?.toISOString?.() ?? raw.expires,
                    raw.revokedAt?.toISOString?.() ?? raw.revokedAt ?? null,
                    raw.lastUsed?.toISOString?.() ?? raw.lastUsed,
                    raw.device ? JSON.stringify(raw.device) : null,
                ];
            case "Vault":
                return [
                    obj.id,
                    JSON.stringify(raw),
                    raw.owner,
                    raw.org?.id ?? null,
                    raw.revision,
                    raw.updated?.toISOString?.() ?? raw.updated,
                ];
            case "Org":
                return [obj.id, JSON.stringify(raw), raw.name, raw.owner?.accountId ?? "", raw.revision];
            case "Invite":
                return [
                    obj.id,
                    JSON.stringify(raw),
                    raw.org?.id ?? "",
                    raw.email,
                    raw.expires?.toISOString?.() ?? raw.expires,
                ];
            case "KeyStoreEntry":
                return [obj.id, JSON.stringify(raw), raw.accountId];
            case "Attachment":
                return [
                    obj.id,
                    raw.vaultId,
                    raw.ownerAccountId,
                    raw.r2Key,
                    raw.sizeBytes,
                    raw.hash,
                    raw.createdAt?.toISOString?.() ?? raw.createdAt,
                ];
            case "Auth":
                return [
                    obj.id,
                    raw.accountId,
                    raw.email,
                    JSON.stringify(raw),
                    raw.updatedAt?.toISOString?.() ?? raw.updatedAt,
                ];
            default:
                return [obj.id, JSON.stringify(raw)];
        }
    }

    async save<T extends Storable>(obj: T): Promise<void> {
        const tableName = this.tableFor(obj.kind);
        const columns = this.serializeColumns(obj.kind);
        const placeholders = columns
            .split(",")
            .map(() => "?")
            .join(", ");
        const params = this.serializeParams(obj);

        await this.db
            .prepare(`INSERT OR REPLACE INTO ${tableName} (${columns}) VALUES (${placeholders})`)
            .bind(...params)
            .run();
    }

    async get<T extends Storable>(cls: StorableConstructor<T> | T, id: string): Promise<T> {
        const res = cls instanceof Storable ? cls : new cls();
        const tableName = this.tableFor(res.kind);

        const result = await this.db
            .prepare(`SELECT data FROM ${tableName} WHERE id = ?`)
            .bind(id)
            .first<{ data: string }>();

        if (!result) {
            throw new Err(ErrorCode.NOT_FOUND, `Cannot find object: ${res.kind}_${id}`);
        }

        return res.fromRaw(JSON.parse(result.data));
    }

    async delete<T extends Storable>(obj: T): Promise<void> {
        const tableName = this.tableFor(obj.kind);

        await this.db.prepare(`DELETE FROM ${tableName} WHERE id = ?`).bind(obj.id).run();
    }

    async clear(): Promise<void> {
        const stmts = DOMAIN_TABLES.map((t) => this.db.prepare(`DELETE FROM ${t}`));
        await this.db.batch(stmts);
    }

    async list<T extends Storable>(cls: StorableConstructor<T>, opts: StorageListOptions = {}): Promise<T[]> {
        const kind = new cls().kind;
        const tableName = this.tableFor(kind);
        const { offset = 0, limit: rowLimit, query: where, orderBy, orderByDirection = "asc" } = opts;

        let sqlQuery = `SELECT data FROM ${tableName}`;
        const params: (string | number | boolean)[] = [];

        if (where) {
            const { sql: whereSql, params: whereParams } = queryToSqlWhere(where);
            sqlQuery += ` WHERE ${whereSql}`;
            params.push(...whereParams);
        }

        if (orderBy) {
            const direction = orderByDirection === "desc" ? "DESC" : "ASC";
            sqlQuery += ` ORDER BY ${orderBy} ${direction}`;
        }

        if (offset) {
            sqlQuery += ` OFFSET ?`;
            params.push(offset);
        }

        if (rowLimit && rowLimit !== Infinity) {
            sqlQuery += ` LIMIT ?`;
            params.push(rowLimit);
        }

        const { results } = await this.db
            .prepare(sqlQuery)
            .bind(...params)
            .all<{ data: string }>();

        return results.map((row: { data: string }) => new cls().fromRaw(JSON.parse(row.data)));
    }

    async count<T extends Storable>(cls: StorableConstructor<T>, query?: StorageQuery): Promise<number> {
        const kind = new cls().kind;
        const tableName = this.tableFor(kind);

        let sqlQuery = `SELECT COUNT(*) as cnt FROM ${tableName}`;
        const params: (string | number | boolean)[] = [];

        if (query) {
            const { sql: whereSql, params: whereParams } = queryToSqlWhere(query);
            sqlQuery += ` WHERE ${whereSql}`;
            params.push(...whereParams);
        }

        const result = await this.db
            .prepare(sqlQuery)
            .bind(...params)
            .first<{ cnt: number }>();

        return result?.cnt ?? 0;
    }
}
