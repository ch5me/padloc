import { execFileSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { runCanary } from "./deployed-canary.mjs";

const releaseDir = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(releaseDir, "../..");

function candidateSha(value) {
    if (!/^[0-9a-f]{40}$/.test(value || "")) {
        throw new Error("PADLOC_DEPLOY_SHA must be a full lowercase 40-character Git SHA");
    }
    return value;
}

function verifyCurrentMain(
    sha,
    runGit = (command, args) => execFileSync(command, args, { cwd: repoRoot, encoding: "utf8" })
) {
    runGit("git", ["fetch", "--no-tags", "origin", "main"]);
    const head = runGit("git", ["rev-parse", "HEAD"]).trim();
    const originMain = runGit("git", ["rev-parse", "origin/main"]).trim();
    if (head !== sha) throw new Error(`production candidate is not checked out: ${head} != ${sha}`);
    if (originMain !== sha) throw new Error(`production candidate is not current origin/main: ${originMain} != ${sha}`);
}

export async function runProductionPreflight({
    sha = process.env.PADLOC_DEPLOY_SHA,
    runGit,
    fetchImpl = globalThis.fetch,
    configPath,
    receiptPath,
} = {}) {
    const expectedSha = candidateSha(sha);
    verifyCurrentMain(expectedSha, runGit);
    await runCanary({ stage: "staging", expectedSha, fetchImpl, configPath, receiptPath });
    return expectedSha;
}

function parseArgs(argv) {
    const args = { sha: process.env.PADLOC_DEPLOY_SHA, configPath: undefined, receiptPath: undefined };
    for (let index = 0; index < argv.length; index += 1) {
        const argument = argv[index];
        if (argument === "--sha") args.sha = argv[++index];
        else if (argument === "--config") args.configPath = argv[++index];
        else if (argument === "--receipt") args.receiptPath = argv[++index];
        else throw new Error(`unknown argument: ${argument}`);
    }
    return args;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
    try {
        const args = parseArgs(process.argv.slice(2));
        const sha = await runProductionPreflight(args);
        console.log(
            `production preflight passed current-main=${sha} staging=${sha}${
                args.receiptPath ? ` receipt=${args.receiptPath}` : ""
            }`
        );
    } catch (error) {
        console.error(error instanceof Error ? error.message : String(error));
        process.exitCode = 1;
    }
}

export { candidateSha, parseArgs, verifyCurrentMain };
