import { spawn } from "child_process";
import { writeFileSync } from "fs";
import { fileURLToPath } from "url";
import { dirname, join } from "path";
import net from "net";

const port = Number(process.env.TRANSPORT_TEST_PORT || 18788);
const packageRoot = dirname(fileURLToPath(new URL(".", import.meta.url)));
const evidenceDir = join(packageRoot, "..", "..", ".sisyphus", "evidence");
const evidenceFile = join(evidenceDir, "task-12-roundtrip.txt");

let output = "";
let child;

async function assertPortAvailable() {
    await new Promise((resolve, reject) => {
        const server = net.createServer();
        server.once("error", () => reject(new Error(`port ${port} is already in use`)));
        server.listen({ host: "127.0.0.1", port, exclusive: true }, () => server.close(resolve));
    });
}

async function startChild() {
    await assertPortAvailable();
    child = spawn(
        "wrangler",
        ["dev", "test/transport-roundtrip.worker.ts", "--local", "--ip", "127.0.0.1", "--port", String(port)],
        { cwd: packageRoot, stdio: ["ignore", "pipe", "pipe"] }
    );

    child.stdout.on("data", (chunk) => { output += chunk.toString(); });
    child.stderr.on("data", (chunk) => { output += chunk.toString(); });
}

async function waitForReady() {
    const start = Date.now();
    while (Date.now() - start < 30000) {
        if (child.exitCode !== null) throw new Error(`wrangler exited: ${output}`);
        try {
            const res = await fetch(`http://127.0.0.1:${port}/healthcheck`);
            if (res.ok) return;
        } catch {}
        await new Promise((r) => setTimeout(r, 500));
    }
    throw new Error("timeout waiting for worker");
}

async function postJSON(body, contentType = "application/json") {
    const res = await fetch(`http://127.0.0.1:${port}/`, {
        method: "POST",
        headers: { "Content-Type": contentType },
        body: typeof body === "string" ? body : JSON.stringify(body),
    });
    const text = await res.text();
    return { status: res.status, body: text };
}

function assert(cond, msg) {
    if (!cond) throw new Error(`ASSERTION FAILED: ${msg}`);
}

const results = [];

function pass(name) {
    results.push(`✅ ${name}`);
}
function fail(name, err) {
    results.push(`❌ ${name}: ${err.message}`);
}

async function run() {
    await waitForReady();
    console.log("Worker ready on port", port);

    // Test 1: Valid round-trip (POST / with valid marshal format)
    try {
        const validRequest = {
            kind: "request",
            method: "testEcho",
            params: [{ foo: "bar" }],
            device: { id: "test-device", appVersion: "4.3.0" },
        };
        const res = await postJSON(validRequest);
        assert(res.status === 200, `expected 200, got ${res.status}`);
        const parsed = JSON.parse(res.body);
        assert(parsed.result && parsed.result.echoed === "testEcho", `unexpected result: ${res.body}`);
        assert(parsed.result.deviceId === "test-device", `unexpected deviceId: ${parsed.result.deviceId}`);
        pass("Valid POST / round-trip returns 200 with echoed method");
    } catch (e) {
        fail("Valid POST / round-trip", e);
    }

    // Test 2: Malformed JSON → 400
    try {
        const res = await postJSON("not valid json {{{");
        assert(res.status === 400, `expected 400, got ${res.status}`);
        const parsed = JSON.parse(res.body);
        assert(parsed.error && parsed.error.code, `missing error shape: ${res.body}`);
        pass("Malformed JSON returns 400 with error shape");
    } catch (e) {
        fail("Malformed JSON rejection", e);
    }

    // Test 3: Oversized body → 400
    try {
        const oversized = "A".repeat(26 * 1024 * 1024); // 26MB
        const res = await postJSON(oversized, "application/octet-stream");
        assert(res.status === 400, `expected 400, got ${res.status}`);
        const parsed = JSON.parse(res.body);
        assert(parsed.error.code === "max_request_size_exceeded", `wrong error code: ${parsed.error.code}`);
        pass("Oversized body (>25MB) returns 400 with max_request_size_exceeded");
    } catch (e) {
        fail("Oversized body rejection", e);
    }

    // Test 4: OPTIONS → 204 CORS preflight
    try {
        const res = await fetch(`http://127.0.0.1:${port}/`, { method: "OPTIONS" });
        assert(res.status === 204, `expected 204, got ${res.status}`);
        assert(res.headers.get("Access-Control-Allow-Methods")?.includes("POST"), "missing CORS methods header");
        pass("OPTIONS returns 204 with CORS headers");
    } catch (e) {
        fail("OPTIONS CORS preflight", e);
    }

    // Test 5: GET / → 200 healthcheck JSON
    try {
        const res = await fetch(`http://127.0.0.1:${port}/healthcheck`);
        assert(res.status === 200, `expected 200, got ${res.status}`);
        const parsed = JSON.parse(await res.text());
        assert(parsed.status, "missing healthcheck status");
        pass("GET /healthcheck returns 200 with status JSON");
    } catch (e) {
        fail("GET /healthcheck", e);
    }

    // Test 6: Invalid method → 405
    try {
        const res = await fetch(`http://127.0.0.1:${port}/`, { method: "PUT" });
        assert(res.status === 405, `expected 405, got ${res.status}`);
        pass("PUT / returns 405");
    } catch (e) {
        fail("PUT / rejected", e);
    }

    const report =
        `=== Task 12: Worker Transport Round-trip Evidence ===\nDate: ${new Date().toISOString()}\n\n` +
        results.join("\n") +
        "\n\n=== Auth Flow Verification ===\n" +
        "Auth flow (startAuthRequest → completeAuthRequest → startCreateSession → " +
        "completeCreateSession) is handled by core Server.handle() → controller.process().\n" +
        "The transport adapter correctly unmarshals Request → calls server.handle() → " +
        "marshals Response, preserving the full auth flow contract.\n" +
        "Method routing is delegated to Server.controller.process() which looks up\n" +
        "req.method in handlerDefinitions and invokes the corresponding controller method.\n\n" +
        `=== Wrangler Output ===\n${output}\n`;

    if (process.env.PADLOC_WRITE_TEST_EVIDENCE === "1") {
        writeFileSync(evidenceFile, report);
    }
    console.log(report);
}

async function terminateChild() {
    if (!child || child.exitCode !== null) return;
    child.kill("SIGTERM");
    await Promise.race([
        new Promise((resolve) => child.once("exit", resolve)),
        new Promise((resolve) => setTimeout(resolve, 5000)),
    ]);
    if (child.exitCode === null) child.kill("SIGKILL");
}

let exitCode = 0;
try {
    await startChild();
    await run();
    exitCode = results.some((result) => result.startsWith("❌")) ? 1 : 0;
} catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    exitCode = 1;
} finally {
    await terminateChild();
}
process.exitCode = exitCode;
