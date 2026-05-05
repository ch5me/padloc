import http from "http";
import { spawn } from "child_process";
import { writeFileSync } from "fs";
import { fileURLToPath } from "url";
import { dirname, join } from "path";

const port = Number(process.env.ERROR_SEMANTICS_PORT || 18789);
const packageRoot = new URL("..", import.meta.url);
const evidenceDir = join(packageRoot.pathname, "..", "..", ".sisyphus", "evidence");

const child = spawn(
    "wrangler",
    ["dev", "test/error-semantics.worker.ts", "--local", "--ip", "127.0.0.1", "--port", String(port)],
    {
        cwd: packageRoot,
        stdio: ["ignore", "pipe", "pipe"],
    },
);

let output = "";
child.stdout.on("data", (chunk) => {
    output += chunk.toString();
});
child.stderr.on("data", (chunk) => {
    output += chunk.toString();
});
child.on("error", (error) => {
    console.error(`Failed to start wrangler: ${error.message}`);
    process.exitCode = 1;
});

function requestReport() {
    return new Promise((resolve, reject) => {
        const req = http.get(`http://127.0.0.1:${port}/error-parity`, (res) => {
            let body = "";
            res.setEncoding("utf8");
            res.on("data", (chunk) => {
                body += chunk;
            });
            res.on("end", () => {
                resolve({ statusCode: res.statusCode || 0, body });
            });
        });
        req.on("error", reject);
        req.setTimeout(30000, () => {
            req.destroy(new Error("Timed out waiting for error semantics worker response"));
        });
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

    const evidence =
        `=== Task 22: Error, Idempotency, Retry & Edge-Case Semantics ===\n` +
        `Date: ${new Date().toISOString()}\n` +
        `Runtime: ${parsed.runtime}\n` +
        `Overall: ${parsed.ok ? "PASS" : "FAIL"}\n` +
        `Summary: ${parsed.summary.passed}/${parsed.summary.total} passed\n\n` +
        parsed.results.map((r) => `${r.ok ? "✅" : "❌"} ${r.name}: ${r.detail}`).join("\n") +
        "\n";

    writeFileSync(join(evidenceDir, "task-22-idempotency.txt"), evidence);
    writeFileSync(join(evidenceDir, "task-22-sanitized-error.txt"), evidence);
    writeFileSync(join(evidenceDir, "task-22-error-semantics.txt"), evidence);

    console.log(evidence);
    process.exitCode = report.statusCode >= 200 && report.statusCode < 300 ? 0 : 1;
} catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
} finally {
    child.kill("SIGTERM");
}
