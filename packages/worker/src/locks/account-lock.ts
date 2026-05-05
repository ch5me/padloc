import { Env } from "../env";

/**
 * AccountLockDO — replaces the in-memory Map-based _requestQueue from
 * packages/core/src/server.ts:2188 with a Durable Object for per-account/
 * per-org request serialization.
 *
 * One DO class keyed by identity string (AccountID or OrgID). Each instance
 * maintains a FIFO deferred queue. acquire() resolves only when the previous
 * caller releases, so RPC callers that "own" the lock hold it until they call
 * release().
 */
export class AccountLockDO {
    private _pending: Promise<void> = Promise.resolve();
    private _release: () => void = () => {};
    private _holder: string | null = null;

    constructor(_state: DurableObjectState, _env: Env) {}

    /**
     * Wait until the previous holder has released the lock, then claim it.
     * Returns when the caller owns the lock.
     *
     * @param jobId Identifier for the lock holder (logging/telemetry).
     * @param ttlMs Maximum hold duration before auto-release.
     */
    async acquire(jobId: string, ttlMs: number): Promise<void> {
        const wait = this._pending;

        let resolveNext: () => void;
        this._pending = new Promise((res) => {
            resolveNext = res;
        });
        this._release = resolveNext!;
        this._holder = jobId;

        const timer = setTimeout(() => {
            if (this._holder === jobId) this._release();
        }, ttlMs);

        await wait;

        clearTimeout(timer);
    }

    /** Release the lock so the next queued caller may proceed. */
    async release(): Promise<void> {
        this._holder = null;
        this._release();
    }

    /** Returns the current holder's jobId or null. */
    async getHolder(): Promise<string | null> {
        return this._holder;
    }

    /**
     * Convenience: acquire, run job inside DO, release. Uses the FIFO
     * pattern — only one job runs at a time per DO instance.
     */
    async acquireAndRun(jobId: string, ttlMs: number, payload?: never): Promise<void>;
    async acquireAndRun(jobId: string, ttlMs: number, payload: Record<string, unknown>): Promise<unknown>;
    async acquireAndRun(jobId: string, ttlMs: number, payload?: Record<string, unknown>): Promise<unknown> {
        await this.acquire(jobId, ttlMs);
        try {
            if (payload) return this.handleJob(payload);
        } finally {
            await this.release();
        }
    }

    protected async handleJob(_payload: Record<string, unknown>): Promise<unknown> {
        return undefined;
    }
}

interface LockTicket {
    release(): Promise<void>;
}

/** Stub returned by DurableObjectNamespace.get() for AccountLockDO. */
interface AccountLockStub {
    acquire(jobId: string, ttlMs: number): Promise<void>;
    release(): Promise<void>;
    getHolder(): Promise<string | null>;
}

async function acquireLock(id: string, lockNamespace: DurableObjectNamespace): Promise<LockTicket> {
    const stub = lockNamespace.get(lockNamespace.idFromName(id)) as unknown as AccountLockStub;
    await stub.acquire(id, 30_000);
    return {
        release: () => stub.release(),
    };
}

/**
 * Acquire locks for given identity IDs in sorted order, execute the callback,
 * and release all locks.
 *
 * Sorted ordering prevents deadlock when two requests touch overlapping
 * identities (e.g. account A + org X vs account B + org X).
 */
export async function withAccountLocks<T>(
    ids: string[],
    lockNamespace: DurableObjectNamespace,
    fn: () => Promise<T>,
): Promise<T> {
    if (ids.length === 0) {
        return fn();
    }
    if (!lockNamespace) {
        throw new Error("ACCOUNT_LOCK durable object namespace not configured");
    }

    const sorted = [...ids].sort();

    const tickets: LockTicket[] = [];
    for (const id of sorted) {
        const ticket = await acquireLock(id, lockNamespace);
        tickets.push(ticket);
    }

    try {
        return await fn();
    } finally {
        const reversed = [...tickets].reverse();
        for (const ticket of reversed) {
            ticket.release().catch(() => {});
        }
    }
}
