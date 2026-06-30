#!/usr/bin/env node

import fs from "node:fs";
import path from "node:path";

const args = new Map();
for (let i = 2; i < process.argv.length; i += 1) {
    const key = process.argv[i];
    const next = process.argv[i + 1];
    if (!key.startsWith("--")) continue;
    if (!next || next.startsWith("--")) {
        args.set(key.slice(2), "true");
    } else {
        args.set(key.slice(2), next);
        i += 1;
    }
}

const mode = args.get("mode") || "smoke";
const port = args.get("port") || "9800";
const extensionId = args.get("extension-id") || "phgggllfaobigoepghbbeojablefkkfa";
const extensionPath = args.get("extension-path") || new URL("../dist", import.meta.url).pathname;

class Cdp {
    nextId = 1;
    pending = new Map();
    socket;

    async connect() {
        const version = await fetch(`http://127.0.0.1:${port}/json/version`).then((res) => res.json());
        this.socket = new WebSocket(version.webSocketDebuggerUrl);
        this.socket.addEventListener("message", (event) => {
            const msg = JSON.parse(event.data);
            if (!msg.id || !this.pending.has(msg.id)) return;
            const { resolve, reject } = this.pending.get(msg.id);
            this.pending.delete(msg.id);
            msg.error ? reject(new Error(`${msg.error.code}: ${msg.error.message}`)) : resolve(msg.result || {});
        });
        await new Promise((resolve, reject) => {
            this.socket.addEventListener("open", resolve, { once: true });
            this.socket.addEventListener("error", reject, { once: true });
        });
    }

    send(method, params = {}, sessionId, timeoutMs = 15000) {
        const id = this.nextId++;
        const payload = { id, method, params };
        if (sessionId) payload.sessionId = sessionId;
        const result = new Promise((resolve, reject) => {
            const timeout = setTimeout(() => {
                this.pending.delete(id);
                reject(new Error(`${method} timed out after ${timeoutMs}ms`));
            }, timeoutMs);
            this.pending.set(id, {
                resolve: (value) => {
                    clearTimeout(timeout);
                    resolve(value);
                },
                reject: (error) => {
                    clearTimeout(timeout);
                    reject(error);
                },
            });
        });
        this.socket.send(JSON.stringify(payload));
        return result;
    }

    close() {
        this.socket?.close();
    }
}

const cdp = new Cdp();
await cdp.connect();

try {
    if (mode === "reload") {
        console.log(JSON.stringify(await reloadExtension(), null, 2));
    } else if (mode === "clear-storage") {
        console.log(JSON.stringify(await clearStorage(), null, 2));
    } else if (mode === "reset") {
        await reloadExtension();
        await clearStorage();
        console.log(JSON.stringify(await reloadExtension(), null, 2));
    } else if (mode === "smoke") {
        console.log(JSON.stringify(await smoke(), null, 2));
    } else if (mode === "webauthn-proof") {
        const result = await webAuthnProof();
        console.log(JSON.stringify(result, null, 2));
        if (!result.ok) process.exitCode = 1;
    } else {
        throw new Error(`unknown mode ${mode}`);
    }
} finally {
    cdp.close();
}

async function reloadExtension() {
    const loaded = await cdp.send("Extensions.loadUnpacked", { path: extensionPath });
    return { status: "reloaded", id: loaded.id, path: extensionPath };
}

