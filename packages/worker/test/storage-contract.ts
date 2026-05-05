/**
 * Storage contract tests for D1Storage adapter.
 *
 * Tests the full Storage interface: save, get, delete, clear, list, count
 * against a local D1 (Miniflare) database.
 *
 * NOTE: Requires `miniflare` and `better-sqlite3` packages installed for
 * local execution. These are optional dev deps not included in the package
 * manifest by default.
 */
import { D1Storage } from "../src/storage/d1";
import { Storable } from "@padloc/core/src/storage";
import { ErrorCode } from "@padloc/core/src/error";
// miniflare and better-sqlite3 types are in storage-contract.d.ts
/// <reference path="./storage-contract.d.ts" />

// ──────────────────────────────────────────────────────────────
// Test fixtures — minimal Storable implementations
// ──────────────────────────────────────────────────────────────

class TestAccount extends Storable {
    id = "";
    email = "";
    name = "";
    created = new Date();
    updated = new Date();

    toRaw() {
        return {
            id: this.id,
            email: this.email,
            name: this.name,
            created: this.created.toISOString(),
            updated: this.updated.toISOString(),
        };
    }

    fromRaw(raw: any) {
        this.id = raw.id;
        this.email = raw.email;
        this.name = raw.name;
        this.created = new Date(raw.created);
        this.updated = new Date(raw.updated);
        return this;
    }
}

class TestSession extends Storable {
    id = "";
    accountId = "";
    expires = new Date();
    revokedAt: Date | null = null;
    lastUsed = new Date();
    device: any = null;

    toRaw() {
        return {
            id: this.id,
            accountId: this.accountId,
            expires: this.expires.toISOString(),
            revokedAt: this.revokedAt?.toISOString() ?? null,
            lastUsed: this.lastUsed.toISOString(),
            device: this.device,
        };
    }

    fromRaw(raw: any) {
        this.id = raw.id;
        this.accountId = raw.accountId;
        this.expires = new Date(raw.expires);
        this.revokedAt = raw.revokedAt ? new Date(raw.revokedAt) : null;
        this.lastUsed = new Date(raw.lastUsed);
        this.device = raw.device;
        return this;
    }
}

class TestVault extends Storable {
    id = "";
    owner = "";
    org: { id: string } | null = null;
    revision = "0";
    updated = new Date();

    toRaw() {
        return {
            id: this.id,
            owner: this.owner,
            org: this.org,
            revision: this.revision,
            updated: this.updated.toISOString(),
        };
    }

    fromRaw(raw: any) {
        this.id = raw.id;
        this.owner = raw.owner;
        this.org = raw.org;
        this.revision = raw.revision;
        this.updated = new Date(raw.updated);
        return this;
    }
}

class TestOrg extends Storable {
    id = "";
    name = "";
    owner: { accountId: string } = { accountId: "" };
    revision = "0";

    toRaw() {
        return {
            id: this.id,
            name: this.name,
            owner: this.owner,
            revision: this.revision,
        };
    }

    fromRaw(raw: any) {
        this.id = raw.id;
        this.name = raw.name;
        this.owner = raw.owner;
        this.revision = raw.revision;
        return this;
    }
}

class TestInvite extends Storable {
    id = "";
    org: { id: string } = { id: "" };
    email = "";
    expires = new Date();

    toRaw() {
        return {
            id: this.id,
            org: this.org,
            email: this.email,
            expires: this.expires.toISOString(),
        };
    }

    fromRaw(raw: any) {
        this.id = raw.id;
        this.org = raw.org;
        this.email = raw.email;
        this.expires = new Date(raw.expires);
        return this;
    }
}

class TestKeyStoreEntry extends Storable {
    id = "";
    accountId = "";

    toRaw() {
        return {
            id: this.id,
            accountId: this.accountId,
        };
    }

    fromRaw(raw: any) {
        this.id = raw.id;
        this.accountId = raw.accountId;
        return this;
    }
}

