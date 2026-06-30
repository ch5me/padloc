const fs = require("fs");
const path = require("path");

const rootDir = path.resolve(__dirname, "..");
const distDir = path.resolve(rootDir, "packages/extension/dist");
const failures = [];

function read(file) {
    const fullPath = path.join(distDir, file);
    if (!fs.existsSync(fullPath)) {
        failures.push(`${file}: missing`);
        return "";
    }
    return fs.readFileSync(fullPath, "utf8");
}

function failIf(file, source, checks) {
    for (const check of checks) {
        if (check.pattern.test(source)) {
            failures.push(`${file}: ${check.reason}`);
        }
    }
}

function failIfMissing(file, source, checks) {
    for (const check of checks) {
        if (!check.pattern.test(source)) {
            failures.push(`${file}: ${check.reason}`);
        }
    }
}

function readBuiltJavaScriptFiles() {
    if (!fs.existsSync(distDir)) return [];
    return fs.readdirSync(distDir)
        .filter((file) => file.endsWith(".js"))
        .map((file) => [file, read(file)]);
}

const manifestSource = read("manifest.json");
let manifest = null;
try {
    manifest = JSON.parse(manifestSource);
} catch {
    failures.push("manifest.json: invalid JSON");
}

if (manifest) {
    if (manifest.manifest_version !== 3) {
        failures.push("manifest.json: expected manifest_version 3");
    }
    if (!manifest.background || manifest.background.service_worker !== "background.js") {
        failures.push("manifest.json: expected background.service_worker background.js");
    }
    const scripts = (manifest.content_scripts || []).flatMap((entry) => entry.js || []);
    for (const required of ["webauthn-page.js", "content.js"]) {
        if (!scripts.includes(required)) {
            failures.push(`manifest.json: missing content script ${required}`);
        }
    }
}

const background = read("background.js");
const backgroundMap = read("background.js.map");
const webauthnPage = read("webauthn-page.js");
read("content.js");

failIf("background.js", background, [
    { pattern: /\bXMLHttpRequest\b/, reason: "service worker bundle must not include XMLHttpRequest" },
    { pattern: /(^|[^.\w$])history\s*\.(?:state|replaceState|pushState|go)\b/m, reason: "service worker bundle must not include page history router calls" },
    { pattern: /window\.router\b/, reason: "service worker bundle must not import app globals/router" },
    { pattern: /new\s+Router\s*\(/, reason: "service worker bundle must not construct app router" },
    { pattern: /onMessage\.addListener\s*\(\s*async\b/, reason: "service worker message listeners must not be async catch-alls" },
    { pattern: /name:\s*["']Private Key["']|["']Private Key["']\s*,\s*type:/, reason: "service worker bundle must not store passkey private keys in vault fields" },
]);

failIfMissing("background.js", background, [
    { pattern: /dedupeMatchedItems/, reason: "service worker bundle must deduplicate matched context-menu items" },
    { pattern: /createContextMenuOnce/, reason: "service worker bundle must create context-menu ids idempotently" },
    { pattern: /duplicate id/, reason: "service worker bundle must retry stale duplicate context-menu ids" },
]);

failIf("background.js.map", backgroundMap, [
    { pattern: /app\/src\/lib\/ajax\.ts/, reason: "service worker source map includes browser-only AjaxSender" },
    { pattern: /app\/src\/globals\.ts/, reason: "service worker source map includes app globals" },
    { pattern: /app\/src\/lib\/route\.ts/, reason: "service worker source map includes page router" },
]);

failIf("webauthn-page.js", webauthnPage, [
    { pattern: /navigator\.credentials\.create\s*=\s*async/.test(webauthnPage) ? /a^/ : /(?:)/, reason: "missing create() interception" },
    { pattern: /navigator\.credentials\.get\s*=\s*async/.test(webauthnPage) ? /a^/ : /(?:)/, reason: "missing get() interception" },
]);

for (const [file, source] of readBuiltJavaScriptFiles()) {
    failIf(file, source, [
        { pattern: /Lit is in dev mode|lit-dev-mode/, reason: "bundle must not include Lit dev-mode warning path" },
        { pattern: /The main 'lit-element' module entrypoint is deprecated|deprecated-import-path/, reason: "bundle must not include deprecated lit-element entrypoint warning path" },
    ]);
}

if (failures.length) {
    console.error("Padloc extension dist preflight failed:");
    for (const failure of failures) {
        console.error(`- ${failure}`);
    }
    process.exit(1);
}

console.log("Padloc extension dist preflight passed.");
