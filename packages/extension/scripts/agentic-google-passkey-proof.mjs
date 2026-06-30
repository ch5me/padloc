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

const mode = args.get("mode") || "state";
const port = args.get("port") || "9800";
const account = args.get("account") || "zackattacktucker@gmail.com";
const allowNonDisposable = args.get("allow-non-disposable") === "true";
const evidenceDir = args.get("evidence-dir") || path.resolve(process.cwd(), ".sisyphus/evidence/oauth-fleet-passkey-2026-06-29");
const screenshots = args.get("screenshots") === "1" || args.get("screenshots") === "true";
const passkeysUrl = "https://myaccount.google.com/signinoptions/passkeys";
const loginUrl = `https://accounts.google.com/ServiceLogin?continue=${encodeURIComponent("https://myaccount.google.com/")}`;

if (!allowNonDisposable && account !== "zackattacktucker@gmail.com") {
    throw new Error("refusing non-disposable Google account; pass --allow-non-disposable only after disposable proof succeeds");
}

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

    send(method, params = {}, sessionId, timeoutMs = 20000) {
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
    const page = await googlePage();
    const sessionId = await attach(page.targetId);
    await cdp.send("Page.enable", {}, sessionId);
    let result;
    if (mode === "state") {
        await navigate(sessionId, passkeysUrl);
        const state = await pageState(sessionId);
        result = { status: state.needsGoogleReauth ? "blocked_google_reauth" : "ready", state };
    } else if (mode === "enroll") {
        result = await enroll(sessionId);
    } else if (mode === "login") {
        result = await login(sessionId);
    } else {
        throw new Error(`unknown mode ${mode}`);
    }
    console.log(JSON.stringify(redact(result), null, 2));
    if (mode !== "state" && result.status && result.status.startsWith("blocked_")) process.exitCode = 2;
    if (result.status && result.status.startsWith("failed_")) process.exitCode = 1;
} finally {
    cdp.close();
}

async function googlePage() {
    const targets = await cdp.send("Target.getTargets");
    const page = targets.targetInfos.find((target) => target.type === "page" && /accounts\.google\.com|myaccount\.google\.com/.test(target.url || ""))
        || targets.targetInfos.find((target) => target.type === "page" && !(target.url || "").startsWith("chrome-extension://"));
    if (page) return page;
    const created = await cdp.send("Target.createTarget", { url: passkeysUrl });
    return { targetId: created.targetId };
}

async function attach(targetId) {
    const { sessionId } = await cdp.send("Target.attachToTarget", { targetId, flatten: true });
    await cdp.send("Runtime.enable", {}, sessionId);
    return sessionId;
}

async function navigate(sessionId, url) {
    await cdp.send("Page.navigate", { url }, sessionId);
    await sleep(3500);
}

async function enroll(sessionId) {
    await navigate(sessionId, passkeysUrl);
    let state = await pageState(sessionId);
    if (state.needsGoogleReauth) {
        return { status: "blocked_google_reauth", state };
    }
    await maybeScreenshot(sessionId, "google-passkey-enroll-before");

    const start = await clickText(sessionId, [
        "Create a passkey",
        "Create passkey",
        "Add a passkey",
        "Add passkey",
        "Add security key",
    ]);
    if (!start.ok) return { status: "failed_enroll_button_missing", state, click: start };

    await sleep(1500);
    await clickText(sessionId, ["Continue", "Create", "Done"]);
    await sleep(5000);
    state = await pageState(sessionId);
    await maybeScreenshot(sessionId, "google-passkey-enroll-after");

    if (!state.createHooked || !state.getHooked) return { status: "failed_hooks_missing_after_enroll", state };
    if (/something went wrong|couldn.t create|try again/i.test(state.text)) return { status: "failed_google_enroll", state };
    if (/passkey created|passkey added|saved passkey|created a passkey|passkeys and security keys/i.test(state.text)) {
        return { status: "enrolled", state };
    }
    return { status: "unknown_enroll_state", state };
}

async function login(sessionId) {
    await navigate(sessionId, loginUrl);
    await typeAccountIfNeeded(sessionId);
    await clickText(sessionId, ["Next"]);
    await sleep(3500);

    let state = await pageState(sessionId);
    if (/enter your password/i.test(state.text)) {
        await clickText(sessionId, ["Try another way"]);
        await sleep(1500);
        await clickText(sessionId, ["Use your passkey", "Passkey"]);
        await sleep(1500);
    }
    await clickText(sessionId, ["Continue", "Use passkey", "Use your passkey"]);
    await sleep(7000);
    state = await pageState(sessionId);
    await maybeScreenshot(sessionId, "google-passkey-login-after");

    if (!state.createHooked || !state.getHooked) return { status: "failed_hooks_missing_after_login", state };
    if (/security delay|you can.t use this passkey yet|try again later/i.test(state.text)) {
        return { status: "blocked_google_security_delay", state };
    }
    if (/something went wrong|weren.t able to sign you in|try another way/i.test(state.text)) {
        return { status: "failed_google_login", state };
    }
    if (/my account|welcome|security|personal info/i.test(state.text) && /myaccount\.google\.com/.test(state.url)) {
        return { status: "logged_in", state };
    }
    return { status: "unknown_login_state", state };
}

