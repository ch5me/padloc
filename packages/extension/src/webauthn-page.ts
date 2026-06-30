type PublicKeyCredentialDescriptorLike = {
    id?: BufferSource;
};

type PadlocWebAuthnRequest =
    | {
          kind: "create";
          requestId: string;
          rpId: string;
          origin: string;
          topOrigin?: string;
          crossOrigin?: boolean;
          challenge: string;
          clientDataJSON: string;
          userHandle?: string;
          userName?: string;
          userDisplayName?: string;
          algorithm?: number;
          userVerification?: UserVerificationRequirement;
          excludeCredentialIds?: string[];
      }
    | {
          kind: "get";
          requestId: string;
          rpId: string;
          origin: string;
          topOrigin?: string;
          crossOrigin?: boolean;
          challenge: string;
          clientDataJSON: string;
          clientDataHash: string;
          userVerification?: UserVerificationRequirement;
          allowCredentialIds?: string[];
      };

type PadlocWebAuthnCredentialResponse = {
    id: string;
    rawId: string;
    type: "public-key";
    authenticatorAttachment: "platform" | "cross-platform";
    clientExtensionResults: { credProps?: { rk: boolean } };
    response: {
        clientDataJSON: string;
        attestationObject?: string;
        authenticatorData?: string;
        publicKey?: string;
        publicKeyAlgorithm?: number;
        signature?: string;
        userHandle?: string;
        transports?: string[];
    };
};

type PadlocWebAuthnResponse =
    | { ok: true; requestId: string; credential: PadlocWebAuthnCredentialResponse }
    | { ok: false; requestId: string; error: { name?: string; message?: string } };

const BRIDGE_REQUEST_EVENT = "padloc-webauthn-request";
const BRIDGE_RESPONSE_EVENT = "padloc-webauthn-response";
const BRIDGE_CHANNEL = webAuthnBridgeChannel();
const BRIDGE_PAGE_SOURCE = `padloc-webauthn-page:${BRIDGE_CHANNEL}`;
const BRIDGE_CONTENT_SOURCE = `padloc-webauthn-content:${BRIDGE_CHANNEL}`;

const credentialContainer = navigator.credentials;
const originalCreate =
    typeof credentialContainer?.create === "function"
        ? credentialContainer.create.bind(credentialContainer)
        : undefined;
const originalGet =
    typeof credentialContainer?.get === "function" ? credentialContainer.get.bind(credentialContainer) : undefined;
const pendingRequests = new Map<string, (response: PadlocWebAuthnResponse) => void>();
const padlocWindow = window as Window & { __padlocWebAuthnPageInstalledChannel?: string };

if (
    padlocWindow.__padlocWebAuthnPageInstalledChannel !== BRIDGE_CHANNEL &&
    credentialContainer &&
    typeof originalCreate === "function" &&
    typeof originalGet === "function"
) {
    padlocWindow.__padlocWebAuthnPageInstalledChannel = BRIDGE_CHANNEL;
    navigator.credentials.create = async function create(
        options?: CredentialCreationOptions
    ): Promise<Credential | null> {
        const publicKey = options?.publicKey;
        if (!publicKey) {
            return originalCreate(options);
        }
        const request = buildCreateRequest(publicKey);
        const response = await dispatchPadlocWebAuthn(request);
        if (!response.ok) {
            throw webAuthnDomException(response.error, "Passkey registration was not approved by Padloc");
        }
        return toPublicKeyCredential(response.credential, "attestation") as unknown as Credential;
    };

    navigator.credentials.get = async function get(options?: CredentialRequestOptions): Promise<Credential | null> {
        const publicKey = options?.publicKey;
        if (!publicKey) {
            return originalGet(options);
        }
        const request = await buildGetRequest(publicKey);
        const response = await dispatchPadlocWebAuthn(request);
        if (!response.ok) {
            throw webAuthnDomException(response.error, "Passkey assertion was not approved by Padloc");
        }
        return toPublicKeyCredential(response.credential, "assertion") as unknown as Credential;
    };

    installPublicKeyCredentialCapabilityHooks();

    window.addEventListener("message", (event) => {
        const data = event.data as { source?: string; type?: string; response?: PadlocWebAuthnResponse };
        if (data?.source !== BRIDGE_CONTENT_SOURCE || data.type !== BRIDGE_RESPONSE_EVENT) return;
        const detail = data.response;
        if (!detail?.requestId) return;
        const resolve = pendingRequests.get(detail.requestId);
        if (!resolve) return;
        pendingRequests.delete(detail.requestId);
        resolve(detail);
    });
}

