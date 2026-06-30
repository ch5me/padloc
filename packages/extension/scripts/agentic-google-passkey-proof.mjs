#!/usr/bin/env node

import fs from "node:fs";
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

const mode = args.get("mode") || "state";
const port = args.get("port") || "9800";
const account = args.get("account") || "zackattacktucker@gmail.com";
const allowNonDisposable = args.get("allow-non-disposable") === "true";
const passwordEnv = args.get("password-env") || defaultPasswordEnv(account);
const evidenceDir = args.get("evidence-dir") || path.resolve(process.cwd(), ".sisyphus/evidence/oauth-fleet-passkey-2026-06-29");
const screenshots = args.get("screenshots") === "1" || args.get("screenshots") === "true";
const passkeysUrl = "https://myaccount.google.com/signinoptions/passkeys";
const loginUrl = `https://accounts.google.com/ServiceLogin?continue=${encodeURIComponent("https://myaccount.google.com/")}`;
const logoutUrl = `https://accounts.google.com/Logout?continue=${encodeURIComponent(loginUrl)}`;

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

let sessionId;
try {
    const page = await googlePage();
    sessionId = await attach(page.targetId);
    let result;
    if (mode === "state") {
        await ensurePasskeysPage(sessionId);
        const state = await pageState(sessionId);
        result = { status: state.needsGoogleReauth ? "blocked_google_reauth" : "ready", state };
    } else if (mode === "clear-google-session") {
        result = await clearGoogleSession();
    } else if (mode === "password-login") {
        result = await passwordLogin(sessionId);
    } else if (mode === "enroll") {
        result = await enroll(sessionId);
    } else if (mode === "login") {
        result = await login(sessionId);
    } else {
        throw new Error(`unknown mode ${mode}`);
    }
    const redacted = redact(result);
    if (screenshots) writeJsonEvidence(mode, redacted);
    console.log(JSON.stringify(redacted, null, 2));
    if (mode !== "state" && result.status && result.status.startsWith("blocked_")) process.exitCode = 2;
    if (result.status && result.status.startsWith("failed_")) process.exitCode = 1;
} finally {
    if (sessionId) {
        await cdp.send("Target.detachFromTarget", { sessionId }).catch(() => undefined);
    }
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

async function ensurePasskeysPage(sessionId) {
    const url = await currentUrl(sessionId);
    if (/^https:\/\/myaccount\.google\.com\/signinoptions\/passkeys\b/.test(url)) return;
    await navigate(sessionId, passkeysUrl);
}

async function currentUrl(sessionId) {
    return evaluate(sessionId, "location.href", "current page URL");
}

async function clearGoogleSession() {
    const targets = await cdp.send("Target.getTargets");
    const googleTargets = targets.targetInfos.filter((target) => target.type === "page" && /accounts\.google\.com|myaccount\.google\.com|accounts\.youtube\.com/.test(target.url || ""));
    for (const target of googleTargets) {
        await cdp.send("Target.closeTarget", { targetId: target.targetId }).catch(() => undefined);
    }
    const blank = await cdp.send("Target.createTarget", { url: "about:blank" });
    const clearSessionId = await attach(blank.targetId);
    await cdp.send("Network.enable", {}, clearSessionId).catch(() => undefined);
    await cdp.send("Network.clearBrowserCookies", {}, clearSessionId);
    await cdp.send("Network.clearBrowserCache", {}, clearSessionId);
    for (const origin of ["https://accounts.google.com", "https://myaccount.google.com", "https://accounts.youtube.com"]) {
        await cdp.send("Storage.clearDataForOrigin", {
            origin,
            storageTypes: "appcache,cache_storage,cookies,file_systems,indexeddb,local_storage,service_workers,websql",
        }, clearSessionId).catch(() => undefined);
    }
    await cdp.send("Target.detachFromTarget", { sessionId: clearSessionId }).catch(() => undefined);
    await cdp.send("Target.closeTarget", { targetId: blank.targetId }).catch(() => undefined);
    const created = await cdp.send("Target.createTarget", { url: loginUrl });
    return {
        status: "google_session_cleared",
        targetId: created.targetId,
        closedGoogleTargets: googleTargets.length,
    };
}

async function enroll(sessionId) {
    await ensurePasskeysPage(sessionId);
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

    if (/passkey created|passkey added|saved passkey|created a passkey|passkeys and security keys/i.test(state.text)) {
        return { status: "enrolled", state };
    }
    if (!state.createHooked || !state.getHooked) return { status: "failed_hooks_missing_after_enroll", state };
    if (/something went wrong|couldn.t create|try again/i.test(state.text)) return { status: "failed_google_enroll", state };
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
    }
    state = await pageState(sessionId);
    if (/use your passkey/i.test(state.text)) {
        await clickText(sessionId, ["Use your passkey", "Passkey"]);
        await sleep(2500);
    }
    await clickText(sessionId, ["Continue"]);
    state = await waitForLoginCompletion(sessionId, 25000);
    await maybeScreenshot(sessionId, "google-passkey-login-after");

    if (!state.createHooked || !state.getHooked) return { status: "failed_hooks_missing_after_login", state };
    if (/security delay|you can.t use this passkey yet|try again later/i.test(state.text)) {
        return { status: "blocked_google_security_delay", state };
    }
    if (/your key requires a password to sign in|2-Step Verification only security key/i.test(state.text)) {
        return { status: "failed_google_2sv_only_security_key", state };
    }
    if (/choose how you want to sign in|enter your password/i.test(state.text) && !/use your passkey|security key|fingerprint|face|screen lock/i.test(state.text)) {
        return { status: "blocked_google_password_required_no_passkey_offer", state };
    }
    if (/something went wrong|weren.t able to sign you in/i.test(state.text)) {
        return { status: "failed_google_login", state };
    }
    if (new URL(state.url).host === "myaccount.google.com") {
        return { status: "logged_in", state };
    }
    return { status: "unknown_login_state", state };
}

