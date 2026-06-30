#!/usr/bin/env node

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
        console.log(JSON.stringify(await webAuthnProof(), null, 2));
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
            expression: `(async () => { await chrome.storage.local.clear(); await chrome.storage.session.clear(); return { ok: true, id: chrome.runtime.id }; })()`,
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
    const workerSession = await attachWorker();
    const workerState = await evaluate(
        workerSession,
        `(async () => {
            const bg = await fetch(chrome.runtime.getURL("background.js")).then((res) => res.text());
            return {
                id: chrome.runtime.id,
                hasMessageListeners: chrome.runtime.onMessage.hasListeners(),
                hasXhrGlobal: typeof XMLHttpRequest !== "undefined",
                hasHistoryGlobal: typeof history !== "undefined",
                hasImmediateBridge: bg.includes("registerImmediateMessageBridge"),
                importsAjaxSender: bg.includes("AjaxSender") || bg.includes("new XMLHttpRequest"),
                importsPageRouter: bg.includes("history.replaceState") || bg.includes("history.pushState") || bg.includes("window.router")
            };
        })()`
    );

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
        })()`
    );
    await cdp.send("Target.closeTarget", { targetId: created.targetId });

    return { status: "smoke", workerState, pageState };
}

async function webAuthnProof() {
    const created = await cdp.send("Target.createTarget", { url: "https://example.com/" });
    const pageSession = await attach(created.targetId);
    await cdp.send("Page.enable", {}, pageSession);
    await sleep(1500);
    const pageState = await evaluate(
        pageSession,
        `(async () => {
            function bufferToBase64Url(buffer) {
                const bytes = new Uint8Array(buffer);
                let binary = "";
                for (const byte of bytes) binary += String.fromCharCode(byte);
                return btoa(binary).replace(/\\+/g, "-").replace(/\\//g, "_").replace(/=+$/g, "");
            }
            const createCredential = await navigator.credentials.create({ publicKey: {
                challenge: crypto.getRandomValues(new Uint8Array(32)),
                rp: { id: "example.com", name: "Example" },
                user: { id: crypto.getRandomValues(new Uint8Array(16)), name: "agent@example.com", displayName: "Agent" },
                pubKeyCredParams: [{ type: "public-key", alg: -7 }],
                authenticatorSelection: { userVerification: "required" }
            }});
            const assertion = await navigator.credentials.get({ publicKey: {
                challenge: crypto.getRandomValues(new Uint8Array(32)),
                rpId: "example.com",
                allowCredentials: [{ type: "public-key", id: createCredential.rawId }],
                userVerification: "required"
            }});
            return {
                createHooked: !String(navigator.credentials.create).includes("[native code]"),
                getHooked: !String(navigator.credentials.get).includes("[native code]"),
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
            };
        })()`
    );
    await cdp.send("Target.closeTarget", { targetId: created.targetId });

    return { status: "webauthn-proof", pageState };
}

async function attachWorker() {
    let openedPopup = false;
    let lastError = "";
    for (let attempt = 0; attempt < 8; attempt += 1) {
        const targets = await cdp.send("Target.getTargets");
        const worker = targets.targetInfos.find(
            (target) => target.type === "service_worker" && (target.url || "").startsWith(`chrome-extension://${extensionId}/`)
        );
        if (worker) {
            try {
                return await attach(worker.targetId);
            } catch (error) {
                lastError = error instanceof Error ? error.message : String(error);
            }
        } else if (!openedPopup) {
            openedPopup = true;
            await cdp.send("Target.createTarget", { url: `chrome-extension://${extensionId}/popup.html` });
        }
        await sleep(500);
    }
    throw new Error(`extension service worker missing for ${extensionId}${lastError ? `: ${lastError}` : ""}`);
}

async function attach(targetId) {
    const { sessionId } = await cdp.send("Target.attachToTarget", { targetId, flatten: true });
    await cdp.send("Runtime.enable", {}, sessionId);
    return sessionId;
}

async function evaluate(sessionId, expression) {
    const result = await cdp.send(
        "Runtime.evaluate",
        { expression, awaitPromise: true, returnByValue: true, timeout: 10000 },
        sessionId
    );
    if (result.exceptionDetails) throw new Error(result.exceptionDetails.text || "evaluation failed");
    return result.result.value;
}

function sleep(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
}
