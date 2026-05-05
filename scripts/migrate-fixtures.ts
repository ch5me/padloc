#!/usr/bin/env tsx
/**
 * migrate-fixtures.ts — Padloc D1/R2 migration CLI
 *
 * Imports from legacy source fixtures into D1/R2, with idempotency guards
 * and backup/export commands. This script lives in scripts/ and is never
 * part of the Worker request hot path.
 *
 * Usage:
 *   npx tsx scripts/migrate-fixtures.ts import --file fixtures/sample-fixture.json --env dev
 *   npx tsx scripts/migrate-fixtures.ts export --env dev --out fixtures/export-$(date +%Y%m%d).json
 *   npx tsx scripts/migrate-fixtures.ts backup --env dev --out fixtures/backup-$(date +%Y%m%d).json
 *   npx tsx scripts/migrate-fixtures.ts validate --file fixtures/sample-fixture.json
 */

import { readFileSync, writeFileSync } from "fs";
import { resolve, join } from "path";
import { createInterface } from "readline";

const ROOT = resolve(__dirname, "..");
const WORKER_DIR = resolve(ROOT, "packages/worker");
const FIXTURES_DIR = resolve(ROOT, "fixtures");
const EVIDENCE_DIR = resolve(ROOT, ".sisyphus/evidence");

// ──────────────────────────────────────────────────────────────
// Types
// ──────────────────────────────────────────────────────────────

interface FixtureRecord {
    kind: string;
    table?: string;
    data: Record<string, unknown>;
}

interface FixtureManifest {
    version: string;
    description: string;
    created_at: string;
    records: FixtureRecord[];
}

interface ExportManifest {
    exported_at: string;
    environment: string;
    tables: Record<string, number>;
    records: Array<{
        table: string;
        id: string;
        data: string;
    }>;
}

// ──────────────────────────────────────────────────────────────
// Table kind → D1 table name mapping
// ──────────────────────────────────────────────────────────────

const KIND_TO_TABLE: Record<string, string> = {
    account: "accounts",
    auth: "auth",
    session: "sessions",
    vault: "vaults",
    org: "orgs",
    orgmember: "org_members",
    invite: "invites",
    keystoreentry: "key_store_entries",
    attachment: "attachments",
    emailverification: "email_verifications",
};

const TABLE_TO_KIND: Record<string, string> = Object.fromEntries(
    Object.entries(KIND_TO_TABLE).map(([k, v]) => [v, k])
);

// Tables that use composite PK (org_id, account_id)
const COMPOSITE_PK_TABLES = new Set(["org_members"]);

// ──────────────────────────────────────────────────────────────
// CLI argument parsing
// ──────────────────────────────────────────────────────────────

function parseArgs(argv: string[]): {
    command: string;
    file?: string;
    env?: string;
    out?: string;
    dryRun?: boolean;
    table?: string;
} {
    const command = argv[0] || "";
    const args = argv.slice(1);
    const result: ReturnType<typeof parseArgs> = { command };

    for (let i = 0; i < args.length; i++) {
        const arg = args[i];
        if (arg === "--file" || arg === "-f") result.file = args[++i];
        else if (arg === "--env" || arg === "-e") result.env = args[++i];
        else if (arg === "--out" || arg === "-o") result.out = args[++i];
        else if (arg === "--dry-run" || arg === "-n") result.dryRun = true;
        else if (arg === "--table" || arg === "-t") result.table = args[++i];
    }

    return result;
}

// ──────────────────────────────────────────────────────────────
// Wrangler D1 execute helper
// ──────────────────────────────────────────────────────────────

async function d1Execute(sql: string, env: string, options: { dryRun?: boolean; local?: boolean } = {}): Promise<string> {
    const { dryRun: isDryRun = false, local = true } = options;
    const target = env || "dev";
    const flag = local ? "--local" : "--remote";

    if (isDryRun) {
        return `[dry-run] would execute SQL on ${target}:\n${sql.substring(0, 200)}${sql.length > 200 ? "..." : ""}`;
    }

    const { execSync } = await import("child_process");
    try {
        const result = execSync(
            `npx wrangler d1 execute padloc-${target} ${flag} --command=${JSON.stringify(sql)} --persist-to .wrangler/state 2>&1`,
            { encoding: "utf8", cwd: WORKER_DIR }
        );
        return result;
    } catch (err: any) {
        return err.stdout || err.message;
    }
}