async function passwordLogin(sessionId) {
    const password = process.env[passwordEnv];
    if (!password) {
        return { status: "blocked_missing_password_env", passwordEnv, state: await pageState(sessionId) };
    }
    await navigate(sessionId, logoutUrl);
    await sleep(2500);
    await clickText(sessionId, ["Use another account"]);
    await sleep(1000);
    await typeAccountIfNeeded(sessionId);
    await clickText(sessionId, ["Next"]);
    await sleep(2500);

    await driveToPasswordInput(sessionId);
    const passwordFilled = await typePasswordIfNeeded(sessionId, password);
    if (passwordFilled.ok) {
        await clickText(sessionId, ["Next"]);
    }
    let state = await waitForPasswordLoginCompletion(sessionId, 90000);
    await maybeScreenshot(sessionId, "google-password-login-after");

    if (!state.createHooked || !state.getHooked) return { status: "failed_hooks_missing_after_password_login", state };
    if (new URL(state.url).host === "myaccount.google.com") return { status: "logged_in", state };
    if (/2-step|verify|check your phone|tap yes|to continue, first verify|enter the code|recovery/i.test(state.text)) {
        return { status: "blocked_google_2fa_or_reauth", state };
    }
    if (/wrong password|couldn.t sign you in|something went wrong/i.test(state.text)) {
        return { status: "failed_google_password_login", state };
    }
    return { status: "unknown_password_login_state", passwordFilled, state };
}

async function driveToPasswordInput(sessionId) {
    for (let attempt = 0; attempt < 6; attempt += 1) {
        const hasPassword = await hasPasswordInput(sessionId);
        if (hasPassword) return { ok: true };
        const state = await pageState(sessionId);
        if (/use your passkey|fingerprint|face|screen lock/i.test(state.text)) {
            await clickText(sessionId, ["Try another way"]);
        } else {
            await clickText(sessionId, ["Password", "Enter your password", "Try another way"]);
        }
        await sleep(1500);
    }
    return { ok: false };
}

async function hasPasswordInput(sessionId) {
    return evaluate(
        sessionId,
        `Boolean(document.querySelector('input[type="password"], input[name="Passwd"]'))`,
        "check password input"
    );
}

async function waitForPasswordLoginCompletion(sessionId, timeoutMs) {
    const started = Date.now();
    let latest = await pageState(sessionId);
    while (Date.now() - started < timeoutMs) {
        const host = new URL(latest.url).host;
        if (host === "myaccount.google.com") return latest;
        if (/wrong password|couldn.t sign you in|something went wrong/i.test(latest.text)) return latest;
        await sleep(1000);
        latest = await pageState(sessionId);
    }
    return latest;
}

