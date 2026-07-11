import { expect } from "chai";
import {
    deserializeWebAuthnValue,
    isPagePasskeyCancellation,
    isPagePasskeyRequest,
    PASSKEY_EXTENSION_MESSAGE_SOURCE,
    PASSKEY_PAGE_MESSAGE_SOURCE,
    PASSKEY_PROTOCOL_VERSION,
    serializeWebAuthnValue,
} from "../src/passkey-protocol";
import { installPasskeyContentBridge } from "../src/passkey-content-bridge";
import {
    installPasskeyCanaryInterceptor,
    reconstructCredential,
    serializedWebAuthnCredentialToJSON,
} from "../src/passkey-page";
import manifest from "../src/manifest.json";

suite("Passkey page bridge protocol", () => {
    test("injects the passkey bridge only into top-level HTTPS and localhost pages at document_start", () => {
        const scripts = manifest.content_scripts.filter((entry) =>
            entry.js.some((script) => script.startsWith("passkey-"))
        );
        expect(scripts).to.have.length(2);
        for (const script of scripts) {
            expect(script.matches).to.deep.equal(["https://*/*", "http://localhost/*", "http://127.0.0.1/*"]);
            expect(script.all_frames).to.equal(false);
            expect(script.run_at).to.equal("document_start");
        }
        expect(scripts.map((entry) => entry.world).sort()).to.deep.equal(["ISOLATED", "MAIN"]);
    });

    test("round-trips WebAuthn buffer sources without JSON corruption", () => {
        const challenge = new Uint8Array([0, 1, 127, 128, 255]);
        const serialized = serializeWebAuthnValue({ challenge, user: { id: challenge.subarray(1, 4) } });
        const restored = deserializeWebAuthnValue(serialized) as any;
        expect(Array.from(new Uint8Array(restored.challenge))).to.deep.equal([0, 1, 127, 128, 255]);
        expect(Array.from(new Uint8Array(restored.user.id))).to.deep.equal([1, 127, 128]);
    });

    test("converts reconstructed credentials to standard base64url JSON", () => {
        const json = serializedWebAuthnCredentialToJSON({
            id: "AQID",
            type: "public-key",
            rawId: { __padlocWebAuthnType: "buffer", base64url: "AQID" },
            response: {
                clientDataJSON: { __padlocWebAuthnType: "buffer", base64url: "BAUG" },
            },
        });

        expect(json.rawId).to.equal("AQID");
        expect((json.response as any).clientDataJSON).to.equal("BAUG");
    });

    test("reconstructs registration response methods expected by relying parties", () => {
        const credential = reconstructCredential({
            id: "AQID",
            type: "public-key",
            rawId: { __padlocWebAuthnType: "buffer", base64url: "AQID" },
            authenticatorAttachment: "platform",
            response: {
                clientDataJSON: { __padlocWebAuthnType: "buffer", base64url: "AQ" },
                attestationObject: { __padlocWebAuthnType: "buffer", base64url: "Ag" },
                authenticatorData: { __padlocWebAuthnType: "buffer", base64url: "Aw" },
                publicKey: { __padlocWebAuthnType: "buffer", base64url: "BA" },
                publicKeyAlgorithm: -7,
                transports: ["internal"],
            },
        }) as any;

        expect(credential.response.getTransports()).to.deep.equal(["internal"]);
        expect(Array.from(new Uint8Array(credential.response.getAuthenticatorData()))).to.deep.equal([3]);
        expect(Array.from(new Uint8Array(credential.response.getPublicKey()))).to.deep.equal([4]);
        expect(credential.response.getPublicKeyAlgorithm()).to.equal(-7);
    });

    test("activates interception only for the explicit CH5/Google canary policy", () => {
        const credentials = {
            create: async () => null,
            get: async () => null,
        } as any;
        expect(installPasskeyCanaryInterceptor("https://unrelated.example", credentials)).to.equal(false);
        expect(Boolean(credentials.__padlocPasskeyInterceptorV1)).to.equal(false);
        expect(installPasskeyCanaryInterceptor("https://accounts.google.com", credentials)).to.equal(true);
        expect(Boolean(credentials.__padlocPasskeyInterceptorV1)).to.equal(true);
    });

    test("accepts only typed requests and has no page-supplied origin field", () => {
        const request = {
            protocolVersion: PASSKEY_PROTOCOL_VERSION,
            requestId: "request-1",
            operation: "get",
            mediation: "conditional",
            options: { challenge: "serialized" },
        };
        expect(isPagePasskeyRequest(request)).to.equal(true);
        expect(isPagePasskeyRequest({ ...request, operation: "delete" })).to.equal(false);
        expect(isPagePasskeyRequest({ ...request, mediation: "unexpected" })).to.equal(false);
        expect(isPagePasskeyRequest({ ...request, options: { challenge: "x".repeat(300_000) } })).to.equal(false);
        expect(
            isPagePasskeyCancellation({ protocolVersion: PASSKEY_PROTOCOL_VERSION, requestId: "request-1" })
        ).to.equal(true);
        expect(isPagePasskeyCancellation({ protocolVersion: 99, requestId: "request-1" })).to.equal(false);
        expect(request).not.to.have.property("origin");
    });

    test("isolated bridge derives origin and returns a mock background response", async () => {
        const listeners = new Map<string, (event: any) => void>();
        const responses: any[] = [];
        const target = {
            location: { origin: "https://rp.example" },
            top: null as any,
            addEventListener(type: string, listener: (event: any) => void) {
                listeners.set(type, listener);
            },
            postMessage(data: any) {
                if (data.source === PASSKEY_EXTENSION_MESSAGE_SOURCE) responses.push(data.detail);
                listeners.get("message")?.({ source: target, data });
                return true;
            },
        } as any;
        target.top = target;
        let runtimeRequest: any;
        const originalConnect = (globalThis as any).chrome.runtime.connect;
        (globalThis as any).chrome.runtime.connect = () => {
            let responseListener: (response: unknown) => void = () => {};
            return {
                onMessage: {
                    addListener(listener: (response: unknown) => void) {
                        responseListener = listener;
                    },
                },
                onDisconnect: { addListener() {} },
                disconnect() {},
                postMessage(request: any) {
                    runtimeRequest = request;
                    responseListener({
                        type: "passkeyResult",
                        protocolVersion: PASSKEY_PROTOCOL_VERSION,
                        requestId: request.requestId,
                        outcome: "error",
                        error: { name: "NotAllowedError", message: "mock rejection" },
                    });
                },
            };
        };

        try {
            installPasskeyContentBridge(target);
            target.postMessage({
                source: PASSKEY_PAGE_MESSAGE_SOURCE,
                kind: "request",
                detail: {
                    protocolVersion: PASSKEY_PROTOCOL_VERSION,
                    requestId: "mock-request",
                    operation: "get",
                    options: { challenge: "serialized" },
                    origin: "https://attacker.invalid",
                },
            });
            await Promise.resolve();
            await Promise.resolve();

            expect(runtimeRequest.origin).to.equal("https://rp.example");
            expect(runtimeRequest.type).to.equal("passkeyRequest");
            expect(runtimeRequest.requestId).to.be.a("string").and.not.equal("mock-request");
            expect(responses[0]).to.deep.include({ requestId: "mock-request", outcome: "error" });
        } finally {
            (globalThis as any).chrome.runtime.connect = originalConnect;
        }
    });

    test("isolated bridge disconnects the ceremony port when the page cancels", async () => {
        const listeners = new Map<string, (event: any) => void>();
        const target = {
            location: { origin: "https://rp.example" },
            top: null as any,
            addEventListener(type: string, listener: (event: any) => void) {
                listeners.set(type, listener);
            },
            postMessage(data: any) {
                listeners.get("message")?.({ source: target, data });
                return true;
            },
        } as any;
        target.top = target;
        let disconnects = 0;
        const originalConnect = (globalThis as any).chrome.runtime.connect;
        (globalThis as any).chrome.runtime.connect = () => ({
            onMessage: { addListener() {} },
            onDisconnect: { addListener() {} },
            disconnect() {
                disconnects += 1;
            },
            postMessage() {},
        });

        try {
            installPasskeyContentBridge(target);
            target.postMessage({
                source: PASSKEY_PAGE_MESSAGE_SOURCE,
                kind: "request",
                detail: {
                    protocolVersion: PASSKEY_PROTOCOL_VERSION,
                    requestId: "cancel-me",
                    operation: "get",
                    options: { challenge: "serialized", timeout: 1_000 },
                },
            });
            target.postMessage({
                source: PASSKEY_PAGE_MESSAGE_SOURCE,
                kind: "cancel",
                detail: { protocolVersion: PASSKEY_PROTOCOL_VERSION, requestId: "cancel-me" },
            });
            await Promise.resolve();

            expect(disconnects).to.equal(1);
        } finally {
            (globalThis as any).chrome.runtime.connect = originalConnect;
        }
    });
});
