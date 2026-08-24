import { readdirSync, readFileSync } from "node:fs";
import { resolve } from "node:path";

const root = resolve(import.meta.dirname, "..");
const workflowDirectory = resolve(root, ".forgejo/workflows");
const npmrc = readFileSync(resolve(root, ".npmrc"), "utf8");
const toolchain = readFileSync(resolve(root, ".ch5/toolchain.toml"), "utf8");
const bootstrap = readFileSync(resolve(root, "scripts/ci-bootstrap-workspaces.sh"), "utf8");
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
if (!bootstrap.includes('export NPM_CONFIG_USERCONFIG="$repository_root/.npmrc"')) {
    failures.push("workspace bootstrap does not force nested npm installs through the repository .npmrc");
}
if (
    !/target = "runtime"[\s\S]*root = "project"[\s\S]*exports = \["NPM_TOKEN"\][\s\S]*requiredFor = \["install"\]/.test(
        toolchain
    )
) {
    failures.push(".ch5/toolchain.toml does not inject repo-local runtime NPM_TOKEN for installs");
}

for (const name of ["Dockerfile-pwa", "Dockerfile-server"]) {
    const dockerfile = readFileSync(resolve(root, name), "utf8");
    const installIndex = dockerfile.indexOf("npm ci");
    const prerequisites =
        "COPY package*.json lerna.json tsconfig.json .npmrc ./\n" +
        "COPY scripts/ci-bootstrap-workspaces.sh scripts/check-native-build-python.sh ./scripts/";
    if (installIndex !== -1 && !dockerfile.slice(0, installIndex).includes(prerequisites)) {
        failures.push(`${name} does not copy npm/bootstrap prerequisites before npm ci`);
    }
    if (!dockerfile.includes("RUN --mount=type=secret,id=npm_token,env=NPM_TOKEN npm ci")) {
        failures.push(`${name} does not mount NPM_TOKEN as a BuildKit secret`);
    }
}

const branchRegression = readFileSync(resolve(workflowDirectory, "branch-regression.yml"), "utf8");
if (
    !branchRegression.includes("docker build --secret id=npm_token,env=NPM_TOKEN --file Dockerfile-server") ||
    !branchRegression.includes("docker build --secret id=npm_token,env=NPM_TOKEN --file Dockerfile-pwa")
) {
    failures.push("branch-regression Docker builds do not pass NPM_TOKEN as a BuildKit secret");
}

const dockerhub = readFileSync(resolve(workflowDirectory, "update-dockerhub.yml"), "utf8");
if (
    !dockerhub.includes("NPM_TOKEN: ${{ secrets.NPM_TOKEN }}") ||
    (dockerhub.match(/npm_token=\$\{\{ secrets\.NPM_TOKEN \}\}/g) ?? []).length !== 2
) {
    failures.push("Docker Hub builds do not pass NPM_TOKEN as a BuildKit secret");
}

if (failures.length > 0) {
    throw new Error(`Private registry CI contract failed:\n- ${failures.join("\n- ")}`);
}

console.log("ci-private-registry:check ok");