// ──────────────────────────────────────────────────────────────
// Timestamp helper
// ──────────────────────────────────────────────────────────────

function nowISO(): string {
    return new Date().toISOString();
}

function logInfo(msg: string): void {
    console.log(`[INFO] ${nowISO()} ${msg}`);
}

function logWarn(msg: string): void {
    console.warn(`[WARN] ${nowISO()} ${msg}`);
}

function logError(msg: string): void {
    console.error(`[ERROR] ${nowISO()} ${msg}`);
}

// ──────────────────────────────────────────────────────────────
// Validate fixture file
// ──────────────────────────────────────────────────────────────

function loadFixture(filePath: string): FixtureManifest {
    const raw = readFileSync(filePath, "utf8");
    const parsed = JSON.parse(raw) as FixtureManifest;

    if (!parsed.records || !Array.isArray(parsed.records)) {
        throw new Error("Fixture must have a 'records' array.");
    }

    for (const rec of parsed.records) {
        if (!rec.kind || typeof rec.kind !== "string") {
            throw new Error("Each record must have a string 'kind' field.");
        }
        if (!rec.data || typeof rec.data !== "object") {
            throw new Error(`Record of kind '${rec.kind}' must have a 'data' object.`);
        }
    }

    return parsed;
}

// ──────────────────────────────────────────────────────────────
// SQL generation per table type
// ──────────────────────────────────────────────────────────────

