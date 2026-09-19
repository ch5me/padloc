export const PASSKEY_PROTOCOL_VERSION = 1 as const;
export const PASSKEY_PAGE_MESSAGE_SOURCE = "elf-vault-passkey-page";
export const PASSKEY_EXTENSION_MESSAGE_SOURCE = "elf-vault-passkey-extension";
const MAX_PASSKEY_REQUEST_JSON_LENGTH = 256 * 1024;
export const PASSKEY_MIN_TTL_MS = 1_000;
export const PASSKEY_MAX_TTL_MS = 120_000;

export type PasskeyOperation = "create" | "get";

export interface SerializedBuffer {
    __elfVaultWebAuthnType: "buffer";
    base64url: string;
}

export interface PagePasskeyRequest {
    protocolVersion: typeof PASSKEY_PROTOCOL_VERSION;
    requestId: string;
    operation: PasskeyOperation;
    mediation?: CredentialMediationRequirement;
    options: Record<string, unknown>;
}

export interface PagePasskeyMessage {
    source: typeof PASSKEY_PAGE_MESSAGE_SOURCE;
    kind: "request";
    detail: PagePasskeyRequest;
}

export interface PagePasskeyCancelMessage {
    source: typeof PASSKEY_PAGE_MESSAGE_SOURCE;
    kind: "cancel";
    detail: {
        protocolVersion: typeof PASSKEY_PROTOCOL_VERSION;
        requestId: string;
    };
}

export interface ExtensionPasskeyMessage {
    source: typeof PASSKEY_EXTENSION_MESSAGE_SOURCE;
    kind: "result";
    detail: PasskeyResult;
}

export interface PasskeyRuntimeRequest extends PagePasskeyRequest {
    type: "passkeyRequest";
    origin: string;
    flowId: string;
    nonce: string;
    ttlMs: number;
    topOrigin: string;
    rpId: string;
    target: {
        frameId: 0;
        origin: string;
        topOrigin: string;
        documentId: string;
    };
}

export interface SerializedPublicKeyCredential {
    id: string;
    type: "public-key";
    rawId: SerializedBuffer;
    authenticatorAttachment?: string | null;
    response: Record<string, unknown>;
    clientExtensionResults?: Record<string, unknown>;
}

export type PasskeyResult =
    | {
          type: "passkeyResult";
          protocolVersion: typeof PASSKEY_PROTOCOL_VERSION;
          requestId: string;
          outcome: "credential";
          credential: SerializedPublicKeyCredential;
      }
    | {
          type: "passkeyResult";
          protocolVersion: typeof PASSKEY_PROTOCOL_VERSION;
          requestId: string;
          outcome: "error";
          error: { name: string; message: string };
      }
    | {
          type: "passkeyResult";
          protocolVersion: typeof PASSKEY_PROTOCOL_VERSION;
          requestId: string;
          outcome: "fallback";
          reason?: string;
      };

function encodeBase64Url(bytes: Uint8Array): string {
    let binary = "";
    for (const byte of bytes) binary += String.fromCharCode(byte);
    return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
}

function decodeBase64Url(value: string): ArrayBuffer {
    const padded = value
        .replace(/-/g, "+")
        .replace(/_/g, "/")
        .padEnd(Math.ceil(value.length / 4) * 4, "=");
    const binary = atob(padded);
    const bytes = new Uint8Array(binary.length);
    for (let index = 0; index < binary.length; index++) bytes[index] = binary.charCodeAt(index);
    return bytes.buffer;
}

export function serializeWebAuthnValue(value: unknown, seen = new WeakSet<object>()): unknown {
    if (value instanceof ArrayBuffer) {
        return { __elfVaultWebAuthnType: "buffer", base64url: encodeBase64Url(new Uint8Array(value)) };
    }
    if (ArrayBuffer.isView(value)) {
        const view = value as ArrayBufferView;
        return {
            __elfVaultWebAuthnType: "buffer",
            base64url: encodeBase64Url(new Uint8Array(view.buffer, view.byteOffset, view.byteLength)),
        };
    }
    if (Array.isArray(value)) return value.map((entry) => serializeWebAuthnValue(entry, seen));
    if (value && typeof value === "object") {
        if (seen.has(value as object)) throw new TypeError("WebAuthn options must not contain cycles");
        seen.add(value as object);
        const serialized: Record<string, unknown> = {};
        for (const [key, entry] of Object.entries(value as Record<string, unknown>)) {
            if (entry !== undefined && typeof entry !== "function" && typeof entry !== "symbol") {
                serialized[key] = serializeWebAuthnValue(entry, seen);
            }
        }
        seen.delete(value as object);
        return serialized;
    }
    return value;
}

export function deserializeWebAuthnValue(value: unknown): unknown {
    if (Array.isArray(value)) return value.map(deserializeWebAuthnValue);
    if (value && typeof value === "object") {
        const record = value as Record<string, unknown>;
        if (record.__elfVaultWebAuthnType === "buffer" && typeof record.base64url === "string") {
            return decodeBase64Url(record.base64url);
        }
        const deserialized: Record<string, unknown> = {};
        for (const [key, entry] of Object.entries(record)) deserialized[key] = deserializeWebAuthnValue(entry);
        return deserialized;
    }
    return value;
}

export function passkeyRequestTtlMs(options: Record<string, unknown>): number {
    const requested = Number(options.timeout);
    if (!Number.isFinite(requested) || requested <= 0) return 60_000;
    return Math.min(Math.max(Math.floor(requested), PASSKEY_MIN_TTL_MS), PASSKEY_MAX_TTL_MS);
}

