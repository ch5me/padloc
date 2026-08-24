import assert from "node:assert/strict";
import { cp, mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";

const root = join(import.meta.dirname, "..");
const fixture = await mkdtemp(join(tmpdir(), "padloc-private-registry-"));

try {
    await mkdir(join(fixture, "scripts"));
    await mkdir(join(fixture, ".forgejo/workflows"), { recursive: true });
    await mkdir(join(fixture, ".ch5"));
    await cp(
        join(root, "scripts/check-ci-private-registry.mjs"),
        join(fixture, "scripts/check-ci-private-registry.mjs")
    );
    await writeFile(
        join(fixture, "scripts/ci-bootstrap-workspaces.sh"),
        'repository_root="$(cd "$(dirname "$0")/.." && pwd)"\n' +
            'export NPM_CONFIG_USERCONFIG="$repository_root/.npmrc"\n'
    );
    await writeFile(
        join(fixture, ".npmrc"),
        "@ch5me:registry=https://npm.ch5.me/\n//npm.ch5.me/:_authToken=${NPM_TOKEN}\n"
    );
    await writeFile(
        join(fixture, ".ch5/toolchain.toml"),
        '[[hushTarget]]\ntarget = "runtime"\nroot = "project"\nexports = ["NPM_TOKEN"]\nrequiredFor = ["install"]\n'
    );
    await writeFile(
        join(fixture, ".forgejo/workflows/test.yml"),
        "name: test\non: push\njobs:\n  test:\n    steps:\n      - run: npm ci\n"
    );
    await writeFile(
        join(fixture, ".forgejo/workflows/branch-regression.yml"),
        "name: branch\non: push\nenv:\n  NPM_TOKEN: ${{ secrets.NPM_TOKEN }}\njobs:\n  docker:\n    steps:\n" +
            "      - run: docker build --secret id=npm_token,env=NPM_TOKEN --file Dockerfile-server .\n" +
            "      - run: docker build --secret id=npm_token,env=NPM_TOKEN --file Dockerfile-pwa .\n"
    );
    await writeFile(
        join(fixture, ".forgejo/workflows/update-dockerhub.yml"),
        "name: dockerhub\non: push\nenv:\n  NPM_TOKEN: ${{ secrets.NPM_TOKEN }}\njobs:\n  docker:\n    steps:\n" +
            "      - with:\n          secrets: |\n            npm_token=${{ secrets.NPM_TOKEN }}\n" +
            "      - with:\n          secrets: |\n            npm_token=${{ secrets.NPM_TOKEN }}\n"
    );
    const dockerfile =
        "FROM node:24-bookworm\n" +
        "WORKDIR /padloc\n" +
        "COPY package*.json lerna.json tsconfig.json .npmrc ./\n" +
        "COPY scripts/ci-bootstrap-workspaces.sh scripts/check-native-build-python.sh ./scripts/\n" +
        "RUN --mount=type=secret,id=npm_token,env=NPM_TOKEN npm ci --unsafe-perm\n";
    await writeFile(join(fixture, "Dockerfile-pwa"), dockerfile);
    await writeFile(join(fixture, "Dockerfile-server"), dockerfile);

    const rejected = spawnSync(process.execPath, [join(fixture, "scripts/check-ci-private-registry.mjs")], {
        encoding: "utf8",
    });
    assert.notEqual(rejected.status, 0);
    assert.match(rejected.stderr, /runs npm ci without the repository NPM_TOKEN/);

    await writeFile(
        join(fixture, ".forgejo/workflows/test.yml"),
        "name: test\non: push\nenv:\n  NPM_TOKEN: ${{ secrets.NPM_TOKEN }}\njobs:\n  test:\n    steps:\n      - run: npm ci\n"
    );
    const accepted = spawnSync(process.execPath, [join(fixture, "scripts/check-ci-private-registry.mjs")], {
        encoding: "utf8",
    });
    assert.equal(accepted.status, 0, accepted.stderr);

    await writeFile(join(fixture, "scripts/ci-bootstrap-workspaces.sh"), "set -euo pipefail\n");
    const nestedRegistryRejected = spawnSync(
        process.execPath,
        [join(fixture, "scripts/check-ci-private-registry.mjs")],
        { encoding: "utf8" }
    );
    assert.notEqual(nestedRegistryRejected.status, 0);
    assert.match(nestedRegistryRejected.stderr, /workspace bootstrap does not force nested npm installs/);
} finally {
    await rm(fixture, { recursive: true, force: true });
}

console.log("ci-private-registry:test ok");
