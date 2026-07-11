/**
 * Coordinates the short-lived user-approval phase of a WebAuthn ceremony.
 *
 * The coordinator intentionally stores only verified, display-safe metadata. The
 * WebAuthn request, challenge, credential identifiers, and key material must stay
 * with the ceremony owner and must never be passed into this class.
 */

export type PasskeyApprovalOperation = "create" | "get";

export interface VerifiedPasskeyApprovalMetadata {
    requestId: string;
    operation: PasskeyApprovalOperation;
    origin: string;
    rpId: string;
    rpName?: string;
    userName?: string;
    userDisplayName?: string;
}

/** Safe to return only to the configured extension approval page. */
export interface PasskeyApprovalPrompt {
    requestId: string;
    promptNonce: string;
    operation: PasskeyApprovalOperation;
    origin: string;
    rpId: string;
    rpName: string;
    userName?: string;
    userDisplayName?: string;
    expiresAt: number;
}

export type PasskeyApprovalResolution =
    | { requestId: string; outcome: "approved"; userVerified: true }
    | { requestId: string; outcome: "dismissed" | "expired" | "cancelled" };

export type PasskeyApprovalReply = (resolution: Readonly<PasskeyApprovalResolution>) => void;

export interface PasskeyApprovalCommand {
    requestId: string;
    promptNonce: string;
}

export interface PasskeyApproveCommand extends PasskeyApprovalCommand {
    userVerified: true;
}

type TimerHandle = unknown;

export interface PasskeyApprovalCoordinatorOptions {
    /** Exact extension document URL allowed to retrieve and resolve prompts. */
    approvalUiSenderUrl: string;
    /** Ceremony approval lifetime. Must be between 1 second and 2 minutes. */
    ttlMs?: number;
    /** In-memory denial-of-service bound. Must be between 1 and 64. */
    maxPending?: number;
    now?: () => number;
    nonceFactory?: () => string;
    schedule?: (callback: () => void, delayMs: number) => TimerHandle;
    cancelScheduled?: (handle: TimerHandle) => void;
}

interface PendingApproval {
    prompt: Readonly<PasskeyApprovalPrompt>;
    reply: PasskeyApprovalReply;
    expectedSenderUrl: string;
    timer: TimerHandle;
}

const DEFAULT_TTL_MS = 60_000;
const MIN_TTL_MS = 1_000;
const MAX_TTL_MS = 120_000;
const DEFAULT_MAX_PENDING = 16;
const MAX_PENDING_LIMIT = 64;
const MAX_REQUEST_ID_LENGTH = 128;
const MAX_ORIGIN_LENGTH = 2_048;
const MAX_RP_ID_LENGTH = 253;
const MAX_LABEL_LENGTH = 256;
const MIN_NONCE_LENGTH = 22; // At least 128 bits when base64url encoded.
const MAX_NONCE_LENGTH = 256;

function defaultNonceFactory(): string {
    const bytes = new Uint8Array(32);
    const cryptoApi = globalThis.crypto;
    if (!cryptoApi?.getRandomValues) throw new Error("Secure randomness is required for passkey approval");
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
        throw new TypeError("approvalUiSenderUrl must be a valid extension URL");
    }
    if (
        parsed.protocol !== "chrome-extension:" &&
        parsed.protocol !== "moz-extension:" &&
        parsed.protocol !== "safari-web-extension:"
    ) {
        throw new TypeError("approvalUiSenderUrl must identify an extension document");
    }
    // URL fragments are not sent to servers and may be omitted by extension
    // MessageSender implementations. The document path and query stay exact.
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

function boundedLabel(value: string | undefined, field: string): string | undefined {
    if (value === undefined) return undefined;
    if (!value || value.length > MAX_LABEL_LENGTH || /[\u0000-\u001f\u007f]/.test(value)) {
        throw new TypeError(`Invalid ${field}`);
    }
    return value;
}