async function clearStorage() {
    const sessionId = await attachExtensionPage();
    const result = await cdp.send(
        "Runtime.evaluate",
        {
            expression: `(async () => {
                await chrome.storage.local.clear();
                await chrome.storage.session.clear();
                await new Promise((resolve, reject) => {
                    const req = indexedDB.deleteDatabase("padloc-agentic-passkey-signers");
                    req.onsuccess = () => resolve();
                    req.onerror = () => reject(req.error || new Error("failed to clear signer store"));
                    req.onblocked = () => reject(new Error("blocked clearing passkey signer store"));
                });
                const verifyReq = indexedDB.open("padloc-agentic-passkey-signers", 1);
                await new Promise((resolve, reject) => {
                    verifyReq.onupgradeneeded = () => {
                        const db = verifyReq.result;
                        if (!db.objectStoreNames.contains("keys")) db.createObjectStore("keys", { keyPath: "handle" });
                    };
                    verifyReq.onsuccess = () => {
                        const db = verifyReq.result;
                        const tx = db.transaction("keys", "readonly");
                        const countReq = tx.objectStore("keys").count();
                        countReq.onsuccess = () => {
                            db.close();
                            countReq.result === 0
                                ? resolve()
                                : reject(new Error("passkey signer store still contains keys after clear"));
                        };
                        countReq.onerror = () => {
                            db.close();
                            reject(countReq.error || new Error("failed to verify signer store clear"));
                        };
                    };
                    verifyReq.onerror = () => reject(verifyReq.error || new Error("failed to open signer store for verification"));
                });
                return { ok: true, id: chrome.runtime.id };
            })()`,
            awaitPromise: true,
            returnByValue: true,
        },
        sessionId
    );
    if (result.exceptionDetails) throw new Error(result.exceptionDetails.text || "storage clear failed");
    return { status: "storage_cleared", ...result.result.value };
}

async function attachExtensionPage() {
    for (let attempt = 0; attempt < 8; attempt += 1) {
        const targets = await cdp.send("Target.getTargets");
        let page = targets.targetInfos.find(
            (target) => target.type === "page" && (target.url || "").startsWith(`chrome-extension://${extensionId}/`)
        );
        if (!page) {
            const created = await cdp.send("Target.createTarget", { url: `chrome-extension://${extensionId}/popup.html` });
            page = { targetId: created.targetId };
        }
        try {
            return await attach(page.targetId);
        } catch {
            await sleep(500);
        }
    }
    throw new Error(`extension page missing for ${extensionId}`);
}

