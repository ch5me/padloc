#!/usr/bin/env node
import WebSocket from "ws";

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

const mode = args.get("mode") || "status";
const port = args.get("port") || "9800";
const extensionId = args.get("extension-id") || "phgggllfaobigoepghbbeojablefkkfa";
const email = args.get("email") || "";
const code = args.get("code") || "";
const displayName = args.get("name") || "Agent";

class Cdp {
    nextId = 1;
    pending = new Map();
    socket;

    async connect() {
        const version = await fetch(`http://127.0.0.1:${port}/json/version`).then((res) => res.json());
        this.socket = new WebSocket(version.webSocketDebuggerUrl);
        this.socket.on("message", (data) => {
            const msg = JSON.parse(data.toString());
            if (!msg.id || !this.pending.has(msg.id)) return;
            const { resolve, reject } = this.pending.get(msg.id);
            this.pending.delete(msg.id);
            msg.error ? reject(new Error(`${msg.error.code}: ${msg.error.message}`)) : resolve(msg.result || {});
        });
        await new Promise((resolve, reject) => {
            this.socket.once("open", resolve);
            this.socket.once("error", reject);
        });
    }

    send(method, params = {}, sessionId) {
        const id = this.nextId++;
        const payload = { id, method, params };
        if (sessionId) payload.sessionId = sessionId;
        const result = new Promise((resolve, reject) => this.pending.set(id, { resolve, reject }));
        this.socket.send(JSON.stringify(payload));
        return result;
    }
}

const cdp = new Cdp();
await cdp.connect();

async function getPopupSession() {
    const targets = await cdp.send("Target.getTargets");
    let target = targets.targetInfos.find(
        (info) => info.type === "page" && (info.url || "").startsWith(`chrome-extension://${extensionId}/`)
    );
    if (!target) {
        const created = await cdp.send("Target.createTarget", {
            url: `chrome-extension://${extensionId}/popup.html`,
        });
        target = { targetId: created.targetId };
    }
    const attached = await cdp.send("Target.attachToTarget", { targetId: target.targetId, flatten: true });
    await cdp.send("Runtime.enable", {}, attached.sessionId);
    return attached.sessionId;
}

async function evalPage(sessionId, expression, awaitPromise = true) {
    const result = await cdp.send(
        "Runtime.evaluate",
        {
            expression,
            awaitPromise,
            returnByValue: true,
        },
        sessionId
    );
    if (result.exceptionDetails) {
        throw new Error(result.exceptionDetails.text || "page evaluation failed");
    }
    return result.result.value;
}

async function waitFor(sessionId, expression, timeoutMs = 30000, label = "condition") {
    const started = Date.now();
    let last;
    while (Date.now() - started < timeoutMs) {
        last = await evalPage(sessionId, expression);
        if (last && last.ok) return last;
        await new Promise((resolve) => setTimeout(resolve, 250));
    }
    throw new Error(`timed out waiting for ${label}; last=${JSON.stringify(redactSensitive(last))}`);
}

function redactSensitive(value) {
    if (typeof value === "string") return redactUrl(value);
    if (!value || typeof value !== "object") return value;
    if (Array.isArray(value)) return value.map(redactSensitive);
    const out = {};
    for (const [key, entry] of Object.entries(value)) {
        out[key] = /code|otp|password|input|token/i.test(key) && key !== "passwordReady" ? "[redacted]" : redactSensitive(entry);
    }
    return out;
}