function validateMetadata(metadata: VerifiedPasskeyApprovalMetadata): VerifiedPasskeyApprovalMetadata {
    if (!metadata.requestId || metadata.requestId.length > MAX_REQUEST_ID_LENGTH) {
        throw new TypeError("Invalid passkey request id");
    }
    if (metadata.operation !== "create" && metadata.operation !== "get") {
        throw new TypeError("Invalid passkey operation");
    }
    if (
        !metadata.rpId ||
        metadata.rpId.length > MAX_RP_ID_LENGTH ||
        /[\s/:\\\u0000-\u001f\u007f]/.test(metadata.rpId)
    ) {
        throw new TypeError("Invalid verified RP ID");
    }

    return {
        requestId: metadata.requestId,
        operation: metadata.operation,
        origin: normalizeVerifiedOrigin(metadata.origin),
        rpId: metadata.rpId,
        rpName: boundedLabel(metadata.rpName, "RP name"),
        userName: boundedLabel(metadata.userName, "user name"),
        userDisplayName: boundedLabel(metadata.userDisplayName, "user display name"),
    };
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

export class PasskeyApprovalCoordinator {
    private readonly _approvalUiSenderUrl: string;
    private readonly _ttlMs: number;
    private readonly _maxPending: number;
    private readonly _now: () => number;
    private readonly _nonceFactory: () => string;
    private readonly _schedule: (callback: () => void, delayMs: number) => TimerHandle;
    private readonly _cancelScheduled: (handle: TimerHandle) => void;
    private readonly _pending = new Map<string, PendingApproval>();

    constructor(options: PasskeyApprovalCoordinatorOptions) {
        this._approvalUiSenderUrl = normalizeExtensionSenderUrl(options.approvalUiSenderUrl);
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

    /**
     * Adds one verified ceremony. The returned handle deliberately excludes the
     * nonce; retrieve the redacted prompt through getPrompt using the trusted UI
     * sender URL.
     */
    begin(
        metadata: VerifiedPasskeyApprovalMetadata,
        reply: PasskeyApprovalReply
    ): Readonly<{ requestId: string; expiresAt: number }> {
        this.expirePending();
        const safe = validateMetadata(metadata);
        if (typeof reply !== "function") throw new TypeError("A passkey approval reply callback is required");
        if (this._pending.has(safe.requestId))
            throw new Error("A passkey approval is already pending for this request");
        if (this._pending.size >= this._maxPending) throw new Error("Too many passkey approvals are pending");

        const promptNonce = validateNonce(this._nonceFactory());
        const expiresAt = this._now() + this._ttlMs;
        const prompt = Object.freeze({
            requestId: safe.requestId,
            promptNonce,
            operation: safe.operation,
            origin: safe.origin,
            rpId: safe.rpId,
            rpName: safe.rpName ?? safe.rpId,
            ...(safe.userName ? { userName: safe.userName } : {}),
            ...(safe.userDisplayName ? { userDisplayName: safe.userDisplayName } : {}),
            expiresAt,
        });
        const entry = {} as PendingApproval;
        entry.prompt = prompt;
        entry.reply = reply;
        entry.expectedSenderUrl = this._approvalUiSenderUrl;
        entry.timer = this._schedule(() => this._expireOne(safe.requestId, entry), this._ttlMs);
        this._pending.set(safe.requestId, entry);
        return Object.freeze({ requestId: safe.requestId, expiresAt });
    }

    /** Returns the oldest live prompt only to the configured extension UI. */
    getPrompt(senderUrl: string, requestId?: string): Readonly<PasskeyApprovalPrompt> | null {
        this.expirePending();
        if (!this._isExpectedSender(senderUrl)) return null;
        if (requestId) return this._pending.get(requestId)?.prompt ?? null;
        return this._pending.values().next().value?.prompt ?? null;
    }

    /** Completes a ceremony only after fresh user verification by the trusted UI. */
    approve(command: PasskeyApproveCommand, senderUrl: string): boolean {
        if (command.userVerified !== true) return false;
        return this._resolve(command, senderUrl, { outcome: "approved", userVerified: true });
    }

    /** Dismissal is capability-checked too, so another extension page cannot cancel a ceremony. */
    dismiss(command: PasskeyApprovalCommand, senderUrl: string): boolean {
        return this._resolve(command, senderUrl, { outcome: "dismissed" });
    }

    /** Trusted ceremony owners can cancel on page abort or port disconnect. */
    cancel(requestId: string): boolean {
        const entry = this._pending.get(requestId);
        if (!entry) return false;
        this._complete(requestId, entry, { requestId, outcome: "cancelled" });
        return true;
    }

    /** Expires all ceremonies whose deadline has elapsed. Useful after worker wake-up. */
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

    /** Cancels every live ceremony and releases timers. */
    dispose(): void {
        for (const requestId of Array.from(this._pending.keys())) this.cancel(requestId);
    }

    private _resolve(
        command: PasskeyApprovalCommand,
        senderUrl: string,
        resolution: { outcome: "approved"; userVerified: true } | { outcome: "dismissed" }
    ): boolean {
        this.expirePending();
        const entry = this._pending.get(command.requestId);
        if (!entry || !this._isExpectedSender(senderUrl)) return false;
        if (!constantTimeEqual(entry.prompt.promptNonce, command.promptNonce)) return false;
        this._complete(command.requestId, entry, { requestId: command.requestId, ...resolution });
        return true;
    }

    private _isExpectedSender(senderUrl: string): boolean {
        try {
            return normalizeExtensionSenderUrl(senderUrl) === this._approvalUiSenderUrl;
        } catch {
            return false;
        }
    }

    private _expireOne(requestId: string, expectedEntry: PendingApproval): void {
        const current = this._pending.get(requestId);
        if (current !== expectedEntry) return;
        const remainingMs = current.prompt.expiresAt - this._now();
        if (remainingMs > 0) {
            // Defend against an early timer or a wall-clock adjustment without
            // allowing a ceremony to lose its expiry timer.
            current.timer = this._schedule(() => this._expireOne(requestId, current), remainingMs);
            return;
        }
        this._complete(requestId, current, { requestId, outcome: "expired" });
    }

    private _complete(requestId: string, entry: PendingApproval, resolution: PasskeyApprovalResolution): void {
        if (this._pending.get(requestId) !== entry) return;
        // Delete before invoking caller code so re-entrant approve/dismiss attempts
        // cannot replay the capability or cause a second completion.
        this._pending.delete(requestId);
        this._cancelScheduled(entry.timer);
        entry.reply(Object.freeze(resolution));
    }
}