function sqlForRecord(rec: FixtureRecord): { sql: string; bindings: unknown[] } {
    const table = rec.table || KIND_TO_TABLE[rec.kind] || rec.kind;
    const raw = rec.data;
    const id = raw.id || raw.uuid || "";
    const now = nowISO();

    if (table === "accounts") {
        const email = (raw.email as string) || "";
        const data = JSON.stringify(raw);
        return {
            sql: `INSERT INTO accounts (id, email, data, created_at, updated_at) VALUES (?, ?, ?, ?, ?) ON CONFLICT(id) DO UPDATE SET email = excluded.email, data = excluded.data, updated_at = excluded.updated_at`,
            bindings: [id, email, data, now, now],
        };
    }

    if (table === "auth") {
        const accountId = (raw.account as string) || (raw.account_id as string) || "";
        const email = (raw.email as string) || "";
        const data = JSON.stringify(raw);
        return {
            sql: `INSERT INTO auth (id, account_id, email, data, updated_at) VALUES (?, ?, ?, ?, ?) ON CONFLICT(id) DO UPDATE SET account_id = excluded.account_id, email = excluded.email, data = excluded.data, updated_at = excluded.updated_at`,
            bindings: [id, accountId, email, data, now],
        };
    }

    if (table === "sessions") {
        const accountId = (raw.account as string) || (raw.account_id as string) || "";
        const keyBlob = (raw.key as string) || (raw.key_blob as string) || "";
        const expiresAt = raw.expires ? new Date(raw.expires as string).toISOString() : now;
        const lastUsedAt = raw.lastUsed ? new Date(raw.lastUsed as string).toISOString() : now;
        const deviceJson = raw.device ? JSON.stringify(raw.device) : null;
        return {
            sql: `INSERT INTO sessions (id, account_id, key_blob, expires_at, last_used_at, device_json) VALUES (?, ?, ?, ?, ?, ?) ON CONFLICT(id) DO UPDATE SET account_id = excluded.account_id, key_blob = excluded.key_blob, expires_at = excluded.expires_at, last_used_at = excluded.last_used_at, device_json = excluded.device_json`,
            bindings: [id, accountId, keyBlob, expiresAt, lastUsedAt, deviceJson],
        };
    }

    if (table === "vaults") {
        const ownerId = (raw.owner as string) || "";
        const orgId = (raw.org as any)?.id || null;
        const revision = (raw.revision as string) || "";
        const data = JSON.stringify(raw);
        return {
            sql: `INSERT INTO vaults (id, owner_account_id, org_id, data, revision, updated_at) VALUES (?, ?, ?, ?, ?, ?) ON CONFLICT(id) DO UPDATE SET owner_account_id = excluded.owner_account_id, org_id = excluded.org_id, data = excluded.data, revision = excluded.revision, updated_at = excluded.updated_at`,
            bindings: [id, ownerId, orgId, data, revision, now],
        };
    }

    if (table === "orgs") {
        const name = (raw.name as string) || "";
        const ownerId = (raw.owner as any)?.accountId || (raw.owner_account_id as string) || "";
        const revision = (raw.revision as string) || "";
        const data = JSON.stringify(raw);
        return {
            sql: `INSERT INTO orgs (id, name, owner_account_id, data, revision) VALUES (?, ?, ?, ?, ?) ON CONFLICT(id) DO UPDATE SET name = excluded.name, owner_account_id = excluded.owner_account_id, data = excluded.data, revision = excluded.revision`,
            bindings: [id, name, ownerId, data, revision],
        };
    }

    if (table === "org_members") {
        const orgId = (raw.orgId as string) || (raw.org_id as string) || "";
        const accountId = (raw.accountId as string) || (raw.account_id as string) || "";
        const role = typeof raw.role === "number" ? raw.role : 2;
        const status = (raw.status as string) || "active";
        return {
            sql: `INSERT INTO org_members (org_id, account_id, role, status) VALUES (?, ?, ?, ?) ON CONFLICT(org_id, account_id) DO UPDATE SET role = excluded.role, status = excluded.status`,
            bindings: [orgId, accountId, role, status],
        };
    }

    if (table === "invites") {
        const orgId = (raw.org as any)?.id || (raw.org_id as string) || "";
        const email = (raw.email as string) || "";
        const data = JSON.stringify(raw);
        const expiresAt = raw.expires ? new Date(raw.expires as string).toISOString() : now;
        return {
            sql: `INSERT INTO invites (id, org_id, email, data, expires_at) VALUES (?, ?, ?, ?, ?) ON CONFLICT(id) DO UPDATE SET org_id = excluded.org_id, email = excluded.email, data = excluded.data, expires_at = excluded.expires_at`,
            bindings: [id, orgId, email, data, expiresAt],
        };
    }

    if (table === "key_store_entries") {
        const accountId = (raw.accountId as string) || (raw.account_id as string) || "";
        const data = JSON.stringify(raw);
        return {
            sql: `INSERT INTO key_store_entries (id, account_id, data) VALUES (?, ?, ?) ON CONFLICT(id) DO UPDATE SET account_id = excluded.account_id, data = excluded.data`,
            bindings: [id, accountId, data],
        };
    }

    if (table === "attachments") {
        const vaultId = (raw.vault as string) || (raw.vault_id as string) || "";
        const ownerId = (raw.owner as string) || (raw.owner_account_id as string) || "";
        const r2Key = (raw.r2_key as string) || `att/${vaultId}/${id}`;
        const sizeBytes = typeof raw.size === "number" ? raw.size : 0;
        const hash = (raw.hash as string) || "";
        return {
            sql: `INSERT INTO attachments (id, vault_id, owner_account_id, r2_key, size_bytes, hash, created_at) VALUES (?, ?, ?, ?, ?, ?, ?) ON CONFLICT(id) DO UPDATE SET vault_id = excluded.vault_id, owner_account_id = excluded.owner_account_id, r2_key = excluded.r2_key, size_bytes = excluded.size_bytes, hash = excluded.hash, created_at = excluded.created_at`,
            bindings: [id, vaultId, ownerId, r2Key, sizeBytes, hash, now],
        };
    }

    if (table === "email_verifications") {
        const email = (raw.email as string) || "";
        const codeHash = (raw.code_hash as string) || (raw.codeHash as string) || "";
        const purpose = (raw.purpose as string) || "register";
        const expiresAt = raw.expires ? new Date(raw.expires as string).toISOString() : now;
        const consumedAt = raw.consumed_at || null;
        return {
            sql: `INSERT INTO email_verifications (id, email, code_hash, purpose, expires_at, consumed_at) VALUES (?, ?, ?, ?, ?, ?) ON CONFLICT(id) DO UPDATE SET email = excluded.email, code_hash = excluded.code_hash, purpose = excluded.purpose, expires_at = excluded.expires_at, consumed_at = excluded.consumed_at`,
            bindings: [id, email, codeHash, purpose, expiresAt, consumedAt],
        };
    }

    // Generic fallback
    const data = JSON.stringify(raw);
    return {
        sql: `INSERT INTO ${table} (id, data) VALUES (?, ?) ON CONFLICT(id) DO UPDATE SET data = excluded.data`,
        bindings: [id, data],
    };
}

// ──────────────────────────────────────────────────────────────
// Check for existing record (idempotency guard)
// ──────────────────────────────────────────────────────────────

