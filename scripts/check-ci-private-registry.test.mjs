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
} finally {
    await rm(fixture, { recursive: true, force: true });
}

console.log("ci-private-registry:test ok");
