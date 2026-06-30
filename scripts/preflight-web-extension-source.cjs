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
    { pattern: /\bXMLHttpRequest\b/, reason: "service worker graph must not reference XMLHttpRequest" },
    { pattern: /(^|[^.\w$])history\s*\.(?:state|replaceState|pushState|go)\b/m, reason: "service worker graph must not call page history" },
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

function walkFiles(relativeDir, extensions = new Set([".ts", ".tsx", ".js"])) {
    const start = path.join(rootDir, relativeDir);
    const files = [];
    if (!fs.existsSync(start)) return files;
    const stack = [start];
    while (stack.length) {
        const current = stack.pop();
        const stat = fs.statSync(current);
        if (stat.isDirectory()) {
            for (const child of fs.readdirSync(current)) {
                stack.push(path.join(current, child));
            }
            continue;
        }
        if (stat.isFile() && extensions.has(path.extname(current))) {
            files.push(current);
        }
    }
    return files;
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

function methodBlock(source, methodName, nextMethodName) {
    const start = source.indexOf(methodName);
    if (start < 0) return "";
    const end = nextMethodName ? source.indexOf(nextMethodName, start + methodName.length) : -1;
    return source.slice(start, end < 0 ? source.length : end);
}

function requireAuthRestart(methodName, block, errorCodes) {
    if (!block) {
        failures.push(`packages/app/src/elements/login-signup.ts: missing ${methodName}`);
        return;
    }
    for (const code of errorCodes) {
        const pattern = new RegExp(`case\\s+ErrorCode\\.${code}\\s*:[\\s\\S]*?_restartEmailVerification\\s*\\(`);
        if (!pattern.test(block)) {
            failures.push(`packages/app/src/elements/login-signup.ts: ${methodName} must restart email verification on ${code}`);
        }
    }
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

    if (!backgroundSource.includes("dedupeMatchedItems")) {
        failures.push("packages/extension/src/background.ts: context menu matched items must be deduplicated before create");
    }

    if (!backgroundSource.includes("createContextMenuOnce")) {
        failures.push("packages/extension/src/background.ts: context menu item creation must be idempotent within a rebuild");
    }

    if (!backgroundSource.includes("duplicate id") || !backgroundSource.includes("browser.contextMenus.remove(createProperties.id)")) {
        failures.push("packages/extension/src/background.ts: context menu create must remove stale duplicate ids before retry");
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

function checkPasskeyBrokerSource() {
    const source = read("packages/extension/src/passkey-broker.ts");
    if (/new\s+Field\s*\(\s*\{\s*name:\s*["']Private Key["']/.test(source)) {
        failures.push("packages/extension/src/passkey-broker.ts: passkey private keys must not be stored in vault fields");
    }
    if (/cryptoApi\.subtle\.exportKey\s*\(\s*["']pkcs8["']/.test(source)) {
        failures.push("packages/extension/src/passkey-broker.ts: generated passkey private keys must not be exported");
    }
    if (!source.includes("PASSKEY_SIGNER_HANDLE_PREFIX") || !source.includes("storePasskeySignerKey")) {
        failures.push("packages/extension/src/passkey-broker.ts: missing opaque signer handle storage");
    }
    if (/if\s*\(\s*!indexedDb\s*\)\s*return\b/.test(source)) {
        failures.push("packages/extension/src/passkey-broker.ts: signer storage must fail loud when IndexedDB is unavailable");
    }
    if (!source.includes("refusing volatile passkey enrollment")) {
        failures.push("packages/extension/src/passkey-broker.ts: signer enrollment must refuse volatile memory-only production storage");
    }
}

function checkExtensionUiSource() {
    for (const file of [
        ...walkFiles("packages/app/src"),
        ...walkFiles("packages/extension/src"),
    ]) {
        const source = fs.readFileSync(file, "utf8");
        const relativePath = relativeFromRoot(file);
        if (/from\s+["']lit-element["']/.test(source)) {
            failures.push(`${relativePath}: import from lit/lit decorators, not deprecated lit-element entrypoint`);
        }
    }

    const startFormSource = read("packages/app/src/elements/start-form.ts");
    if (/reset\s*\(\)\s*\{[\s\S]*?this\.requestUpdate\s*\(/.test(startFormSource)) {
        failures.push("packages/app/src/elements/start-form.ts: reset() must not schedule another update from updated()");
    }

    const unlockSource = read("packages/app/src/elements/unlock.ts");
    if (/addEventListener\s*\(\s*["']visibilitychange["']\s*,\s*\(\)\s*=>/.test(unlockSource)) {
        failures.push("packages/app/src/elements/unlock.ts: visibilitychange listener must be removable, not anonymous");
    }

    const loginSignupSource = read("packages/app/src/elements/login-signup.ts");
    requireAuthRestart(
        "_login",
        methodBlock(loginSignupSource, "private async _login()", "private async _submitName()"),
        ["AUTHENTICATION_FAILED", "AUTHENTICATION_REQUIRED", "INVALID_SESSION"]
    );
    requireAuthRestart(
        "_confirmPassword",
        methodBlock(loginSignupSource, "private async _confirmPassword()", "private _accountExists()"),
        ["AUTHENTICATION_FAILED", "AUTHENTICATION_REQUIRED", "INVALID_SESSION"]
    );

    const cdpHelperSource = read("packages/extension/scripts/agentic-extension-cdp.mjs");
    if (cdpHelperSource.includes("chrome.storage.local.clear") && !cdpHelperSource.includes("indexedDB.deleteDatabase(\"padloc-agentic-passkey-signers\")")) {
        failures.push("packages/extension/scripts/agentic-extension-cdp.mjs: clear-storage must also clear passkey signer IndexedDB");
    }
    if (cdpHelperSource.includes("indexedDB.deleteDatabase(\"padloc-agentic-passkey-signers\")") && !cdpHelperSource.includes("blocked clearing passkey signer store")) {
        failures.push("packages/extension/scripts/agentic-extension-cdp.mjs: clear-storage must fail when signer IndexedDB deletion is blocked");
    }
    if (cdpHelperSource.includes("indexedDB.deleteDatabase(\"padloc-agentic-passkey-signers\")") && !cdpHelperSource.includes("passkey signer store still contains keys after clear")) {
        failures.push("packages/extension/scripts/agentic-extension-cdp.mjs: clear-storage must verify signer IndexedDB is empty");
    }
    if (!cdpHelperSource.includes("pingExtensionRuntime") || !cdpHelperSource.includes("readDistAsset") || !cdpHelperSource.includes("extension runtime ping")) {
        failures.push("packages/extension/scripts/agentic-extension-cdp.mjs: smoke must avoid service-worker inspector hangs and label failing phases");
    }

    const signupHelperSource = read("packages/extension/scripts/agentic-email-signup.mjs");
    if (!signupHelperSource.includes("replace(/\\\\D/g, \"\")")) {
        failures.push("packages/extension/scripts/agentic-email-signup.mjs: OTP consume helper must normalize extracted codes before UI validation");
    }

    const webpackSource = read("packages/extension/webpack.config.js");
    if (/mode\s*:\s*["']development["']/.test(webpackSource)) {
        failures.push("packages/extension/webpack.config.js: unpacked extension build must not force Lit dev-mode");
    }
}

checkBackgroundSource();
checkManifestSource();
checkWebAuthnPageSource();
checkPasskeyBrokerSource();
checkExtensionUiSource();

if (failures.length) {
    console.error("Padloc extension source preflight failed:");
    for (const failure of failures) {
        console.error(`- ${failure}`);
    }
    process.exit(1);
}

console.log("Padloc extension source preflight passed.");