function buildCreateRequest(publicKey: PublicKeyCredentialCreationOptions): PadlocWebAuthnRequest {
    const rpId = publicKey.rp.id || location.hostname;
    const algorithm = chooseSupportedAlgorithm(publicKey.pubKeyCredParams);
    if (!algorithm) {
        throw new DOMException(
            "Padloc does not support any requested WebAuthn public-key algorithm",
            "NotSupportedError"
        );
    }
    const originContext = getOriginContext();
    const clientDataJSON = buildClientDataJson("webauthn.create", publicKey.challenge, originContext);
    return {
        kind: "create",
        requestId: randomRequestId(),
        rpId,
        origin: location.origin,
        topOrigin: originContext.topOrigin,
        crossOrigin: originContext.crossOrigin,
        challenge: bytesToBase64Url(toBytes(publicKey.challenge)),
        clientDataJSON: bytesToBase64Url(stringToBytes(clientDataJSON)),
        userHandle: publicKey.user?.id ? bytesToBase64Url(toBytes(publicKey.user.id)) : undefined,
        userName: publicKey.user?.name,
        userDisplayName: publicKey.user?.displayName,
        algorithm,
        userVerification: publicKey.authenticatorSelection?.userVerification,
        excludeCredentialIds: (publicKey.excludeCredentials || [])
            .map((entry: PublicKeyCredentialDescriptorLike) => entry.id)
            .filter((id): id is BufferSource => Boolean(id))
            .map((id) => bytesToBase64Url(toBytes(id))),
    };
}

async function buildGetRequest(publicKey: PublicKeyCredentialRequestOptions): Promise<PadlocWebAuthnRequest> {
    const rpId = publicKey.rpId || location.hostname;
    const originContext = getOriginContext();
    const clientDataJSON = buildClientDataJson("webauthn.get", publicKey.challenge, originContext);
    const clientDataBytes = stringToBytes(clientDataJSON);
    const clientDataHash = new Uint8Array(await crypto.subtle.digest("SHA-256", clientDataBytes));
    return {
        kind: "get",
        requestId: randomRequestId(),
        rpId,
        origin: location.origin,
        topOrigin: originContext.topOrigin,
        crossOrigin: originContext.crossOrigin,
        challenge: bytesToBase64Url(toBytes(publicKey.challenge)),
        clientDataJSON: bytesToBase64Url(clientDataBytes),
        clientDataHash: bytesToBase64Url(clientDataHash),
        userVerification: publicKey.userVerification,
        allowCredentialIds: (publicKey.allowCredentials || [])
            .map((entry: PublicKeyCredentialDescriptorLike) => entry.id)
            .filter((id): id is BufferSource => Boolean(id))
            .map((id) => bytesToBase64Url(toBytes(id))),
    };
}

function dispatchPadlocWebAuthn(request: PadlocWebAuthnRequest): Promise<PadlocWebAuthnResponse> {
    return new Promise((resolve) => {
        pendingRequests.set(request.requestId, resolve);
        window.postMessage(
            {
                source: BRIDGE_PAGE_SOURCE,
                type: BRIDGE_REQUEST_EVENT,
                request,
            },
            location.origin
        );
        window.setTimeout(() => {
            if (!pendingRequests.delete(request.requestId)) return;
            resolve({
                ok: false,
                requestId: request.requestId,
                error: {
                    name: "NotAllowedError",
                    message: "Timed out waiting for Padloc passkey response",
                },
            });
        }, 120000);
    });
}

