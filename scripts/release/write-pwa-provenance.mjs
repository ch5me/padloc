import { createHash } from "node:crypto";
import { readFile, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { execFileSync } from "node:child_process";
import { targetForStage } from "./target-config.mjs";

const releaseDir = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(releaseDir, "../..");

function parseArgs(argv) {
    const args = {
        stage: null,
        sha: process.env.PADLOC_DEPLOY_SHA || null,
        dist: path.join(repoRoot, "packages/pwa/dist"),
        output: null,
        configPath: undefined,
    };
    for (let index = 0; index < argv.length; index += 1) {
        const argument = argv[index];
        if (argument === "--stage") args.stage = argv[++index];
        else if (argument === "--sha") args.sha = argv[++index];
        else if (argument === "--dist") args.dist = path.resolve(argv[++index]);
        else if (argument === "--output") args.output = path.resolve(argv[++index]);
        else if (argument === "--config") args.configPath = argv[++index];
        else throw new Error(`unknown argument: ${argument}`);
    }
    if (!args.stage || !args.sha) throw new Error("usage: write-pwa-provenance.mjs --stage <stage> --sha <full-sha>");
    if (!/^[0-9a-f]{40}$/.test(args.sha)) throw new Error("--sha must be a full lowercase 40-character Git SHA");
    return args;
}

async function fileMetadata(dist, relativePath) {
    const absolutePath = path.join(dist, relativePath);
    const bytes = await readFile(absolutePath);
    const info = await stat(absolutePath);
    return {
        path: relativePath,
        sha256: createHash("sha256").update(bytes).digest("hex"),
        size: info.size,
    };
}

async function findEntryJavaScript(dist) {
    const html = await readFile(path.join(dist, "index.html"), "utf8");
    const scripts = [...html.matchAll(/<script\b[^>]*\bsrc=["']([^"']+\.js)["']/gi)]
        .map((match) => match[1].replace(/^\/+/, ""))
        .filter((file) => file !== "sw.js" && !file.endsWith(".map"));
    const entry = scripts.find((file) => path.basename(file) === "main.js") || scripts[0];
    if (!entry) throw new Error("PWA index.html does not reference an entry JavaScript file");
    return entry;
}

async function writeProvenance({ stage, sha, dist, output, configPath }) {
    const target = await targetForStage(stage, configPath);
    const currentSha = execFileSync("git", ["rev-parse", "HEAD"], { cwd: repoRoot, encoding: "utf8" }).trim();
    if (currentSha !== sha) throw new Error(`PWA provenance SHA does not match HEAD: ${sha} != ${currentSha}`);

    const required = ["index.html", "manifest.json", "sw.js", "favicon.png"];
    for (const file of required) {
        try {
            await stat(path.join(dist, file));
        } catch {
            throw new Error(`PWA provenance input is missing: ${file}`);
        }
    }
    const entryJavaScript = await findEntryJavaScript(dist);
    const sourceDateEpoch = Number(process.env.SOURCE_DATE_EPOCH);
    const buildTime =
        process.env.PWA_BUILD_TIME ||
        (Number.isFinite(sourceDateEpoch) && sourceDateEpoch > 0
            ? new Date(sourceDateEpoch * 1000).toISOString()
            : new Date().toISOString());
    if (Number.isNaN(Date.parse(buildTime))) throw new Error("PWA_BUILD_TIME must be an ISO date-time");

    const hashes = {
        indexHtml: await fileMetadata(dist, "index.html"),
        manifest: await fileMetadata(dist, "manifest.json"),
        serviceWorker: await fileMetadata(dist, "sw.js"),
        favicon: await fileMetadata(dist, "favicon.png"),
        entryJavaScript: await fileMetadata(dist, entryJavaScript),
    };
    const provenance = {
        schema: "elf-vault.pwa-provenance.v1",
        stage,
        sourceSha: sha,
        appUrl: target.appUrl,
        apiUrl: target.apiBaseUrl,
        buildTime,
        hashes,
    };
    const outputPath = output || path.join(dist, "build-provenance.json");
    await writeFile(outputPath, `${JSON.stringify(provenance, null, 2)}\n`);
    return provenance;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
    try {
        const args = parseArgs(process.argv.slice(2));
        const provenance = await writeProvenance({
            ...args,
            dist: path.resolve(args.dist),
            output: args.output ? path.resolve(args.output) : null,
        });
        console.log(`wrote ${provenance.schema} ${provenance.stage} ${provenance.sourceSha}`);
    } catch (error) {
        console.error(error instanceof Error ? error.message : String(error));
        process.exitCode = 1;
    }
}

export { findEntryJavaScript, fileMetadata, parseArgs, writeProvenance };
