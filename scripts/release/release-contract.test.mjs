import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fetchWithRetry, runCanary } from "./deployed-canary.mjs";
import { candidateSha, verifyCurrentMain } from "./preflight-production.mjs";
import { writeProvenance } from "./write-pwa-provenance.mjs";

const repoRoot = path.resolve(path.dirname(new URL(import.meta.url).pathname), "../..");
const sha = execFileSync("git", ["rev-parse", "HEAD"], { cwd: repoRoot, encoding: "utf8" }).trim();

test("production preflight rejects invalid and stale candidates before deployment", () => {
    assert.throws(() => candidateSha("short"), /full lowercase 40-character Git SHA/);

    const responses = [sha, "f".repeat(40)];
    assert.throws(
        () =>
            verifyCurrentMain(sha, (_command, args) => {
                if (args[0] === "fetch") return "";
                return `${responses.shift()}\n`;
            }),
        /not current origin\/main/
    );

    const wrongHead = "e".repeat(40);
    assert.throws(
        () =>
            verifyCurrentMain(sha, (_command, args) => {
                if (args[0] === "fetch") return "";
                return `${wrongHead}\n`;
            }),
        /not checked out/
    );
});

test("production deploy rejects dirty tracked or untracked source before build and auth", async () => {
    const deploy = await readFile(path.join(repoRoot, "scripts/deploy-production"), "utf8");
    const cleanGate = deploy.indexOf("git diff --quiet");
    const auth = deploy.indexOf("hush run --target wrangler-deploy-production");
    const build = deploy.indexOf("npm run pwa:build");
    assert.ok(cleanGate >= 0 && cleanGate < auth && cleanGate < build);
    assert.match(deploy, /git ls-files --others --exclude-standard -z/);
    assert.doesNotMatch(deploy, /git ls-files --others --ignored/);
    assert.match(deploy, /production deploy requires a clean tracked index and worktree/);
});

test("deployed canary times out each never-resolving fetch attempt", async () => {
    const started = Date.now();
    await assert.rejects(
        fetchWithRetry(() => new Promise(() => {}), "https://never-resolves.invalid", {}, 10),
        /fetch timed out after 10ms/
    );
    assert.ok(Date.now() - started < 500, "canary timeout should not wait for the default timeout");
});

