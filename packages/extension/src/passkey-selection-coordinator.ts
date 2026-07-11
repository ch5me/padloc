import type { PasskeySelectionCandidate } from "./passkey-provider-engine";

export interface VerifiedPasskeySelectionMetadata {
    requestId: string;
    origin: string;
    rpId: string;
    candidates: readonly PasskeySelectionCandidate[];
}

export interface PasskeySelectionPrompt extends VerifiedPasskeySelectionMetadata {
    promptNonce: string;
    expiresAt: number;
}

export type PasskeySelectionResolution =
    | { requestId: string; outcome: "selected"; selectionId: string }
    | { requestId: string; outcome: "dismissed" | "expired" | "cancelled" };

export type PasskeySelectionReply = (resolution: Readonly<PasskeySelectionResolution>) => void;

export interface PasskeySelectionCommand {
    requestId: string;
    promptNonce: string;
    selectionId: string;
}

export interface PasskeySelectionCoordinatorOptions {
    selectionUiSenderUrl: string;
    ttlMs?: number;
    maxPending?: number;
    now?: () => number;
    nonceFactory?: () => string;
    schedule?: (callback: () => void, delayMs: number) => unknown;
    cancelScheduled?: (handle: unknown) => void;
}

interface PendingSelection {
    prompt: Readonly<PasskeySelectionPrompt>;
    reply: PasskeySelectionReply;
    timer: unknown;
}

const DEFAULT_TTL_MS = 60_000;
const MIN_TTL_MS = 1_000;
const MAX_TTL_MS = 120_000;
const DEFAULT_MAX_PENDING = 16;
const MAX_PENDING_LIMIT = 64;
const MAX_REQUEST_ID_LENGTH = 128;
const MAX_ORIGIN_LENGTH = 2_048;
const MAX_RP_ID_LENGTH = 253;
const MAX_CANDIDATES = 64;
const MAX_SELECTION_ID_LENGTH = 128;
const MAX_LABEL_LENGTH = 256;
const MIN_NONCE_LENGTH = 22;
const MAX_NONCE_LENGTH = 256;

function defaultNonceFactory(): string {
    const bytes = new Uint8Array(32);
    const cryptoApi = globalThis.crypto;
    if (!cryptoApi?.getRandomValues) throw new Error("Secure randomness is required for passkey selection");
    cryptoApi.getRandomValues(bytes);
    let binary = "";
    for (const byte of bytes) binary += String.fromCharCode(byte);
    return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
}

function normalizeExtensionSenderUrl(value: string): string {
    let parsed: URL;
    try {
        parsed = new URL(value);
    } catch {
        throw new TypeError("selectionUiSenderUrl must be a valid extension URL");
    }
    if (
        parsed.protocol !== "chrome-extension:" &&
        parsed.protocol !== "moz-extension:" &&
        parsed.protocol !== "safari-web-extension:"
    ) {
        throw new TypeError("selectionUiSenderUrl must identify an extension document");
    }
    parsed.hash = "";
    return parsed.href;
}

function normalizeVerifiedOrigin(value: string): string {
    if (!value || value.length > MAX_ORIGIN_LENGTH) throw new TypeError("Invalid verified origin");
    let parsed: URL;
    try {
        parsed = new URL(value);
    } catch {
        throw new TypeError("Invalid verified origin");
    }
    if (parsed.origin === "null" || parsed.origin !== value) throw new TypeError("Invalid verified origin");
    return parsed.origin;
}

function boundedText(value: string, field: string, maxLength: number): string {
    if (!value || value.length > maxLength || /[\u0000-\u001f\u007f]/.test(value)) {
        throw new TypeError(`Invalid ${field}`);
    }
    return value;
}

function validateMetadata(metadata: VerifiedPasskeySelectionMetadata): VerifiedPasskeySelectionMetadata {
    const requestId = boundedText(metadata.requestId, "passkey request id", MAX_REQUEST_ID_LENGTH);
    const rpId = boundedText(metadata.rpId, "verified RP ID", MAX_RP_ID_LENGTH);
    if (/[\s/:\\]/.test(rpId)) throw new TypeError("Invalid verified RP ID");
    if (
        !Array.isArray(metadata.candidates) ||
        metadata.candidates.length < 2 ||
        metadata.candidates.length > MAX_CANDIDATES
    ) {
        throw new TypeError("Passkey selection requires between 2 and 64 candidates");
    }
    const selectionIds = new Set<string>();
    const candidates = metadata.candidates.map((candidate) => {
        const selectionId = boundedText(candidate.selectionId, "selection ID", MAX_SELECTION_ID_LENGTH);
        if (selectionIds.has(selectionId)) throw new TypeError("Duplicate passkey selection ID");
        selectionIds.add(selectionId);
        return Object.freeze({
            selectionId,
            userName: boundedText(candidate.userName, "user name", MAX_LABEL_LENGTH),
            userDisplayName: boundedText(candidate.userDisplayName, "user display name", MAX_LABEL_LENGTH),
        });
    });
    return { requestId, origin: normalizeVerifiedOrigin(metadata.origin), rpId, candidates };
}

function validateNonce(value: string): string {
    if (value.length < MIN_NONCE_LENGTH || value.length > MAX_NONCE_LENGTH || !/^[A-Za-z0-9_-]+$/.test(value)) {
        throw new Error("nonceFactory must return a base64url capability with at least 128 bits of entropy");
    }
    return value;
}

function constantTimeEqual(left: string, right: string): boolean {
    let mismatch = left.length ^ right.length;
    const length = Math.max(left.length, right.length);
    for (let index = 0; index < length; index++) {
        mismatch |= (left.charCodeAt(index) || 0) ^ (right.charCodeAt(index) || 0);
    }
    return mismatch === 0;
}

