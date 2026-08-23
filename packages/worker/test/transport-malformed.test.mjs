import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import net from "node:net";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const packageRoot = dirname(fileURLToPath(new URL("../package.json", import.meta.url)));
const port = Number(process.env.TRANSPORT_MALFORMED_TEST_PORT || 18789);
const temporaryDirectory = mkdtempSync(join(tmpdir(), "padloc-transport-malformed-"));
const workerFile = join(temporaryDirectory, "worker.ts");
const persistDirectory = join(temporaryDirectory, "wrangler-state");
let child;
let childOutput = "";

writeFileSync(
    workerFile,
    `import { WorkerReceiver, WorkerReceiverConfig } from ${JSON.stringify(join(packageRoot, "src/transport"))};
import { Request as PlRequest, Response as PlResponse } from ${JSON.stringify(
        join(packageRoot, "../core/src/transport")
    )};
import { Err, ErrorCode } from ${JSON.stringify(join(packageRoot, "../core/src/error"))};

const entries = new Map<string, any>();
const config = new WorkerReceiverConfig();
config.allowOrigin = "https://pad.example";
config.maxRequestSize = 256;
config.maxRequestAgeMs = 1_000;
config.clockSkewToleranceMs = 0;
config.idempotencyStore = {
    async lookup(key: string) { return entries.get(key); },
    async store(key: string, value: any) { entries.set(key, value); },
};
const receiver = new WorkerReceiver(config);

export default {
    fetch(request: Request, env: unknown, ctx: ExecutionContext) {
        return receiver.handleFetch(request, async (req: PlRequest) => {
            if (req.method === "rejectKnown") throw new Err(ErrorCode.BAD_REQUEST, "known rejection");
            if (req.method === "rejectUnknown") throw new Error("handler secret must be sanitized");
            const response = new PlResponse();
            if (req.method === "duplicate") response.error = ErrorCode.BAD_REQUEST;
            response.message = req.method === "duplicate" ? "duplicate result" : "";
            response.result = req.method === "duplicate" ? undefined : { method: req.method, appVersion: req.device?.appVersion };
            return response;
        }, env, ctx);
    },
};
`
);

function availablePort() {
    return new Promise((resolve, reject) => {
        const server = net.createServer();
        server.once("error", reject);
        server.listen({ host: "127.0.0.1", port, exclusive: true }, () => server.close(resolve));
    });
}

async function ready() {
    const deadline = Date.now() + 30_000;
    while (Date.now() < deadline) {
        if (child.exitCode !== null) throw new Error(`wrangler exited before becoming ready:\n${childOutput}`);
        try {
            const response = await fetch(`http://127.0.0.1:${port}/healthcheck`);
            if (response.ok) return;
        } catch {}
        await new Promise((resolve) => setTimeout(resolve, 250));
    }
    throw new Error(`timed out waiting for wrangler:\n${childOutput}`);
}

async function request(body, { method = "POST", headers = {}, path = "/" } = {}) {
    const response = await fetch(`http://127.0.0.1:${port}${path}`, {
        method,
        headers,
        body: method === "POST" ? body : undefined,
    });
    const text = await response.text();
    return { response, text, json: text ? JSON.parse(text) : undefined };
}

const valid = (method, extra = {}) =>
    JSON.stringify({
        kind: "request",
        method,
        params: [],
        device: { id: "malformed-vector", appVersion: "4.3.0" },
        ...extra,
    });

async function vector(name, callback) {
    await callback();
    console.log(`PASS ${name}`);
}

