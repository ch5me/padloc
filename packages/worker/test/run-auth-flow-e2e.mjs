import http from "http";
import { spawn } from "child_process";

const port = Number(process.env.AUTH_FLOW_TEST_PORT || 18790);
const packageRoot = new URL("..", import.meta.url);
const wranglerArgs = [
    "dev",
    "test/auth-flow-e2e.worker.ts",
    "--local",
    "--env=dev",
    "--ip",
    "127.0.0.1",
    "--port",
    String(port),
];

const child = spawn("wrangler", wranglerArgs, {
    cwd: packageRoot,
    stdio: ["ignore", "pipe", "pipe"],
});

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

function requestTests() {
    return new Promise((resolve, reject) => {
        const req = http.get(`http://127.0.0.1:${port}/auth-flow-tests`, (res) => {
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
        req.setTimeout(120000, () => {
            req.destroy(new Error("Timed out waiting for auth flow test response"));
        });
    });
}

async function waitForWorker() {
    const started = Date.now();
    while (Date.now() - started < 30000) {
        if (child.exitCode !== null) {
            throw new Error(`wrangler exited before serving requests.\n${output}`);
        }

        try {
            return await requestTests();
        } catch (_error) {
            await new Promise((resolve) => setTimeout(resolve, 500));
        }
    }

    throw new Error(`Timed out waiting for wrangler.\n${output}`);
}

try {
    const report = await waitForWorker();
    console.log(report.body);
    process.exitCode = report.statusCode >= 200 && report.statusCode < 300 ? 0 : 1;
} catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
} finally {
    child.kill("SIGTERM");
}
