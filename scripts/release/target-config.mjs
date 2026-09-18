import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const releaseDir = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(releaseDir, "../..");
const defaultConfigPath = path.join(repoRoot, "config/environment-targets.json");

function asArray(value) {
    if (value === undefined || value === null) return [];
    return Array.isArray(value) ? value : [value];
}

function uniqueStrings(values) {
    return [...new Set(values.filter((value) => typeof value === "string" && value.length > 0))];
}

function collectCompatibilityUrls(target, kind) {
    const nested = target.compatibility || target.legacy || {};
    const names =
        kind === "app"
            ? [
                  "legacyAppUrls",
                  "legacyAppUrl",
                  "oldAppUrls",
                  "oldAppUrl",
                  "compatibilityAppUrls",
                  "compatibilityAppUrl",
              ]
            : [
                  "legacyApiBaseUrls",
                  "legacyApiBaseUrl",
                  "oldApiBaseUrls",
                  "oldApiBaseUrl",
                  "compatibilityApiBaseUrls",
                  "compatibilityApiBaseUrl",
              ];
    const nestedNames = kind === "app" ? ["appUrls", "appUrl", "origins"] : ["apiBaseUrls", "apiBaseUrl"];
    return uniqueStrings([
        ...names.flatMap((name) => asArray(target[name])),
        ...nestedNames.flatMap((name) => asArray(nested[name])),
    ]);
}

function validateUrl(value, field, stage) {
    if (typeof value !== "string" || value.length === 0) throw new Error(`${stage}.${field} is required`);
    let url;
    try {
        url = new URL(value);
    } catch {
        throw new Error(`${stage}.${field} must be a URL`);
    }
    if (!["http:", "https:"].includes(url.protocol)) throw new Error(`${stage}.${field} must use HTTP(S)`);
    return value.replace(/\/+$/, "");
}

export async function loadEnvironmentTargets(configPath = process.env.ENVIRONMENT_TARGETS_PATH || defaultConfigPath) {
    const config = JSON.parse(await readFile(configPath, "utf8"));
    if (!config || typeof config.targets !== "object" || !config.targets) {
        throw new Error("config/environment-targets.json must contain targets");
    }
    return config;
}

export async function targetForStage(stage, configPath) {
    const config = await loadEnvironmentTargets(configPath);
    const target = config.targets?.[stage];
    if (!target) throw new Error(`unknown environment target: ${stage}`);

    const appUrl = validateUrl(target.appUrl, "appUrl", stage);
    const apiBaseUrl = validateUrl(target.apiBaseUrl, "apiBaseUrl", stage);
    const legacyAppUrls = collectCompatibilityUrls(target, "app")
        .map((url) => validateUrl(url, "legacyAppUrl", stage))
        .filter((url) => url !== appUrl);
    const legacyApiBaseUrls = collectCompatibilityUrls(target, "api")
        .map((url) => validateUrl(url, "legacyApiBaseUrl", stage))
        .filter((url) => url !== apiBaseUrl);

    return {
        ...target,
        stage,
        appUrl,
        apiBaseUrl,
        allowedOrigin: target.allowedOrigin ? validateUrl(target.allowedOrigin, "allowedOrigin", stage) : appUrl,
        legacyAppUrls,
        legacyApiBaseUrls,
    };
}

function parseArgs(argv) {
    const args = { stage: null, field: null, json: false, configPath: undefined };
    for (let index = 0; index < argv.length; index += 1) {
        const argument = argv[index];
        if (argument === "--stage") args.stage = argv[++index];
        else if (argument === "--field") args.field = argv[++index];
        else if (argument === "--config") args.configPath = argv[++index];
        else if (argument === "--json") args.json = true;
        else throw new Error(`unknown argument: ${argument}`);
    }
    if (!args.stage) throw new Error("usage: target-config.mjs --stage <stage> [--field <field>|--json]");
    return args;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
    try {
        const args = parseArgs(process.argv.slice(2));
        const target = await targetForStage(args.stage, args.configPath);
        if (args.field) {
            const value = target[args.field];
            if (value === undefined) throw new Error(`target field is missing: ${args.stage}.${args.field}`);
            process.stdout.write(typeof value === "string" ? `${value}\n` : `${JSON.stringify(value)}\n`);
        } else {
            process.stdout.write(`${JSON.stringify(target, null, 2)}\n`);
        }
    } catch (error) {
        console.error(error instanceof Error ? error.message : String(error));
        process.exitCode = 2;
    }
}
