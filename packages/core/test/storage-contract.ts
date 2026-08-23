import { strict as assert } from "assert";
import { suite, test } from "mocha";
import { Err, ErrorCode } from "../src/error";
import { filterByQuery, MemoryStorage, sortBy, Storable, Storage, StorageEvent, StorageQuery } from "../src/storage";

class StorageRecord extends Storable {
    id = "";
    name = "";
    score: number | null = null;
    active = false;
    profile: { rank: number; label: string | null } = { rank: 0, label: null };

    constructor(values: Partial<StorageRecord> = {}) {
        super();
        Object.assign(this, values);
    }
}

const records = [
    new StorageRecord({
        id: "alpha",
        name: "Alpha",
        score: 0,
        active: true,
        profile: { rank: 3, label: null },
    }),
    new StorageRecord({
        id: "bravo",
        name: "bravo",
        score: 10,
        active: false,
        profile: { rank: 1, label: "second" },
    }),
    new StorageRecord({
        id: "charlie",
        name: "Charlie",
        score: null,
        active: true,
        profile: { rank: 2, label: "third" },
    }),
];

function ids(values: StorageRecord[]) {
    return values.map(({ id }) => id);
}

/**
 * Registers the reusable storage behavior contract. Other storage backends can
 * invoke this with their own isolated factory and compare directly with the
 * MemoryStorage authority below.
 */
export function storageContract(name: string, createStorage: () => Storage) {
    suite(name, () => {
        test("supports create, get, update, delete, and clear", async () => {
            const storage = createStorage();
            const created = new StorageRecord(records[0].toRaw());

            await storage.save(created);
            const loaded = await storage.get(StorageRecord, created.id);
            assert.deepEqual(loaded.toRaw(), created.toRaw());
            assert.notEqual(loaded, created, "stored values are returned as fresh instances");

            created.name = "Updated";
            await storage.save(created);
            assert.equal((await storage.get(StorageRecord, created.id)).name, "Updated");
            assert.equal(await storage.count(StorageRecord), 1);

            await storage.delete(created);
            await assert.rejects(
                storage.get(StorageRecord, created.id),
                (error: Err) => error instanceof Err && error.code === ErrorCode.NOT_FOUND
            );

            await Promise.all(records.map((record) => storage.save(record)));
            await storage.clear();
            assert.deepEqual(await storage.list(StorageRecord), []);
        });

        test("lists and counts records using nested fields, nulls, and boolean values", async () => {
            const storage = createStorage();
            await Promise.all(records.map((record) => storage.save(record)));

            assert.deepEqual(ids(await storage.list(StorageRecord)), ["alpha", "bravo", "charlie"]);
            assert.equal(await storage.count(StorageRecord), 3);
            assert.deepEqual(
                ids(await storage.list(StorageRecord, { query: { path: "profile.label", value: null } })),
                ["alpha"]
            );
            assert.deepEqual(ids(await storage.list(StorageRecord, { query: { path: "active", value: false } })), [
                "bravo",
            ]);
            assert.equal(await storage.count(StorageRecord, { path: "profile.rank", value: 2, op: "gte" }), 2);
        });

        test("sorts before applying MemoryStorage pagination semantics", async () => {
            const storage = createStorage();
            await Promise.all(records.map((record) => storage.save(record)));

            assert.deepEqual(
                ids(await storage.list(StorageRecord, { orderBy: "profile.rank", orderByDirection: "asc" })),
                ["bravo", "charlie", "alpha"]
            );
            assert.deepEqual(
                ids(
                    await storage.list(StorageRecord, {
                        orderBy: "profile.rank",
                        orderByDirection: "desc",
                        limit: 2,
                    })
                ),
                ["alpha", "bravo"]
            );
            assert.deepEqual(
                ids(await storage.list(StorageRecord, { offset: 1, limit: 2 })),
                ["bravo"],
                "MemoryStorage stops collecting at limit before applying offset"
            );
        });
    });
}

suite("storage query vectors", () => {
    const subject = {
        name: "Alpha-10",
        score: 10,
        zero: 0,
        nothing: null,
        nested: { rank: 2, label: "Team Red" },
    };

    const cases: Array<[string, StorageQuery, boolean]> = [
        ["implicit equality", { path: "score", value: 10 }, true],
        ["nested equality", { path: "nested.rank", value: 2 }, true],
        ["null equality", { path: "nothing", value: null }, true],
        ["inequality", { op: "ne", path: "nothing", value: null }, false],
        ["greater than", { op: "gt", path: "score", value: 9 }, true],
        ["greater than or equal", { op: "gte", path: "score", value: 10 }, true],
        ["less than", { op: "lt", path: "score", value: 11 }, true],
        ["less than or equal", { op: "lte", path: "score", value: 10 }, true],
        ["falsy comparison operand", { op: "gte", path: "zero", value: 0 }, false],
        ["regular expression", { op: "regex", path: "nested.label", value: "^Team" }, true],
        ["negative regular expression", { op: "negex", path: "name", value: "^Beta" }, true],
        [
            "and",
            {
                op: "and",
                queries: [
                    { path: "score", value: 10 },
                    { op: "regex", path: "name", value: "Alpha" },
                ],
            },
            true,
        ],
        [
            "or",
            {
                op: "or",
                queries: [
                    { path: "score", value: 11 },
                    { path: "nested.rank", value: 2 },
                ],
            },
            true,
        ],
        ["not", { op: "not", query: { path: "name", value: "Beta" } }, true],
    ];

    for (const [name, query, expected] of cases) {
        test(name, () => assert.equal(filterByQuery(subject, query), expected));
    }
});

suite("storage sort vectors", () => {
    test("sorts nested values in both directions and preserves ties", () => {
        const values = [
            { id: "a", nested: { rank: 2 } },
            { id: "b", nested: { rank: 1 } },
            { id: "c", nested: { rank: 2 } },
        ];

        assert.deepEqual(
            values
                .slice()
                .sort(sortBy("nested.rank", "asc"))
                .map(({ id }) => id),
            ["b", "a", "c"]
        );
        assert.deepEqual(
            values
                .slice()
                .sort(sortBy("nested.rank", "desc"))
                .map(({ id }) => id),
            ["a", "c", "b"]
        );
    });
});

suite("storage event vectors", () => {
    test("represent create, get, update, and delete payloads", () => {
        const current = new StorageRecord({ id: "event", name: "After" });
        const before = new StorageRecord({ id: "event", name: "Before" });
        const events: StorageEvent[] = [
            { action: "create", object: current },
            { action: "get", object: current },
            { action: "update", object: current, before },
            { action: "delete", object: current },
        ];

        assert.deepEqual(
            events.map(({ action, object, before: previous }) => ({
                action,
                id: object.id,
                before: previous && previous.toRaw(),
            })),
            [
                { action: "create", id: "event", before: undefined },
                { action: "get", id: "event", before: undefined },
                { action: "update", id: "event", before: before.toRaw() },
                { action: "delete", id: "event", before: undefined },
            ]
        );
    });
});

storageContract("MemoryStorage contract", () => new MemoryStorage());