/**
 * Resolve the RP ID before the request crosses into the extension worker. The
 * page supplies the WebAuthn options, but the origin comes from the isolated
 * bridge and is revalidated again by the worker/provider.
 */
export function derivePasskeyRpId(
    operation: PasskeyOperation,
    options: Record<string, unknown>,
    origin: string
): string | null {
    const requested =
        operation === "get"
            ? options.rpId
            : options.rp && typeof options.rp === "object" && !Array.isArray(options.rp)
            ? (options.rp as Record<string, unknown>).id
            : undefined;
    if (typeof requested !== "undefined" && typeof requested !== "string") return null;
    if (typeof requested === "string" && requested.length === 0) return null;
    const fallback = typeof requested === "string" ? requested : safeOriginHost(origin);
    if (!fallback) return null;
    const normalized = fallback.toLowerCase().replace(/\.$/, "");
    return normalized && normalized.length <= 253 && !/[\s/:\\]/.test(normalized) ? normalized : null;
}

export function isPasskeyRuntimeRequest(value: unknown): value is PasskeyRuntimeRequest {
    if (!value || typeof value !== "object") return false;
    if (!isPagePasskeyRequest(value)) return false;
    const request = value as PasskeyRuntimeRequest;
    if (
        typeof request.origin !== "string" ||
        typeof request.flowId !== "string" ||
        typeof request.nonce !== "string" ||
        typeof request.topOrigin !== "string" ||
        typeof request.rpId !== "string" ||
        !Number.isInteger(request.ttlMs) ||
        request.ttlMs < PASSKEY_MIN_TTL_MS ||
        request.ttlMs > PASSKEY_MAX_TTL_MS
    ) {
        return false;
    }
    if (!isExactHttpOrigin(request.origin) || request.topOrigin !== request.origin) return false;
    const target = request.target;
    return (
        !!target &&
        target.frameId === 0 &&
        target.origin === request.origin &&
        target.topOrigin === request.topOrigin &&
        typeof target.documentId === "string" &&
        target.documentId.length > 0 &&
        target.documentId.length <= 256 &&
        !/[\u0000-\u001f\u007f]/.test(target.documentId) &&
        request.flowId.length > 0 &&
        request.flowId.length <= 256 &&
        request.nonce.length > 0 &&
        request.nonce.length <= 256 &&
        request.rpId.length > 0 &&
        request.rpId.length <= 253 &&
        !/[\s/:\\]/.test(request.rpId) &&
        request.rpId === request.rpId.toLowerCase()
    );
}

export function isPagePasskeyRequest(value: unknown): value is PagePasskeyRequest {
    if (!value || typeof value !== "object") return false;
    const request = value as Partial<PagePasskeyRequest>;
    const shapeValid =
        request.protocolVersion === PASSKEY_PROTOCOL_VERSION &&
        typeof request.requestId === "string" &&
        request.requestId.length > 0 &&
        request.requestId.length <= 128 &&
        (request.operation === "create" || request.operation === "get") &&
        (typeof request.mediation === "undefined" ||
            request.mediation === "silent" ||
            request.mediation === "optional" ||
            request.mediation === "required" ||
            request.mediation === "conditional") &&
        !!request.options &&
        typeof request.options === "object" &&
        !Array.isArray(request.options);
    if (!shapeValid) return false;
    try {
        return JSON.stringify(request).length <= MAX_PASSKEY_REQUEST_JSON_LENGTH;
    } catch {
        return false;
    }
}

function safeOriginHost(origin: string): string | null {
    try {
        const parsed = new URL(origin);
        return parsed.hostname.toLowerCase().replace(/\.$/, "");
    } catch {
        return null;
    }
}

function isExactHttpOrigin(origin: string): boolean {
    try {
        const parsed = new URL(origin);
        const host = parsed.hostname.toLowerCase().replace(/\.$/, "");
        const loopback = host === "localhost" || host === "127.0.0.1" || host === "[::1]";
        return parsed.origin === origin && (parsed.protocol === "https:" || (parsed.protocol === "http:" && loopback));
    } catch {
        return false;
    }
}

export function isPagePasskeyCancellation(value: unknown): value is PagePasskeyCancelMessage["detail"] {
    if (!value || typeof value !== "object") return false;
    const cancellation = value as PagePasskeyCancelMessage["detail"];
    return (
        cancellation.protocolVersion === PASSKEY_PROTOCOL_VERSION &&
        typeof cancellation.requestId === "string" &&
        cancellation.requestId.length > 0 &&
        cancellation.requestId.length <= 128
    );
}

export function isPasskeyResult(value: unknown, requestId?: string): value is PasskeyResult {
    if (!value || typeof value !== "object") return false;
    const result = value as Partial<PasskeyResult>;
    const envelopeValid =
        result.type === "passkeyResult" &&
        result.protocolVersion === PASSKEY_PROTOCOL_VERSION &&
        typeof result.requestId === "string" &&
        (!requestId || result.requestId === requestId) &&
        (result.outcome === "credential" || result.outcome === "error" || result.outcome === "fallback");
    if (!envelopeValid) return false;
    if (result.outcome === "fallback") return true;
    if (result.outcome === "error") {
        const error = (result as any).error;
        return !!error && typeof error.name === "string" && typeof error.message === "string";
    }
    const credential = (result as any).credential;
    return (
        !!credential &&
        typeof credential.id === "string" &&
        credential.type === "public-key" &&
        !!credential.rawId &&
        credential.rawId.__elfVaultWebAuthnType === "buffer" &&
        typeof credential.rawId.base64url === "string" &&
        !!credential.response &&
        typeof credential.response === "object"
    );
}
