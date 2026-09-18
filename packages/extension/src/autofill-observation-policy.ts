import { AutofillBrokerObservationState, AutofillBrokerTarget } from "./autofill-broker-protocol";

export interface AutofillObservationStorage {
    get(key: string): Promise<Record<string, unknown>>;
    set(value: Record<string, unknown>): Promise<void>;
}

interface ContaminatedDocument {
    target: AutofillBrokerTarget;
    contaminatedAt: string;
    fieldRefs: string[];
}

const STORAGE_KEY = "pl_agenticAutofillContaminatedDocuments";

export class AutofillObservationLedger {
    private readonly _entries = new Map<string, ContaminatedDocument>();
    private _loaded = false;

    constructor(private readonly _storage: AutofillObservationStorage) {}

    async markPotentiallyPrivate(target: AutofillBrokerTarget, fieldRef: string, now = Date.now()): Promise<void> {
        await this._load();
        const key = documentKey(target.tabId, target.frameId, target.documentId);
        const existing = this._entries.get(key);
        this._entries.set(key, {
            target: cloneTarget(target),
            contaminatedAt: existing?.contaminatedAt || new Date(now).toISOString(),
            fieldRefs: Array.from(new Set([...(existing?.fieldRefs || []), fieldRef])),
        });
        this._trim();
        await this._persist();
    }

    async status(tabId: number, frameId: number, documentId: string): Promise<AutofillBrokerObservationState> {
        await this._load();
        const entry = this._entries.get(documentKey(tabId, frameId, documentId));
        return entry
            ? {
                  documentId,
                  state: "potentially-private",
                  genericObservation: "blocked",
                  reason: "A private field write was attempted; use trusted receipts or obtain a separate disclosure grant",
                  contaminatedAt: entry.contaminatedAt,
              }
            : {
                  documentId,
                  state: "unknown",
                  genericObservation: "requires-separate-disclosure",
                  reason: "No current trusted cleanliness proof exists for this document",
              };
    }

    async clearTab(tabId: number): Promise<void> {
        await this._load();
        for (const [key, entry] of this._entries.entries()) {
            if (entry.target.tabId === tabId) this._entries.delete(key);
        }
        await this._persist();
    }

    private async _load(): Promise<void> {
        if (this._loaded) return;
        this._loaded = true;
        const stored = (await this._storage.get(STORAGE_KEY))[STORAGE_KEY];
        if (!Array.isArray(stored)) return;
        for (const candidate of stored) {
            if (!isContaminatedDocument(candidate)) continue;
            this._entries.set(
                documentKey(candidate.target.tabId, candidate.target.frameId, candidate.target.documentId),
                candidate
            );
        }
        this._trim();
    }

    private _trim(): void {
        const entries = Array.from(this._entries.values())
            .sort((left, right) => Date.parse(right.contaminatedAt) - Date.parse(left.contaminatedAt))
            .slice(0, 64);
        this._entries.clear();
        for (const entry of entries) {
            this._entries.set(documentKey(entry.target.tabId, entry.target.frameId, entry.target.documentId), entry);
        }
    }

    private async _persist(): Promise<void> {
        await this._storage.set({ [STORAGE_KEY]: Array.from(this._entries.values()) });
    }
}

function isContaminatedDocument(value: unknown): value is ContaminatedDocument {
    if (!value || typeof value !== "object") return false;
    const candidate = value as ContaminatedDocument;
    return Boolean(
        candidate.target &&
            Number.isInteger(candidate.target.tabId) &&
            Number.isInteger(candidate.target.frameId) &&
            candidate.target.documentId &&
            isExactHttpOrigin(candidate.target.topOrigin) &&
            isExactHttpOrigin(candidate.target.frameOrigin) &&
            Number.isFinite(Date.parse(candidate.contaminatedAt)) &&
            Array.isArray(candidate.fieldRefs) &&
            candidate.fieldRefs.every((fieldRef) => typeof fieldRef === "string")
    );
}

function isExactHttpOrigin(value: string): boolean {
    try {
        const url = new URL(value);
        return url.origin === value && url.origin !== "null" && (url.protocol === "https:" || url.protocol === "http:");
    } catch {
        return false;
    }
}

function documentKey(tabId: number, frameId: number, documentId: string): string {
    return `${tabId}:${frameId}:${documentId}`;
}

function cloneTarget(target: AutofillBrokerTarget): AutofillBrokerTarget {
    return { ...target };
}