async function waitForLoginCompletion(sessionId, timeoutMs) {
    const started = Date.now();
    let latest = await pageState(sessionId);
    while (Date.now() - started < timeoutMs) {
        if (new URL(latest.url).host === "myaccount.google.com" && (latest.title || latest.text)) return latest;
        if (/security delay|you can.t use this passkey yet|try again later|your key requires a password to sign in|2-Step Verification only security key|something went wrong|weren.t able to sign you in/i.test(latest.text)) {
            return latest;
        }
        if (/choose how you want to sign in|enter your password/i.test(latest.text) && !/use your passkey|security key|fingerprint|face|screen lock/i.test(latest.text)) {
            return latest;
        }
        await sleep(1000);
        latest = await pageState(sessionId);
    }
    return latest;
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

async function typePasswordIfNeeded(sessionId, password) {
    return evaluate(
        sessionId,
        `(async () => {
            const password = ${JSON.stringify(password)};
            const input = document.querySelector('input[type="password"], input[name="Passwd"]');
            if (!input) return { ok: false, reason: "password input missing" };
            input.focus();
            input.value = password;
            input.dispatchEvent(new Event("input", { bubbles: true }));
            input.dispatchEvent(new Event("change", { bubbles: true }));
            return { ok: true };
        })()`,
        "type Google password"
    );
}

async function clickText(sessionId, labels) {
    return evaluate(
        sessionId,
        `(async () => {
            const labels = ${JSON.stringify(labels)};
            const ACTION_SELECTOR = [
                "button",
                "a[href]",
                "[role=button]",
                "[role=link]",
                "[role=menuitem]",
                "[role=option]",
                "[data-challengetype]",
                "input[type=button]",
                "input[type=submit]"
            ].join(",");
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
            function labelFor(el) {
                return [
                    el.getAttribute("aria-label"),
                    el.getAttribute("title"),
                    el.value,
                    el.innerText,
                    el.textContent
                ].filter(Boolean).join(" ").replace(/\\s+/g, " ").trim();
            }
            function actionableFor(el) {
                const direct = el.matches(ACTION_SELECTOR) ? el : el.closest(ACTION_SELECTOR);
                if (direct && visible(direct)) return direct;
                return el;
            }
            function escapeRegex(value) {
                return value.replace(/[-/\\\\^$*+?.()|[\\]{}]/g, "\\\\$&");
            }
            function score(entry, label) {
                const text = entry.text.toLowerCase();
                const lower = label.toLowerCase();
                const rect = entry.target.getBoundingClientRect();
                const area = Math.max(1, rect.width * rect.height);
                const exact = text === lower ? 0 : 1000;
                const wordish = new RegExp("\\\\b" + escapeRegex(lower) + "\\\\b").test(text) ? 0 : 100;
                const action = entry.target.matches(ACTION_SELECTOR) ? 0 : 10;
                const containerPenalty = /^(HTML|BODY|MAIN|SECTION)$/.test(entry.target.tagName) ? 5000 : 0;
                return exact + wordish + action + containerPenalty + Math.min(area / 1000, 1000);
            }
            const seenTargets = new Set();
            const candidates = deepElements()
                .filter((el) => visible(el))
                .map((el) => {
                    const target = actionableFor(el);
                    const text = labelFor(target) || labelFor(el);
                    return { el, target, text };
                })
                .filter((entry) => {
                    if (!entry.text || seenTargets.has(entry.target)) return false;
                    seenTargets.add(entry.target);
                    return true;
                });
            for (const label of labels) {
                const lower = label.toLowerCase();
                const matches = candidates
                    .filter((entry) => {
                        const text = entry.text.toLowerCase();
                        return text === lower || text.includes(lower);
                    })
                    .sort((a, b) => score(a, label) - score(b, label));
                const match = matches[0];
                if (!match) continue;
                match.target.scrollIntoView({ block: "center", inline: "center" });
                await new Promise((resolve) => requestAnimationFrame(resolve));
                match.target.click();
                return {
                    ok: true,
                    text: match.text.slice(0, 120),
                    tag: match.target.tagName,
                    role: match.target.getAttribute("role") || "",
                    ariaLabel: match.target.getAttribute("aria-label") || ""
                };
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
    await redactPageForScreenshot(sessionId);
    await enablePageForScreenshot(sessionId);
    try {
        const captured = await cdp.send("Page.captureScreenshot", { format: "png", captureBeyondViewport: true }, sessionId, 30000);
        const file = path.join(evidenceDir, `${name}.png`);
        fs.writeFileSync(file, Buffer.from(captured.data, "base64"));
        return file;
    } catch (error) {
        console.error(`[agentic-google-passkey-proof] screenshot skipped: ${redactString(error.message)}`);
        return null;
    }
}

async function enablePageForScreenshot(sessionId) {
    try {
        await cdp.send("Page.enable", {}, sessionId, 5000);
    } catch (error) {
        console.error(`[agentic-google-passkey-proof] Page.enable skipped: ${redactString(error.message)}`);
    }
}

async function redactPageForScreenshot(sessionId) {
    await evaluate(
        sessionId,
        `(() => {
            const account = ${JSON.stringify(account)};
            const emailPattern = /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\\.[A-Za-z]{2,}/g;
            const escapedAccount = account.replace(/[-/\\\\^$*+?.()|[\\]{}]/g, "\\\\$&");
            const replacements = [
                [new RegExp(escapedAccount, "gi"), "[redacted-google-account]"],
                [/\bChris\s+Hasson\b/gi, "[redacted-name]"],
                [/\bHasson\b/gi, "[redacted-name]"],
                [/\bChris\b/g, "[redacted-name]"],
                [/\bZack\s+Tucker\b/gi, "[redacted-name]"],
                [/\bTucker\b/gi, "[redacted-name]"],
                ["Tucker", "[redacted-name]"],
                [/\bZack\b/g, "[redacted-name]"],
                ["Zack", "[redacted-name]"],
                [emailPattern, "[redacted-email]"]
            ];
            const scrub = (value) => {
                if (!value) return value;
                let next = String(value);
                for (const [pattern, replacement] of replacements) {
                    next = typeof pattern === "string"
                        ? next.split(pattern).join(replacement)
                        : next.replace(pattern, replacement);
                }
                return next;
            };
            const walker = document.createTreeWalker(document.body || document.documentElement, NodeFilter.SHOW_TEXT);
            let node;
            let changed = 0;
            while ((node = walker.nextNode())) {
                const next = scrub(node.nodeValue);
                if (next !== node.nodeValue) {
                    node.nodeValue = next;
                    changed += 1;
                }
            }
            for (const el of document.querySelectorAll("[aria-label], [title], input, textarea")) {
                for (const attr of ["aria-label", "title", "value"]) {
                    if (attr === "value" && !("value" in el)) continue;
                    const current = attr === "value" ? el.value : el.getAttribute(attr);
                    const next = scrub(current);
                    if (next && next !== current) {
                        attr === "value" ? (el.value = next) : el.setAttribute(attr, next);
                        changed += 1;
                    }
                }
            }
            return { changed };
        })()`,
        "redact page for screenshot"
    );
}

function writeJsonEvidence(mode, redacted) {
    fs.mkdirSync(evidenceDir, { recursive: true });
    const file = path.join(evidenceDir, `google-passkey-${mode}.json`);
    fs.writeFileSync(file, `${JSON.stringify(redacted, null, 2)}\n`);
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
    const password = process.env[passwordEnv] || "";
    return value
        .replace(/zackattacktucker@gmail\.com/g, "[redacted-google-account]")
        .replace(new RegExp(escapeRegExp(account), "gi"), "[redacted-google-account]")
        .replace(password ? new RegExp(escapeRegExp(password), "g") : /$a/, "[redacted-google-password]")
        .replace(/hassoncs@gmail\.com/g, "[redacted-forbidden-account]")
        .replace(/[A-Za-z0-9._%+-]+@elf\\.dance/g, "[redacted-padloc-agent]")
        .replace(
            /([?&])([A-Za-z0-9_%-]*?(?:TL|token|authuser|cid|dsh|rart|rapt|rpbg|continue|followup|ifkv|flowEntry|flowName|service|pli|sarp|scc|lid)[A-Za-z0-9_%-]*=)[^&\s"]+/gi,
            (_match, prefix, key) => `${prefix}${key}[redacted]`
        )
        .replace(/Zack\s+Tucker/gi, "[redacted-name]")
        .replace(/Chris\s+Hasson/gi, "[redacted-name]")
        .replace(/\bHasson\b/gi, "[redacted-name]")
        .replace(/\bChris\b/g, "[redacted-name]")
        .replace(/\bTucker\b/gi, "[redacted-name]")
        .replace(/Hi Zack/g, "Hi [redacted-name]")
        .replace(/\bZack\b/g, "[redacted-name]");
}

function escapeRegExp(value) {
    return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function defaultPasswordEnv(email) {
    const local = String(email).split("@")[0] || "GOOGLE";
    return `GOOGLE_TEST_${local.replace(/[^A-Za-z0-9]+/g, "_").toUpperCase()}_PASSWORD`;
}

function sleep(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
}
