-- Migration: 0000_init
-- Description: Initial D1 schema for Padloc Cloudflare backend.
-- Forward-only: to revert, create a new migration that drops/alters tables.
-- See migrations/README.md for rollback strategy.

PRAGMA defer_foreign_keys=on;

-- ──────────────────────────────────────────────────────────────
-- accounts
-- ──────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS accounts (
    id TEXT PRIMARY KEY,
    email TEXT NOT NULL,
    data TEXT NOT NULL,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
);

CREATE UNIQUE INDEX IF NOT EXISTS accounts_email_unique ON accounts(email);

-- ──────────────────────────────────────────────────────────────
-- auth
-- ──────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS auth (
    id TEXT PRIMARY KEY,
    account_id TEXT NOT NULL,
    email TEXT NOT NULL,
    data TEXT NOT NULL,
    updated_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS auth_account_id_idx ON auth(account_id);
CREATE INDEX IF NOT EXISTS auth_email_idx ON auth(email);

-- ──────────────────────────────────────────────────────────────
-- sessions
-- ──────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS sessions (
    id TEXT PRIMARY KEY,
    account_id TEXT NOT NULL,
    key_blob TEXT NOT NULL,
    expires_at TEXT NOT NULL,
    revoked_at TEXT,
    last_used_at TEXT NOT NULL,
    device_json TEXT
);

CREATE INDEX IF NOT EXISTS sessions_account_id_idx ON sessions(account_id);
CREATE INDEX IF NOT EXISTS sessions_expires_at_idx ON sessions(expires_at);

-- ──────────────────────────────────────────────────────────────
-- vaults
-- ──────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS vaults (
    id TEXT PRIMARY KEY,
    owner_account_id TEXT NOT NULL,
    org_id TEXT,
    data TEXT NOT NULL,
    revision TEXT NOT NULL,
    updated_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS vaults_owner_account_id_idx ON vaults(owner_account_id);
CREATE INDEX IF NOT EXISTS vaults_org_id_idx ON vaults(org_id);

-- ──────────────────────────────────────────────────────────────
-- orgs
-- ──────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS orgs (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    owner_account_id TEXT NOT NULL,
    data TEXT NOT NULL,
    revision TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS orgs_owner_account_id_idx ON orgs(owner_account_id);

-- ──────────────────────────────────────────────────────────────
-- org_members
-- ──────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS org_members (
    org_id TEXT NOT NULL,
    account_id TEXT NOT NULL,
    role INTEGER NOT NULL,
    status TEXT NOT NULL,
    PRIMARY KEY (org_id, account_id)
);

CREATE INDEX IF NOT EXISTS org_members_account_id_idx ON org_members(account_id);

-- ──────────────────────────────────────────────────────────────
-- invites
-- ──────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS invites (
    id TEXT PRIMARY KEY,
    org_id TEXT NOT NULL,
    email TEXT NOT NULL,
    data TEXT NOT NULL,
    expires_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS invites_org_id_idx ON invites(org_id);
CREATE INDEX IF NOT EXISTS invites_email_idx ON invites(email);

-- ──────────────────────────────────────────────────────────────
-- key_store_entries
-- ──────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS key_store_entries (
    id TEXT PRIMARY KEY,
    account_id TEXT NOT NULL,
    data TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS key_store_entries_account_id_idx ON key_store_entries(account_id);

-- ──────────────────────────────────────────────────────────────
-- attachments
-- ──────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS attachments (
    id TEXT PRIMARY KEY,
    vault_id TEXT NOT NULL,
    owner_account_id TEXT NOT NULL,
    r2_key TEXT NOT NULL,
    size_bytes INTEGER NOT NULL,
    hash TEXT NOT NULL,
    created_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS attachments_vault_id_idx ON attachments(vault_id);

-- ──────────────────────────────────────────────────────────────
-- email_verifications
-- ──────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS email_verifications (
    id TEXT PRIMARY KEY,
    email TEXT NOT NULL,
    code_hash TEXT NOT NULL,
    purpose TEXT NOT NULL,
    expires_at TEXT NOT NULL,
    consumed_at TEXT
);

CREATE INDEX IF NOT EXISTS email_verifications_email_idx ON email_verifications(email);
CREATE INDEX IF NOT EXISTS email_verifications_purpose_idx ON email_verifications(purpose);

-- ──────────────────────────────────────────────────────────────
-- change_log (append-only audit)
-- ──────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS change_log (
    id TEXT PRIMARY KEY,
    action TEXT NOT NULL,
    object_type TEXT NOT NULL,
    object_id TEXT NOT NULL,
    data TEXT,
    timestamp TEXT NOT NULL
);

-- ──────────────────────────────────────────────────────────────
-- request_log (append-only audit)
-- ──────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS request_log (
    id TEXT PRIMARY KEY,
    method TEXT NOT NULL,
    path TEXT NOT NULL,
    status INTEGER NOT NULL,
    duration_ms INTEGER,
    ip TEXT,
    timestamp TEXT NOT NULL
);
