export const PASSKEY_PROTOCOL_VERSION = 1 as const;
export const PASSKEY_PAGE_MESSAGE_SOURCE = "padloc-passkey-page";
export const PASSKEY_EXTENSION_MESSAGE_SOURCE = "padloc-passkey-extension";
const MAX_PASSKEY_REQUEST_JSON_LENGTH = 256 * 1024;

export type PasskeyOperation = "create" | "get";

export interface SerializedBuffer {
    __padlocWebAuthnType: "buffer";
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
        return { __padlocWebAuthnType: "buffer", base64url: encodeBase64Url(new Uint8Array(value)) };
    }
    if (ArrayBuffer.isView(value)) {
        const view = value as ArrayBufferView;
        return {
            __padlocWebAuthnType: "buffer",
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
        if (record.__padlocWebAuthnType === "buffer" && typeof record.base64url === "string") {
            return decodeBase64Url(record.base64url);
        }
        const deserialized: Record<string, unknown> = {};
        for (const [key, entry] of Object.entries(record)) deserialized[key] = deserializeWebAuthnValue(entry);
        return deserialized;
    }
    return value;
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
        credential.rawId.__padlocWebAuthnType === "buffer" &&
        typeof credential.rawId.base64url === "string" &&
        !!credential.response &&
        typeof credential.response === "object"
    );
}
