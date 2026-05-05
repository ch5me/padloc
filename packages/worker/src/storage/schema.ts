/**
 * Drizzle ORM schema for Padloc D1 storage.
 *
 * Each Storable in @padloc/core maps to one table. Encrypted blob columns store
 * serialized objects — no plaintext that the existing Postgres backend encrypts.
 *
 * Schema ownership map:
 *   accounts          → Account (core/src/account.ts)
 *   auth              → Auth metadata (getAuthInfo flow)
 *   sessions          → Session (core/src/session.ts)
 *   vaults            → Vault (core/src/vault.ts)
 *   orgs              → Org (core/src/org.ts)
 *   org_members       → OrgMember (core/src/org.ts)
 *   invites           → Invite (core/src/invite.ts)
 *   key_store_entries → KeyStoreEntry (core/src/key-store.ts)
 *   attachments       → Attachment metadata (R2-backed payloads)
 *   email_verifications → Email verification codes
 *   change_log        → Audit trail (forward-only)
 *   request_log       → Audit trail (forward-only)
 */

import { sqliteTable, text, integer, uniqueIndex, index, primaryKey } from "drizzle-orm/sqlite-core";

// ──────────────────────────────────────────────────────────────
// Domain tables
// ──────────────────────────────────────────────────────────────

/**
 * accounts — Account objects.
 * Encrypted blob (PBES2Container) stores privateKey, signingKey, favorites, tags.
 */
export const accounts = sqliteTable(
    "accounts",
    {
        /** ULID-style TEXT PRIMARY KEY */
        id: text("id").primaryKey(),
        /** Email, stored lowercased. Unique index enforced. */
        email: text("email").notNull(),
        /** Serialized + encrypted Account (PBES2Container.encryptedData + metadata) */
        data: text("data").notNull(),
        /** ISO 8601 timestamp */
        created_at: text("created_at").notNull(),
        /** ISO 8601 timestamp */
        updated_at: text("updated_at").notNull(),
    },
    (table) => ({
        emailUnique: uniqueIndex("accounts_email_unique").on(table.email),
    }),
);

/**
 * auth — Auth metadata for getAuthInfo flow.
 */
export const auth = sqliteTable(
    "auth",
    {
        id: text("id").primaryKey(),
        /** FK reference to accounts.id */
        account_id: text("account_id").notNull(),
        email: text("email").notNull(),
        /** Serialized + encrypted Auth object */
        data: text("data").notNull(),
        updated_at: text("updated_at").notNull(),
    },
    (table) => ({
        accountIdx: index("auth_account_id_idx").on(table.account_id),
        emailIdx: index("auth_email_idx").on(table.email),
    }),
);

/**
 * sessions — Session objects.
 * key_blob stores the HMAC session key (encrypted at rest).
 */
export const sessions = sqliteTable(
    "sessions",
    {
        id: text("id").primaryKey(),
        account_id: text("account_id").notNull(),
        /** HMAC session key, stored encrypted */
        key_blob: text("key_blob").notNull(),
        /** ISO 8601 expiration */
        expires_at: text("expires_at").notNull(),
        /** ISO 8601 — NULL if session is still valid */
        revoked_at: text("revoked_at"),
        /** ISO 8601 — last authentication use */
        last_used_at: text("last_used_at").notNull(),
        /** JSON serialization of DeviceInfo */
        device_json: text("device_json"),
    },
    (table) => ({
        accountIdx: index("sessions_account_id_idx").on(table.account_id),
        expiresIdx: index("sessions_expires_at_idx").on(table.expires_at),
    }),
);

/**
 * vaults — Vault objects.
 * Encrypted blob (SharedContainer) stores vault items.
 * D1 row-size limit (10 MB) — blobs exceeding this spill to R2 with
 * key prefix `vault-blob/` and a D1 pointer row (handled at storage layer).
 */
export const vaults = sqliteTable(
    "vaults",
    {
        id: text("id").primaryKey(),
        owner_account_id: text("owner_account_id").notNull(),
        /** NULL = private vault; otherwise shared org vault */
        org_id: text("org_id"),
        /** Serialized + encrypted Vault (SharedContainer.encryptedData + metadata) */
        data: text("data").notNull(),
        /** Revision string for sync continuity */
        revision: text("revision").notNull(),
        updated_at: text("updated_at").notNull(),
    },
    (table) => ({
        ownerIdx: index("vaults_owner_account_id_idx").on(table.owner_account_id),
        orgIdx: index("vaults_org_id_idx").on(table.org_id),
    }),
);

/**
 * orgs — Org objects.
 * Encrypted blob stores privateKey, invitesKey (Owner-only secrets).
 */