async function smoke() {
    const pingState = await pingExtensionRuntime();
    const bg = readDistAsset("background.js");
    const bgMap = readDistAsset("background.js.map");
    const workerState = {
        id: pingState.id,
        hasRuntime: pingState.hasRuntime,
        pingLastError: pingState.lastError,
        pingResponseType: pingState.responseType,
        hasMessageListeners: pingState.responseType === "pong",
        hasImmediateBridge: bg.includes("registerImmediateMessageBridge"),
        referencesXhr: /\bXMLHttpRequest\b/.test(bg),
        importsPageRouter:
            /(^|[^.\w$])history\s*\.(?:state|replaceState|pushState|go)\b/m.test(bg) ||
            bg.includes("window.router") ||
            bg.includes("new Router("),
        sourceMapIncludesBrowserOnlyAppModules:
            bgMap.includes("app/src/lib/ajax.ts") ||
            bgMap.includes("app/src/globals.ts") ||
            bgMap.includes("app/src/lib/route.ts"),
        storesPasskeyPrivateKeyField: /name:\s*["']Private Key["']|["']Private Key["']\s*,\s*type:/.test(bg),
        hasContextMenuDedupe: bg.includes("dedupeMatchedItems"),
        hasContextMenuIdempotence: bg.includes("createContextMenuOnce"),
        hasContextMenuDuplicateRetry: bg.includes("duplicate id"),
    };

    const created = await cdp.send("Target.createTarget", { url: "https://example.com/" });
    const pageSession = await attach(created.targetId);
    await cdp.send("Page.enable", {}, pageSession);
    await sleep(1500);
    const pageState = await evaluate(
        pageSession,
        `(async () => {
            const hookState = {
                createHooked: !String(navigator.credentials.create).includes("[native code]"),
                getHooked: !String(navigator.credentials.get).includes("[native code]")
            };
            let createResult;
            try {
                await Promise.race([
                    navigator.credentials.create({ publicKey: {
                        challenge: crypto.getRandomValues(new Uint8Array(32)),
                        rp: { id: "example.com", name: "Example" },
                        user: { id: crypto.getRandomValues(new Uint8Array(16)), name: "agent@example.com", displayName: "Agent" },
                        pubKeyCredParams: [{ type: "public-key", alg: -7 }],
                        authenticatorSelection: { userVerification: "required" }
                    }}),
                    new Promise((_, reject) => setTimeout(() => reject(new Error("probe-timeout")), 7000))
                ]);
                createResult = { ok: true };
            } catch (error) {
                createResult = { ok: false, name: error?.name || "", message: error?.message || String(error) };
            }
            return { ...hookState, createResult };
        })()`,
        "example.com WebAuthn hook probe"
    );
    await cdp.send("Target.closeTarget", { targetId: created.targetId });

    return { status: "smoke", workerState, pageState };
}

function readDistAsset(file) {
    return fs.readFileSync(path.join(extensionPath, file), "utf8");
}

async function pingExtensionRuntime() {
    const sessionId = await attachExtensionPage();
    return evaluate(
        sessionId,
        `(async () => new Promise((resolve) => {
            const runtime = globalThis.chrome?.runtime;
            if (!runtime) {
                resolve({ id: "${extensionId}", hasRuntime: false, responseType: "", lastError: "chrome.runtime missing" });
                return;
            }
            runtime.sendMessage(runtime.id, { type: "ping" }, (resp) => {
                resolve({
                    id: runtime.id,
                    hasRuntime: true,
                    responseType: resp?.type || "",
                    lastError: runtime.lastError?.message || ""
                });
            });
        }))()`,
        "extension runtime ping"
    );
}

async function webAuthnProof() {
    const created = await cdp.send("Target.createTarget", { url: "https://example.com/" });
    const pageSession = await attach(created.targetId);
    await cdp.send("Page.enable", {}, pageSession);
    await sleep(1500);
    let pageState;
    try {
        pageState = await evaluate(
            pageSession,
            `(async () => {
                function bufferToBase64Url(buffer) {
                    const bytes = new Uint8Array(buffer);
                    let binary = "";
                    for (const byte of bytes) binary += String.fromCharCode(byte);
                    return btoa(binary).replace(/\\+/g, "-").replace(/\\//g, "_").replace(/=+$/g, "");
                }
                function webAuthnState(extra = {}) {
                    return {
                        createHooked: !String(navigator.credentials.create).includes("[native code]"),
                        getHooked: !String(navigator.credentials.get).includes("[native code]"),
                        ...extra
                    };
                }
                let createCredential;
                try {
                    createCredential = await navigator.credentials.create({ publicKey: {
                        challenge: crypto.getRandomValues(new Uint8Array(32)),
                        rp: { id: "example.com", name: "Example" },
                        user: { id: crypto.getRandomValues(new Uint8Array(16)), name: "agent@example.com", displayName: "Agent" },
                        pubKeyCredParams: [{ type: "public-key", alg: -7 }],
                        authenticatorSelection: { userVerification: "required" }
                    }});
                } catch (error) {
                    return webAuthnState({
                        ok: false,
                        stage: "create",
                        error: { name: error?.name || "", message: error?.message || String(error) }
                    });
                }
                let assertion;
                try {
                    assertion = await navigator.credentials.get({ publicKey: {
                        challenge: crypto.getRandomValues(new Uint8Array(32)),
                        rpId: "example.com",
                        allowCredentials: [{ type: "public-key", id: createCredential.rawId }],
                        userVerification: "required"
                    }});
                } catch (error) {
                    return webAuthnState({
                        ok: false,
                        stage: "get",
                        create: {
                            ok: Boolean(createCredential),
                            type: createCredential?.type || "",
                            idLength: createCredential?.id?.length || 0,
                            rawIdLength: createCredential?.rawId?.byteLength || 0,
                            hasAttestationObject: Boolean(createCredential?.response?.attestationObject),
                            hasClientDataJSON: Boolean(createCredential?.response?.clientDataJSON)
                        },
                        error: { name: error?.name || "", message: error?.message || String(error) }
                    });
                }
                return webAuthnState({
                    ok: Boolean(createCredential && assertion),
                    create: {
                        ok: Boolean(createCredential),
                        type: createCredential?.type || "",
                        idLength: createCredential?.id?.length || 0,
                        rawIdLength: createCredential?.rawId?.byteLength || 0,
                        hasAttestationObject: Boolean(createCredential?.response?.attestationObject),
                        hasClientDataJSON: Boolean(createCredential?.response?.clientDataJSON)
                    },
                    get: {
                        ok: Boolean(assertion),
                        type: assertion?.type || "",
                        idLength: assertion?.id?.length || 0,
                        rawIdLength: assertion?.rawId?.byteLength || 0,
                        sameCredential: bufferToBase64Url(assertion.rawId) === bufferToBase64Url(createCredential.rawId),
                        hasAuthenticatorData: Boolean(assertion?.response?.authenticatorData),
                        hasSignature: Boolean(assertion?.response?.signature),
                        hasClientDataJSON: Boolean(assertion?.response?.clientDataJSON)
                    }
                });
            })()`,
            "example.com WebAuthn proof"
        );
    } finally {
        await cdp.send("Target.closeTarget", { targetId: created.targetId }).catch(() => undefined);
    }

    return { status: "webauthn-proof", ok: Boolean(pageState?.ok), pageState };
}

async function attachWorker({ reloadOnUnresponsive = false } = {}) {
    let openedPopup = false;
    let reloaded = false;
    let lastError = "";
    for (let attempt = 0; attempt < 10; attempt += 1) {
        const targets = await cdp.send("Target.getTargets");
        const worker = targets.targetInfos.find(
            (target) => target.type === "service_worker" && (target.url || "").startsWith(`chrome-extension://${extensionId}/`)
        );
        if (worker) {
            try {
                return await attach(worker.targetId, "extension service worker");
            } catch (error) {
                lastError = error instanceof Error ? error.message : String(error);
                if (reloadOnUnresponsive && !reloaded && /Runtime\.enable timed out|Runtime\.evaluate timed out/.test(lastError)) {
                    reloaded = true;
                    await reloadExtension();
                    await sleep(1000);
                    continue;
                }
            }
        } else if (!openedPopup) {
            openedPopup = true;
            await cdp.send("Target.createTarget", { url: `chrome-extension://${extensionId}/popup.html` });
        }
        await sleep(500);
    }
    throw new Error(`extension service worker missing for ${extensionId}${lastError ? `: ${lastError}` : ""}`);
}

async function attach(targetId, label = "target") {
    const { sessionId } = await cdp.send("Target.attachToTarget", { targetId, flatten: true });
    try {
        await cdp.send("Runtime.enable", {}, sessionId);
    } catch (error) {
        await cdp.send("Target.detachFromTarget", { sessionId }).catch(() => undefined);
        const message = error instanceof Error ? error.message : String(error);
        throw new Error(`${label} Runtime.enable failed: ${message}`);
    }
    return sessionId;
}

async function evaluate(sessionId, expression, label = "Runtime.evaluate") {
    let result;
    try {
        result = await cdp.send(
            "Runtime.evaluate",
            { expression, awaitPromise: true, returnByValue: true, timeout: 10000 },
            sessionId
        );
    } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        throw new Error(`${label}: ${message}`);
    }
    if (result.exceptionDetails) {
        const details = result.exceptionDetails.exception?.description || result.exceptionDetails.text || "evaluation failed";
        throw new Error(`${label}: ${details}`);
    }
    return result.result.value;
}

function sleep(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
}
