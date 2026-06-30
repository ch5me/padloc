#!/usr/bin/env node

import fs from "node:fs";
import http from "node:http";
import crypto from "node:crypto";
import path from "node:path";

const args = new Map();
for (let i = 2; i < process.argv.length; i += 1) {
    const key = process.argv[i];
    const next = process.argv[i + 1];
    if (!key.startsWith("--")) continue;
    const equalsIndex = key.indexOf("=");
    if (equalsIndex > 2) {
        args.set(key.slice(2, equalsIndex), key.slice(equalsIndex + 1));
        continue;
    }
    if (!next || next.startsWith("--")) {
        args.set(key.slice(2), "true");
    } else {
        args.set(key.slice(2), next);
        i += 1;
    }
}

const mode = args.get("mode") || "smoke";
const port = args.get("port") || "9800";
let extensionId = args.get("extension-id") || "";
const extensionPath = args.get("extension-path") || new URL("../dist", import.meta.url).pathname;
const PADLOC_AGENTIC_VAULT_AAGUID = "7a46cc38-26d9-47fe-9f3b-b52837c6020d";
const PADLOC_AGENTIC_VAULT_TRANSPORTS = ["internal"];
const PADLOC_AGENTIC_VAULT_AUTHENTICATOR_ATTACHMENT = "platform";

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

if (mode === "readiness-redaction-self-test") {
    const result = readinessRedactionSelfTest();
    console.log(JSON.stringify(result, null, 2));
    if (!result.ok) process.exitCode = 1;
    process.exit();
}

let cdp;
cdp = new Cdp();
await cdp.connect();