function redactUrl(value) {
    if (!/^chrome-extension:\/\/|^https?:\/\//.test(value)) return value;
    try {
        const url = new URL(value);
        for (const key of [...url.searchParams.keys()]) {
            if (/code|otp|token|pendingAuth|pendingAuthData/i.test(key)) {
                url.searchParams.set(key, "[redacted]");
            }
        }
        return url.toString();
    } catch {
        return value;
    }
}

const domHelpers = String.raw`
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
function bySelector(selector) {
    return deepElements().find((el) => el.matches && el.matches(selector));
}
function byLocalName(name) {
    return deepElements().find((el) => el.localName === name);
}
function byVisibleText(text) {
    return deepElements().find((el) => visible(el) && ((el.innerText || el.textContent || "").trim() === text));
}
async function settle(el) {
    if (el && el.updateComplete && typeof el.updateComplete.then === "function") {
        await el.updateComplete;
    }
    await new Promise((resolve) => requestAnimationFrame(() => resolve()));
}
async function loginSignup() {
    const el = byLocalName("pl-login-signup");
    if (el) await settle(el);
    return el;
}
async function emailPrompt() {
    const dialog = byLocalName("pl-prompt-dialog");
    if (dialog) await settle(dialog);
    if (!dialog || !dialog.open || !String(dialog.title || "").includes("Email Authentication")) return null;
    return dialog;
}
function signupState(el) {
    return {
        href: location.href,
        page: el?._page || "",
        step: el?._step || "",
        loggedIn: Boolean(el?.app?.state?.loggedIn),
        locked: Boolean(el?.app?.state?.locked),
        passwordReady: Boolean(el?._password)
    };
}
function setValue(el, value) {
    if (!el) return;
    el.value = value;
    const root = el.shadowRoot || el.renderRoot;
    const input = root && root.querySelector("input");
    if (input) input.value = value;
    el.dispatchEvent(new Event("input", { bubbles: true, composed: true }));
    el.dispatchEvent(new Event("change", { bubbles: true, composed: true }));
    if (input) {
        input.dispatchEvent(new Event("input", { bubbles: true, composed: true }));
        input.dispatchEvent(new Event("change", { bubbles: true, composed: true }));
    }
}
function clickElement(el) {
    const button = el.shadowRoot && el.shadowRoot.querySelector("button");
    (button || el).click();
}
function textIncludes(value) {
    return deepElements().some((el) => visible(el) && (el.innerText || el.textContent || "").includes(value));
}
`;

function assertOk(result, label) {
    if (!result || !result.ok) {
        throw new Error(`${label} failed: ${JSON.stringify(result)}`);
    }
    return result;
}

async function start() {
    if (!email) throw new Error("--email is required for start");
    const sessionId = await getPopupSession();
    await evalPage(
        sessionId,
        `(async () => {
            if (!location.href.startsWith("chrome-extension://${extensionId}/popup.html")) {
                location.href = "chrome-extension://${extensionId}/popup.html";
            }
            return { ok: true, href: location.href };
        })()`
    );
    await waitFor(
        sessionId,
        `(() => {
            const app = document.querySelector("pl-extension-app");
            return { ok: Boolean(app?.shadowRoot), href: location.href };
        })()`,
        30000,
        "extension app shell"
    );
    await evalPage(
        sessionId,
        `(() => {
            const app = document.querySelector("pl-extension-app");
            if (app && typeof app.go === "function") app.go("start", { next: "vaults" }, true);
            return { ok: Boolean(app), href: location.href };
        })()`
    );
    await waitFor(
        sessionId,
        `(async () => {
            ${domHelpers}
            const login = await loginSignup();
            return { ok: Boolean(login), href: location.href, state: signupState(login) };
        })()`,
        30000,
        "login signup component"
    );
    const started = await evalPage(
        sessionId,
        `(async () => {
            ${domHelpers}
            window.__padlocAgenticSignupError = "";
            const login = await loginSignup();
            if (!login) return { ok: false, reason: "login signup component missing", href: location.href };
            const input = login._emailInput || login.renderRoot?.querySelector("#emailInput") || bySelector("#emailInput");
            if (!input) return { ok: false, reason: "email input missing", state: signupState(login) };
            setValue(input, ${JSON.stringify(email)});
            await settle(login);
            if (typeof login._submitEmail !== "function") {
                return { ok: false, reason: "login signup submit method missing", state: signupState(login) };
            }
            void login._submitEmail().catch((error) => {
                window.__padlocAgenticSignupError = error && error.message ? error.message : String(error);
            });
            return { ok: true, state: signupState(login) };
        })()`
    );
    assertOk(started, "email signup start");
    const promptState = await waitFor(
        sessionId,
        `(async () => {
            ${domHelpers}
            const prompt = await emailPrompt();
            const login = await loginSignup();
            const error = window.__padlocAgenticSignupError || "";
            return { ok: Boolean(prompt) || Boolean(error), promptOpen: Boolean(prompt), error, state: signupState(login) };
        })()`,
        30000,
        "email authentication prompt"
    );
    if (promptState.error) throw new Error(promptState.error);
    console.log(JSON.stringify({ status: "email_sent", email }));
}

async function complete() {
    const sessionId = await getPopupSession();
    const ready = await waitFor(
        sessionId,
        `(async () => {
            ${domHelpers}
            const prompt = await emailPrompt();
            const login = await loginSignup();
            const state = signupState(login);
            return { ok: Boolean(prompt) || state.page === "signup" || state.page === "login", promptOpen: Boolean(prompt), state };
        })()`,
        30000,
        "email prompt or signup route"
    );
    let signupReady = ready;
    if (ready.promptOpen) {
        if (!code) throw new Error("--code is required while email prompt is open");
        const confirmedCode = await evalPage(
            sessionId,
            `(async () => {
                ${domHelpers}
                window.__padlocAgenticSignupError = "";
                const prompt = await emailPrompt();
                if (!prompt) return { ok: false, reason: "email prompt missing" };
                const codeInput = prompt._input || prompt.renderRoot?.querySelector("pl-input");
                if (!codeInput) return { ok: false, reason: "code input missing" };
                const rawCode = ${JSON.stringify(code)};
                if (prompt.validate) {
                    try {
                        const validated = await prompt.validate(rawCode, codeInput);
                        prompt.done(validated);
                    } catch (error) {
                        prompt._validationMessage = error && error.message ? error.message : String(error);
                        return { ok: false, reason: "code validation failed" };
                    }
                } else if (typeof prompt.done === "function") {
                    prompt.done(rawCode);
                } else if (typeof prompt._confirm === "function") {
                    setValue(codeInput, rawCode);
                    await prompt._confirm();
                } else {
                    const submit = prompt._confirmButton || prompt.renderRoot?.querySelector("#confirmButton") || byVisibleText("Submit");
                    if (!submit) return { ok: false, reason: "submit missing" };
                    setValue(codeInput, rawCode);
                    clickElement(submit);
                }
                return { ok: true };
            })()`
        );
        assertOk(confirmedCode, "email code submit");
        signupReady = await waitFor(
            sessionId,
            `(async () => {
                ${domHelpers}
                const login = await loginSignup();
                const state = signupState(login);
                return { ok: state.page === "signup" || state.page === "login", state };
            })()`,
            30000,
            "signup route after email verification"
        );
    }
    if (signupReady.state?.page === "login") {
        throw new Error("account already exists; signup helper expected an unregistered disposable email");
    }
    const nameSubmitted = await evalPage(
        sessionId,
        `(async () => {
            ${domHelpers}
            const login = await loginSignup();
            if (!login) return { ok: false, reason: "login signup component missing" };
            const nameInput = login._nameInput || login.renderRoot?.querySelector("#nameInput") || bySelector("#nameInput");
            if (nameInput) setValue(nameInput, ${JSON.stringify(displayName)});
            const tos = login._tosCheckbox || login.renderRoot?.querySelector("#tosCheckbox") || bySelector("#tosCheckbox");
            if (tos && !tos.checked) tos.click();
            await settle(login);
            if (typeof login._submitName !== "function") {
                return { ok: false, reason: "submit name method missing", state: signupState(login) };
            }
            await login._submitName();
            return { ok: true, state: signupState(login) };
        })()`
    );
    assertOk(nameSubmitted, "signup name submit");
    await waitFor(
        sessionId,
        `(async () => {
            ${domHelpers}
            const login = await loginSignup();
            const state = signupState(login);
            return { ok: state.page === "signup" && state.step === "choose-password", state };
        })()`,
        30000,
        "choose-password route"
    );
    const passwordReady = await evalPage(
        sessionId,
        `(async () => {
            ${domHelpers}
            const login = await loginSignup();
            if (!login) return { ok: false, reason: "login signup component missing" };
            if (!login._password) {
                const bytes = Array.from(crypto.getRandomValues(new Uint8Array(18)));
                login._password = bytes.map((byte) => byte.toString(16).padStart(2, "0")).join("");
                login.requestUpdate?.();
                await settle(login);
            }
            return { ok: Boolean(login._password), state: signupState(login) };
        })()`
    );
    assertOk(passwordReady, "signup password generation");
    const passwordSubmitted = await evalPage(
        sessionId,
        `(async () => {
            ${domHelpers}
            const login = await loginSignup();
            if (!login || typeof login._submitPassword !== "function") {
                return { ok: false, reason: "submit password method missing", state: signupState(login) };
            }
            login._submitPassword();
            return { ok: true, state: signupState(login) };
        })()`
    );
    assertOk(passwordSubmitted, "signup password submit");
    await waitFor(
        sessionId,
        `(async () => {
            ${domHelpers}
            const login = await loginSignup();
            const state = signupState(login);
            return { ok: state.page === "signup" && state.step === "confirm-password", state };
        })()`,
        30000,
        "confirm-password route"
    );
    const confirmedPassword = await evalPage(
        sessionId,
        `(async () => {
            ${domHelpers}
            const login = await loginSignup();
            if (!login) return { ok: false, reason: "login signup component missing" };
            window.__padlocAgenticSignupError = "";
            const repeat = login._repeatPasswordInput || login.renderRoot?.querySelector("#repeatPasswordInput") || bySelector("#repeatPasswordInput");
            if (!repeat) return { ok: false, reason: "repeat password input missing", state: signupState(login) };
            setValue(repeat, login._password || "");
            await settle(login);
            if (typeof login._confirmPassword !== "function") {
                return { ok: false, reason: "confirm password method missing", state: signupState(login) };
            }
            try {
                await login._confirmPassword();
            } catch (error) {
                window.__padlocAgenticSignupError = error && error.message ? error.message : String(error);
                return { ok: false, reason: window.__padlocAgenticSignupError, state: signupState(login) };
            }
            return { ok: true, state: signupState(login) };
        })()`
    );
    assertOk(confirmedPassword, "signup password confirm");
    await waitFor(
        sessionId,
        `(async () => {
            ${domHelpers}
            const login = await loginSignup();
            const state = signupState(login);
            const app = document.querySelector("pl-extension-app");
            const unlocked = Boolean(app?.app?.state?.loggedIn && !app?.app?.state?.locked);
            return { ok: unlocked || (state.page === "signup" && state.step === "success"), unlocked, state };
        })()`,
        60000,
        "signup success route"
    );
    await evalPage(
        sessionId,
        `(async () => {
            ${domHelpers}
            const login = await loginSignup();
            if (login && typeof login._done === "function") login._done();
            return { ok: true };
        })()`
    );
    await evalPage(
        sessionId,
        `(async () => {
            const appEl = document.querySelector("pl-extension-app");
            if (appEl?.app?.settings) {
                appEl.app.settings.autoLock = false;
                await appEl.app.save();
            }
            if (appEl && typeof appEl._persistUnlockedState === "function") {
                await appEl._persistUnlockedState();
            }
            await chrome.runtime.sendMessage({ type: "unlocked" }).catch(() => undefined);
            return { ok: true };
        })()`
    );
    const status = await waitFor(
        sessionId,
        `(() => {
            const app = document.querySelector("pl-extension-app");
            return {
                ok: Boolean(app?.app?.state?.loggedIn && !app?.app?.state?.locked),
                loggedIn: Boolean(app?.app?.state?.loggedIn),
                locked: Boolean(app?.app?.state?.locked),
                href: location.href
            };
        })()`,
        30000,
        "unlocked extension account"
    );
    console.log(JSON.stringify({ status: "ok", email, loggedIn: status.loggedIn, locked: status.locked }));
}

async function status() {
    const sessionId = await getPopupSession();
    const result = await evalPage(
        sessionId,
        `(() => {
            const app = document.querySelector("pl-extension-app");
            return {
                href: location.href,
                loggedIn: Boolean(app?.app?.state?.loggedIn),
                locked: Boolean(app?.app?.state?.locked),
                accountEmail: app?.app?.account?.email || null
            };
        })()`
    );
    console.log(JSON.stringify(result));
}

if (mode === "start") {
    await start();
} else if (mode === "complete") {
    await complete();
} else if (mode === "status") {
    await status();
} else {
    throw new Error(`unknown mode ${mode}`);
}

cdp.socket.close();
