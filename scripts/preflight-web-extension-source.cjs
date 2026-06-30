const fs = require("fs");
const path = require("path");

const rootDir = path.resolve(__dirname, "..");
const extensionSrcDir = path.join(rootDir, "packages/extension/src");
const failures = [];

const forbiddenBackgroundFiles = new Map([
    ["packages/app/src/globals.ts", "service worker must not import app globals"],
    ["packages/app/src/lib/ajax.ts", "service worker must not import browser-only AjaxSender"],
    ["packages/app/src/lib/route.ts", "service worker must not import page router/history"],
]);

const forbiddenBackgroundSource = [
    { pattern: /\bnew\s+XMLHttpRequest\s*\(/, reason: "service worker graph must not construct XMLHttpRequest" },
    { pattern: /\bhistory\.(?:replaceState|pushState|go)\b/, reason: "service worker graph must not call page history" },
    { pattern: /\bwindow\.router\b/, reason: "service worker graph must not reference window.router" },
    { pattern: /\bnew\s+Router\s*\(/, reason: "service worker graph must not construct app Router" },
];

function read(relativePath) {
    const fullPath = path.join(rootDir, relativePath);
    if (!fs.existsSync(fullPath)) {
        failures.push(`${relativePath}: missing`);
        return "";
    }
    return fs.readFileSync(fullPath, "utf8");
}

function relativeFromRoot(fullPath) {
    return path.relative(rootDir, fullPath).split(path.sep).join("/");
}

function resolveImport(fromFile, specifier) {
    if (specifier.startsWith(".")) {
        return resolveCandidate(path.resolve(path.dirname(fromFile), specifier));
    }

    const aliases = [
        ["@padloc/app/src/", "packages/app/src/"],
        ["@padloc/core/src/", "packages/core/src/"],
        ["@padloc/extension/src/", "packages/extension/src/"],
        ["@padloc/locale/src/", "packages/locale/src/"],
    ];

    for (const [prefix, target] of aliases) {
        if (specifier.startsWith(prefix)) {
            return resolveCandidate(path.join(rootDir, target, specifier.slice(prefix.length)));
        }
    }

    return null;
}

function resolveCandidate(basePath) {
    const candidates = [
        basePath,
        `${basePath}.ts`,
        `${basePath}.tsx`,
        `${basePath}.js`,
        `${basePath}.json`,
        path.join(basePath, "index.ts"),
        path.join(basePath, "index.tsx"),
        path.join(basePath, "index.js"),
    ];

    return candidates.find((candidate) => fs.existsSync(candidate) && fs.statSync(candidate).isFile()) || null;
}

function findImports(source) {
    const specs = [];
    const patterns = [
        /\bimport\s+(?:[^'"]+\s+from\s+)?["']([^"']+)["']/g,
        /\bexport\s+[^'"]+\s+from\s+["']([^"']+)["']/g,
        /\brequire\s*\(\s*["']([^"']+)["']\s*\)/g,
    ];

    for (const pattern of patterns) {
        let match;
        while ((match = pattern.exec(source))) {
            specs.push(match[1]);
        }
    }

    return specs;
}

function walkImportGraph(entryRelativePath) {
    const entry = path.join(rootDir, entryRelativePath);
    const stack = [entry];
    const seen = new Set();

    while (stack.length) {
        const file = stack.pop();
        if (!file || seen.has(file)) continue;
        seen.add(file);

        if (!fs.existsSync(file)) {
            failures.push(`${relativeFromRoot(file)}: missing from import graph`);
            continue;
        }

        const source = fs.readFileSync(file, "utf8");
        for (const specifier of findImports(source)) {
            const resolved = resolveImport(file, specifier);
            if (resolved) stack.push(resolved);
        }
    }

    return [...seen];
}

function checkBackgroundSource() {
    const graph = walkImportGraph("packages/extension/src/background.ts");
    const graphSet = new Set(graph.map(relativeFromRoot));

    for (const [relativePath, reason] of forbiddenBackgroundFiles) {
        if (graphSet.has(relativePath)) {
            failures.push(`${relativePath}: ${reason}`);
        }
    }

    for (const file of graph) {
        const relativePath = relativeFromRoot(file);
        const source = fs.readFileSync(file, "utf8");
        for (const check of forbiddenBackgroundSource) {
            if (check.pattern.test(source)) {
                failures.push(`${relativePath}: ${check.reason}`);
            }
        }
    }

    const backgroundSource = read("packages/extension/src/background.ts");
    if (/\b(?:browser|chrome)\.runtime\.onMessage\.addListener\s*\(\s*async\b/.test(backgroundSource)) {
        failures.push("packages/extension/src/background.ts: runtime message listeners must not be async catch-alls");
    }

    const bridgeIndex = backgroundSource.indexOf("registerImmediateMessageBridge();");
    const initIndex = backgroundSource.indexOf("async function initBackground");
    if (bridgeIndex < 0) {
        failures.push("packages/extension/src/background.ts: missing immediate WebAuthn message bridge registration");
    } else if (initIndex >= 0 && bridgeIndex > initIndex) {
        failures.push("packages/extension/src/background.ts: immediate bridge must register before async background init");
    }

    if (!backgroundSource.includes("badgeAndContextMenuUpdateChain")) {
        failures.push("packages/extension/src/background.ts: context menu rebuilds must be serialized");
    }

    if (!backgroundSource.includes("enqueueBadgeAndContextMenuUpdate")) {
        failures.push("packages/extension/src/background.ts: missing serialized context menu update queue");
    }
}

function checkManifestSource() {
    const manifestSource = read("packages/extension/src/manifest.json");
    let manifest;
    try {
        manifest = JSON.parse(manifestSource);
    } catch {
        failures.push("packages/extension/src/manifest.json: invalid JSON");
        return;
    }

    const contentScripts = manifest.content_scripts || [];
    const pageHook = contentScripts.find((entry) => (entry.js || []).includes("webauthn-page.js"));
    const contentBridge = contentScripts.find((entry) => (entry.js || []).includes("content.js"));

    if (!pageHook) {
        failures.push("packages/extension/src/manifest.json: missing webauthn-page.js content script");
    } else {
        if (pageHook.world !== "MAIN") failures.push("packages/extension/src/manifest.json: webauthn-page.js must run in MAIN world");
        if (pageHook.run_at !== "document_start") failures.push("packages/extension/src/manifest.json: webauthn-page.js must run at document_start");
        if (pageHook.all_frames !== true) failures.push("packages/extension/src/manifest.json: webauthn-page.js must run in all frames");
    }

    if (!contentBridge) {
        failures.push("packages/extension/src/manifest.json: missing content.js bridge content script");
    } else {
        if (contentBridge.run_at !== "document_start") failures.push("packages/extension/src/manifest.json: content.js must run at document_start");
        if (contentBridge.all_frames !== true) failures.push("packages/extension/src/manifest.json: content.js must run in all frames");
    }
}

function checkWebAuthnPageSource() {
    const source = read("packages/extension/src/webauthn-page.ts");
    if (!/navigator\.credentials\.create\s*=\s*async/.test(source)) {
        failures.push("packages/extension/src/webauthn-page.ts: missing navigator.credentials.create interception");
    }
    if (!/navigator\.credentials\.get\s*=\s*async/.test(source)) {
        failures.push("packages/extension/src/webauthn-page.ts: missing navigator.credentials.get interception");
    }
    if (!source.includes("padloc-webauthn-page") || !source.includes("padloc-webauthn-content")) {
        failures.push("packages/extension/src/webauthn-page.ts: missing page/content WebAuthn bridge markers");
    }
}

checkBackgroundSource();
checkManifestSource();
checkWebAuthnPageSource();

if (failures.length) {
    console.error("Padloc extension source preflight failed:");
    for (const failure of failures) {
        console.error(`- ${failure}`);
    }
    process.exit(1);
}

console.log("Padloc extension source preflight passed.");