// ──────────────────────────────────────────────────────────────
// Test harness
// ──────────────────────────────────────────────────────────────

let storage: D1Storage;
let db: any;

async function setup() {
    const { D1Database, D1DatabaseAPI } = await import("miniflare");
    const sqlite = await import("better-sqlite3");
    const client = new sqlite.default(":memory:");
    db = new D1Database(new D1DatabaseAPI(client));

    // Apply migrations
    const migrationSql = `
        CREATE TABLE IF NOT EXISTS accounts (
            id TEXT PRIMARY KEY,
            email TEXT NOT NULL,
            data TEXT NOT NULL,
            created_at TEXT NOT NULL,
            updated_at TEXT NOT NULL
        );
        CREATE UNIQUE INDEX IF NOT EXISTS accounts_email_unique ON accounts(email);

        CREATE TABLE IF NOT EXISTS auth (
            id TEXT PRIMARY KEY,
            account_id TEXT NOT NULL,
            email TEXT NOT NULL,
            data TEXT NOT NULL,
            updated_at TEXT NOT NULL
        );
        CREATE INDEX IF NOT EXISTS auth_account_id_idx ON auth(account_id);
        CREATE INDEX IF NOT EXISTS auth_email_idx ON auth(email);

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

        CREATE TABLE IF NOT EXISTS orgs (
            id TEXT PRIMARY KEY,
            name TEXT NOT NULL,
            owner_account_id TEXT NOT NULL,
            data TEXT NOT NULL,
            revision TEXT NOT NULL
        );
        CREATE INDEX IF NOT EXISTS orgs_owner_account_id_idx ON orgs(owner_account_id);

        CREATE TABLE IF NOT EXISTS org_members (
            org_id TEXT NOT NULL,
            account_id TEXT NOT NULL,
            role INTEGER NOT NULL,
            status TEXT NOT NULL,
            PRIMARY KEY (org_id, account_id)
        );
        CREATE INDEX IF NOT EXISTS org_members_account_id_idx ON org_members(account_id);

        CREATE TABLE IF NOT EXISTS invites (
            id TEXT PRIMARY KEY,
            org_id TEXT NOT NULL,
            email TEXT NOT NULL,
            data TEXT NOT NULL,
            expires_at TEXT NOT NULL
        );
        CREATE INDEX IF NOT EXISTS invites_org_id_idx ON invites(org_id);
        CREATE INDEX IF NOT EXISTS invites_email_idx ON invites(email);

        CREATE TABLE IF NOT EXISTS key_store_entries (
            id TEXT PRIMARY KEY,
            account_id TEXT NOT NULL,
            data TEXT NOT NULL
        );
        CREATE INDEX IF NOT EXISTS key_store_entries_account_id_idx ON key_store_entries(account_id);

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

        CREATE TABLE IF NOT EXISTS change_log (
            id TEXT PRIMARY KEY,
            action TEXT NOT NULL,
            object_type TEXT NOT NULL,
            object_id TEXT NOT NULL,
            data TEXT,
            timestamp TEXT NOT NULL
        );

        CREATE TABLE IF NOT EXISTS request_log (
            id TEXT PRIMARY KEY,
            method TEXT NOT NULL,
            path TEXT NOT NULL,
            status INTEGER NOT NULL,
            duration_ms INTEGER,
            ip TEXT,
            timestamp TEXT NOT NULL
        );
    `;

    await db.exec(migrationSql);
    storage = new D1Storage(db);
}

async function teardown() {
    if (db) {
        await storage.clear();
    }
}

// ──────────────────────────────────────────────────────────────
// Test runner
// ──────────────────────────────────────────────────────────────

interface TestResult {
    name: string;
    ok: boolean;
    detail: string;
}

const results: TestResult[] = [];

function test(name: string, fn: () => Promise<void>) {
    return fn()
        .then(() => results.push({ name, ok: true, detail: "passed" }))
        .catch((err) => results.push({ name, ok: false, detail: err.message }));
}

function assert(condition: boolean, message: string) {
    if (!condition) throw new Error(message);
}

