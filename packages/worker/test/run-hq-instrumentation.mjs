import http from "http";
import { spawn } from "child_process";

const workerPort = Number(process.env.HQ_INSTRUMENTATION_PORT || 18791);
const packageRoot = new URL("..", import.meta.url);

const child = spawn(
    "wrangler",
    ["dev", "test/hq-instrumentation.worker.ts", "--local", "--ip", "127.0.0.1", "--port", String(workerPort)],
    { cwd: packageRoot, stdio: ["ignore", "pipe", "pipe"] }
);

let output = "";
child.stdout.on("data", (chunk) => (output += chunk.toString()));
child.stderr.on("data", (chunk) => (output += chunk.toString()));
child.on("error", (error) => {
    console.error(`Failed to start wrangler: ${error.message}`);
    process.exitCode = 1;
});

function requestReport() {
    return new Promise((resolve, reject) => {
        const req = http.get(`http://127.0.0.1:${workerPort}/hq-instrumentation`, (res) => {
            let body = "";
            res.setEncoding("utf8");
            res.on("data", (chunk) => (body += chunk));
            res.on("end", () => resolve({ statusCode: res.statusCode || 0, body }));
        });
        req.on("error", reject);
        req.setTimeout(30000, () => req.destroy(new Error("Timed out waiting for HQ instrumentation worker")));
    });
}

async function waitForWorker() {
    const started = Date.now();
    while (Date.now() - started < 30000) {
        if (child.exitCode !== null) throw new Error(`wrangler exited before serving requests.\n${output}`);
        try {
            return await requestReport();
        } catch {
            await new Promise((r) => setTimeout(r, 500));
        }
    }
    throw new Error(`Timed out waiting for wrangler.\n${output}`);
}

try {
    const report = await waitForWorker();
    const parsed = JSON.parse(report.body);
    const lines = [
        "=== HQ Instrumentation Proof ===",
        `Date: ${new Date().toISOString()}`,
        `Overall: ${parsed.ok ? "PASS" : "FAIL"}`,
        `Summary: ${parsed.summary.passed}/${parsed.summary.total} passed`,
        "",
        ...parsed.results.map((r) => `${r.ok ? "PASS" : "FAIL"} ${r.name}: ${r.detail}`),
    ];
    console.log(lines.join("\n"));
    process.exitCode = report.statusCode >= 200 && report.statusCode < 300 ? 0 : 1;
} catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
} finally {
    child.kill("SIGTERM");
}
