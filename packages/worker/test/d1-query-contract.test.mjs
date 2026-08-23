/**
 * D1Storage query parity vectors, backed by a deliberately small fake D1.
 *
 * The fake implements the D1 prepared-statement boundary (rather than mocking
 * D1Storage methods), so these checks cover the SQL and bindings emitted by
 * Drizzle as well as object serialization.
 *
 * Run: node packages/worker/test/d1-query-contract.test.mjs
 */
import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { build } from "esbuild";

class Storable {
    fromRaw(raw) {
        Object.assign(this, structuredClone(raw));
        return this;
    }

    toRaw() {
        return structuredClone(Object.fromEntries(Object.entries(this).filter(([key]) => key !== "kind")));
    }
}

class AccountRecord extends Storable {
    kind = "account";
    id = "";
    email = "";
    profile = {};
}

class FakeD1PreparedStatement {
    constructor(database, sql, bindings = []) {
        this.database = database;
        this.sql = sql;
        this.bindings = bindings;
    }

    bind(...bindings) {
        return new FakeD1PreparedStatement(this.database, this.sql, bindings);
    }

    async run() {
        this.database.execute(this.sql, this.bindings);
        return { success: true, meta: { changes: 1 } };
    }

    async all() {
        return { success: true, results: this.database.execute(this.sql, this.bindings) };
    }

    async raw() {
        const rows = this.database.execute(this.sql, this.bindings);
        return rows.map((row) => Object.values(row));
    }
}

class FakeD1 {
    constructor() {
        this.tables = new Map();
    }

    prepare(sql) {
        return new FakeD1PreparedStatement(this, sql);
    }

    async batch(statements) {
        return Promise.all(statements.map((statement) => statement.run()));
    }

    execute(sql, bindings) {
        const normalized = sql.replace(/\s+/g, " ").trim();
        if (/^insert into /i.test(normalized)) return this.insert(normalized, bindings);
        if (/^delete from /i.test(normalized)) return this.remove(normalized, bindings);
        if (/^select /i.test(normalized)) return this.select(normalized, bindings);
        throw new Error(`Fake D1 does not understand SQL: ${normalized}`);
    }

    table(name) {
        if (!this.tables.has(name)) this.tables.set(name, new Map());
        return this.tables.get(name);
    }