export class PasskeySelectionCoordinator {
    private readonly _selectionUiSenderUrl: string;
    private readonly _ttlMs: number;
    private readonly _maxPending: number;
    private readonly _now: () => number;
    private readonly _nonceFactory: () => string;
    private readonly _schedule: (callback: () => void, delayMs: number) => unknown;
    private readonly _cancelScheduled: (handle: unknown) => void;
    private readonly _pending = new Map<string, PendingSelection>();

    constructor(options: PasskeySelectionCoordinatorOptions) {
        this._selectionUiSenderUrl = normalizeExtensionSenderUrl(options.selectionUiSenderUrl);
        this._ttlMs = options.ttlMs ?? DEFAULT_TTL_MS;
        this._maxPending = options.maxPending ?? DEFAULT_MAX_PENDING;
        if (!Number.isFinite(this._ttlMs) || this._ttlMs < MIN_TTL_MS || this._ttlMs > MAX_TTL_MS) {
            throw new RangeError(`ttlMs must be between ${MIN_TTL_MS} and ${MAX_TTL_MS}`);
        }
        if (!Number.isInteger(this._maxPending) || this._maxPending < 1 || this._maxPending > MAX_PENDING_LIMIT) {
            throw new RangeError(`maxPending must be between 1 and ${MAX_PENDING_LIMIT}`);
        }
        this._now = options.now ?? Date.now;
        this._nonceFactory = options.nonceFactory ?? defaultNonceFactory;
        this._schedule = options.schedule ?? ((callback, delayMs) => setTimeout(callback, delayMs));
        this._cancelScheduled = options.cancelScheduled ?? ((handle) => clearTimeout(handle as number));
    }

    get pendingCount(): number {
        this.expirePending();
        return this._pending.size;
    }

    begin(metadata: VerifiedPasskeySelectionMetadata, reply: PasskeySelectionReply): void {
        this.expirePending();
        const safe = validateMetadata(metadata);
        if (typeof reply !== "function") throw new TypeError("A passkey selection reply callback is required");
        if (this._pending.has(safe.requestId))
            throw new Error("A passkey selection is already pending for this request");
        if (this._pending.size >= this._maxPending) throw new Error("Too many passkey selections are pending");

        const promptNonce = validateNonce(this._nonceFactory());
        const expiresAt = this._now() + this._ttlMs;
        const prompt = Object.freeze({
            ...safe,
            candidates: Object.freeze([...safe.candidates]),
            promptNonce,
            expiresAt,
        });
        const entry = {} as PendingSelection;
        entry.prompt = prompt;
        entry.reply = reply;
        entry.timer = this._schedule(() => this._expireOne(safe.requestId, entry), this._ttlMs);
        this._pending.set(safe.requestId, entry);
    }

    getPrompt(senderUrl: string, requestId?: string): Readonly<PasskeySelectionPrompt> | null {
        this.expirePending();
        if (!this._isExpectedSender(senderUrl)) return null;
        if (requestId) return this._pending.get(requestId)?.prompt ?? null;
        return this._pending.values().next().value?.prompt ?? null;
    }

    select(command: PasskeySelectionCommand, senderUrl: string): boolean {
        this.expirePending();
        const entry = this._pending.get(command.requestId);
        if (!entry || !this._isExpectedSender(senderUrl)) return false;
        if (!constantTimeEqual(entry.prompt.promptNonce, command.promptNonce)) return false;
        if (
            !entry.prompt.candidates.some((candidate) => constantTimeEqual(candidate.selectionId, command.selectionId))
        ) {
            return false;
        }
        this._complete(command.requestId, entry, {
            requestId: command.requestId,
            outcome: "selected",
            selectionId: command.selectionId,
        });
        return true;
    }

    dismiss(command: Omit<PasskeySelectionCommand, "selectionId">, senderUrl: string): boolean {
        this.expirePending();
        const entry = this._pending.get(command.requestId);
        if (!entry || !this._isExpectedSender(senderUrl)) return false;
        if (!constantTimeEqual(entry.prompt.promptNonce, command.promptNonce)) return false;
        this._complete(command.requestId, entry, { requestId: command.requestId, outcome: "dismissed" });
        return true;
    }

    cancel(requestId: string): boolean {
        const entry = this._pending.get(requestId);
        if (!entry) return false;
        this._complete(requestId, entry, { requestId, outcome: "cancelled" });
        return true;
    }

    expirePending(): number {
        const now = this._now();
        let expired = 0;
        for (const [requestId, entry] of Array.from(this._pending)) {
            if (now >= entry.prompt.expiresAt) {
                this._complete(requestId, entry, { requestId, outcome: "expired" });
                expired++;
            }
        }
        return expired;
    }

    dispose(): void {
        for (const requestId of Array.from(this._pending.keys())) this.cancel(requestId);
    }

    private _isExpectedSender(senderUrl: string): boolean {
        try {
            return normalizeExtensionSenderUrl(senderUrl) === this._selectionUiSenderUrl;
        } catch {
            return false;
        }
    }

    private _expireOne(requestId: string, expectedEntry: PendingSelection): void {
        const current = this._pending.get(requestId);
        if (current !== expectedEntry) return;
        const remainingMs = current.prompt.expiresAt - this._now();
        if (remainingMs > 0) {
            current.timer = this._schedule(() => this._expireOne(requestId, current), remainingMs);
            return;
        }
        this._complete(requestId, current, { requestId, outcome: "expired" });
    }

    private _complete(requestId: string, entry: PendingSelection, resolution: PasskeySelectionResolution): void {
        if (this._pending.get(requestId) !== entry) return;
        this._pending.delete(requestId);
        this._cancelScheduled(entry.timer);
        entry.reply(Object.freeze(resolution));
    }
}
