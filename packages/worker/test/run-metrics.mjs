import { spawn } from "child_process";
import { dirname, resolve } from "path";
import { fileURLToPath } from "url";

const root = dirname(fileURLToPath(import.meta.url));
const worker = spawn("wrangler", ["dev", "test/metrics.worker.ts", "--local", "--ip", "127.0.0.1", "--port", "18789"], { cwd: resolve(root, ".."), stdio: ["ignore", "pipe", "pipe"] });
let output = "";
worker.stdout.on("data", (chunk) => (output += chunk));
worker.stderr.on("data", (chunk) => (output += chunk));

try {
    const started = Date.now();
    while (Date.now() - started < 30000) {
        try {
            const response = await fetch("http://127.0.0.1:18789/metrics");
            if (response.ok) break;
        } catch {}
        await new Promise((resolve) => setTimeout(resolve, 200));
    }
    const request = { kind: "request", method: "getVault", params: [{ id: "vault-id" }] };
    const response = await fetch("http://127.0.0.1:18789/", { method: "POST", body: JSON.stringify(request) });
    if (!response.ok) throw new Error(`RPC failed: ${response.status}`);
    const metrics = await (await fetch("http://127.0.0.1:18789/metrics")).text();
    if (!metrics.includes('padloc_rpc_total{method="getVault"} 1')) throw new Error(metrics);
    if (!metrics.includes("padloc_vault_sync_success_total 1")) throw new Error(metrics);
    console.log(metrics);
} finally {
    worker.kill("SIGTERM");
}
