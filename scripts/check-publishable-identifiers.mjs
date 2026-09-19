import { readFile, readdir, stat } from "node:fs/promises";
import { extname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(fileURLToPath(new URL("..", import.meta.url)));
const RETIRED_PRODUCT_PATTERN = new RegExp("pad" + "loc(?!k)", "i");
const DEFAULT_PATHS = [
    "assets/manifest.json",
    "packages/cordova/config.xml",
    "packages/electron/package.json",
    "packages/extension/dist",
    "packages/extension/native-host",
    "packages/extension/package.json",
    "packages/macos/project.yml",
    "packages/pwa/dist",
    "packages/pwa/package.json",
    "packages/tauri/src-tauri/tauri.conf.json",
];
const TEXT_EXTENSIONS = new Set([
    "", ".cjs", ".css", ".html", ".js", ".json", ".mjs", ".plist", ".sh", ".swift", ".ts", ".xml", ".yaml", ".yml",
]);

async function collect(rootDir, pathValue) {
    const absolute = join(rootDir, pathValue);
    let info;
    try {
        info = await stat(absolute);
    } catch (error) {
        if (error?.code === "ENOENT") return [];
        throw error;
    }
    if (info.isFile()) return [absolute];
    const files = [];
    for (const entry of await readdir(absolute, { withFileTypes: true })) {
        const child = join(pathValue, entry.name);
        files.push(...(entry.isDirectory() ? await collect(rootDir, child) : [join(rootDir, child)]));
    }
    return files;
}

export async function scanPublishableIdentifiers(rootDir = ROOT, paths = DEFAULT_PATHS) {
    const failures = [];
    const files = (await Promise.all(paths.map((pathValue) => collect(rootDir, pathValue)))).flat().sort();
    for (const file of files) {
        const relativePath = relative(rootDir, file).replaceAll("\\", "/");
        if (RETIRED_PRODUCT_PATTERN.test(relativePath)) {
            failures.push(`${relativePath}: retired product token in artifact path`);
        }
        RETIRED_PRODUCT_PATTERN.lastIndex = 0;
        if (!TEXT_EXTENSIONS.has(extname(file).toLowerCase())) continue;
        const contents = await readFile(file, "utf8");
        if (RETIRED_PRODUCT_PATTERN.test(contents)) {
            failures.push(`${relativePath}: retired product token in publishable bytes`);
        }
        RETIRED_PRODUCT_PATTERN.lastIndex = 0;
    }
    return failures;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
    const failures = await scanPublishableIdentifiers();
    if (failures.length) {
        console.error("Publishable identifier check failed:");
        for (const failure of failures) console.error(`- ${failure}`);
        process.exit(1);
    }
    console.log("Publishable identifier check passed.");
}