try {
    await availablePort();
    child = spawn(
        join(packageRoot, "node_modules/.bin/wrangler"),
        ["dev", workerFile, "--local", "--persist-to", persistDirectory, "--ip", "127.0.0.1", "--port", String(port)],
        { cwd: packageRoot, stdio: ["ignore", "pipe", "pipe"] }
    );
    child.stdout.on("data", (chunk) => (childOutput += chunk));
    child.stderr.on("data", (chunk) => (childOutput += chunk));
    await ready();

    await vector("empty body is an invalid request", async () => {
        const result = await request("");
        assert.equal(result.response.status, 400);
        assert.equal(result.json.error.code, "invalid_request");
    });

    await vector("invalid JSON is an invalid request", async () => {
        const result = await request("{ definitely-not-json");
        assert.equal(result.response.status, 400);
        assert.equal(result.json.error.code, "invalid_request");
    });

    await vector("oversized UTF-8 body is rejected by byte length", async () => {
        const result = await request(`{"padding":"${"é".repeat(140)}"}`);
        assert.equal(result.response.status, 400);
        assert.equal(result.json.error.code, "max_request_size_exceeded");
    });

    await vector("transport accepts JSON with a parameterized content type", async () => {
        const result = await request(valid("contentType"), {
            headers: { "content-type": "application/json; charset=utf-8" },
        });
        assert.equal(result.response.status, 200);
        assert.equal(result.json.result.method, "contentType");
        assert.match(result.response.headers.get("content-type") || "", /^application\/json\b/);
    });

    await vector("transport parsing is independent of an absent content type", async () => {
        const result = await request(valid("noContentType"));
        assert.equal(result.response.status, 200);
        assert.equal(result.json.result.method, "noContentType");
    });

    await vector("current client version survives request decoding", async () => {
        const result = await request(valid("version"));
        assert.equal(result.response.status, 200);
        assert.equal(result.json.result.appVersion, "4.3.0");
    });

    for (const [name, time] of [
        ["stale request version", Date.now() - 60_000],
        ["future request version", Date.now() + 60_000],
    ]) {
        await vector(`${name} is rejected`, async () => {
            const result = await request(valid("versionAge", { time }));
            assert.equal(result.response.status, 400);
            assert.equal(result.json.error.code, "max_request_age_exceeded");
        });
    }

    await vector("CORS preflight exposes the Worker transport policy", async () => {
        const result = await request(undefined, { method: "OPTIONS" });
        assert.equal(result.response.status, 204);
        assert.equal(result.response.headers.get("access-control-allow-origin"), "https://pad.example");
        assert.match(result.response.headers.get("access-control-allow-methods") || "", /POST/);
        assert.match(result.response.headers.get("access-control-allow-headers") || "", /Content-Type/i);
    });

    await vector("duplicate request bodies replay the complete stored response", async () => {
        const body = valid("duplicate");
        const first = await request(body, { headers: { "idempotency-key": "same-key" } });
        const second = await request(body, { headers: { "idempotency-key": "same-key" } });
        assert.equal(first.response.status, 200);
        assert.equal(first.response.headers.get("idempotency-replayed"), null);
        assert.equal(second.response.status, 200);
        assert.equal(second.response.headers.get("idempotency-replayed"), "true");
        assert.deepEqual(second.json, first.json);
    });

    await vector("duplicate successful request bodies remain successful", async () => {
        const body = valid("successfulDuplicate");
        const first = await request(body);
        const second = await request(body);
        assert.equal(first.response.headers.get("idempotency-replayed"), null);
        assert.equal(second.response.headers.get("idempotency-replayed"), "true");
        assert.deepEqual(second.json, first.json);
    });

    await vector("known handler rejection preserves its public error", async () => {
        const result = await request(valid("rejectKnown"));
        assert.equal(result.response.status, 400);
        assert.deepEqual(result.json.error, { code: "bad_request", message: "known rejection" });
    });

    await vector("unknown handler rejection is sanitized", async () => {
        const result = await request(valid("rejectUnknown"));
        assert.equal(result.response.status, 500);
        assert.equal(result.json.error.code, "server_error");
        assert.doesNotMatch(result.text, /handler secret/);
    });

    console.log("All malformed Worker transport vectors passed.");
} finally {
    if (child && child.exitCode === null) child.kill("SIGTERM");
    rmSync(temporaryDirectory, { recursive: true, force: true });
}
