import {
    isPagePasskeyCancellation,
    isPagePasskeyRequest,
    isPasskeyResult,
    PASSKEY_EXTENSION_MESSAGE_SOURCE,
    PASSKEY_PAGE_MESSAGE_SOURCE,
    PASSKEY_PROTOCOL_VERSION,
    PasskeyResult,
    derivePasskeyRpId,
    passkeyRequestTtlMs,
} from "./passkey-protocol";

const PASSKEY_DIAGNOSTICS_ENABLED = process.env.PL_PASSKEY_DIAGNOSTICS === "true";

interface RuntimeRequestHandle {
    response: Promise<unknown>;
    cancel(): void;
}

const PASSKEY_DOCUMENT_ID_MARKER = "__elfVaultPasskeyDocumentIdV1";

function bridgeRequestId(): string {
    const randomUUID = (crypto as Crypto & { randomUUID?: () => string }).randomUUID;
    if (typeof randomUUID === "function") return randomUUID.call(crypto);
    const bytes = crypto.getRandomValues(new Uint8Array(16));
    return Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
}

function sendRuntimeMessage(message: unknown, timeoutMs: number): RuntimeRequestHandle {
    const runtime = (
        globalThis as typeof globalThis & {
            chrome: {
                runtime: {
                    lastError?: { message?: string };
                    connect(options: { name: string }): {
                        onMessage: { addListener(listener: (response: unknown) => void): void };
                        onDisconnect: { addListener(listener: () => void): void };
                        postMessage(message: unknown): void;
                        disconnect(): void;
                    };
                };
            };
        }
    ).chrome.runtime;
    let cancel: () => void = () => undefined;
    const response = new Promise((resolve, reject) => {
        let settled = false;
        const port = runtime.connect({ name: "elf-vault-passkey-v1" });
        const finish = (action: () => void) => {
            if (settled) return;
            settled = true;
            clearTimeout(timeout);
            port.disconnect();
            action();
        };
        const timeout = setTimeout(() => {
            finish(() => reject(new Error("Passkey background response timed out")));
        }, timeoutMs);
        port.onMessage.addListener((response: unknown) => finish(() => resolve(response)));
        port.onDisconnect.addListener(() => {
            const error = runtime.lastError;
            finish(() => reject(new Error(error?.message || "Passkey background port disconnected")));
        });
        cancel = () => finish(() => reject(new Error("Passkey request was cancelled")));
        port.postMessage(message);
    });
    return { response, cancel: () => cancel() };
}

function bridgeDocumentId(target: Window): string {
    const existing = (target as any)[PASSKEY_DOCUMENT_ID_MARKER];
    if (typeof existing === "string" && existing.length > 0) return existing;
    const generated = bridgeRequestId();
    try {
        Object.defineProperty(target, PASSKEY_DOCUMENT_ID_MARKER, {
            configurable: false,
            enumerable: false,
            value: generated,
        });
    } catch {
        // The marker is only a same-document hint. The worker still binds tab,
        // frame, URL origin, flow, nonce, and TTL independently.
    }
    return generated;
}

export function installPasskeyContentBridge(target: Window = window): void {
    if (target.top && target.top !== target) return;
    const marker = "__elfVaultPasskeyContentBridgeV1";
    if ((target as any)[marker]) return;
    Object.defineProperty(target, marker, { value: true });
    const pending = new Map<string, { bridgeRequestId: string; cancel(): void }>();

    target.addEventListener("message", ((event: MessageEvent) => {
        if (event.source !== target || event.data?.source !== PASSKEY_PAGE_MESSAGE_SOURCE) {
            return;
        }
        if (event.data?.kind === "cancel") {
            if (!isPagePasskeyCancellation(event.data.detail)) return;
            const active = pending.get(event.data.detail.requestId);
            if (!active) return;
            pending.delete(event.data.detail.requestId);
            active.cancel();
            return;
        }
        if (event.data?.kind !== "request") return;
        const detail = event.data.detail;
        if (!isPagePasskeyRequest(detail)) return;
        if (pending.has(detail.requestId)) return;
        const runtimeRequestId = bridgeRequestId();
        if (PASSKEY_DIAGNOSTICS_ENABLED) {
            console.debug("[Elf Vault passkey] forwarding request", runtimeRequestId, detail.operation);
        }

        const timeoutMs = passkeyRequestTtlMs(detail.options);
        const topOrigin = target.location.origin;
        const documentId = bridgeDocumentId(target);
        const rpId = derivePasskeyRpId(detail.operation, detail.options, topOrigin);
        const runtimeRequest = sendRuntimeMessage(
            {
                type: "passkeyRequest",
                protocolVersion: PASSKEY_PROTOCOL_VERSION,
                requestId: runtimeRequestId,
                operation: detail.operation,
                mediation: detail.mediation,
                options: detail.options,
                // The page event has no origin field. This value comes only from the isolated world.
                origin: topOrigin,
                flowId: runtimeRequestId,
                nonce: bridgeRequestId(),
                ttlMs: timeoutMs,
                topOrigin,
                rpId: rpId || "",
                target: {
                    frameId: 0,
                    origin: topOrigin,
                    topOrigin,
                    documentId,
                },
            },
            timeoutMs
        );
        const pendingRequest = { bridgeRequestId: runtimeRequestId, cancel: runtimeRequest.cancel };
        pending.set(detail.requestId, pendingRequest);
        void runtimeRequest.response
            .then((response: unknown) => {
                const result: PasskeyResult = isPasskeyResult(response, runtimeRequestId)
                    ? { ...response, requestId: detail.requestId }
                    : {
                          type: "passkeyResult",
                          protocolVersion: PASSKEY_PROTOCOL_VERSION,
                          requestId: detail.requestId,
                          outcome: "fallback",
                          reason: "provider-unavailable",
                      };
                if (PASSKEY_DIAGNOSTICS_ENABLED) {
                    console.debug("[Elf Vault passkey] returning result", runtimeRequestId, result.outcome);
                }
                target.postMessage({ source: PASSKEY_EXTENSION_MESSAGE_SOURCE, kind: "result", detail: result }, "*");
            })
            .catch((error: Error) => {
                if (PASSKEY_DIAGNOSTICS_ENABLED) {
                    console.debug("[Elf Vault passkey] runtime transport failed", runtimeRequestId, error.message);
                }
                target.postMessage(
                    {
                        source: PASSKEY_EXTENSION_MESSAGE_SOURCE,
                        kind: "result",
                        detail: {
                            type: "passkeyResult",
                            protocolVersion: PASSKEY_PROTOCOL_VERSION,
                            requestId: detail.requestId,
                            outcome: "fallback",
                            reason: "extension-transport-error",
                        } as PasskeyResult,
                    },
                    "*"
                );
            })
            .finally(() => {
                if (pending.get(detail.requestId) === pendingRequest) pending.delete(detail.requestId);
            });
    }) as EventListener);
}

if (typeof window !== "undefined" && (!window.top || window.top === window)) installPasskeyContentBridge();
