const { spawn, spawnSync } = require("child_process");
const { once } = require("events");
const fs = require("fs");
const os = require("os");
const net = require("net");
const path = require("path");

const repo = path.resolve(__dirname, "../../../..");
const workerPort = Number(process.env.PADLOC_PASSKEY_WORKER_PORT || 18787);
const localServer = `http://127.0.0.1:${workerPort}`;
const canaryId = `${process.pid}-${Date.now()}`;
const canaryEmail = `passkey-canary-${canaryId}@example.test`;
let worker;
let artifactsSnapshotted = false;
const artifactBackup = fs.mkdtempSync(path.join(os.tmpdir(), "ch5-passkey-e2e-"));
const artifactPaths = [
    "packages/extension/dist",
    "packages/extension/test-harness/.playwright-html",
    "packages/extension/test-harness/.playwright-results.json",
];

function snapshotArtifacts() {
    for (const relative of artifactPaths) {
        const source = path.join(repo, relative);
        if (!fs.existsSync(source)) continue;
        const destination = path.join(artifactBackup, relative);
        fs.mkdirSync(path.dirname(destination), { recursive: true });
        fs.cpSync(source, destination, { recursive: true });
    }
    artifactsSnapshotted = true;
}

function restoreArtifacts() {
    if (!artifactsSnapshotted) {
        fs.rmSync(artifactBackup, { recursive: true, force: true });
        return;
    }
    for (const relative of artifactPaths) {
        const target = path.join(repo, relative);
        const backup = path.join(artifactBackup, relative);
        fs.rmSync(target, { recursive: true, force: true });
        if (fs.existsSync(backup)) {
            fs.mkdirSync(path.dirname(target), { recursive: true });
            fs.cpSync(backup, target, { recursive: true });
        }
    }
    fs.rmSync(artifactBackup, { recursive: true, force: true });
}

function run(command, args, env = {}) {
    const result = spawnSync(command, args, {
        cwd: repo,
        env: { ...process.env, ...env },
        stdio: "inherit",
    });
    if (result.status !== 0) throw new Error(`${command} ${args.join(" ")} failed`);
}

function cleanupLocalCanaries() {
    const accountSet = `SELECT id FROM accounts WHERE email = '${canaryEmail}'`;
    const sql = [
        `DELETE FROM sessions WHERE account_id IN (${accountSet})`,
        `DELETE FROM key_store_entries WHERE account_id IN (${accountSet})`,
        `DELETE FROM vaults WHERE owner_account_id IN (${accountSet})`,
        `DELETE FROM auth WHERE account_id IN (${accountSet})`,
        `DELETE FROM accounts WHERE email = '${canaryEmail}'`,
    ].join("; ");
    run(path.join(repo, "packages/worker/node_modules/.bin/wrangler"), [
        "d1", "execute", "DB", "--local", "--cwd", "packages/worker", "--command", sql,
    ]);
}

function portOpen() {
    return new Promise((resolve) => {
        const socket = net.connect({ host: "127.0.0.1", port: workerPort });
        socket.once("connect", () => { socket.destroy(); resolve(true); });
        socket.once("error", () => resolve(false));
    });
}

async function waitForWorker() {
    const deadline = Date.now() + 30_000;
    while (Date.now() < deadline) {
        if (worker.exitCode !== null) throw new Error("local Worker exited before becoming ready");
        if (await portOpen()) return;
        await new Promise((resolve) => setTimeout(resolve, 250));
    }
    throw new Error("local Worker did not become ready");
}

async function stopWorker() {
    if (!worker || worker.exitCode !== null) return;
    worker.kill("SIGTERM");
    await Promise.race([
        once(worker, "exit"),
        new Promise((resolve) => setTimeout(resolve, 5_000)),
    ]);
    if (worker.exitCode === null) {
        worker.kill("SIGKILL");
        await once(worker, "exit");
    }
    const deadline = Date.now() + 5_000;
    while (Date.now() < deadline && await portOpen()) {
        await new Promise((resolve) => setTimeout(resolve, 100));
    }
    if (await portOpen()) throw new Error(`owned local Worker port ${workerPort} was not released`);
}

async function main() {
    if (await portOpen()) throw new Error(`owned local Worker port ${workerPort} is already in use`);
    snapshotArtifacts();
    run("npm", ["run", "worker:migrate:local"]);
    cleanupLocalCanaries();
    worker = spawn("npm", ["run", "worker:dev"], {
        cwd: repo,
        env: { ...process.env, PL_WORKER_PORT: String(workerPort) },
        stdio: "inherit",
    });
    await waitForWorker();
    run("npm", ["run", "web-extension:build"], {
        PL_SERVER_URL: localServer,
        PL_BUILD_ENV: "development",
    });
    run("npm", ["--prefix", "packages/extension", "run", "test:harness", "--", "--grep", "controlled CH5 RP creates and verifies"], {
        PADLOC_PASSKEY_E2E: "1",
        PADLOC_PASSKEY_CANARY_ID: canaryId,
        PL_SERVER_URL: localServer,
    });
}

main().catch((error) => {
    console.error(error.message);
    process.exitCode = 1;
}).finally(async () => {
    try {
        await stopWorker();
        cleanupLocalCanaries();
    } catch {
        process.exitCode = 1;
    }
    try {
        restoreArtifacts();
    } catch {
        process.exitCode = 1;
    }
});
