import { readdirSync, readFileSync } from "node:fs";
import { resolve } from "node:path";

const root = resolve(import.meta.dirname, "..");
const workflowDirectory = resolve(root, ".forgejo/workflows");
const npmrc = readFileSync(resolve(root, ".npmrc"), "utf8");
const toolchain = readFileSync(resolve(root, ".ch5/toolchain.toml"), "utf8");
const failures = [];

for (const name of readdirSync(workflowDirectory).filter((entry) => entry.endsWith(".yml"))) {
    const workflow = readFileSync(resolve(workflowDirectory, name), "utf8");
    if (!workflow.includes("npm ci")) continue;

    const jobsIndex = workflow.indexOf("\njobs:");
    const header = jobsIndex === -1 ? workflow : workflow.slice(0, jobsIndex);
    if (!header.includes("NPM_TOKEN: ${{ secrets.NPM_TOKEN }}")) {
        failures.push(`${name} runs npm ci without the repository NPM_TOKEN`);
    }
}

if (!npmrc.includes("@ch5me:registry=https://npm.ch5.me/")) {
    failures.push(".npmrc does not route @ch5me packages to npm.ch5.me");
}
if (!npmrc.includes("//npm.ch5.me/:_authToken=${NPM_TOKEN}")) {
    failures.push(".npmrc does not authenticate npm.ch5.me with NPM_TOKEN");
}
if (
    !/target = "runtime"[\s\S]*root = "project"[\s\S]*exports = \["NPM_TOKEN"\][\s\S]*requiredFor = \["install"\]/.test(
        toolchain
    )
) {
    failures.push(".ch5/toolchain.toml does not inject repo-local runtime NPM_TOKEN for installs");
}

if (failures.length > 0) {
    throw new Error(`Private registry CI contract failed:\n- ${failures.join("\n- ")}`);
}

console.log("ci-private-registry:check ok");
