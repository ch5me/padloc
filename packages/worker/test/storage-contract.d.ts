// Ambient module declarations for optional test dependencies.
// Used by storage-contract.ts for local D1 testing with Miniflare.

declare module "miniflare" {
    export class D1Database {
        exec(sql: string): Promise<void>;
        prepare: (sql: string) => {
            bind: (...args: unknown[]) => {
                run: () => Promise<unknown>;
                first: <T>() => Promise<T | null>;
            };
        };
    }
    export class D1DatabaseAPI {
        constructor(db: unknown);
    }
}

declare module "better-sqlite3" {
    class Database {
        constructor(path: string);
        exec(sql: string): void;
        close(): void;
        prepare(sql: string): unknown;
    }
    export default Database;
}