async function fixtureConfig(directory, port, host = "127.0.0.1") {
    const configPath = path.join(directory, "environment-targets.json");
    await writeFile(
        configPath,
        `${JSON.stringify(
            {
                stages: ["staging"],
                targets: {
                    staging: {
                        stage: "staging",
                        displayName: "Elf Vault",
                        appUrl: `http://${host}:${port}/new`,
                        apiBaseUrl: `http://${host}:${port}/api/new`,
                        workerEnv: "staging",
                        workerName: "padloc-worker-staging",
                        pagesProject: "padloc-pwa-staging",
                        allowedOrigin: `http://${host}:${port}/new`,
                        legacyAppUrls: [`http://${host}:${port}/old`],
                        legacyApiBaseUrls: [`http://${host}:${port}/api/old`],
                    },
                },
            },
            null,
            2
        )}\n`
    );
    return configPath;
}

test("PWA provenance fixture records exact files and hashes", async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), "elf-vault-provenance-"));
    try {
        const dist = path.join(directory, "dist");
        await mkdir(dist, { recursive: true });
        await writeFile(
            path.join(dist, "index.html"),
            '<meta http-equiv="Content-Security-Policy" content="default-src none"><script src="/main.js"></script>'
        );
        await writeFile(path.join(dist, "manifest.json"), JSON.stringify({ name: "Elf Vault" }));
        await writeFile(path.join(dist, "sw.js"), "self.addEventListener('fetch', () => {});");
        await writeFile(path.join(dist, "favicon.png"), Buffer.from([137, 80, 78, 71]));
        await writeFile(path.join(dist, "main.js"), "console.log('Elf Vault');");
        const configPath = await fixtureConfig(directory, 44111);
        const provenance = await writeProvenance({
            stage: "staging",
            sha,
            dist,
            output: path.join(dist, "build-provenance.json"),
            configPath,
        });
        assert.equal(provenance.schema, "elf-vault.pwa-provenance.v1");
        assert.equal(provenance.sourceSha, sha);
        assert.equal(provenance.hashes.entryJavaScript.path, "main.js");
        assert.equal(
            JSON.parse(await readFile(path.join(dist, "build-provenance.json"), "utf8")).apiUrl,
            "http://127.0.0.1:44111/api/new"
        );
    } finally {
        await rm(directory, { recursive: true, force: true });
    }
});

test("deployed canary fixture covers API, PWA, CORS, CSP, assets, and old hosts", async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), "elf-vault-canary-"));
    const server = http.createServer();
    try {
        const port = await new Promise((resolve, reject) => {
            server.once("error", reject);
            server.listen(0, "127.0.0.1", () => resolve(server.address().port));
        });
        const dist = path.join(directory, "dist");
        await mkdir(dist, { recursive: true });
        const html = `<meta http-equiv="Content-Security-Policy" content="default-src 'none'; connect-src http://127.0.0.1:${port}/api/new; worker-src http://127.0.0.1:${port}/new; script-src http://127.0.0.1:${port}"><script src="/main.js"></script><title>Elf Vault</title>`;
        await writeFile(path.join(dist, "index.html"), html);
        await writeFile(path.join(dist, "manifest.json"), JSON.stringify({ name: "Elf Vault" }));
        await writeFile(path.join(dist, "sw.js"), "self.addEventListener('fetch', () => {});");
        await writeFile(path.join(dist, "favicon.png"), Buffer.from([137, 80, 78, 71]));
        await writeFile(path.join(dist, "main.js"), "console.log('Elf Vault');");
        const configPath = await fixtureConfig(directory, port);
        const provenance = await writeProvenance({
            stage: "staging",
            sha,
            dist,
            output: path.join(dist, "build-provenance.json"),
            configPath,
        });

        server.on("request", async (request, response) => {
            const url = new URL(request.url, `http://${request.headers.host}`);
            const origin = request.headers.origin;
            const allowedOrigins = [`http://127.0.0.1:${port}/new`, `http://127.0.0.1:${port}/old`];
            if (url.pathname.endsWith("/healthcheck")) {
                const headers = {
                    "content-type": "application/json",
                    vary: "Origin",
                };
                if (allowedOrigins.includes(origin)) headers["access-control-allow-origin"] = origin;
                if (request.method === "OPTIONS") {
                    response.writeHead(204, headers);
                    response.end();
                    return;
                }
                response.writeHead(200, headers);
                response.end(JSON.stringify({ status: "ok", version: sha, d1: "ok", r2: "ok", resend: "ok" }));
                return;
            }
            if (request.method === "OPTIONS") {
                const headers = { vary: "Origin" };
                if (allowedOrigins.includes(origin)) headers["access-control-allow-origin"] = origin;
                response.writeHead(204, headers);
                response.end();
                return;
            }
            const isApp = url.pathname === "/new/" || url.pathname === "/old/";
            const relative = url.pathname.replace(/^\/(?:new|old)\//, "");
            if (isApp && !relative) {
                response.writeHead(200, {
                    "content-type": "text/html",
                    "content-security-policy": html.match(/content="([^"]+)"/)[1],
                });
                response.end(html);
                return;
            }
            const file = relative === "build-provenance.json" ? "build-provenance.json" : relative;
            const filePath = path.join(dist, file);
            try {
                const body = await readFile(filePath);
                response.writeHead(200, {
                    "content-type":
                        file === "manifest.json" || file === "build-provenance.json"
                            ? "application/json"
                            : file === "favicon.png"
                            ? "image/png"
                            : file.endsWith(".js")
                            ? "application/javascript"
                            : "text/plain",
                });
                response.end(body);
            } catch {
                response.writeHead(404);
                response.end();
            }
        });

        const receiptPath = path.join(directory, "receipts", "staging.json");
        const target = await runCanary({ stage: "staging", expectedSha: sha, configPath, receiptPath });
        assert.equal(target.displayName, "Elf Vault");
        const receipt = JSON.parse(await readFile(receiptPath, "utf8"));
        assert.equal(receipt.schema, "elf-vault.deployed-canary-receipt.v1");
        assert.equal(receipt.stage, "staging");
        assert.equal(receipt.expectedSha, sha);
        assert.equal(receipt.apiSha, sha);
        assert.equal(receipt.pwaSha, sha);
        assert.match(receipt.checkedAt, /^\d{4}-\d{2}-\d{2}T/);
        void provenance;
    } finally {
        await new Promise((resolve) => server.close(resolve));
        await rm(directory, { recursive: true, force: true });
    }
});
