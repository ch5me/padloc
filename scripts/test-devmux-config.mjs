import { readFileSync } from "node:fs";

const root = JSON.parse(readFileSync(new URL("../devmux.config.json", import.meta.url)));
const packageJson = JSON.parse(readFileSync(new URL("../package.json", import.meta.url)));
const services = root.services;

if (root.version !== 1 || root.project !== "padloc" || root.proxy?.enabled !== true) {
    throw new Error("DevMux config must use version 1, padloc project, and proxy");
}
for (const name of ["api", "web", "v3", "maildev", "tauri"]) {
    if (!services[name]) throw new Error(`Missing DevMux service: ${name}`);
}
if (services.web.dependsOn?.join(",") !== "api") throw new Error("web must depend on api");
if (!services.web.env?.PL_SERVER_URL.includes("{{INSTANCE}}")) throw new Error("web API URL must be Grove-scoped");
if (!services.api.env?.PL_WORKER_PORT.includes("{{PORT}}")) throw new Error("api must consume DevMux port");
if (!services.web.env?.PL_PWA_PORT.includes("{{PORT}}")) throw new Error("web must consume DevMux port");
if (services.api.health?.type !== "http" || services.api.health?.url.endsWith("/healthcheck") !== true) {
    throw new Error("api must use HTTP healthcheck");
}
if (packageJson.devDependencies?.["@chriscode/devmux"] !== "^1.13.0") {
    throw new Error("repo must pin @chriscode/devmux ^1.13.0");
}
for (const [name, service] of Object.entries(services)) {
    if (/\b8787\b|\b3000\b/.test(service.command)) throw new Error(`${name} command hardcodes a port`);
}