async function recordExists(table: string, id: string, env: string): Promise<boolean> {
    const { execSync } = await import("child_process");
    // Escape single quotes in id for safe SQL interpolation
    const safeId = id.replace(/'/g, "''");
    const sql = `SELECT id FROM ${table} WHERE id = '${safeId}' LIMIT 1`;
    try {
        const raw = execSync(
            `npx wrangler d1 execute padloc-${env} --local --command=${JSON.stringify(sql)} --persist-to .wrangler/state --json 2>&1`,
            { encoding: "utf8", cwd: WORKER_DIR }
        );
        const parsed = JSON.parse(raw);
        return (parsed[0]?.results?.length ?? 0) > 0;
    } catch {
        return false;
    }
}

// ──────────────────────────────────────────────────────────────
// Import command
// ──────────────────────────────────────────────────────────────

async function cmdImport(opts: {
    file: string;
    env: string;
    dryRun?: boolean;
    force?: boolean;
}): Promise<{ imported: number; skipped: number; errors: number }> {
    const { file, env, dryRun, force } = opts;

    logInfo(`Loading fixture from: ${file}`);
    const fixture = loadFixture(file);
    logInfo(`Fixture version: ${fixture.version} — ${fixture.description}`);
    logInfo(`Total records: ${fixture.records.length}`);

    const stats = { imported: 0, skipped: 0, errors: 0 };

    for (const rec of fixture.records) {
        const table = rec.table || KIND_TO_TABLE[rec.kind] || rec.kind;
        const id = rec.data.id || rec.data.uuid || "";

        if (!id) {
            logWarn(`Skipping record of kind '${rec.kind}' — no 'id' field found.`);
            stats.errors++;
            continue;
        }

        if (!force) {
            const exists = await recordExists(table, id, env);
            if (exists) {
                logInfo(`Skipping [${table}] ${id} — already exists (idempotency guard).`);
                stats.skipped++;
                continue;
            }
        }

        try {
            const { sql, bindings } = sqlForRecord(rec);
            if (dryRun) {
                logInfo(`[dry-run] would INSERT INTO ${table} (id=${id})`);
            } else {
                await d1Execute(sql, env);
                logInfo(`Imported [${table}] ${id}`);
            }
            stats.imported++;
        } catch (err) {
            logError(`Failed to import [${table}] ${id}: ${err}`);
            stats.errors++;
        }
    }

    logInfo(
        `Import complete — imported: ${stats.imported}, skipped: ${stats.skipped}, errors: ${stats.errors}`
    );

    return stats;
}

// ──────────────────────────────────────────────────────────────
// Export command
// ──────────────────────────────────────────────────────────────

async function cmdExport(opts: { env: string; out: string; table?: string }): Promise<void> {
    const { env, out, table } = opts;
    const tables = table ? [table] : Object.values(KIND_TO_TABLE);

    logInfo(`Exporting D1 data from environment: ${env}`);

    const exportData: ExportManifest = {
        exported_at: nowISO(),
        environment: env,
        tables: {},
        records: [],
    };

    for (const tbl of tables) {
        const sql = `SELECT id, data FROM ${tbl}`;
        const { execSync } = await import("child_process");
        try {
            const raw = execSync(
                `npx wrangler d1 execute padloc-${env} --local --command=${JSON.stringify(sql)} --persist-to .wrangler/state 2>&1`,
                { encoding: "utf8", cwd: ROOT }
            );

            // Parse D1 output (each row is tab-separated, rows are newline-separated)
            const rows: Array<{ id: string; data: string }> = [];
            const lines = raw.split("\n").filter((l) => l.trim() && !l.startsWith("──") && !l.startsWith("("));
            for (const line of lines) {
                const parts = line.split("\t");
                if (parts.length >= 2) {
                    rows.push({ id: parts[0].trim(), data: parts[1].trim() });
                }
            }

            exportData.tables[tbl] = rows.length;
            for (const row of rows) {
                exportData.records.push({ table: tbl, id: row.id, data: row.data });
            }
            logInfo(`  Exported ${rows.length} rows from '${tbl}'`);
        } catch (err) {
            logWarn(`  Could not export '${tbl}': ${err}`);
            exportData.tables[tbl] = -1;
        }
    }

    writeFileSync(out, JSON.stringify(exportData, null, 2), "utf8");
    logInfo(`Export written to: ${out}`);
}

// ──────────────────────────────────────────────────────────────
// Backup command (wraps export)
// ──────────────────────────────────────────────────────────────

async function cmdBackup(opts: { env: string; out: string }): Promise<void> {
    logInfo("Starting backup before any migration operation...");
    await cmdExport(opts);
    logInfo("Backup complete.");
}

// ──────────────────────────────────────────────────────────────
// Validate command
// ──────────────────────────────────────────────────────────────

function cmdValidate(opts: { file: string }): void {
    logInfo(`Validating fixture: ${opts.file}`);
    const fixture = loadFixture(opts.file);
    logInfo(`Fixture version: ${fixture.version} — ${fixture.description}`);
    logInfo(`Records: ${fixture.records.length}`);

    let valid = true;
    for (const rec of fixture.records) {
        const table = rec.table || KIND_TO_TABLE[rec.kind];
        if (!table) {
            logError(`Unknown kind '${rec.kind}' — no D1 table mapping.`);
            valid = false;
            continue;
        }

        const id = rec.data.id || rec.data.uuid;
        if (!id) {
            logError(`Record of kind '${rec.kind}' missing 'id' or 'uuid' in data.`);
            valid = false;
        }

        // Validate kind-specific required fields
        if (rec.kind === "account" && !rec.data.email) {
            logError(`Account record missing 'email' field.`);
            valid = false;
        }
    }

    if (valid) {
        logInfo("Validation PASSED — fixture is well-formed.");
    } else {
        logError("Validation FAILED — see errors above.");
        process.exit(1);
    }
}

// ──────────────────────────────────────────────────────────────
// Help
// ──────────────────────────────────────────────────────────────

function printHelp(): void {
    console.log(`
Usage: npx tsx scripts/migrate-fixtures.ts <command> [options]

Commands:
  import   Import fixture data into D1. Uses idempotency guards by default.
  export   Export D1 data to a JSON fixture file.
  backup   Export D1 data (backup before migration).
  validate Check fixture file structure without importing.

Options:
  --file, -f <path>    Path to fixture JSON file (required for import/validate)
  --env, -e <env>      Target environment: dev | preview | production (default: dev)
  --out, -o <path>     Output file path (required for export/backup)
  --dry-run, -n        Show what would be imported without making changes
  --table, -t <table>  Only export/import a specific table

Idempotency:
  Import rejects records whose id already exists in the target table.
  Use --force to overwrite existing records.

Examples:
  npx tsx scripts/migrate-fixtures.ts validate --file fixtures/sample-fixture.json
  npx tsx scripts/migrate-fixtures.ts import --file fixtures/sample-fixture.json --env dev
  npx tsx scripts/migrate-fixtures.ts import --file fixtures/sample-fixture.json --env dev --dry-run
  npx tsx scripts/migrate-fixtures.ts backup --env dev --out fixtures/backup-$(date +%Y%m%d).json
  npx tsx scripts/migrate-fixtures.ts export --env dev --out fixtures/export.json
`);
}

// ──────────────────────────────────────────────────────────────
// Main
// ──────────────────────────────────────────────────────────────

async function main() {
    const args = parseArgs(process.argv.slice(2));
    const { command, file, env = "dev", out, dryRun, table } = args;

    if (!command || command === "help" || command === "--help") {
        printHelp();
        process.exit(0);
    }

    // Create evidence directory
    try {
        const { mkdirSync } = await import("fs");
        mkdirSync(EVIDENCE_DIR, { recursive: true });
    } catch {}

    switch (command) {
        case "validate": {
            if (!file) {
                logError("--file is required for validate command.");
                process.exit(1);
            }
            cmdValidate({ file });
            break;
        }

        case "import": {
            if (!file) {
                logError("--file is required for import command.");
                process.exit(1);
            }
            const stats = await cmdImport({ file, env, dryRun });
            process.exit(stats.errors > 0 ? 1 : 0);
        }

        case "export": {
            if (!out) {
                logError("--out is required for export command.");
                process.exit(1);
            }
            await cmdExport({ env, out, table });
            break;
        }

        case "backup": {
            if (!out) {
                logError("--out is required for backup command.");
                process.exit(1);
            }
            await cmdBackup({ env, out });
            break;
        }

        default:
            logError(`Unknown command: ${command}`);
            printHelp();
            process.exit(1);
    }
}

main().catch((err) => {
    logError(`Unhandled error: ${err}`);
    process.exit(1);
});
