import { readFile, readdir, stat } from "node:fs/promises";
import { extname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(fileURLToPath(new URL("..", import.meta.url)));

const CUSTOMER_SURFACE_PATHS = [
    "assets/manifest.json",
    "assets/support.md",
    "assets/logo-light.svg",
    "assets/logo-dark.svg",
    "config/release-manifest.schema.json",
    "docs/public-releases.md",
    ".forgejo/workflows/public-release-staging.yml",
    "packages/pwa",
    "packages/app/src",
    "packages/locale/res/translations",
    "packages/extension/src",
    "packages/cordova/config.xml",
    "packages/cordova/src",
    "packages/electron/src",
    "packages/electron/package.json",
    "packages/tauri/src",
    "packages/tauri/src-tauri/Cargo.toml",
    "packages/tauri/src-tauri/tauri.conf.json",
    "packages/macos",
];

const TEXT_EXTENSIONS = new Set([
    ".cjs",
    ".html",
    ".json",
    ".md",
    ".plist",
    ".rs",
    ".swift",
    ".ts",
    ".tsx",
    ".xml",
    ".yml",
    ".yaml",
    ".js",
    ".svg",
]);

// These are compatibility identifiers, not customer-facing product names.
const COMPATIBILITY_ALLOWLIST = [
    /@padloc\/[a-z0-9_/-]+/gi,
    /\bPADLOC_[A-Z0-9_]+/g,
    /\bPadloc(?:WebAuthn|Agentic|Passkey|Native|Credential)[A-Za-z0-9_]*/g,
    /\bdispatchPadlocWebAuthn\b/g,
    /\bpadloc(?:Agentic|Passkey)[A-Za-z0-9_]*/g,
    /\bpadloc-(?:passkey|agentic|extension|native)[a-z0-9-]*/gi,
    /\bpadloc-worker(?:-staging|-dev)?\b/gi,
    /\bpadloc-webauthn-[a-z-]*/gi,
    /data-padloc-webauthn-channel/gi,
    /["']padloc(?:-legacy)?["']/gi,
    /\[Padloc passkey\]/gi,
    /\bPadlock(?:V1|Legacy)?\b/g,
    /\blegacy Padloc 4 version\b/gi,
    /\bPadloc\/Magic Browser bridge\b/gi,
    /\bCH5Auth[A-Za-z0-9_]*/g,
    /\bCH5-owned\b/gi,
    /\bCH5 broker\b/gi,
    /\bch5-auth\b/gi,
    /\bme\.ch5(?:\.[A-Za-z0-9._-]+)?\b/g,
    /https?:\/\/github\.com\/padloc\/padloc(?:\.git)?(?:\/[A-Za-z0-9._/-]*)?/gi,
    /git@github\.com:padloc\/padloc\.git/gi,
    /\bcd padloc\b/gi,
];

const FORBIDDEN_BRAND_PATTERNS = [
    { pattern: /\bPadloc\b/gi, label: "Padloc" },
    { pattern: /\bCH5 Auth\b/gi, label: "CH5 Auth" },
    { pattern: /\bpadloc\.app\b/gi, label: "padloc.app" },
    { pattern: /\b(?:api-)?pad(?:-staging)?\.ch5\.me\b/gi, label: "legacy CH5 host" },
];

async function collectFiles(rootDir, pathValue) {
    const absolute = join(rootDir, pathValue);
    const info = await stat(absolute);
    if (info.isFile()) return [absolute];

    const files = [];
    for (const entry of await readdir(absolute, { withFileTypes: true })) {
        if (entry.name === "node_modules" || entry.name === "dist" || entry.name === "www") continue;
        if (entry.name === "package-lock.json" || entry.name === "Cargo.lock") continue;
        files.push(...(entry.isDirectory()
            ? await collectFiles(rootDir, join(pathValue, entry.name))
            : [join(rootDir, pathValue, entry.name)]));
    }
    return files;
}

function removeCompatibilityMatches(line) {
    return COMPATIBILITY_ALLOWLIST.reduce((remaining, pattern) => remaining.replace(pattern, ""), line);
}

export async function scanCustomerSurface(rootDir = ROOT) {
    const failures = [];
    const files = (await Promise.all(CUSTOMER_SURFACE_PATHS.map((pathValue) => collectFiles(rootDir, pathValue)))).flat();

    for (const file of files) {
        if (!TEXT_EXTENSIONS.has(extname(file).toLowerCase())) continue;
        const source = await readFile(file, "utf8");
        source.split(/\r?\n/).forEach((line, index) => {
            const remaining = removeCompatibilityMatches(line);
            for (const { pattern, label } of FORBIDDEN_BRAND_PATTERNS) {
                if (pattern.test(remaining)) {
                    failures.push(`${relative(rootDir, file)}:${index + 1}: current-product ${label} is not allowlisted`);
                }
                pattern.lastIndex = 0;
            }
        });
    }

    const manifest = JSON.parse(await readFile(join(rootDir, "assets/manifest.json"), "utf8"));
    if (manifest.name !== "Elf Vault") {
        failures.push(`assets/manifest.json: expected name "Elf Vault", got ${JSON.stringify(manifest.name)}`);
    }
    if (!String(manifest.terms_of_service || "").startsWith("https://vault.elf.dance/")) {
        failures.push("assets/manifest.json: terms_of_service must use the Elf Vault host");
    }

    const support = await readFile(join(rootDir, "assets/support.md"), "utf8");
    if (!support.includes("https://vault.elf.dance/")) {
        failures.push("assets/support.md: support website must use the Elf Vault host");
    }

    return failures;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
    const rootArg = process.argv.indexOf("--root");
    const rootDir = rootArg === -1 ? ROOT : resolve(process.argv[rootArg + 1]);
    const failures = await scanCustomerSurface(rootDir);
    if (failures.length) {
        console.error("Customer surface check failed:");
        for (const failure of failures) console.error(`- ${failure}`);
        process.exit(1);
    }
    console.log("Customer surface check passed.");
}
