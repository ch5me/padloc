#!/usr/bin/env node
/**
 * Storage contract test runner — uses esbuild to bundle + Node to execute.
 */
import * as esbuild from "esbuild";
import { execSync } from "child_process";
import { writeFileSync, unlinkSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";

const outfile = join(tmpdir(), "storage-test-bundle.mjs");

await esbuild.build({
    entryPoints: ["packages/worker/test/storage-contract.ts"],
    bundle: true,
    platform: "node",
    target: "node20",
    format: "esm",
    outfile,
    external: ["better-sqlite3", "miniflare"],
    tsconfig: "packages/worker/tsconfig.json",
});

try {
    execSync(`node ${outfile}`, { stdio: "inherit" });
} finally {
    try {
        unlinkSync(outfile);
    } catch {}
}