function toPublicKeyCredential(
    credential: PadlocWebAuthnCredentialResponse,
    responseKind: "attestation" | "assertion"
) {
    const rawId = base64UrlToBytes(credential.rawId);
    const jsonResponse =
        responseKind === "attestation"
            ? {
                  clientDataJSON: credential.response.clientDataJSON,
                  attestationObject: credential.response.attestationObject || "",
                  authenticatorData: credential.response.authenticatorData || "",
                  publicKey: credential.response.publicKey || "",
                  publicKeyAlgorithm: credential.response.publicKeyAlgorithm || -7,
                  transports: credential.response.transports || ["internal"],
              }
            : {
                  clientDataJSON: credential.response.clientDataJSON,
                  authenticatorData: credential.response.authenticatorData || "",
                  signature: credential.response.signature || "",
                  userHandle: credential.response.userHandle || null,
              };
    const responsePayload =
        responseKind === "attestation"
            ? {
                  clientDataJSON: base64UrlToArrayBuffer(credential.response.clientDataJSON),
                  attestationObject: base64UrlToArrayBuffer(credential.response.attestationObject || ""),
                  getTransports: () => credential.response.transports || ["internal"],
                  getAuthenticatorData: () => base64UrlToArrayBuffer(credential.response.authenticatorData || ""),
                  getPublicKey: () => base64UrlToArrayBuffer(credential.response.publicKey || ""),
                  getPublicKeyAlgorithm: () => credential.response.publicKeyAlgorithm || -7,
                  toJSON: () => jsonResponse,
              }
            : {
                  clientDataJSON: base64UrlToArrayBuffer(credential.response.clientDataJSON),
                  authenticatorData: base64UrlToArrayBuffer(credential.response.authenticatorData || ""),
                  signature: base64UrlToArrayBuffer(credential.response.signature || ""),
                  userHandle: credential.response.userHandle
                      ? base64UrlToArrayBuffer(credential.response.userHandle)
                      : null,
                  toJSON: () => jsonResponse,
              };
    const publicKeyCredential = {
        id: credential.id,
        rawId: rawId.buffer.slice(rawId.byteOffset, rawId.byteOffset + rawId.byteLength),
        type: credential.type,
        authenticatorAttachment: credential.authenticatorAttachment,
        response: responsePayload,
        getClientExtensionResults: () => credential.clientExtensionResults || {},
        toJSON: () => ({
            id: credential.id,
            rawId: credential.rawId,
            type: credential.type,
            authenticatorAttachment: credential.authenticatorAttachment,
            clientExtensionResults: credential.clientExtensionResults || {},
            response: jsonResponse,
        }),
    };
    brandLikeNativeCredential(publicKeyCredential, responsePayload, responseKind);
    return publicKeyCredential;
}

function chooseSupportedAlgorithm(params: PublicKeyCredentialParameters[]): number | null {
    if (params.some((entry) => entry.type === "public-key" && entry.alg === -7)) return -7;
    if (params.some((entry) => entry.type === "public-key" && entry.alg === -8)) return -8;
    return null;
}

function installPublicKeyCredentialCapabilityHooks(): void {
    if (typeof PublicKeyCredential === "undefined") return;
    const credentialCtor = PublicKeyCredential as typeof PublicKeyCredential & {
        getClientCapabilities?: () => Promise<Record<string, boolean>>;
    };
    credentialCtor.isUserVerifyingPlatformAuthenticatorAvailable = async () => true;
    if (typeof credentialCtor.getClientCapabilities === "function") {
        const originalGetClientCapabilities = credentialCtor.getClientCapabilities.bind(credentialCtor);
        credentialCtor.getClientCapabilities = async () => ({
            ...(await originalGetClientCapabilities().catch(() => ({}))),
            passkeyPlatformAuthenticator: true,
            userVerifyingPlatformAuthenticator: true,
        });
    }
}