export const orgs = sqliteTable(
    "orgs",
    {
        id: text("id").primaryKey(),
        name: text("name").notNull(),
        owner_account_id: text("owner_account_id").notNull(),
        /** Serialized + encrypted Org (SharedContainer.encryptedData + metadata) */
        data: text("data").notNull(),
        revision: text("revision").notNull(),
    },
    (table) => ({
        ownerIdx: index("orgs_owner_account_id_idx").on(table.owner_account_id),
    }),
);

/**
 * org_members — membership join table.
 * Composite PK: (org_id, account_id).
 */
export const orgMembers = sqliteTable(
    "org_members",
    {
        org_id: text("org_id").notNull(),
        account_id: text("account_id").notNull(),
        /** OrgRole enum value as integer (0=Owner, 1=Admin, 2=Member, 3=Suspended) */
        role: integer("role").notNull(),
        /** OrgMemberStatus string */
        status: text("status").notNull(),
    },
    (table) => ({
        pk: primaryKey({ columns: [table.org_id, table.account_id] }),
        accountIdx: index("org_members_account_id_idx").on(table.account_id),
    }),
);

/**
 * invites — Invite objects for org membership key exchange.
 * Encrypted blob stores the invite secret and expiration.
 */
export const invites = sqliteTable(
    "invites",
    {
        id: text("id").primaryKey(),
        org_id: text("org_id").notNull(),
        email: text("email").notNull(),
        /** Serialized + encrypted Invite data */
        data: text("data").notNull(),
        /** ISO 8601 expiration */
        expires_at: text("expires_at").notNull(),
    },
    (table) => ({
        orgIdx: index("invites_org_id_idx").on(table.org_id),
        emailIdx: index("invites_email_idx").on(table.email),
    }),
);

/**
 * key_store_entries — KeyStoreEntry objects (webauthn credential blobs).
 */
export const keyStoreEntries = sqliteTable(
    "key_store_entries",
    {
        id: text("id").primaryKey(),
        account_id: text("account_id").notNull(),
        /** Serialized + encrypted KeyStoreEntry.data */
        data: text("data").notNull(),
    },
    (table) => ({
        accountIdx: index("key_store_entries_account_id_idx").on(table.account_id),
    }),
);

/**
 * attachments — Attachment metadata.
 * Actual file payload lives in R2 (key = r2_key).
 */
export const attachments = sqliteTable(
    "attachments",
    {
        id: text("id").primaryKey(),
        vault_id: text("vault_id").notNull(),
        owner_account_id: text("owner_account_id").notNull(),
        /** R2 object key */
        r2_key: text("r2_key").notNull(),
        /** File size in bytes */
        size_bytes: integer("size_bytes").notNull(),
        /** Content hash (SHA-256 hex) */
        hash: text("hash").notNull(),
        created_at: text("created_at").notNull(),
    },
    (table) => ({
        vaultIdx: index("attachments_vault_id_idx").on(table.vault_id),
    }),
);

// ──────────────────────────────────────────────────────────────
// Operational tables
// ──────────────────────────────────────────────────────────────

/**
 * email_verifications — One-time verification codes for email flows.
 */
export const emailVerifications = sqliteTable(
    "email_verifications",
    {
        id: text("id").primaryKey(),
        email: text("email").notNull(),
        /** Hashed verification code (never plaintext) */
        code_hash: text("code_hash").notNull(),
        /** Purpose: "register" | "password_reset" | "email_change" */
        purpose: text("purpose").notNull(),
        expires_at: text("expires_at").notNull(),
        /** ISO 8601 — NULL until consumed */
        consumed_at: text("consumed_at"),
    },
    (table) => ({
        emailIdx: index("email_verifications_email_idx").on(table.email),
        purposeIdx: index("email_verifications_purpose_idx").on(table.purpose),
    }),
);

/**
 * change_log — Append-only audit trail for storage mutations.
 */
export const changeLog = sqliteTable("change_log", {
    id: text("id").primaryKey(),
    action: text("action").notNull(), // "create" | "update" | "delete"
    object_type: text("object_type").notNull(), // e.g., "Account", "Vault"
    object_id: text("object_id").notNull(),
    /** JSON metadata snapshot */
    data: text("data"),
    timestamp: text("timestamp").notNull(),
});

/**
 * request_log — Append-only audit trail for HTTP requests.
 * Configurable retention (truncated by cron in T26).
 */
export const requestLog = sqliteTable("request_log", {
    id: text("id").primaryKey(),
    method: text("method").notNull(),
    path: text("path").notNull(),
    status: integer("status").notNull(),
    duration_ms: integer("duration_ms"),
    ip: text("ip"),
    timestamp: text("timestamp").notNull(),
});
