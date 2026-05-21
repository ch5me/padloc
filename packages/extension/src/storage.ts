import { Storage, Storable, StorableConstructor, StorageListOptions, StorageQuery } from "@padloc/core/src/storage";
import { Err, ErrorCode } from "@padloc/core/src/error";
import { bytesToBase64, base64ToBytes } from "@padloc/core/src/encoding";
import { browser } from "webextension-polyfill-ts";

type StorageArea = {
    get(keys?: string | string[] | Record<string, unknown> | null): Promise<Record<string, unknown>>;
    set(items: Record<string, unknown>): Promise<void>;
    remove(keys: string | string[]): Promise<void>;
};

type SessionStorageArea = StorageArea & {
    setAccessLevel?: (options: { accessLevel: "TRUSTED_CONTEXTS" | "TRUSTED_AND_UNTRUSTED_CONTEXTS" }) => Promise<void>;
};

interface SessionMasterKeyRecord {
    accountId: string;
    sessionId: string;
    masterKey: string;
}

const sessionMasterKeyStorageKey = "session_master_key";

function getSessionStorageArea(): SessionStorageArea {
    const storage = browser.storage as typeof browser.storage & { session?: SessionStorageArea };
    if (storage.session) {
        return storage.session;
    }

    return (chrome as typeof chrome & { storage?: { session?: SessionStorageArea } }).storage
        ?.session as SessionStorageArea;
}

export async function configureSessionStorage() {
    await getSessionStorageArea().setAccessLevel?.({ accessLevel: "TRUSTED_CONTEXTS" });
}

export async function saveSessionMasterKey(opts: { accountId: string; sessionId: string; masterKey: Uint8Array }) {
    const data: SessionMasterKeyRecord = {
        accountId: opts.accountId,
        sessionId: opts.sessionId,
        masterKey: bytesToBase64(opts.masterKey),
    };

    await getSessionStorageArea().set({ [sessionMasterKeyStorageKey]: data });
}

export async function getSessionMasterKey(opts: { accountId?: string; sessionId?: string } = {}) {
    const data = await getSessionStorageArea().get(sessionMasterKeyStorageKey);
    const stored = data[sessionMasterKeyStorageKey] as SessionMasterKeyRecord | undefined;

    if (!stored) {
        return null;
    }

    if ((opts.accountId && stored.accountId !== opts.accountId) || (opts.sessionId && stored.sessionId !== opts.sessionId)) {
        return null;
    }

    return base64ToBytes(stored.masterKey);
}

export async function clearSessionMasterKey() {
    await getSessionStorageArea().remove(sessionMasterKeyStorageKey);
}

export class ExtensionStorage implements Storage {
    async save(s: Storable) {
        const data = { [`${s.kind}_${s.id}`]: s.toRaw() };
        await browser.storage.local.set(data);
    }

    async get<T extends Storable>(cls: T | StorableConstructor<T>, id: string) {
        const s = cls instanceof Storable ? cls : new cls();
        const key = `${s.kind}_${id}`;
        const data = await browser.storage.local.get(key);
        if (!data[key]) {
            throw new Err(ErrorCode.NOT_FOUND);
        }
        return s.fromRaw(data[key]);
    }

    async delete(s: Storable) {
        await browser.storage.local.remove(`${s.kind}_${s.id}`);
    }

    async clear() {
        await browser.storage.local.clear();
    }

    async list<T extends Storable>(_cls: StorableConstructor<T>, _: StorageListOptions): Promise<T[]> {
        throw new Err(ErrorCode.NOT_SUPPORTED);
    }

    async count<T extends Storable>(_cls: StorableConstructor<T>, _: StorageQuery): Promise<number> {
        throw new Err(ErrorCode.NOT_SUPPORTED);
    }
}
