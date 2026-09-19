import {
    AutofillBrokerObservationState,
    AutofillBrokerTarget,
    ExactAutofillBrokerTarget,
    isExactAutofillBrokerTarget,
} from "./autofill-broker-protocol";

export interface AutofillObservationStorage {
    get(key: string): Promise<Record<string, unknown>>;
    set(value: Record<string, unknown>): Promise<void>;
}

interface ObservationEntry {
    target: AutofillBrokerTarget;
    state: "clean" | "potentially-private";
    observationRevision: number;
    genericObservation: "allowed" | "blocked";
    contaminatedAt?: string;
    fieldRefs: string[];
}

const STORAGE_KEY = "pl_agenticAutofillObservationLedger_v2";
const LEGACY_STORAGE_KEY = "pl_agenticAutofillContaminatedDocuments";

export class AutofillObservationLedger {
    private readonly _entries = new Map<string, ObservationEntry>();
    private _loaded = false;

    constructor(private readonly _storage: AutofillObservationStorage) {}

    async markPotentiallyPrivate(target: AutofillBrokerTarget, fieldRef: string, now = Date.now()): Promise<void> {
        if (!fieldRef) throw new Error("Autofill privacy field reference is required");
        await this._load();
        const key = documentKey(target.tabId, target.frameId, target.documentId);
        const existing = this._entries.get(key);
        if (existing && !sameTargetIdentity(existing.target, target)) {
            throw new Error("Autofill observation target mismatch");
        }
        const nextRevision = (existing?.observationRevision || 0) + 1;
        this._entries.set(key, {
            target: cloneTarget(target),
            state: "potentially-private",
            observationRevision: nextRevision,
            genericObservation: "blocked",
            contaminatedAt: existing?.contaminatedAt || new Date(now).toISOString(),
            fieldRefs: Array.from(new Set([...(existing?.fieldRefs || []), fieldRef])),
        });
        this._trim();
        await this._persist();
    }

    /**
     * The reset operation is trusted extension state, not a page-originated
     * hint. Once a value-bearing write happened, the document stays private.
     */
    async reset(target: AutofillBrokerTarget): Promise<AutofillBrokerObservationState> {
        await this._load();
        const key = documentKey(target.tabId, target.frameId, target.documentId);
        const existing = this._entries.get(key);
        if (existing && !sameTargetIdentity(existing.target, target)) {
            throw new Error("Autofill observation reset target mismatch");
        }
        if (existing?.state === "potentially-private") {
            throw new Error("Autofill observation reset cannot clean a private document");
        }
        const entry: ObservationEntry = {
            target: cloneTarget(target),
            state: "clean",
            observationRevision: (existing?.observationRevision || 0) + 1,
            genericObservation: "allowed",
            fieldRefs: [],
        };
        this._entries.set(key, entry);
        this._trim();
        await this._persist();
        return this._statusForEntry(entry);
    }

    async status(
        targetOrTabId: AutofillBrokerTarget | number,
        frameId?: number,
        documentId?: string
    ): Promise<AutofillBrokerObservationState> {
        await this._load();
        const target =
            typeof targetOrTabId === "number"
                ? ({
                      tabId: targetOrTabId,
                      frameId: frameId || 0,
                      documentId: documentId || "",
                      formRef: "",
                      targetRevision: "",
                      topOrigin: "",
                      frameOrigin: "",
                  } as AutofillBrokerTarget)
                : targetOrTabId;
        const entry = this._entries.get(documentKey(target.tabId, target.frameId, target.documentId));
        if (entry && isExactAutofillBrokerTarget(target) && !sameTargetIdentity(entry.target, target)) {
            throw new Error("Autofill observation target mismatch");
        }
        if (!entry) {
            return {
                documentId: target.documentId,
                state: "unknown",
                observationRevision: 0,
                genericObservation: "requires-separate-disclosure",
                reason: "No current trusted cleanliness proof exists for this document",
                ...(isExactAutofillBrokerTarget(target) ? { target } : {}),
            };
        }
        return this._statusForEntry(entry);
    }

    async clearTab(tabId: number): Promise<void> {
        await this._load();
        for (const [key, entry] of this._entries.entries()) {
            if (entry.target.tabId === tabId) this._entries.delete(key);
        }
        await this._persist();
    }