try {
    if (mode === "reload") {
        console.log(JSON.stringify(await reloadExtension(), null, 2));
    } else if (mode === "clear-storage") {
        await ensureExtensionId();
        console.log(JSON.stringify(await clearStorage(), null, 2));
    } else if (mode === "reset") {
        await reloadExtension();
        await clearStorage();
        console.log(JSON.stringify(await reloadExtension(), null, 2));
    } else if (mode === "smoke") {
        await ensureExtensionId();
        console.log(JSON.stringify(await smoke(), null, 2));
    } else if (mode === "readiness") {
        await ensureExtensionId();
        const result = await readiness();
        console.log(JSON.stringify(result, null, 2));
        if (!result.ok && args.get("fail-on-not-ready") !== "false") process.exitCode = 1;
    } else if (mode === "webauthn-proof") {
        await ensureExtensionId();
        const result = await webAuthnProof();
        console.log(JSON.stringify(result, null, 2));
        if (!result.ok) process.exitCode = 1;
    } else if (mode === "webauthn-io-proof") {
        await ensureExtensionId();
        const result = await webAuthnIoProof();
        console.log(JSON.stringify(result, null, 2));
        if (!result.ok) process.exitCode = 1;
    } else if (mode === "webauthn-me-proof") {
        await ensureExtensionId();
        const result = await webAuthnMeProof();
        console.log(JSON.stringify(result, null, 2));
        if (!result.ok) process.exitCode = 1;
    } else if (mode === "local-rp-webauthn-proof") {
        await ensureExtensionId();
        const result = await localRpWebAuthnProof();
        console.log(JSON.stringify(result, null, 2));
        if (!result.ok) process.exitCode = 1;
    } else if (mode === "inject-webauthn-hooks") {
        await ensureExtensionId();
        const result = await injectWebAuthnHooks();
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
    extensionId = loaded.id || extensionId;
    return { status: "reloaded", id: loaded.id, path: extensionPath };
}

async function ensureExtensionId() {
    if (extensionId) return extensionId;
    extensionId = await discoverExtensionId();
    return extensionId;
}

async function discoverExtensionId() {
    const targets = await cdp.send("Target.getTargets");
    const extensionTargets = (targets.targetInfos || [])
        .map((target) => {
            const match = String(target.url || "").match(/^chrome-extension:\/\/([^/]+)\//);
            return match ? { id: match[1], type: target.type, url: target.url || "" } : null;
        })
        .filter(Boolean);
    const serviceWorker = extensionTargets.find((target) => target.type === "service_worker" && /\/background\.js$/.test(target.url));
    const selected = serviceWorker || extensionTargets.find((target) => target.type === "page") || extensionTargets[0];
    if (!selected?.id) {
        throw new Error("extension id not provided and no loaded extension target was discoverable");
    }
    return selected.id;
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
            const created = await cdp.send("Target.createTarget", {
                url: `chrome-extension://${extensionId}/popup.html`,
            });
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

async function readiness() {
    const requireSignerKeys = args.get("require-signer-keys") !== "false";
    const probeOrigin = args.get("probe-origin") || "https://example.com/";
    const reasons = [];

    const extension = await readExtensionReadiness().catch((error) => ({
        loaded: false,
        id: extensionId,
        version: "",
        runtimeReachable: false,
        ping: "failed",
        error: safeReadinessError(error),
    }));
    if (!extension.loaded) reasons.push("extension_not_loaded");

    const vault = extension.loaded
        ? await readVaultReadiness().catch((error) => ({
              appReady: false,
              loggedIn: false,
              locked: true,
              unlocked: false,
              vaultCount: 0,
              passkeyCredentialCount: 0,
              error: safeReadinessError(error),
          }))
        : {
              appReady: false,
              loggedIn: false,
              locked: true,
              unlocked: false,
              vaultCount: 0,
              passkeyCredentialCount: 0,
          };
    if (!vault.unlocked) reasons.push("vault_locked");

    const signerStore = extension.loaded
        ? await readSignerStoreReadiness().catch((error) => ({
              available: false,
              hasKeys: false,
              keyCount: 0,
              error: safeReadinessError(error),
          }))
        : { available: false, hasKeys: false, keyCount: 0 };
    if (!signerStore.available || (requireSignerKeys && !signerStore.hasKeys)) reasons.push("signer_store_missing");

    const webAuthn = await readWebAuthnHookReadiness(probeOrigin).catch((error) => ({
        probeOrigin: originOnly(probeOrigin),
        createHooked: false,
        getHooked: false,
        error: safeReadinessError(error),
    }));
    if (!webAuthn.createHooked || !webAuthn.getHooked) reasons.push("webauthn_hooks_inactive");

    const passkeyIdentity = {
        aaguid: PADLOC_AGENTIC_VAULT_AAGUID,
        transports: [...PADLOC_AGENTIC_VAULT_TRANSPORTS],
        authenticatorAttachment: PADLOC_AGENTIC_VAULT_AUTHENTICATOR_ATTACHMENT,
        credPropsRk: true,
    };
    if (
        passkeyIdentity.transports.length !== 1 ||
        passkeyIdentity.transports[0] !== "internal" ||
        passkeyIdentity.authenticatorAttachment !== "platform"
    ) {
        reasons.push("unsupported_transport_shape");
    }

    const result = {
        status: "readiness",
        ok: reasons.length === 0,
        reasons,
        extension,
        vault,
        signerStore,
        webAuthn,
        passkeyIdentity,
        rpPolicy: {
            enforced: true,
            source: "per-passkey policy plus request binding",
            mismatchDecision: "deny",
        },
        outputPolicy: "metadata only; no cookies, challenges, OTPs, passwords, private keys, signer handles, or raw vault fields",
    };
    assertReadinessRedacted(result);
    return result;
}

async function readExtensionReadiness() {
    const sessionId = await attachExtensionPage();
    const result = await evaluate(
        sessionId,
        `(async () => new Promise((resolve) => {
            const runtime = globalThis.chrome?.runtime;
            if (!runtime) {
                resolve({ loaded: false, id: ${JSON.stringify(extensionId)}, version: "", runtimeReachable: false, ping: "missing" });
                return;
            }
            let version = "";
            try {
                version = runtime.getManifest()?.version || "";
            } catch {}
            runtime.sendMessage(runtime.id, { type: "ping" }, (resp) => {
                const lastError = runtime.lastError?.message || "";
                const pong = resp?.type === "pong";
                resolve({
                    loaded: Boolean(runtime.id && pong),
                    id: runtime.id || ${JSON.stringify(extensionId)},
                    version,
                    runtimeReachable: Boolean(runtime.id),
                    ping: pong ? "pong" : "missing",
                    error: lastError ? "runtime_message_failed" : ""
                });
            });
        }))()`,
        "extension readiness ping"
    );
    return normalizeReadinessRecord(result, {
        loaded: false,
        id: extensionId,
        version: "",
        runtimeReachable: false,
        ping: "missing",
        error: "",
    });
}

async function readVaultReadiness() {
    const sessionId = await attachExtensionPage();
    const result = await evaluate(
        sessionId,
        `(() => {
            const app = document.querySelector("pl-extension-app")?.app;
            const vaults = Array.from(app?.vaults || []);
            const items = vaults.flatMap((vault) => Array.from(vault?.items || []));
            return {
                appReady: Boolean(app),
                loggedIn: Boolean(app?.state?.loggedIn),
                locked: Boolean(!app || app?.state?.locked || !app?.state?.loggedIn),
                unlocked: Boolean(app?.state?.loggedIn && !app?.state?.locked),
                vaultCount: vaults.length,
                passkeyCredentialCount: items.filter((item) => Boolean(item?.passkeyCredential?.credentialId)).length
            };
        })()`,
        "vault readiness"
    );
    return normalizeReadinessRecord(result, {
        appReady: false,
        loggedIn: false,
        locked: true,
        unlocked: false,
        vaultCount: 0,
        passkeyCredentialCount: 0,
    });
}

async function readSignerStoreReadiness() {
    const sessionId = await attachExtensionPage();
    const result = await evaluate(
        sessionId,
        `(async () => {
            if (!globalThis.indexedDB) return { available: false, hasKeys: false, keyCount: 0, error: "indexeddb_unavailable" };
            const openRequest = indexedDB.open("padloc-agentic-passkey-signers", 1);
            const db = await new Promise((resolve, reject) => {
                openRequest.onupgradeneeded = () => {
                    const database = openRequest.result;
                    if (!database.objectStoreNames.contains("keys")) database.createObjectStore("keys", { keyPath: "handle" });
                };
                openRequest.onsuccess = () => resolve(openRequest.result);
                openRequest.onerror = () => reject(openRequest.error || new Error("signer_store_open_failed"));
            });
            try {
                const tx = db.transaction("keys", "readonly");
                const countRequest = tx.objectStore("keys").count();
                const keyCount = await new Promise((resolve, reject) => {
                    countRequest.onsuccess = () => resolve(countRequest.result || 0);
                    countRequest.onerror = () => reject(countRequest.error || new Error("signer_store_count_failed"));
                });
                return { available: true, hasKeys: keyCount > 0, keyCount };
            } finally {
                db.close();
            }
        })()`,
        "signer store readiness"
    );
    return normalizeReadinessRecord(result, {
        available: false,
        hasKeys: false,
        keyCount: 0,
        error: "",
    });
}

async function readWebAuthnHookReadiness(probeOrigin) {
    const url = new URL(probeOrigin);
    const created = await cdp.send("Target.createTarget", { url: url.origin + "/" });
    const pageSession = await attach(created.targetId);
    try {
        await cdp.send("Page.enable", {}, pageSession);
        await sleep(1500);
        return await evaluate(
            pageSession,
            `(() => ({
                probeOrigin: ${JSON.stringify(url.origin)},
                createHooked: !String(navigator.credentials.create).includes("[native code]"),
                getHooked: !String(navigator.credentials.get).includes("[native code]")
            }))()`,
            "WebAuthn hook readiness"
        );
    } finally {
        await cdp.send("Target.closeTarget", { targetId: created.targetId }).catch(() => undefined);
    }
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

async function webAuthnIoProof() {
    const username = `padloc-agentic-${Date.now()}-${Math.floor(Math.random() * 1000000)}@example.com`;
    const cleanup =
        args.get("preserve-rp-passkeys") === "true"
            ? { ok: true, rpId: "webauthn.io", skipped: true, deletedCount: 0 }
            : await deletePasskeysForRpId("webauthn.io", "padloc-agentic-");
    if (!cleanup.ok) return { status: "webauthn-io-proof", ok: false, cleanup };
    const created = await cdp.send("Target.createTarget", { url: "about:blank" });
    const pageSession = await attach(created.targetId);
    await cdp.send("Page.enable", {}, pageSession);
    await clearCookiesForDomain(pageSession, "webauthn.io");
    await cdp
        .send(
            "Storage.clearDataForOrigin",
            {
                origin: "https://webauthn.io",
                storageTypes:
                    "appcache,cache_storage,cookies,file_systems,indexeddb,local_storage,service_workers,websql",
            },
            pageSession
        )
        .catch(() => undefined);
    await cdp.send("Page.navigate", { url: "https://webauthn.io/" }, pageSession);
    await sleep(3500);
    let pageState;
    try {
        const controls = await waitForWebAuthnIoState(pageSession, username, "controls", 15000);
        if (!controls.hasControls) {
            const existingPadlocCredential =
                controls.loginSuccess &&
                /7a46cc38-26d9-47fe-9f3b-b52837c6020d/.test(controls.text || "") &&
                /"internal"/.test(controls.text || "");
            pageState = existingPadlocCredential
                ? {
                      ...controls,
                      ok: true,
                      stage: "profile-existing",
                      registerSuccess: false,
                      loginSuccess: true,
                      existingCredential: true,
                      successIndicator: controls.successIndicator,
                  }
                : { ...controls, ok: false, stage: "controls", error: "timed out waiting for webauthn.io controls" };
        } else {
            await driveWebAuthnIoAction(pageSession, username, "register");
            const registration = await waitForWebAuthnIoState(pageSession, username, "register", 25000);
            if (!registration.registerSuccess) {
                pageState = { ...registration, ok: false, stage: "register", registerSuccess: false };
            } else {
                await driveWebAuthnIoAction(pageSession, username, "login");
                const authentication = await waitForWebAuthnIoState(pageSession, username, "login", 30000);
                pageState = {
                    ...authentication,
                    ok: authentication.loginSuccess,
                    stage: authentication.loginSuccess ? "complete" : "login",
                    registerSuccess: true,
                    loginSuccess: authentication.loginSuccess,
                    successIndicator: authentication.loginSuccess ? authentication.successIndicator : null,
                };
            }
        }
    } finally {
        await cdp.send("Target.closeTarget", { targetId: created.targetId }).catch(() => undefined);
    }

    return { status: "webauthn-io-proof", ok: Boolean(pageState?.ok), cleanup, pageState };
}

async function driveWebAuthnIoAction(sessionId, username, action) {
    const selector = action === "register" ? "#register-button" : "#login-button";
    try {
        return await evaluate(
            sessionId,
            `(() => {
                const username = ${JSON.stringify(username)};
                function setInput(selector, value) {
                    const input = document.querySelector(selector);
                    if (!input) throw new Error("missing input " + selector);
                    input.focus();
                    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set;
                    setter ? setter.call(input, value) : (input.value = value);
                    input.dispatchEvent(new InputEvent("input", { bubbles: true, inputType: "insertText", data: value }));
                    input.dispatchEvent(new Event("change", { bubbles: true }));
                }
                function setSelect(selector, value) {
                    const select = document.querySelector(selector);
                    if (!select) return;
                    select.value = value;
                    select.dispatchEvent(new Event("input", { bubbles: true }));
                    select.dispatchEvent(new Event("change", { bubbles: true }));
                }
                function setCheckbox(selector, checked) {
                    const input = document.querySelector(selector);
                    if (!input || input.checked === checked) return;
                    input.click();
                }
                function configure() {
                    setSelect("#optRegUserVerification", "required");
                    setSelect("#attachment", "platform");
                    setSelect("#discoverableCredential", "required");
                    setSelect("#attestation", "none");
                    setSelect("#optAuthUserVerification", "required");
                    setCheckbox("#optAlgEd25519", false);
                    setCheckbox("#optAlgRS256", false);
                    setCheckbox("#optAlgES256", true);
                }
                configure();
                setInput("#input-email", username);
                const button = document.querySelector(${JSON.stringify(selector)});
                if (!button) throw new Error("missing button " + ${JSON.stringify(selector)});
                button.click();
                return { ok: true, action: ${JSON.stringify(action)}, url: location.href };
            })()`,
            `webauthn.io ${action} action`,
            10000
        );
    } catch (error) {
        if (/navigated|closed|Cannot find context/i.test(error.message || "")) {
            return { ok: true, action, navigationInterruptedEvaluation: true };
        }
        throw error;
    }
}

async function waitForWebAuthnIoState(sessionId, username, stage, timeoutMs) {
    const deadline = Date.now() + timeoutMs;
    let last = null;
    while (Date.now() < deadline) {
        try {
            last = await readWebAuthnIoState(sessionId, username);
            if (stage === "controls" && (last.hasControls || last.loginSuccess)) return last;
            if (stage === "register" && (last.registerSuccess || hasWebAuthnIoError(last.error))) return last;
            if (stage === "login" && (last.loginSuccess || hasWebAuthnIoError(last.error))) return last;
        } catch (error) {
            last = {
                ok: false,
                stage,
                username,
                transientError: error?.message || String(error),
            };
        }
        await sleep(500);
    }
    return last || { ok: false, stage, username, error: `timed out waiting for ${stage}` };
}

function hasWebAuthnIoError(value) {
    return /error|failed|not allowed|denied/i.test(value || "");
}

async function readWebAuthnIoState(sessionId, username) {
    return await evaluate(
        sessionId,
        `(() => {
            const username = ${JSON.stringify(username)};
            const registerSuccessText = "Success! Now try to authenticate";
            const loginSuccessText = "You're logged in!";
            const bodyText = document.body?.innerText || "";
            const resultErrorText = [...document.querySelectorAll(".alert-danger,.text-danger,.error,#error,[role='alert']")]
                .map((node) => node.innerText || node.textContent || "")
                .join("\\n");
            const loginSuccess = bodyText.includes(loginSuccessText);
            return {
                url: location.href,
                title: document.title,
                createHooked: !String(navigator.credentials.create).includes("[native code]"),
                getHooked: !String(navigator.credentials.get).includes("[native code]"),
                username,
                hasControls: Boolean(document.querySelector("#input-email") && document.querySelector("#register-button")),
                registerSuccess: bodyText.includes(registerSuccessText),
                loginSuccess,
                error: resultErrorText,
                successIndicator: loginSuccess
                    ? bodyText.slice(bodyText.indexOf(loginSuccessText), bodyText.indexOf(loginSuccessText) + 240)
                    : null,
                text: bodyText.slice(0, 1200)
            };
        })()`,
        "webauthn.io page state",
        10000
    );
}

async function webAuthnMeProof() {
    const username = `padloc-agentic-${Date.now()}-${Math.floor(Math.random() * 1000000)}@example.com`;
    const created = await cdp.send("Target.createTarget", { url: "about:blank" });
    const pageSession = await attach(created.targetId);
    await cdp.send("Page.enable", {}, pageSession);
    await clearCookiesForDomain(pageSession, "webauthn.me");
    await cdp
        .send(
            "Storage.clearDataForOrigin",
            {
                origin: "https://www.webauthn.me",
                storageTypes: "all",
            },
            pageSession
        )
        .catch(() => undefined);
    await cdp
        .send(
            "Storage.clearDataForOrigin",
            {
                origin: "https://webauthn.me",
                storageTypes: "all",
            },
            pageSession
        )
        .catch(() => undefined);
    await cdp.send("Page.navigate", { url: "https://www.webauthn.me/" }, pageSession);
    await sleep(3500);
    let pageState;
    try {
        pageState = await evaluate(
            pageSession,
            `(async () => {
                const username = ${JSON.stringify(username)};
                const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
                const bodyText = () => document.body?.innerText || "";
                const hookState = (extra = {}) => ({
                    url: location.href,
                    title: document.title,
                    createHooked: !String(navigator.credentials.create).includes("[native code]"),
                    getHooked: !String(navigator.credentials.get).includes("[native code]"),
                    username,
                    ...extra
                });
                async function waitFor(predicate, timeoutMs, label) {
                    const deadline = Date.now() + timeoutMs;
                    let lastError = "";
                    while (Date.now() < deadline) {
                        try {
                            if (predicate()) return;
                        } catch (error) {
                            lastError = error?.message || String(error);
                        }
                        await sleep(250);
                    }
                    throw new Error("timed out waiting for " + label + (lastError ? ": " + lastError : ""));
                }
                function modalText() {
                    const modal = document.querySelector(".modal.active,.modal");
                    return modal ? (modal.innerText || modal.textContent || "") : "";
                }
                function setInput(selector, value) {
                    const input = document.querySelector(selector);
                    if (!input) throw new Error("missing input " + selector);
                    input.focus();
                    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set;
                    setter ? setter.call(input, value) : (input.value = value);
                    input.dispatchEvent(new InputEvent("input", { bubbles: true, inputType: "insertText", data: value }));
                    input.dispatchEvent(new Event("change", { bubbles: true }));
                }
                function click(selector) {
                    const el = document.querySelector(selector);
                    if (!el) throw new Error("missing button " + selector);
                    el.click();
                }
                try {
                    await waitFor(
                        () => document.querySelector(".tutorial-step-1-input") &&
                            typeof document.querySelector(".tutorial-step-1-register")?.onclick === "function",
                        20000,
                        "webauthn.me tutorial handlers"
                    );
                    setInput(".tutorial-step-1-input", username);
                    click(".tutorial-step-1-register");
                    await waitFor(
                        () => (document.querySelector("#tutorial-step-3-data-raw-id")?.textContent || "").length > 0 ||
                            /not allowed|denied|failed|error/i.test(modalText()),
                        35000,
                        "webauthn.me registration result"
                    );
                    const rawIdLength = (document.querySelector("#tutorial-step-3-data-raw-id")?.textContent || "").length;
                    const publicKeyPresent = (document.querySelector("#tutorial-step-3-data-public-key")?.textContent || "").length > 0;
                    if (!rawIdLength) {
                        return hookState({
                            ok: false,
                            stage: "register",
                            error: modalText(),
                            text: bodyText().slice(0, 1200)
                        });
                    }
                    await waitFor(
                        () => typeof document.querySelector(".tutorial-step-3-next")?.onclick === "function",
                        10000,
                        "webauthn.me next control"
                    );
                    click(".tutorial-step-3-next");
                    await waitFor(
                        () => typeof document.querySelector(".tutorial-step-4-login")?.onclick === "function",
                        15000,
                        "webauthn.me login control"
                    );
                    click(".tutorial-step-4-login");
                    await waitFor(
                        () => bodyText().includes("Login Successful") || /not allowed|denied|failed|error/i.test(modalText()),
                        35000,
                        "webauthn.me login result"
                    );
                    const text = bodyText();
                    return hookState({
                        ok: text.includes("Login Successful"),
                        stage: text.includes("Login Successful") ? "complete" : "login",
                        registerSuccess: true,
                        loginSuccess: text.includes("Login Successful"),
                        rawIdLength,
                        publicKeyPresent,
                        error: text.includes("Login Successful") ? "" : modalText(),
                        successIndicator: text.includes("Login Successful")
                            ? text.slice(text.indexOf("Login Successful"), text.indexOf("Login Successful") + 180)
                            : null,
                        text: text.slice(0, 1200)
                    });
                } catch (error) {
                    return hookState({
                        ok: false,
                        stage: "exception",
                        error: error?.message || String(error),
                        text: bodyText().slice(0, 1200)
                    });
                }
            })()`,
            "webauthn.me WebAuthn proof",
            100000
        );
    } finally {
        await cdp.send("Target.closeTarget", { targetId: created.targetId }).catch(() => undefined);
    }

    return { status: "webauthn-me-proof", ok: Boolean(pageState?.ok), pageState };
}

async function localRpWebAuthnProof() {
    const rp = await startLocalWebAuthnRpServer();
    const created = await cdp.send("Target.createTarget", { url: "about:blank" });
    const pageSession = await attach(created.targetId);
    await cdp.send("Page.enable", {}, pageSession);
    await cdp
        .send(
            "Storage.clearDataForOrigin",
            {
                origin: rp.origin,
                storageTypes:
                    "appcache,cache_storage,cookies,file_systems,indexeddb,local_storage,service_workers,websql",
            },
            pageSession
        )
        .catch(() => undefined);
    await cdp.send("Page.navigate", { url: rp.origin }, pageSession);
    await sleep(1200);
    let pageState;
    try {
        pageState = await evaluate(
            pageSession,
            `(async () => {
                function b64urlToBytes(value) {
                    const padded = value.replace(/-/g, "+").replace(/_/g, "/") + "=".repeat((4 - value.length % 4) % 4);
                    const binary = atob(padded);
                    const bytes = new Uint8Array(binary.length);
                    for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
                    return bytes;
                }
                function bytesToB64url(buffer) {
                    const bytes = new Uint8Array(buffer);
                    let binary = "";
                    for (const byte of bytes) binary += String.fromCharCode(byte);
                    return btoa(binary).replace(/\\+/g, "-").replace(/\\//g, "_").replace(/=+$/g, "");
                }
                async function jsonFetch(path, payload) {
                    const response = await fetch(path, {
                        method: payload ? "POST" : "GET",
                        headers: payload ? { "content-type": "application/json" } : undefined,
                        body: payload ? JSON.stringify(payload) : undefined
                    });
                    const body = await response.json();
                    if (!response.ok) throw new Error(body.error || "request failed: " + path);
                    return body;
                }
                function hookState(extra = {}) {
                    return {
                        url: location.href,
                        title: document.title,
                        createHooked: !String(navigator.credentials.create).includes("[native code]"),
                        getHooked: !String(navigator.credentials.get).includes("[native code]"),
                        ...extra
                    };
                }
                function publicKeyCredentialToJson(credential) {
                    return {
                        id: credential.id,
                        type: credential.type,
                        rawId: bytesToB64url(credential.rawId),
                        authenticatorAttachment: credential.authenticatorAttachment || "",
                        clientExtensionResults: credential.getClientExtensionResults ? credential.getClientExtensionResults() : {},
                        response: {
                            attestationObject: credential.response.attestationObject ? bytesToB64url(credential.response.attestationObject) : "",
                            authenticatorData: credential.response.authenticatorData ? bytesToB64url(credential.response.authenticatorData) : "",
                            clientDataJSON: bytesToB64url(credential.response.clientDataJSON),
                            signature: credential.response.signature ? bytesToB64url(credential.response.signature) : "",
                            userHandle: credential.response.userHandle ? bytesToB64url(credential.response.userHandle) : "",
                            transports: credential.response.getTransports ? credential.response.getTransports() : []
                        }
                    };
                }
                try {
                    const registrationOptions = await jsonFetch("/register/options");
                    const createCredential = await navigator.credentials.create({
                        publicKey: {
                            ...registrationOptions.publicKey,
                            challenge: b64urlToBytes(registrationOptions.publicKey.challenge),
                            user: {
                                ...registrationOptions.publicKey.user,
                                id: b64urlToBytes(registrationOptions.publicKey.user.id)
                            }
                        }
                    });
                    const registration = await jsonFetch("/register/verify", publicKeyCredentialToJson(createCredential));
                    if (!registration.ok) return hookState({ ok: false, stage: "register-verify", registration });

                    const authenticationOptions = await jsonFetch("/authenticate/options");
                    const assertion = await navigator.credentials.get({
                        publicKey: {
                            ...authenticationOptions.publicKey,
                            challenge: b64urlToBytes(authenticationOptions.publicKey.challenge),
                            allowCredentials: authenticationOptions.publicKey.allowCredentials.map((item) => ({
                                ...item,
                                id: b64urlToBytes(item.id)
                            }))
                        }
                    });
                    const authentication = await jsonFetch("/authenticate/verify", publicKeyCredentialToJson(assertion));
                    return hookState({
                        ok: Boolean(registration.ok && authentication.ok),
                        stage: authentication.ok ? "complete" : "authenticate-verify",
                        registration,
                        authentication,
                        nativeChooserAvoided: Boolean(
                            registration.ok &&
                            authentication.ok &&
                            registration.aaguid === "7a46cc38-26d9-47fe-9f3b-b52837c6020d" &&
                            Array.isArray(registration.transports) &&
                            registration.transports.length === 1 &&
                            registration.transports[0] === "internal"
                        )
                    });
                } catch (error) {
                    return hookState({
                        ok: false,
                        stage: "exception",
                        error: { name: error?.name || "", message: error?.message || String(error) }
                    });
                }
            })()`,
            "local RP WebAuthn proof",
            60000
        );
    } finally {
        await cdp.send("Target.closeTarget", { targetId: created.targetId }).catch(() => undefined);
        await rp.close();
    }

    return { status: "local-rp-webauthn-proof", ok: Boolean(pageState?.ok), pageState };
}

async function injectWebAuthnHooks() {
    const sessionId = await attachWorker({ reloadOnUnresponsive: true });
    const urlMatch = args.get("url-match") || "https://*.google.com/*";
    const result = await evaluate(
        sessionId,
        `(async () => {
            if (!chrome.scripting?.executeScript) {
                return { ok: false, error: "chrome.scripting permission missing" };
            }
            const tabs = await chrome.tabs.query({ url: ${JSON.stringify(urlMatch)} });
            const results = [];
            function safeUrl(value) {
                try {
                    const url = new URL(value || "");
                    return url.origin + url.pathname;
                } catch {
                    return "";
                }
            }
            for (const tab of tabs) {
                if (!tab.id || !/^https:\\/\\/(accounts|myaccount)\\.google\\.com\\//.test(tab.url || "")) continue;
                const channel = "agentic-" + Date.now() + "-" + Math.random().toString(36).slice(2);
                const tabResult = { tabId: tab.id, url: safeUrl(tab.url), channel, injections: [] };
                try {
                    await chrome.scripting.executeScript({
                        target: { tabId: tab.id, allFrames: true },
                        world: "MAIN",
                        args: [channel],
                        func: (nextChannel) => {
                            document.documentElement.setAttribute("data-padloc-webauthn-channel", nextChannel);
                        }
                    });
                } catch (error) {
                    tabResult.injections.push({
                        file: "bridge-channel",
                        world: "MAIN",
                        ok: false,
                        error: error?.message || String(error)
                    });
                    results.push(tabResult);
                    continue;
                }
                for (const injection of [
                    { file: "content.js", world: "ISOLATED" },
                    { file: "webauthn-page.js", world: "MAIN" }
                ]) {
                    try {
                        const frames = await chrome.scripting.executeScript({
                            target: { tabId: tab.id, allFrames: true },
                            files: [injection.file],
                            world: injection.world
                        });
                        tabResult.injections.push({
                            file: injection.file,
                            world: injection.world,
                            ok: true,
                            frames: frames.length
                        });
                    } catch (error) {
                        tabResult.injections.push({
                            file: injection.file,
                            world: injection.world,
                            ok: false,
                            error: error?.message || String(error)
                        });
                    }
                }
                results.push(tabResult);
            }
            return {
                ok: results.length > 0 && results.every((tab) => tab.injections.every((item) => item.ok)),
                urlMatch: ${JSON.stringify(urlMatch)},
                tabs: results
            };
        })()`,
        "inject WebAuthn hooks"
    );
    return { status: "inject-webauthn-hooks", ...result };
}

async function clearCookiesForDomain(sessionId, domainSuffix) {
    await cdp.send("Network.enable", {}, sessionId).catch(() => undefined);
    const allCookies = await cdp.send("Network.getAllCookies", {}, sessionId).catch(() => ({ cookies: [] }));
    const targetCookies = (allCookies.cookies || []).filter((cookie) => {
        const domain = String(cookie.domain || "").replace(/^\./, "");
        return domain === domainSuffix || domain.endsWith(`.${domainSuffix}`);
    });
    for (const cookie of targetCookies) {
        await cdp
            .send(
                "Network.deleteCookies",
                {
                    name: cookie.name,
                    url: `https://${domainSuffix}/`,
                },
                sessionId
            )
            .catch(() => undefined);
    }
}

async function deletePasskeysForRpId(rpId, generatedNameFragment) {
    const sessionId = await attachExtensionPage();
    return evaluate(
        sessionId,
        `(async () => {
            const app = document.querySelector("pl-extension-app")?.app;
            if (!app?.state?.loggedIn || app?.state?.locked) {
                return { ok: false, rpId: ${JSON.stringify(rpId)}, reason: "extension vault locked" };
            }
            const items = Array.from(app.vaults || [])
                .flatMap((vault) => Array.from(vault.items || []))
                .filter((item) => item?.passkeyCredential?.rpId === ${JSON.stringify(rpId)})
                .filter((item) => String(item?.name || "").includes(${JSON.stringify(generatedNameFragment)}));
            if (items.length) await app.deleteItems(items);
            return { ok: true, rpId: ${JSON.stringify(rpId)}, generatedNameFragment: ${JSON.stringify(
            generatedNameFragment
        )}, deletedCount: items.length };
        })()`,
        `delete ${rpId} passkeys`,
        30000
    );
}

async function startLocalWebAuthnRpServer() {
    const state = {
        rpId: "localhost",
        origin: "",
        registrationChallenge: "",
        authenticationChallenge: "",
        credential: null,
    };
    const userId = randomBase64Url(16);
    const server = http.createServer(async (req, res) => {
        try {
            const url = new URL(req.url || "/", state.origin || "http://localhost");
            if (req.method === "GET" && url.pathname === "/") {
                res.writeHead(200, {
                    "content-type": "text/html; charset=utf-8",
                    "cache-control": "no-store",
                });
                res.end(`<!doctype html><title>Padloc Local WebAuthn RP</title><main>Padloc Local WebAuthn RP</main>`);
                return;
            }
            if (req.method === "GET" && url.pathname === "/register/options") {
                state.registrationChallenge = randomBase64Url(32);
                sendJson(res, 200, {
                    publicKey: {
                        challenge: state.registrationChallenge,
                        rp: { id: state.rpId, name: "Padloc Local WebAuthn RP" },
                        user: {
                            id: userId,
                            name: "padloc-agentic-local-rp@example.test",
                            displayName: "Padloc Agentic Local RP",
                        },
                        pubKeyCredParams: [{ type: "public-key", alg: -7 }],
                        timeout: 60000,
                        attestation: "none",
                        authenticatorSelection: {
                            authenticatorAttachment: "platform",
                            residentKey: "required",
                            requireResidentKey: true,
                            userVerification: "required",
                        },
                        extensions: { credProps: true },
                    },
                });
                return;
            }
            if (req.method === "POST" && url.pathname === "/register/verify") {
                const payload = await readJsonBody(req);
                const verification = verifyLocalRegistration(payload, state);
                state.credential = verification.credential;
                delete verification.credential;
                sendJson(res, verification.ok ? 200 : 400, verification);
                return;
            }
            if (req.method === "GET" && url.pathname === "/authenticate/options") {
                if (!state.credential) {
                    sendJson(res, 400, { ok: false, error: "credential missing" });
                    return;
                }
                state.authenticationChallenge = randomBase64Url(32);
                sendJson(res, 200, {
                    publicKey: {
                        challenge: state.authenticationChallenge,
                        timeout: 60000,
                        rpId: state.rpId,
                        allowCredentials: [
                            {
                                id: state.credential.credentialId,
                                type: "public-key",
                                transports: ["internal"],
                            },
                        ],
                        userVerification: "required",
                    },
                });
                return;
            }
            if (req.method === "POST" && url.pathname === "/authenticate/verify") {
                const payload = await readJsonBody(req);
                const verification = verifyLocalAuthentication(payload, state);
                sendJson(res, verification.ok ? 200 : 400, verification);
                return;
            }
            sendJson(res, 404, { ok: false, error: "not found" });
        } catch (error) {
            sendJson(res, 500, { ok: false, error: error instanceof Error ? error.message : String(error) });
        }
    });
    await new Promise((resolve, reject) => {
        server.listen(0, "localhost", resolve);
        server.once("error", reject);
    });
    const address = server.address();
    state.origin = `http://localhost:${address.port}`;
    return {
        origin: state.origin,
        close: () => new Promise((resolve) => server.close(resolve)),
    };
}

function verifyLocalRegistration(payload, state) {
    const clientDataBytes = base64UrlToBytes(payload.response?.clientDataJSON || "");
    const clientData = JSON.parse(new TextDecoder().decode(clientDataBytes));
    const attestationObject = decodeCbor(base64UrlToBytes(payload.response?.attestationObject || ""));
    const parsedAuthData = parseAuthenticatorData(attestationObject.authData, { expectAttestedCredentialData: true });
    const credentialId = bytesToBase64Url(parsedAuthData.credentialId);
    const publicKey = coseKeyToPublicKey(parsedAuthData.credentialPublicKey);
    const expectedRpIdHash = sha256Bytes(new TextEncoder().encode(state.rpId));
    const transports = payload.response?.transports || [];
    const credPropsRk = payload.clientExtensionResults?.credProps?.rk === true;

    const checks = {
        type: clientData.type === "webauthn.create",
        challenge: clientData.challenge === state.registrationChallenge,
        origin: clientData.origin === state.origin,
        rpIdHash: bytesEqual(parsedAuthData.rpIdHash, expectedRpIdHash),
        userPresent: parsedAuthData.flags.userPresent,
        userVerified: parsedAuthData.flags.userVerified,
        backupEligible: parsedAuthData.flags.backupEligible,
        backupState: parsedAuthData.flags.backupState,
        attestedCredentialData: parsedAuthData.flags.attestedCredentialData,
        aaguid: parsedAuthData.aaguid === "7a46cc38-26d9-47fe-9f3b-b52837c6020d",
        signCount: parsedAuthData.signCount === 0,
        fmt: attestationObject.fmt === "none",
        attStmt: Object.keys(attestationObject.attStmt || {}).length === 0,
        credentialId: payload.rawId === credentialId,
        algorithm: publicKey.algorithm === -7,
        transports: transports.length === 1 && transports[0] === "internal",
        authenticatorAttachment: payload.authenticatorAttachment === "platform",
        credPropsRk,
    };
    const ok = Object.values(checks).every(Boolean);
    return {
        ok,
        checks,
        aaguid: parsedAuthData.aaguid,
        flagsHex: toHexByte(parsedAuthData.flagsByte),
        flags: parsedAuthData.flags,
        signCount: parsedAuthData.signCount,
        fmt: attestationObject.fmt,
        transports,
        authenticatorAttachment: payload.authenticatorAttachment || "",
        credPropsRk,
        credentialIdLength: parsedAuthData.credentialId.length,
        publicKeyAlgorithm: publicKey.algorithm,
        serverRegistrationVerified: ok,
        credential: {
            credentialId,
            publicKey,
            signCount: parsedAuthData.signCount,
        },
    };
}

function verifyLocalAuthentication(payload, state) {
    if (!state.credential) throw new Error("credential missing");
    const clientDataBytes = base64UrlToBytes(payload.response?.clientDataJSON || "");
    const clientData = JSON.parse(new TextDecoder().decode(clientDataBytes));
    const authDataBytes = base64UrlToBytes(payload.response?.authenticatorData || "");
    const signature = base64UrlToBytes(payload.response?.signature || "");
    const parsedAuthData = parseAuthenticatorData(authDataBytes, { expectAttestedCredentialData: false });
    const expectedRpIdHash = sha256Bytes(new TextEncoder().encode(state.rpId));
    const signedData = concatBytes(authDataBytes, sha256Bytes(clientDataBytes));
    const signatureVerified = crypto.verify(
        "sha256",
        Buffer.from(signedData),
        { key: state.credential.publicKey.keyObject, dsaEncoding: "der" },
        Buffer.from(signature)
    );
    const checks = {
        type: clientData.type === "webauthn.get",
        challenge: clientData.challenge === state.authenticationChallenge,
        origin: clientData.origin === state.origin,
        rpIdHash: bytesEqual(parsedAuthData.rpIdHash, expectedRpIdHash),
        credentialId: payload.rawId === state.credential.credentialId,
        userPresent: parsedAuthData.flags.userPresent,
        userVerified: parsedAuthData.flags.userVerified,
        backupEligible: parsedAuthData.flags.backupEligible,
        backupState: parsedAuthData.flags.backupState,
        signature: signatureVerified,
        signCount: parsedAuthData.signCount > state.credential.signCount,
    };
    const ok = Object.values(checks).every(Boolean);
    return {
        ok,
        checks,
        flagsHex: toHexByte(parsedAuthData.flagsByte),
        flags: parsedAuthData.flags,
        signCount: parsedAuthData.signCount,
        credentialIdLength: base64UrlToBytes(payload.rawId || "").length,
        serverSignatureVerified: signatureVerified,
        serverAuthenticationVerified: ok,
    };
}

async function readJsonBody(req) {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    const raw = Buffer.concat(chunks).toString("utf8");
    return raw ? JSON.parse(raw) : {};
}

function sendJson(res, status, body) {
    res.writeHead(status, {
        "content-type": "application/json; charset=utf-8",
        "cache-control": "no-store",
    });
    res.end(JSON.stringify(body));
}

function parseAuthenticatorData(bytes, { expectAttestedCredentialData }) {
    if (bytes.length < 37) throw new Error("authenticatorData too short");
    const flagsByte = bytes[32];
    const flags = decodeAuthenticatorFlags(flagsByte);
    const parsed = {
        rpIdHash: bytes.slice(0, 32),
        flagsByte,
        flags,
        signCount: readUint32(bytes, 33),
        aaguid: "",
        credentialId: new Uint8Array(),
        credentialPublicKey: null,
    };
    if (!expectAttestedCredentialData) return parsed;
    if (!flags.attestedCredentialData) throw new Error("attested credential data missing");
    const credentialIdLength = (bytes[53] << 8) | bytes[54];
    const credentialIdStart = 55;
    const credentialIdEnd = credentialIdStart + credentialIdLength;
    parsed.aaguid = formatUuid(bytes.slice(37, 53));
    parsed.credentialId = bytes.slice(credentialIdStart, credentialIdEnd);
    const decodedKey = decodeCborValue(bytes, credentialIdEnd);
    parsed.credentialPublicKey = decodedKey.value;
    if (decodedKey.offset !== bytes.length) throw new Error("unexpected trailing authenticator data");
    return parsed;
}

function coseKeyToPublicKey(coseKey) {
    const algorithm = coseKey[3];
    const x = coseKey[-2];
    const y = coseKey[-3];
    if (coseKey[1] !== 2 || algorithm !== -7 || coseKey[-1] !== 1) {
        throw new Error("unsupported COSE key");
    }
    if (!(x instanceof Uint8Array) || !(y instanceof Uint8Array) || x.length !== 32 || y.length !== 32) {
        throw new Error("invalid P-256 public key coordinates");
    }
    const jwk = {
        kty: "EC",
        crv: "P-256",
        x: bytesToBase64Url(x),
        y: bytesToBase64Url(y),
        ext: true,
    };
    return {
        algorithm,
        keyObject: crypto.createPublicKey({ key: jwk, format: "jwk" }),
    };
}

function decodeAuthenticatorFlags(flags) {
    return {
        userPresent: Boolean(flags & 0x01),
        userVerified: Boolean(flags & 0x04),
        backupEligible: Boolean(flags & 0x08),
        backupState: Boolean(flags & 0x10),
        attestedCredentialData: Boolean(flags & 0x40),
        extensionData: Boolean(flags & 0x80),
    };
}

function decodeCbor(bytes) {
    const decoded = decodeCborValue(bytes, 0);
    if (decoded.offset !== bytes.length) throw new Error("unexpected trailing CBOR data");
    return decoded.value;
}

function decodeCborValue(bytes, offset) {
    const first = bytes[offset++];
    const major = first >> 5;
    const additional = first & 0x1f;
    const length = readCborLength(bytes, offset, additional);
    offset = length.offset;
    if (major === 0) return { value: length.value, offset };
    if (major === 1) return { value: -1 - length.value, offset };
    if (major === 2) return { value: bytes.slice(offset, offset + length.value), offset: offset + length.value };
    if (major === 3) {
        const textBytes = bytes.slice(offset, offset + length.value);
        return { value: new TextDecoder().decode(textBytes), offset: offset + length.value };
    }
    if (major === 5) {
        const result = {};
        for (let index = 0; index < length.value; index += 1) {
            const key = decodeCborValue(bytes, offset);
            const value = decodeCborValue(bytes, key.offset);
            result[key.value] = value.value;
            offset = value.offset;
        }
        return { value: result, offset };
    }
    throw new Error(`unsupported CBOR major type ${major}`);
}

function readCborLength(bytes, offset, additional) {
    if (additional < 24) return { value: additional, offset };
    if (additional === 24) return { value: bytes[offset], offset: offset + 1 };
    if (additional === 25) return { value: (bytes[offset] << 8) | bytes[offset + 1], offset: offset + 2 };
    if (additional === 26) return { value: readUint32(bytes, offset), offset: offset + 4 };
    throw new Error(`unsupported CBOR additional info ${additional}`);
}

function readUint32(bytes, offset) {
    return ((bytes[offset] << 24) | (bytes[offset + 1] << 16) | (bytes[offset + 2] << 8) | bytes[offset + 3]) >>> 0;
}

function randomBase64Url(length) {
    return bytesToBase64Url(crypto.randomBytes(length));
}

function base64UrlToBytes(value) {
    const padded = value.replace(/-/g, "+").replace(/_/g, "/") + "=".repeat((4 - (value.length % 4)) % 4);
    return new Uint8Array(Buffer.from(padded, "base64"));
}

function bytesToBase64Url(bytes) {
    return Buffer.from(bytes).toString("base64url");
}

function sha256Bytes(bytes) {
    return new Uint8Array(crypto.createHash("sha256").update(Buffer.from(bytes)).digest());
}

function concatBytes(...arrays) {
    const total = arrays.reduce((sum, item) => sum + item.length, 0);
    const out = new Uint8Array(total);
    let offset = 0;
    for (const item of arrays) {
        out.set(item, offset);
        offset += item.length;
    }
    return out;
}

function bytesEqual(a, b) {
    if (a.length !== b.length) return false;
    return crypto.timingSafeEqual(Buffer.from(a), Buffer.from(b));
}

function formatUuid(bytes) {
    const hex = Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
    return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

function toHexByte(value) {
    return `0x${value.toString(16).padStart(2, "0")}`;
}

function normalizeReadinessRecord(value, defaults) {
    if (!value || typeof value !== "object" || Array.isArray(value)) return { ...defaults };
    const out = { ...defaults };
    for (const key of Object.keys(defaults)) {
        const next = value[key];
        if (
            typeof next === "string" ||
            typeof next === "number" ||
            typeof next === "boolean" ||
            Array.isArray(next)
        ) {
            out[key] = next;
        }
    }
    return out;
}

function safeReadinessError(error) {
    const message = error instanceof Error ? error.message : String(error || "");
    if (/timed out/i.test(message)) return "timeout";
    if (/missing|not found/i.test(message)) return "missing";
    if (/denied|permission/i.test(message)) return "permission_denied";
    if (/indexeddb/i.test(message)) return "indexeddb_unavailable";
    if (/runtime/i.test(message)) return "runtime_unavailable";
    return "unavailable";
}

function originOnly(value) {
    try {
        return new URL(value).origin;
    } catch {
        return "";
    }
}

function assertReadinessRedacted(value, pathParts = []) {
    if (Array.isArray(value)) {
        value.forEach((item, index) => assertReadinessRedacted(item, [...pathParts, String(index)]));
        return;
    }
    if (value && typeof value === "object") {
        for (const [key, nested] of Object.entries(value)) {
            const normalizedKey = key.replace(/[_-]/g, "").toLowerCase();
            if (
                normalizedKey === "value" ||
                normalizedKey.includes("privatekey") ||
                normalizedKey.includes("signerhandle") ||
                normalizedKey.includes("pkcs8") ||
                normalizedKey.includes("cookie") ||
                normalizedKey.includes("challenge") ||
                normalizedKey.includes("password") ||
                normalizedKey.includes("secret") ||
                normalizedKey.includes("token") ||
                normalizedKey.includes("otp")
            ) {
                throw new Error(`readiness output contains forbidden key ${[...pathParts, key].join(".")}`);
            }
            assertReadinessRedacted(nested, [...pathParts, key]);
        }
        return;
    }
    if (typeof value === "string" && /-----BEGIN [A-Z ]*PRIVATE KEY-----|Bearer\s+[A-Za-z0-9._-]{12,}/i.test(value)) {
        throw new Error(`readiness output contains forbidden string at ${pathParts.join(".") || "<root>"}`);
    }
}

function readinessRedactionSelfTest() {
    const good = {
        status: "readiness",
        ok: true,
        reasons: [],
        extension: { loaded: true, id: extensionId, version: "4.3.0", runtimeReachable: true, ping: "pong", error: "" },
        vault: {
            appReady: true,
            loggedIn: true,
            locked: false,
            unlocked: true,
            vaultCount: 1,
            passkeyCredentialCount: 1,
        },
        signerStore: { available: true, hasKeys: true, keyCount: 1, error: "" },
        webAuthn: { probeOrigin: "https://example.com", createHooked: true, getHooked: true },
        passkeyIdentity: {
            aaguid: PADLOC_AGENTIC_VAULT_AAGUID,
            transports: [...PADLOC_AGENTIC_VAULT_TRANSPORTS],
            authenticatorAttachment: PADLOC_AGENTIC_VAULT_AUTHENTICATOR_ATTACHMENT,
            credPropsRk: true,
        },
        rpPolicy: { enforced: true, source: "per-passkey policy plus request binding", mismatchDecision: "deny" },
        outputPolicy: "metadata only",
    };
    try {
        assertReadinessRedacted(good);
        let rejectedForbiddenKey = false;
        try {
            assertReadinessRedacted({ ...good, passkey: { signerHandle: "padloc-passkey-signer:raw" } });
        } catch {
            rejectedForbiddenKey = true;
        }
        let rejectedForbiddenString = false;
        try {
            assertReadinessRedacted({ ...good, audit: "-----BEGIN PRIVATE KEY-----" });
        } catch {
            rejectedForbiddenString = true;
        }
        return { status: "readiness-redaction-self-test", ok: rejectedForbiddenKey && rejectedForbiddenString };
    } catch (error) {
        return { status: "readiness-redaction-self-test", ok: false, error: safeReadinessError(error) };
    }
}

async function attachWorker({ reloadOnUnresponsive = false } = {}) {
    let openedPopup = false;
    let reloaded = false;
    let lastError = "";
    for (let attempt = 0; attempt < 10; attempt += 1) {
        const targets = await cdp.send("Target.getTargets");
        const worker = targets.targetInfos.find(
            (target) =>
                target.type === "service_worker" && (target.url || "").startsWith(`chrome-extension://${extensionId}/`)
        );
        if (worker) {
            try {
                return await attach(worker.targetId, "extension service worker");
            } catch (error) {
                lastError = error instanceof Error ? error.message : String(error);
                if (
                    reloadOnUnresponsive &&
                    !reloaded &&
                    /Runtime\.enable timed out|Runtime\.evaluate timed out/.test(lastError)
                ) {
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

async function evaluate(sessionId, expression, label = "Runtime.evaluate", timeoutMs = 10000) {
    let result;
    try {
        result = await cdp.send(
            "Runtime.evaluate",
            { expression, awaitPromise: true, returnByValue: true, timeout: timeoutMs },
            sessionId,
            timeoutMs + 5000
        );
    } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        throw new Error(`${label}: ${message}`);
    }
    if (result.exceptionDetails) {
        const details =
            result.exceptionDetails.exception?.description || result.exceptionDetails.text || "evaluation failed";
        throw new Error(`${label}: ${details}`);
    }
    return result.result.value;
}

function sleep(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
}
