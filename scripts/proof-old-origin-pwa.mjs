#!/usr/bin/env node

/**
 * Old-origin PWA smoke.
 *
 * The browser is owned by Magic Browser. This script only uses its registered
 * local-CDP lane, then talks to the owned page target over CDP so Hush secrets
 * never cross a process argument or browser CLI log.
 */

import { spawnSync } from "node:child_process";
import { readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const rootDir = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const scriptPath = resolve(fileURLToPath(import.meta.url));
const supportedStages = new Set(["staging", "production"]);
const legacyFallbacks = {
    staging: "https://pad-staging.ch5.me",
    production: "https://pad.ch5.me",
};
const require = createRequire(import.meta.url);
let WebSocket;

class SmokeError extends Error {
    constructor(code, message) {
        super(message);
        this.name = "SmokeError";
        this.code = code;
    }
}

class Cdp {
    constructor(webSocketUrl) {
        this.webSocketUrl = webSocketUrl;
        this.nextId = 1;
        this.pending = new Map();
        this.socket = null;
        this.pageSessionId = null;
    }

    async connect(targetId) {
        this.socket = new WebSocket(this.webSocketUrl);
        this.socket.on("message", (data) => {
            const message = JSON.parse(data.toString());
            if (!message.id || !this.pending.has(message.id)) return;
            const pending = this.pending.get(message.id);
            this.pending.delete(message.id);
            message.error
                ? pending.reject(new Error(`${message.error.code}: ${message.error.message}`))
                : pending.resolve(message.result || {});
        });
        await new Promise((resolveOpen, rejectOpen) => {
            this.socket.once("open", resolveOpen);
            this.socket.once("error", rejectOpen);
        });
        const targets = await this.send("Target.getTargets");
        const selectedTargetId =
            targetId ||
            (targets.targetInfos || []).find((target) => target.type === "page")?.targetId;
        if (!selectedTargetId) {
            throw new SmokeError("BROWSER_TARGET_UNAVAILABLE", "Magic Browser returned no page target");
        }
        const attached = await this.send("Target.attachToTarget", {
            targetId: selectedTargetId,
            flatten: true,
        });
        this.pageSessionId = attached.sessionId;
        await this.send("Runtime.enable", {}, this.pageSessionId);
        await this.send("Page.enable", {}, this.pageSessionId);
    }

    send(method, params = {}, sessionId) {
        const id = this.nextId++;
        const result = new Promise((resolveResult, rejectResult) => {
            this.pending.set(id, { resolve: resolveResult, reject: rejectResult });
        });
        this.socket.send(
            JSON.stringify({
                id,
                method,
                params,
                ...(sessionId ? { sessionId } : {}),
            })
        );
        return result;
    }

    async evaluate(expression) {
        const result = await this.send(
            "Runtime.evaluate",
            {
                expression,
                awaitPromise: true,
                returnByValue: true,
                userGesture: true,
            },
            this.pageSessionId
        );
        if (result.exceptionDetails) {
            throw new Error(result.exceptionDetails.text || "page evaluation failed");
        }
        return result.result?.value;
    }

    close() {
        this.socket?.close();
    }
}

async function main() {
    const args = parseArgs(process.argv.slice(2));
    const mode = args.get("mode") || "smoke";
    if (mode === "self-test") {
        runSelfTest();
        return;
    }
    const stage = requireStage(args.get("stage"));
    const WebSocketModule = loadWebSocket();
    WebSocket = WebSocketModule.WebSocket || WebSocketModule.default || WebSocketModule;
    const target = await readStageTarget(stage);
    const email = requireAgentEmail();
    const masterPassword = requireMasterPassword();
    const sessionIdArg = args.get("session-id");

    if (mode === "request-email" || mode === "complete-email") {
        if (!sessionIdArg) {
            throw new SmokeError("SESSION_REQUIRED", `${mode} requires --session-id`);
        }
        const browser = resolveMagicBrowser();
        const cdp = await connectSession(browser, sessionIdArg);
        try {
            if (mode === "request-email") {
                await requestEmail(cdp, email);
                return;
            }
            const code = await readCode(args);
            await completeEmail(cdp, code);
            return;
        } finally {
            cdp.close();
        }
    }

    if (mode !== "smoke") {
        throw new SmokeError("USAGE", `unknown mode ${mode}`);
    }

    const browser = resolveMagicBrowser();
    const fixtureName = `elf-vault-agent-smoke:${stage}`;
    let sessionId = null;
    let cdp = null;
    let primaryError = null;
    try {
        const started = runMagicJson(browser, [
            "session",
            "start",
            "adhoc.browser",
            "--adapter",
            "local-cdp",
            "--profile-source",
            "clean",
            "--headless",
        ]);
        sessionId = started.id;
        if (!sessionId || !started.webSocketDebuggerUrl) {
            throw new SmokeError("BROWSER_SESSION_INVALID", "Magic Browser returned an incomplete session");
        }

        runMagicJson(browser, [
            "session",
            "open",
            sessionId,
            target.oldAppUrl,
            "--action-attempt-id",
            `old-origin-open-${Date.now()}`,
        ]);

        cdp = await connectSession(browser, sessionId);
        await waitFor(
            cdp,
            `(() => ({
                ok: document.readyState === "complete" && Boolean(window.app),
                origin: location.origin,
                loggedIn: Boolean(window.app?.state?.loggedIn),
                locked: Boolean(window.app?.state?.locked)
            }))()`,
            "old-origin PWA load"
        );
        const loaded = await cdp.evaluate(
            `(() => ({ origin: location.origin, title: document.title || "", hasApp: Boolean(window.app) }))()`
        );
        if (loaded.origin !== target.oldOrigin) {
            throw new SmokeError(
                "OLD_ORIGIN_REDIRECTED",
                `old origin landed on ${loaded.origin || "(empty origin)"}`
            );
        }

        await runEmailCodeFlow(browser, stage, sessionId, email);
        const loggedIn = await loginWithPassword(cdp, email, masterPassword);
        if (!loggedIn.ok) {
            throw new SmokeError("LOGIN_FAILED", "old-origin PWA did not reach an unlocked state");
        }

        const unlock = await lockAndUnlock(cdp, masterPassword);
        if (!unlock.ok) {
            throw new SmokeError("UNLOCK_FAILED", "old-origin PWA could not lock and unlock the test vault");
        }

        const fixture = await ensureFixtureAndSync(cdp, fixtureName);
        if (!fixture.ok || !fixture.itemVisible) {
            throw new SmokeError("SYNC_FAILED", "old-origin PWA did not sync a synthetic test item");
        }

        runMagicJson(browser, [
            "session",
            "open",
            sessionId,
            target.oldAppUrl,
            "--action-attempt-id",
            `old-origin-reload-${Date.now()}`,
        ]);
        cdp.close();
        cdp = await connectSession(browser, sessionId);
        const reloaded = await waitFor(
            cdp,
            `(() => {
                const items = [...(window.app?.state?.vaults || [])]
                    .flatMap((vault) => [...(vault.items || [])]);
                return {
                    ok: document.readyState === "complete" &&
                        Boolean(window.app?.state?.loggedIn) &&
                        window.app?.state?.locked === false,
                    origin: location.origin,
                    itemVisible: items.some((item) => item.name === ${JSON.stringify(fixtureName)}),
                    vaultCount: (window.app?.state?.vaults || []).length,
                    itemCount: items.length
                };
            })()`,
            "old-origin PWA reload and item visibility"
        );
        if (reloaded.origin !== target.oldOrigin) {
            throw new SmokeError("OLD_ORIGIN_REDIRECTED", "old-origin reload changed browser origin");
        }

        console.log(
            JSON.stringify({
                status: "ok",
                stage,
                origin: target.oldOrigin,
                loaded: true,
                loggedIn: true,
                unlocked: true,
                synced: true,
                reloaded: true,
                itemVisible: true,
                vaultCount: reloaded.vaultCount,
                itemCount: reloaded.itemCount,
                fixture: "synthetic-agent-smoke-item",
            })
        );
    } catch (error) {
        primaryError = error;
        throw error;
    } finally {
        cdp?.close();
        if (sessionId) {
            try {
                runMagicJson(browser, ["session", "stop", sessionId]);
            } catch (cleanupError) {
                if (!primaryError) throw cleanupError;
            }
        }
    }
}

function parseArgs(argv) {
    const args = new Map();
    for (let index = 0; index < argv.length; index += 1) {
        const token = argv[index];
        if (!token.startsWith("--")) continue;
        const equal = token.indexOf("=");
        if (equal > 2) {
            args.set(token.slice(2, equal), token.slice(equal + 1));
            continue;
        }
        const next = argv[index + 1];
        if (!next || next.startsWith("--")) {
            args.set(token.slice(2), "true");
        } else {
            args.set(token.slice(2), next);
            index += 1;
        }
    }
    return args;
}

function requireStage(value) {
    if (!supportedStages.has(value)) {
        throw new SmokeError("INVALID_STAGE", "usage: node scripts/proof-old-origin-pwa.mjs --stage <staging|production>");
    }
    return value;
}

async function readStageTarget(stage) {
    const config = JSON.parse(await readFile(join(rootDir, "config/environment-targets.json"), "utf8"));
    const target = config.targets?.[stage];
    if (!target) throw new SmokeError("TARGET_MISSING", `missing environment target for ${stage}`);

    const oldAppUrl =
        target.legacyAppUrl ||
        target.oldAppUrl ||
        target.compatibility?.appUrl ||
        target.legacy?.appUrl ||
        (isLegacyPadlocHost(target.appUrl) ? target.appUrl : legacyFallbacks[stage]);
    const oldOrigin = normalizeOrigin(oldAppUrl);
    if (!isLegacyPadlocHost(oldOrigin)) {
        throw new SmokeError("OLD_ORIGIN_INVALID", `old-origin target for ${stage} is not a retained Padloc host`);
    }
    return {
        oldAppUrl: oldOrigin,
        oldOrigin,
        apiBaseUrl: target.legacyApiBaseUrl || target.oldApiBaseUrl || target.apiBaseUrl,
    };
}

function normalizeOrigin(value) {
    try {
        const url = new URL(value);
        if (!["http:", "https:"].includes(url.protocol)) throw new Error("unsupported protocol");
        return url.origin;
    } catch {
        throw new SmokeError("ORIGIN_INVALID", `invalid old-origin URL: ${String(value)}`);
    }
}

function isLegacyPadlocHost(value) {
    try {
        const host = new URL(value).hostname;
        return /(^|\.)pad(?:-staging)?\.ch5\.me$/i.test(host);
    } catch {
        return false;
    }
}

function requireAgentEmail() {
    const email = process.env.PADLOC_AGENT_EMAIL?.trim() || "";
    if (!email) throw new SmokeError("HUSH_SECRET_MISSING", "PADLOC_AGENT_EMAIL must resolve from Hush");
    if (!/^agent\+[^@]+@elf\.dance$/i.test(email)) {
        throw new SmokeError("TEST_IDENTITY_INVALID", "PADLOC_AGENT_EMAIL must be a dedicated agent+ alias at elf.dance");
    }
    return email;
}

function requireMasterPassword() {
    if (!process.env.PADLOC_AGENT_MASTER_PASSWORD) {
        throw new SmokeError("HUSH_SECRET_MISSING", "PADLOC_AGENT_MASTER_PASSWORD must resolve from Hush");
    }
    return process.env.PADLOC_AGENT_MASTER_PASSWORD;
}

function resolveMagicBrowser() {
    const command = process.env.MAGIC_BROWSER_CLI || "magic-browser";
    const result = spawnSync(command, ["--json", "session", "list"], {
        cwd: rootDir,
        env: process.env,
        encoding: "utf8",
        stdio: ["ignore", "pipe", "pipe"],
    });
    if (result.error || result.status !== 0) {
        throw new SmokeError(
            "BROWSER_AUTOMATION_UNAVAILABLE",
            "authorized Magic Browser automation is unavailable"
        );
    }
    return command;
}

function runMagicJson(command, args) {
    const result = spawnSync(command, ["--json", ...args], {
        cwd: rootDir,
        env: process.env,
        encoding: "utf8",
        maxBuffer: 2 * 1024 * 1024,
        stdio: ["ignore", "pipe", "pipe"],
    });
    if (result.error || result.status !== 0) {
        const detail = redact(`${result.stderr || result.stdout || ""}`.trim());
        throw new SmokeError("BROWSER_AUTOMATION_FAILED", detail || `${args[0]} failed`);
    }
    try {
        return JSON.parse(result.stdout);
    } catch {
        throw new SmokeError("BROWSER_AUTOMATION_INVALID", "Magic Browser returned invalid JSON");
    }
}

async function connectSession(browser, sessionId) {
    const status = runMagicJson(browser, ["session", "status", sessionId]);
    const session = status.session || status;
    const provider = status.provider || session.provider;
    const webSocketUrl = session.webSocketDebuggerUrl || provider?.cdp?.webSocketDebuggerUrl;
    if (!webSocketUrl) {
        throw new SmokeError("BROWSER_CDP_UNAVAILABLE", "Magic Browser session has no CDP endpoint");
    }
    const cdp = new Cdp(webSocketUrl);
    await cdp.connect(session.targetId || provider?.cdp?.targetId);
    return cdp;
}

async function waitFor(cdp, expression, label, timeoutMs = 120_000) {
    const deadline = Date.now() + timeoutMs;
    let last = null;
    while (Date.now() < deadline) {
        last = await cdp.evaluate(expression);
        if (last?.ok) return last;
        await new Promise((resolveWait) => setTimeout(resolveWait, 300));
    }
    throw new SmokeError("BROWSER_WAIT_TIMEOUT", `${label} timed out; last=${JSON.stringify(redact(last))}`);
}

async function requestEmail(cdp, email) {
    const result = await cdp.evaluate(
        `(async () => {
            if (!window.app?.api?.startAuthRequest) return { ok: false, reason: "PWA API unavailable" };
            const req = await window.app.api.startAuthRequest({
                email: ${JSON.stringify(email)},
                purpose: "login",
                type: "email",
                supportedTypes: ["email"]
            });
            window.__elfVaultSmokeAuthRequest = {
                id: req.id,
                email: req.email,
                token: req.token,
                type: req.type,
                purpose: req.purpose
            };
            return { ok: Boolean(req.id && req.email === ${JSON.stringify(email)}), request: Boolean(req.id) };
        })()`
    );
    if (!result?.ok) throw new SmokeError("EMAIL_REQUEST_FAILED", "old-origin PWA did not request email verification");
}

async function completeEmail(cdp, code) {
    const result = await cdp.evaluate(
        `(async () => {
            const req = window.__elfVaultSmokeAuthRequest;
            if (!req?.id) return { ok: false, reason: "email request missing" };
            const auth = await window.app.api.completeAuthRequest({
                id: req.id,
                email: req.email,
                data: { code: ${JSON.stringify(code)} }
            });
            window.__elfVaultSmokeAuthResult = {
                token: auth.token,
                email: auth.email,
                accountStatus: auth.accountStatus
            };
            return { ok: Boolean(auth.token && auth.accountStatus === "active") };
        })()`
    );
    if (!result?.ok) throw new SmokeError("EMAIL_VERIFY_FAILED", "old-origin PWA email verification failed");
}

async function loginWithPassword(cdp, email, password) {
    return cdp.evaluate(
        `(async () => {
            const auth = window.__elfVaultSmokeAuthResult;
            if (!auth?.token || !window.app?.login) {
                return { ok: false, reason: "verified auth session missing" };
            }
            await window.app.login({
                email: ${JSON.stringify(email)},
                password: ${JSON.stringify(password)},
                authToken: auth.token,
                addTrustedDevice: false
            });
            for (let i = 0; i < 120 && window.app.state.syncing; i += 1) {
                await new Promise((resolveWait) => setTimeout(resolveWait, 250));
            }
            return {
                ok: window.app.state.loggedIn === true && window.app.state.locked === false,
                loggedIn: window.app.state.loggedIn === true,
                locked: window.app.state.locked === true,
                synced: window.app.state.syncing === false
            };
        })()`
    );
}

async function lockAndUnlock(cdp, password) {
    return cdp.evaluate(
        `(async () => {
            await window.app.lock();
            const locked = window.app.state.locked === true;
            await window.app.unlock(${JSON.stringify(password)});
            for (let i = 0; i < 120 && window.app.state.syncing; i += 1) {
                await new Promise((resolveWait) => setTimeout(resolveWait, 250));
            }
            return {
                ok: locked && window.app.state.loggedIn === true && window.app.state.locked === false,
                locked,
                unlocked: window.app.state.locked === false,
                synced: window.app.state.syncing === false
            };
        })()`
    );
}

async function ensureFixtureAndSync(cdp, fixtureName) {
    return cdp.evaluate(
        `(async () => {
            const items = () => [...(window.app?.state?.vaults || [])]
                .flatMap((vault) => [...(vault.items || [])]);
            let visible = items().some((item) => item.name === ${JSON.stringify(fixtureName)});
            let created = false;
            if (!visible) {
                const vault = window.app?.state?.vaults?.find((candidate) => !candidate.org) ||
                    window.app?.state?.vaults?.[0];
                if (!vault || !window.app?.createItem) return { ok: false, reason: "dedicated test vault unavailable" };
                await window.app.createItem({ name: ${JSON.stringify(fixtureName)}, vault: { id: vault.id } });
                created = true;
            }
            await window.app.synchronize();
            for (let i = 0; i < 120 && window.app.state.syncing; i += 1) {
                await new Promise((resolveWait) => setTimeout(resolveWait, 250));
            }
            visible = items().some((item) => item.name === ${JSON.stringify(fixtureName)});
            return {
                ok: window.app.state.loggedIn === true && window.app.state.locked === false,
                itemVisible: visible,
                created,
                synced: window.app.state.syncing === false,
                vaultCount: (window.app.state.vaults || []).length,
                itemCount: items().length
            };
        })()`
    );
}

async function runEmailCodeFlow(browser, stage, sessionId, email) {
    const devtoolsRoot = resolveProjectPath("ch5-devtools");
    const trigger = shellCommand(process.execPath, [
        scriptPath,
        "--mode",
        "request-email",
        "--stage",
        stage,
        "--session-id",
        sessionId,
    ]);
    const consume = `${shellCommand("printf", ["%s", "{code}"])} | ${shellCommand(
        process.execPath,
        [scriptPath, "--mode", "complete-email", "--stage", stage, "--session-id", sessionId, "--code-stdin"]
    )}`;
    const result = spawnSync(
        "hush",
        [
            "run",
            "--global",
            "-t",
            "root",
            "--",
            "hush",
            "run",
            "--",
            "bun",
            "run",
            "--filter",
            "@ch5me/mailslot-elf-dance",
            "email:code-flow",
            "--",
            "--email",
            email,
            "--subject-contains",
            "Elf Vault Email Verification",
            "--extract",
            "otp",
            "--timeout-s",
            "120",
            "--since-s",
            "30",
            "--command-timeout-s",
            "420",
            "--cwd",
            rootDir,
            "--trigger-command",
            trigger,
            "--consume-command",
            consume,
        ],
        {
            cwd: devtoolsRoot,
            env: process.env,
            encoding: "utf8",
            maxBuffer: 2 * 1024 * 1024,
            stdio: ["ignore", "pipe", "pipe"],
        }
    );
    if (result.error || result.status !== 0) {
        throw new SmokeError("EMAIL_FLOW_UNAVAILABLE", redact(`${result.stderr || result.stdout || ""}`));
    }
}

function resolveProjectPath(project) {
    const result = spawnSync("ch5", ["project", "path", project], {
        cwd: rootDir,
        encoding: "utf8",
        stdio: ["ignore", "pipe", "pipe"],
    });
    if (result.status !== 0 || !result.stdout.trim()) {
        throw new SmokeError("DEVTOOLS_UNAVAILABLE", `could not resolve ${project}`);
    }
    return result.stdout.trim();
}

async function readCode(args) {
    const value = args.get("code");
    const code = value || (args.get("code-stdin") === "true" ? (await readFile(0, "utf8")).trim() : "");
    if (!/^\d{6}$/.test(code)) throw new SmokeError("EMAIL_CODE_INVALID", "verification code must be six digits");
    return code;
}

function shellCommand(command, args) {
    return [command, ...args].map(shellQuote).join(" ");
}

function shellQuote(value) {
    if (/^\{(?:email|code)\}$/.test(value)) return value;
    return `'${String(value).replaceAll("'", "'\"'\"'")}'`;
}

function redact(value) {
    let text = String(value || "");
    const email = process.env.PADLOC_AGENT_EMAIL || "";
    const password = process.env.PADLOC_AGENT_MASTER_PASSWORD || "";
    if (email) text = text.replaceAll(email, "[redacted-email]");
    if (password) text = text.replaceAll(password, "[redacted-password]");
    return text.replaceAll(/\b\d{6}\b/g, "[redacted-code]").slice(-2000);
}

function loadWebSocket() {
    try {
        return require(require.resolve("ws", { paths: [join(rootDir, "packages/extension")] }));
    } catch {
        throw new SmokeError("BROWSER_AUTOMATION_UNAVAILABLE", "WebSocket runtime is unavailable");
    }
}

function runSelfTest() {
    const sample = {
        targets: {
            staging: {
                appUrl: "https://staging.vault.elf.dance",
                legacyAppUrl: "https://pad-staging.ch5.me",
            },
        },
    };
    const old = normalizeOrigin(sample.targets.staging.legacyAppUrl);
    if (old !== legacyFallbacks.staging || !isLegacyPadlocHost(old)) {
        throw new SmokeError("SELF_TEST_FAILED", "old-origin target derivation failed");
    }
    const masked = redact("agent+test@elf.dance 123456");
    if (masked.includes("123456") || !masked.includes("[redacted-code]")) {
        throw new SmokeError("SELF_TEST_FAILED", "secret redaction failed");
    }
    console.log(JSON.stringify({ status: "ok", mode: "self-test", stageValidation: true, redaction: true }));
}

main().catch((error) => {
    const code = error instanceof SmokeError ? error.code : "OLD_ORIGIN_SMOKE_FAILED";
    const message = redact(error instanceof Error ? error.message : String(error));
    console.error(JSON.stringify({ status: "blocked", code, message }));
    process.exitCode = 2;
});