    insert(sql, bindings) {
        const [, tableName, columnList] = sql.match(/^insert into ([\w"]+) \(([^)]+)\)/i) ?? [];
        assert(tableName && columnList, `parse insert: ${sql}`);
        const columns = columnList.split(",").map((column) => column.trim().replaceAll('"', ""));
        const row = Object.fromEntries(columns.map((column, index) => [column, bindings[index]]));
        this.table(tableName.replaceAll('"', "")).set(row.id, row);
        return [];
    }

    remove(sql, bindings) {
        const [, quotedTable] = sql.match(/^delete from ([\w"]+)/i) ?? [];
        const table = this.table(quotedTable.replaceAll('"', ""));
        if (!/ where /i.test(sql)) {
            table.clear();
        } else {
            const id = bindings.at(-1);
            table.delete(id);
        }
        return [];
    }

    select(sql, bindings) {
        const [, quotedTable] = sql.match(/ from ([\w"]+)/i) ?? [];
        let rows = [...this.table(quotedTable.replaceAll('"', "")).values()];
        const where = sql.match(/ where (.*?)(?: order by| limit| offset|$)/i)?.[1];
        let consumed = 0;
        if (where) {
            const predicate = compilePredicate(where, bindings);
            consumed = predicate.consumed;
            rows = rows.filter(predicate.test);
        }

        const order = sql.match(/ order by (.*?)(?: limit| offset|$)/i)?.[1];
        if (order) {
            const direction = / desc$/i.test(order) ? -1 : 1;
            const expression = order.replace(/ (?:asc|desc)$/i, "");
            const accessor = compileAccessor(expression, bindings, { index: consumed });
            consumed = accessor.index;
            rows.sort((a, b) =>
                accessor.get(a) < accessor.get(b) ? -direction : accessor.get(a) > accessor.get(b) ? direction : 0
            );
        }

        const limit = sql.match(/ limit \?/i) ? Number(bindings[consumed++]) : Infinity;
        const offset = sql.match(/ offset \?/i) ? Number(bindings[consumed++]) : 0;
        rows = rows.slice(offset, offset + limit);

        if (/count\(\*\)/i.test(sql)) return [{ count: rows.length }];
        return rows.map((row) => ({ data: row.data }));
    }
}

function compileAccessor(expression, bindings, state) {
    const json = expression.match(/^json_extract\([^,]+, \?\)$/i);
    if (json) {
        const path = bindings[state.index++].slice(2).split(".");
        return { get: (row) => path.reduce((value, key) => value?.[key], JSON.parse(row.data)), index: state.index };
    }
    const column = expression.split(".").at(-1).replaceAll('"', "").replace(/[()]/g, "");
    return { get: (row) => row[column], index: state.index };
}

function compilePredicate(source, bindings) {
    const tokens =
        source.match(/json_extract\([^)]*\)|regexp|is null|<>|>=|<=|>|<|=|not|and|or|\?|\(|\)|[\w".]+/gi) ?? [];
    const state = { token: 0, binding: 0 };
    const parseOr = () => {
        let left = parseAnd();
        while (tokens[state.token]?.toLowerCase() === "or") {
            state.token++;
            const right = parseAnd();
            const previous = left;
            left = (row) => previous(row) || right(row);
        }
        return left;
    };
    const parseAnd = () => {
        let left = parseTerm();
        while (tokens[state.token]?.toLowerCase() === "and") {
            state.token++;
            const right = parseTerm();
            const previous = left;
            left = (row) => previous(row) && right(row);
        }
        return left;
    };
    const parseTerm = () => {
        if (tokens[state.token]?.toLowerCase() === "not") {
            state.token++;
            const inner = parseTerm();
            return (row) => !inner(row);
        }
        if (tokens[state.token] === "(") {
            state.token++;
            const inner = parseOr();
            assert.equal(tokens[state.token++], ")");
            return inner;
        }
        const expression = tokens[state.token++];
        const accessor = compileAccessor(expression, bindings, { index: state.binding });
        state.binding = accessor.index;
        const operator = tokens[state.token++].toLowerCase();
        if (operator === "is null") return (row) => accessor.get(row) == null;
        assert.equal(tokens[state.token++], "?");
        const expected = bindings[state.binding++];
        if (operator === "regexp") return (row) => new RegExp(expected).test(accessor.get(row));
        return (row) =>
            ({
                "=": accessor.get(row) === expected,
                "<>": accessor.get(row) !== expected,
                ">": accessor.get(row) > expected,
                ">=": accessor.get(row) >= expected,
                "<": accessor.get(row) < expected,
                "<=": accessor.get(row) <= expected,
            }[operator]);
    };
    const test = parseOr();
    assert.equal(state.token, tokens.length, `unparsed predicate tokens in ${source}`);
    return { test, consumed: state.binding };
}

const temp = await mkdtemp(join(tmpdir(), "padloc-d1-query-"));
try {
    const shim = join(temp, "core-shim.mjs");
    await writeFile(
        shim,
        `
export class Storable {}
export class Err extends Error { constructor(code, message) { super(message); this.code = code; } }
export const ErrorCode = { NOT_FOUND: "not_found", ENCODING_ERROR: "encoding_error", ACCOUNT_EXISTS: "account_exists", SERVER_ERROR: "server_error" };
export const hexToBytes = value => Uint8Array.from(value.match(/../g).map(byte => parseInt(byte, 16)));
`
    );
    const outfile = join(temp, "d1-storage.mjs");
    await build({
        entryPoints: [new URL("../src/storage/d1.ts", import.meta.url).pathname],
        outfile,
        bundle: true,
        format: "esm",
        platform: "node",
        plugins: [
            {
                name: "core-shim",
                setup(buildApi) {
                    buildApi.onResolve({ filter: /^@padloc\/core\/src\/(?:storage|error|encoding)$/ }, () => ({
                        path: shim,
                    }));
                },
            },
        ],
    });
    const { D1Storage } = await import(`${pathToFileURL(outfile)}?${Date.now()}`);
    const d1 = new FakeD1();
    const storage = new D1Storage(d1);
    const records = [
        { id: "a", email: "amy@example.test", profile: { tier: "pro", score: 9, region: "eu" } },
        { id: "b", email: "bob@example.test", profile: { tier: "free", score: 3, region: "us" } },
        { id: "c", email: "cy@example.test", profile: { tier: "pro", score: 7, region: "us" } },
        { id: "d", email: "dee@example.test", profile: { tier: "pro", score: 5, region: "ap" } },
    ].map((raw) => new AccountRecord().fromRaw(raw));
    for (const record of records) await storage.save(record);

    const query = {
        op: "and",
        queries: [
            { path: "profile.tier", value: "pro" },
            {
                op: "or",
                queries: [
                    { path: "profile.score", op: "gte", value: 7 },
                    { path: "profile.region", value: "ap" },
                ],
            },
            { op: "not", query: { path: "email", op: "regex", value: "^amy" } },
        ],
    };
    assert.deepEqual(
        (await storage.list(AccountRecord, { query, orderBy: "profile.score", orderByDirection: "desc" })).map(
            (x) => x.id
        ),
        ["c", "d"]
    );
    assert.equal(await storage.count(AccountRecord, query), 2);
    assert.deepEqual(
        (
            await storage.list(AccountRecord, {
                orderBy: "profile.score",
                orderByDirection: "desc",
                offset: 1,
                limit: 2,
            })
        ).map((x) => x.id),
        ["c", "d"]
    );

    const restored = await storage.get(AccountRecord, "b");
    assert.deepEqual(restored.toRaw(), records[1].toRaw(), "serialized nested data round-trips");
    await assert.rejects(storage.get(AccountRecord, "missing"), (error) => error.code === "not_found");
    await storage.delete(restored);
    assert.deepEqual(
        (await storage.list(AccountRecord, { orderBy: "id" })).map((x) => x.id),
        ["a", "c", "d"]
    );
    await storage.clear();
    assert.equal(await storage.count(AccountRecord), 0);
    console.log("D1 query contract: 8 parity vectors passed");
} finally {
    await rm(temp, { recursive: true, force: true });
}