function buildClientDataJson(
    type: "webauthn.create" | "webauthn.get",
    challenge: BufferSource,
    originContext: { crossOrigin: boolean; topOrigin?: string }
): string {
    const payload: Record<string, unknown> = {
        type,
        challenge: bytesToBase64Url(toBytes(challenge)),
        origin: location.origin,
        crossOrigin: originContext.crossOrigin,
    };
    if (originContext.crossOrigin && originContext.topOrigin) {
        payload.topOrigin = originContext.topOrigin;
    }
    return JSON.stringify(payload);
}

function getOriginContext(): { crossOrigin: boolean; topOrigin?: string } {
    if (window.top === window) {
        return { crossOrigin: false, topOrigin: location.origin };
    }
    try {
        return {
            crossOrigin: window.top?.location.origin !== location.origin,
            topOrigin: window.top?.location.origin,
        };
    } catch {
        try {
            return { crossOrigin: true, topOrigin: document.referrer ? new URL(document.referrer).origin : undefined };
        } catch {
            return { crossOrigin: true };
        }
    }
}

function webAuthnBridgeChannel(): string {
    return document.documentElement.getAttribute("data-padloc-webauthn-channel") || "default";
}

function brandLikeNativeCredential(
    credential: Record<string, unknown>,
    response: Record<string, unknown>,
    responseKind: "attestation" | "assertion"
): void {
    try {
        if (typeof PublicKeyCredential !== "undefined") {
            Object.setPrototypeOf(credential, PublicKeyCredential.prototype);
        }
        const webAuthnGlobal = globalThis as typeof globalThis & {
            AuthenticatorAttestationResponse?: { prototype: object };
            AuthenticatorAssertionResponse?: { prototype: object };
        };
        const responsePrototype =
            responseKind === "attestation"
                ? webAuthnGlobal.AuthenticatorAttestationResponse?.prototype
                : webAuthnGlobal.AuthenticatorAssertionResponse?.prototype;
        if (responsePrototype) {
            Object.setPrototypeOf(response, responsePrototype);
        }
    } catch {
        // Some browsers disallow native prototype grafting; own fields and toJSON still satisfy normal RP code.
    }
}

function webAuthnDomException(error: { name?: string; message?: string } | undefined, fallback: string): DOMException {
    return new DOMException(error?.message || fallback, error?.name || "NotAllowedError");
}

function randomRequestId(): string {
    const bytes = new Uint8Array(16);
    crypto.getRandomValues(bytes);
    return `padloc-webauthn-${bytesToBase64Url(bytes)}`;
}

function toBytes(source: BufferSource): Uint8Array {
    if (source instanceof ArrayBuffer) return new Uint8Array(source);
    return new Uint8Array(source.buffer, source.byteOffset, source.byteLength);
}

function stringToBytes(value: string): Uint8Array {
    return new TextEncoder().encode(value);
}

function bytesToBase64Url(bytes: Uint8Array): string {
    let binary = "";
    for (const byte of bytes) binary += String.fromCharCode(byte);
    return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
}

function base64UrlToArrayBuffer(value: string): ArrayBuffer {
    const bytes = base64UrlToBytes(value);
    return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);
}

function base64UrlToBytes(value: string): Uint8Array {
    const padded = value
        .replace(/-/g, "+")
        .replace(/_/g, "/")
        .padEnd(Math.ceil(value.length / 4) * 4, "=");
    const binary = atob(padded);
    const bytes = new Uint8Array(binary.length);
    for (let index = 0; index < binary.length; index += 1) {
        bytes[index] = binary.charCodeAt(index);
    }
    return bytes;
}
