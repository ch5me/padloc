#!/usr/bin/env node
import { spawn, spawnSync } from "node:child_process";
import { createServer } from "node:net";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const rootDir = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const stage = process.argv[2] || "";
const supportedStages = new Set(["staging", "production"]);
if (!supportedStages.has(stage)) {
    throw new Error("usage: node scripts/provision-agent-test-identity.mjs <staging|production>");
}

const email = process.env.PADLOC_AGENT_EMAIL || "";
const masterPassword = process.env.PADLOC_AGENT_MASTER_PASSWORD || "";
if (!email || !masterPassword) {
    throw new Error("PADLOC_AGENT_EMAIL and PADLOC_AGENT_MASTER_PASSWORD must resolve from Hush");
}
if (!/^agent\+[^@]+@elf\.dance$/i.test(email)) {
    throw new Error("PADLOC_AGENT_EMAIL must be a no-forward agent+ alias at elf.dance");
}

const targets = JSON.parse(await readFile(join(rootDir, "config/environment-targets.json"), "utf8"));
const target = targets.targets?.[stage];
if (!target?.apiBaseUrl) {
    throw new Error(`missing API target for ${stage}`);
}

const extensionDir = join(rootDir, "packages/extension");
const helperPath = join(extensionDir, "scripts/agentic-email-signup.mjs");
const require = createRequire(import.meta.url);
const { chromium } = require(join(extensionDir, "node_modules/playwright"));
const chromePath = process.env.PADLOC_AGENT_CHROME || chromium.executablePath();
const devtoolsRoot = process.env.CH5_DEVTOOLS_ROOT || resolveProjectPath("ch5-devtools");
const profileDir = await mkdtemp(join(tmpdir(), `padloc-${stage}-agent-`));
const port = await availablePort();
let chrome;

try {
    if (process.env.PADLOC_AGENT_SKIP_BUILD !== "1") {
        run(
            process.execPath,
            [join(rootDir, "scripts/build-web-extension.cjs")],
            {
                ...process.env,
                PL_SERVER_URL: target.apiBaseUrl,
            },
            rootDir
        );
    }

    chrome = spawn(
        chromePath,
        [
            `--user-data-dir=${profileDir}`,
            `--remote-debugging-port=${port}`,
            `--disable-extensions-except=${join(extensionDir, "dist")}`,
            `--load-extension=${join(extensionDir, "dist")}`,
            "--headless=new",
            "--no-first-run",
            "--no-default-browser-check",
            "about:blank",
        ],
        { stdio: "ignore" }
    );
    await waitForCdp(port, chrome);

    const trigger = shellCommand(process.execPath, helperPath, [
        "--mode",
        "start",
        "--port",
        String(port),
        "--email",
        "{email}",
    ]);
    const consume = shellCommand(process.execPath, helperPath, [
        "--mode",
        "complete",
        "--port",
        String(port),
        "--email",
        "{email}",
        "--code",
        "{code}",
    ]);

    run(
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
        process.env,
        devtoolsRoot,
        { quiet: true }
    );

    const status = runJson(
        process.execPath,
        [helperPath, "--mode", "status", "--port", String(port)],
        process.env,
        rootDir
    );
    if (status.accountEmail !== email || status.loggedIn !== true || status.locked !== false) {
        throw new Error(
            `identity verification failed: ${JSON.stringify({
                accountMatches: status.accountEmail === email,
                loggedIn: status.loggedIn,
                locked: status.locked,
            })}`
        );
    }
    console.log(
        JSON.stringify({
            status: "ok",
            stage,
            identity: "dedicated-agent-test-identity",
            loggedIn: true,
            locked: false,
        })
    );
} finally {
    if (chrome && chrome.exitCode === null) {
        chrome.kill("SIGTERM");
        await Promise.race([
            new Promise((resolveExit) => chrome.once("exit", resolveExit)),
            new Promise((resolveTimeout) => setTimeout(resolveTimeout, 5000)),
        ]);
        if (chrome.exitCode === null) chrome.kill("SIGKILL");
    }
    await rm(profileDir, { recursive: true, force: true });
}

function resolveProjectPath(project) {
    const result = spawnSync("ch5", ["project", "path", project], {
        cwd: rootDir,
        encoding: "utf8",
        stdio: ["ignore", "pipe", "pipe"],
    });
    if (result.status !== 0) {
        throw new Error(`could not resolve ${project}; set CH5_DEVTOOLS_ROOT`);
    }
    return result.stdout.trim();
}

function run(command, args, env, cwd, { quiet = false } = {}) {
    const result = spawnSync(command, args, {
        cwd,
        env,
        encoding: quiet ? "utf8" : undefined,
        stdio: quiet ? ["ignore", "pipe", "pipe"] : "inherit",
    });
    if (result.status !== 0) {
        const detail = quiet ? redact(`${result.stderr || result.stdout || ""}`.trim()) : "";
        throw new Error(`${command} exited ${result.status ?? "without status"}${detail ? `: ${detail}` : ""}`);
    }
}

function redact(value) {
    let text = String(value || "");
    if (email) text = text.replaceAll(email, "[redacted-email]");
    if (masterPassword) text = text.replaceAll(masterPassword, "[redacted-password]");
    return text.replaceAll(/\b\d{6}\b/g, "[redacted-code]").slice(-2000);
}

function runJson(command, args, env, cwd) {
    const result = spawnSync(command, args, { cwd, env, encoding: "utf8" });
    if (result.status !== 0) {
        throw new Error(`${command} exited ${result.status ?? "without status"}: ${result.stderr.trim()}`);
    }
    const line = result.stdout
        .trim()
        .split("\n")
        .findLast((entry) => entry.startsWith("{"));
    if (!line) throw new Error(`${command} returned no JSON status`);
    return JSON.parse(line);
}

function shellCommand(command, script, args) {
    return [command, script, ...args].map(shellQuote).join(" ");
}

function shellQuote(value) {
    if (/^\{(?:email|code)\}$/.test(value)) return value;
    return `'${String(value).replaceAll("'", "'\"'\"'")}'`;
}

async function availablePort() {
    return new Promise((resolvePort, reject) => {
        const server = createServer();
        server.once("error", reject);
        server.listen(0, "127.0.0.1", () => {
            const address = server.address();
            const selected = typeof address === "object" && address ? address.port : 0;
            server.close((error) => (error ? reject(error) : resolvePort(selected)));
        });
    });
}

async function waitForCdp(port, processHandle) {
    const deadline = Date.now() + 30000;
    while (Date.now() < deadline) {
        if (processHandle.exitCode !== null) {
            throw new Error(`Chrome exited before CDP became ready: ${processHandle.exitCode}`);
        }
        try {
            const response = await fetch(`http://127.0.0.1:${port}/json/version`);
            if (response.ok) return;
        } catch {}
        await new Promise((resolveWait) => setTimeout(resolveWait, 250));
    }
    throw new Error("timed out waiting for Chrome CDP");
}