async function typeAccountIfNeeded(sessionId) {
    return evaluate(
        sessionId,
        `(async () => {
            const account = ${JSON.stringify(account)};
            const input = document.querySelector('input[type="email"], input#identifierId');
            if (!input) return { ok: false, reason: "email input missing" };
            input.focus();
            input.value = account;
            input.dispatchEvent(new Event("input", { bubbles: true }));
            input.dispatchEvent(new Event("change", { bubbles: true }));
            return { ok: true };
        })()`,
        "type Google account"
    );
}

async function clickText(sessionId, labels) {
    return evaluate(
        sessionId,
        `(async () => {
            const labels = ${JSON.stringify(labels)};
            function deepElements(root = document) {
                const out = [];
                const visit = (node) => {
                    if (!node) return;
                    if (node.nodeType === Node.ELEMENT_NODE) {
                        out.push(node);
                        if (node.shadowRoot) visit(node.shadowRoot);
                    }
                    for (const child of node.children || []) visit(child);
                };
                visit(root);
                return out;
            }
            function visible(el) {
                const rect = el.getBoundingClientRect();
                const style = getComputedStyle(el);
                return rect.width > 0 && rect.height > 0 && style.visibility !== "hidden" && style.display !== "none";
            }
            const candidates = deepElements()
                .filter((el) => visible(el))
                .map((el) => ({ el, text: (el.innerText || el.textContent || "").replace(/\\s+/g, " ").trim() }))
                .filter((entry) => entry.text);
            for (const label of labels) {
                const lower = label.toLowerCase();
                const match = candidates.find((entry) => entry.text.toLowerCase() === lower)
                    || candidates.find((entry) => entry.text.toLowerCase().includes(lower));
                if (!match) continue;
                match.el.scrollIntoView({ block: "center", inline: "center" });
                await new Promise((resolve) => requestAnimationFrame(resolve));
                match.el.click();
                return { ok: true, text: match.text.slice(0, 120) };
            }
            return { ok: false, candidates: candidates.slice(0, 30).map((entry) => entry.text.slice(0, 120)) };
        })()`,
        `click ${labels.join(" | ")}`
    );
}

async function pageState(sessionId) {
    return evaluate(
        sessionId,
        `(() => {
            const text = document.body?.innerText || "";
            const url = location.href;
            const needsGoogleReauth = /accounts\\.google\\.com\\/v3\\/signin\\/challenge\\/(pwd|selection|pk)|To continue, first verify/i.test(url + "\\n" + text);
            return {
                url,
                title: document.title,
                createHooked: !String(navigator.credentials.create).includes("[native code]"),
                getHooked: !String(navigator.credentials.get).includes("[native code]"),
                needsGoogleReauth,
                text: text.slice(0, 4000)
            };
        })()`,
        "Google page state"
    );
}

async function maybeScreenshot(sessionId, name) {
    if (!screenshots) return null;
    fs.mkdirSync(evidenceDir, { recursive: true });
    const captured = await cdp.send("Page.captureScreenshot", { format: "png", captureBeyondViewport: true }, sessionId, 30000);
    const file = path.join(evidenceDir, `${name}.png`);
    fs.writeFileSync(file, Buffer.from(captured.data, "base64"));
    return file;
}

async function evaluate(sessionId, expression, label) {
    const result = await cdp.send("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true, timeout: 15000 }, sessionId);
    if (result.exceptionDetails) {
        const details = result.exceptionDetails.exception?.description || result.exceptionDetails.text || "evaluation failed";
        throw new Error(`${label}: ${details}`);
    }
    return result.result.value;
}

function redact(value) {
    if (typeof value === "string") return redactString(value);
    if (Array.isArray(value)) return value.map(redact);
    if (!value || typeof value !== "object") return value;
    const out = {};
    for (const [key, entry] of Object.entries(value)) out[key] = redact(entry);
    return out;
}

function redactString(value) {
    return value
        .replace(/zackattacktucker@gmail\\.com/g, "[redacted-google-account]")
        .replace(new RegExp(escapeRegExp(account), "gi"), "[redacted-google-account]")
        .replace(/hassoncs@gmail\\.com/g, "[redacted-forbidden-account]")
        .replace(/[A-Za-z0-9._%+-]+@elf\\.dance/g, "[redacted-padloc-agent]")
        .replace(/[?&](TL|dsh|rart|authuser|cid|lid|rpbg|continue|followup)=([^&]+)/g, (match, key) => match[0] + `${key}=[redacted]`)
        .replace(/Hi Zack/g, "Hi [redacted-name]")
        .replace(/\\bZack\\b/g, "[redacted-name]");
}

function escapeRegExp(value) {
    return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function sleep(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
}