function assertEqual(actual: any, expected: any, message: string) {
    if (actual !== expected) {
        throw new Error(`${message}: expected ${expected}, got ${actual}`);
    }
}

// ──────────────────────────────────────────────────────────────
// Tests
// ──────────────────────────────────────────────────────────────

async function runTests() {
    await setup();

    // Account CRUD
    await test("Account: create and get", async () => {
        const account = new TestAccount();
        account.id = "acc-001";
        account.email = "test@example.com";
        account.name = "Test User";
        account.created = new Date();
        account.updated = new Date();

        await storage.save(account);
        const retrieved = await storage.get(new TestAccount(), "acc-001");

        assertEqual(retrieved.id, "acc-001", "id");
        assertEqual(retrieved.email, "test@example.com", "email");
        assertEqual(retrieved.name, "Test User", "name");
    });

    await test("Account: update existing", async () => {
        const account = new TestAccount();
        account.id = "acc-002";
        account.email = "update@example.com";
        account.name = "Original";
        account.created = new Date();
        account.updated = new Date();

        await storage.save(account);

        account.name = "Updated";
        account.updated = new Date();
        await storage.save(account);

        const retrieved = await storage.get(new TestAccount(), "acc-002");
        assertEqual(retrieved.name, "Updated", "name should be updated");
    });

    await test("Account: delete", async () => {
        const account = new TestAccount();
        account.id = "acc-003";
        account.email = "delete@example.com";
        account.name = "Delete Me";
        account.created = new Date();
        account.updated = new Date();

        await storage.save(account);
        await storage.delete(account);

        try {
            await storage.get(new TestAccount(), "acc-003");
            throw new Error("Should have thrown NOT_FOUND");
        } catch (err: any) {
            assert(err.code === ErrorCode.NOT_FOUND, "Should throw NOT_FOUND");
        }
    });

    await test("Account: get non-existent throws NOT_FOUND", async () => {
        try {
            await storage.get(new TestAccount(), "non-existent");
            throw new Error("Should have thrown");
        } catch (err: any) {
            assert(err.code === ErrorCode.NOT_FOUND, "Should throw NOT_FOUND");
        }
    });

    // Session CRUD
    await test("Session: create and get", async () => {
        const session = new TestSession();
        session.id = "sess-001";
        session.accountId = "acc-001";
        session.expires = new Date(Date.now() + 86400000);
        session.lastUsed = new Date();

        await storage.save(session);
        const retrieved = await storage.get(new TestSession(), "sess-001");

        assertEqual(retrieved.id, "sess-001", "id");
        assertEqual(retrieved.accountId, "acc-001", "accountId");
    });

    await test("Session: revoke (update)", async () => {
        const session = new TestSession();
        session.id = "sess-002";
        session.accountId = "acc-001";
        session.expires = new Date(Date.now() + 86400000);
        session.lastUsed = new Date();

        await storage.save(session);

        session.revokedAt = new Date();
        await storage.save(session);

        const retrieved = await storage.get(new TestSession(), "sess-002");
        assert(retrieved.revokedAt !== null, "revokedAt should be set");
    });

    // Vault CRUD
    await test("Vault: create and get", async () => {
        const vault = new TestVault();
        vault.id = "vault-001";
        vault.owner = "acc-001";
        vault.revision = "1";
        vault.updated = new Date();

        await storage.save(vault);
        const retrieved = await storage.get(new TestVault(), "vault-001");

        assertEqual(retrieved.id, "vault-001", "id");
        assertEqual(retrieved.owner, "acc-001", "owner");
    });

    await test("Vault: update revision", async () => {
        const vault = new TestVault();
        vault.id = "vault-002";
        vault.owner = "acc-001";
        vault.revision = "1";
        vault.updated = new Date();

        await storage.save(vault);

        vault.revision = "2";
        vault.updated = new Date();
        await storage.save(vault);

        const retrieved = await storage.get(new TestVault(), "vault-002");
        assertEqual(retrieved.revision, "2", "revision should be updated");
    });

    // Org CRUD
    await test("Org: create and get", async () => {
        const org = new TestOrg();
        org.id = "org-001";
        org.name = "Test Org";
        org.owner = { accountId: "acc-001" };
        org.revision = "1";

        await storage.save(org);
        const retrieved = await storage.get(new TestOrg(), "org-001");

        assertEqual(retrieved.id, "org-001", "id");
        assertEqual(retrieved.name, "Test Org", "name");
    });

    // Invite CRUD
    await test("Invite: create and get", async () => {
        const invite = new TestInvite();
        invite.id = "inv-001";
        invite.org = { id: "org-001" };
        invite.email = "invite@example.com";
        invite.expires = new Date(Date.now() + 86400000);

        await storage.save(invite);
        const retrieved = await storage.get(new TestInvite(), "inv-001");

        assertEqual(retrieved.id, "inv-001", "id");
        assertEqual(retrieved.email, "invite@example.com", "email");
    });

    // KeyStoreEntry CRUD
    await test("KeyStoreEntry: create and get", async () => {
        const entry = new TestKeyStoreEntry();
        entry.id = "ks-001";
        entry.accountId = "acc-001";

        await storage.save(entry);
        const retrieved = await storage.get(new TestKeyStoreEntry(), "ks-001");

        assertEqual(retrieved.id, "ks-001", "id");
        assertEqual(retrieved.accountId, "acc-001", "accountId");
    });

    // List operations
    await test("List: returns all accounts", async () => {
        const accounts = await storage.list(TestAccount);
        assert(accounts.length >= 3, "Should have at least 3 accounts");
    });

    await test("List: with limit", async () => {
        const accounts = await storage.list(TestAccount, { limit: 2 });
        assert(accounts.length <= 2, "Should have at most 2 accounts");
    });

    await test("List: with offset", async () => {
        const all = await storage.list(TestAccount);
        const offset = await storage.list(TestAccount, { offset: 1 });
        assert(offset.length === Math.max(0, all.length - 1), "Offset should skip first item");
    });

    // Count operations
    await test("Count: returns correct count", async () => {
        const count = await storage.count(TestAccount);
        assert(count >= 3, "Should have at least 3 accounts");
    });

    // Clear
    await test("Clear: removes all data", async () => {
        await storage.clear();
        const accounts = await storage.list(TestAccount);
        assertEqual(accounts.length, 0, "Should have 0 accounts after clear");
    });

    // Batch write
    await test("Batch: save multiple items atomically", async () => {
        const items = [
            new TestAccount().fromRaw({
                id: "batch-1",
                email: "batch1@test.com",
                name: "Batch 1",
                created: new Date().toISOString(),
                updated: new Date().toISOString(),
            }),
            new TestAccount().fromRaw({
                id: "batch-2",
                email: "batch2@test.com",
                name: "Batch 2",
                created: new Date().toISOString(),
                updated: new Date().toISOString(),
            }),
            new TestAccount().fromRaw({
                id: "batch-3",
                email: "batch3@test.com",
                name: "Batch 3",
                created: new Date().toISOString(),
                updated: new Date().toISOString(),
            }),
        ];

        await storage.saveBatch(items);
        const count = await storage.count(TestAccount);
        assertEqual(count, 3, "Should have 3 accounts after batch save");
    });

    // Print results
    const passed = results.filter((r) => r.ok).length;
    const failed = results.filter((r) => !r.ok).length;

    console.log("\n=== D1 Storage Contract Tests ===");
    console.log(`Total: ${results.length} | Passed: ${passed} | Failed: ${failed}\n`);

    for (const r of results) {
        const status = r.ok ? "✓" : "✗";
        console.log(`${status} ${r.name}`);
        if (!r.ok) {
            console.log(`  Error: ${r.detail}`);
        }
    }

    if (failed > 0) {
        process.exit(1);
    }
}

runTests().catch((err) => {
    console.error("Test harness failed:", err);
    process.exit(1);
});