    private _statusForEntry(entry: ObservationEntry): AutofillBrokerObservationState {
        return {
            documentId: entry.target.documentId,
            state: entry.state,
            observationRevision: entry.observationRevision,
            genericObservation: entry.genericObservation,
            reason:
                entry.state === "clean"
                    ? "Trusted extension observation reset established cleanliness"
                    : "A private field write was attempted; use trusted receipts or obtain a separate disclosure grant",
            ...(entry.contaminatedAt ? { contaminatedAt: entry.contaminatedAt } : {}),
            ...(isExactAutofillBrokerTarget(entry.target)
                ? { target: entry.target as ExactAutofillBrokerTarget }
                : {}),
        };
    }

    private async _load(): Promise<void> {
        if (this._loaded) return;
        this._loaded = true;
        const storedValue = (await this._storage.get(STORAGE_KEY))[STORAGE_KEY];
        const legacyValue =
            Array.isArray(storedValue) ? undefined : (await this._storage.get(LEGACY_STORAGE_KEY))[LEGACY_STORAGE_KEY];
        const stored = Array.isArray(storedValue) ? storedValue : legacyValue;
        if (!Array.isArray(stored)) return;
        for (const candidate of stored) {
            const entry = isObservationEntry(candidate) ? candidate : migrateLegacyEntry(candidate);
            if (!entry) continue;
            this._entries.set(
                documentKey(entry.target.tabId, entry.target.frameId, entry.target.documentId),
                entry
            );
        }
        this._trim();
    }

    private _trim(): void {
        const entries = Array.from(this._entries.values())
            .sort((left, right) => right.observationRevision - left.observationRevision)
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

function isObservationEntry(value: unknown): value is ObservationEntry {
    if (!value || typeof value !== "object" || Array.isArray(value)) return false;
    const candidate = value as ObservationEntry;
    return Boolean(
        candidate.target &&
            Number.isInteger(candidate.target.tabId) &&
            Number.isInteger(candidate.target.frameId) &&
            typeof candidate.target.documentId === "string" &&
            (candidate.state === "clean" || candidate.state === "potentially-private") &&
            Number.isInteger(candidate.observationRevision) &&
            candidate.observationRevision >= 0 &&
            (candidate.genericObservation === "allowed" || candidate.genericObservation === "blocked") &&
            Array.isArray(candidate.fieldRefs) &&
            candidate.fieldRefs.every((fieldRef) => typeof fieldRef === "string") &&
            (!candidate.contaminatedAt || Number.isFinite(Date.parse(candidate.contaminatedAt)))
    );
}

function migrateLegacyEntry(value: unknown): ObservationEntry | null {
    if (!value || typeof value !== "object" || Array.isArray(value)) return null;
    const candidate = value as {
        target?: AutofillBrokerTarget;
        contaminatedAt?: string;
        fieldRefs?: string[];
    };
    if (
        !candidate.target ||
        !Number.isInteger(candidate.target.tabId) ||
        !Number.isInteger(candidate.target.frameId) ||
        typeof candidate.target.documentId !== "string" ||
        !Array.isArray(candidate.fieldRefs) ||
        !candidate.fieldRefs.every((fieldRef) => typeof fieldRef === "string")
    ) {
        return null;
    }
    return {
        target: cloneTarget(candidate.target),
        state: "potentially-private",
        observationRevision: 1,
        genericObservation: "blocked",
        contaminatedAt:
            typeof candidate.contaminatedAt === "string" && Number.isFinite(Date.parse(candidate.contaminatedAt))
                ? candidate.contaminatedAt
                : new Date(0).toISOString(),
        fieldRefs: [...candidate.fieldRefs],
    };
}

function documentKey(tabId: number, frameId: number, documentId: string): string {
    return `${tabId}:${frameId}:${documentId}`;
}

function cloneTarget(target: AutofillBrokerTarget): AutofillBrokerTarget {
    return { ...target };
}

function sameTargetIdentity(left: AutofillBrokerTarget, right: AutofillBrokerTarget): boolean {
    return (
        left.tabId === right.tabId &&
        left.frameId === right.frameId &&
        left.documentId === right.documentId &&
        left.formRef === right.formRef &&
        left.targetRevision === right.targetRevision &&
        left.topOrigin === right.topOrigin &&
        left.frameOrigin === right.frameOrigin &&
        left.origin === right.origin &&
        left.sessionId === right.sessionId
    );
}
