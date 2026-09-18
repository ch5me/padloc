import { createHash } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { targetForStage } from "./target-config.mjs";

const releaseDir = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(releaseDir, "../..");
const DEFAULT_ATTEMPT_TIMEOUT_MS = 20_000;

function parseArgs(argv) {
    const args = { stage: null, sha: null, configPath: undefined, attemptTimeoutMs: undefined, receiptPath: undefined };
    for (let index = 0; index < argv.length; index += 1) {
        const argument = argv[index];
        if (argument === "--stage") args.stage = argv[++index];
        else if (argument === "--sha") args.sha = argv[++index];
        else if (argument === "--config") args.configPath = argv[++index];
        else if (argument === "--attempt-timeout-ms") args.attemptTimeoutMs = Number(argv[++index]);
        else if (argument === "--receipt") args.receiptPath = argv[++index];
        else throw new Error(`unknown argument: ${argument}`);
    }
    if (!args.stage) throw new Error("usage: deployed-canary.mjs --stage <stage> [--sha <full-sha>]");
    if (args.sha && !/^[0-9a-f]{40}$/.test(args.sha))
        throw new Error("--sha must be a full lowercase 40-character Git SHA");
    return args;
}

function originOf(value) {
    return new URL(value).origin;
}

function header(response, name) {
    return response.headers.get(name) || "";
}

function fail(message) {
    throw new Error(`deployed canary failed: ${message}`);
}

function attemptTimeout(value) {
    const timeout = Number(value ?? DEFAULT_ATTEMPT_TIMEOUT_MS);
    if (!Number.isFinite(timeout) || timeout <= 0) {
        throw new Error(`canary request timeout must be a positive number, got ${value}`);
    }
    return timeout;
}

async function fetchAttempt(fetchImpl, url, options, timeoutMs) {
    const controller = new AbortController();
    const callerSignal = options.signal;
    let onCallerAbort;
    if (callerSignal) {
        if (callerSignal.aborted) controller.abort(callerSignal.reason);
        else {
            onCallerAbort = () => controller.abort(callerSignal.reason);
            callerSignal.addEventListener("abort", onCallerAbort, { once: true });
        }
    }

    let timeoutHandle;
    const timeoutPromise = new Promise((_, reject) => {
        timeoutHandle = setTimeout(() => {
            controller.abort();
            reject(new Error(`fetch timed out after ${timeoutMs}ms: ${url}`));
        }, timeoutMs);
    });
    try {
        return await Promise.race([
            Promise.resolve().then(() => fetchImpl(url, { ...options, signal: controller.signal })),
            timeoutPromise,
        ]);
    } finally {
        clearTimeout(timeoutHandle);
        callerSignal?.removeEventListener("abort", onCallerAbort);
    }
}

async function fetchWithRetry(fetchImpl, url, options = {}, timeoutMs = DEFAULT_ATTEMPT_TIMEOUT_MS) {
    const requestTimeout = attemptTimeout(timeoutMs);
    let lastError;
    for (let attempt = 0; attempt < 3; attempt += 1) {
        try {
            const response = await fetchAttempt(fetchImpl, url, options, requestTimeout);
            if (response.status >= 500 && attempt < 2) continue;
            return response;
        } catch (error) {
            lastError = error;
            if (attempt < 2) continue;
        }
    }
    throw lastError || new Error(`fetch failed: ${url}`);
}

function assertStatus(response, label, expected = 200) {
    if (response.status !== expected) fail(`${label} returned HTTP ${response.status}`);
    if (response.redirected || (response.status >= 300 && response.status < 400)) fail(`${label} redirected`);
}

function assertContentType(response, label, expected) {
    const contentType = header(response, "content-type").toLowerCase();
    if (!contentType.includes(expected)) fail(`${label} content-type ${contentType || "<missing>"} lacks ${expected}`);
}

async function readJson(fetchImpl, url, label, options = {}, timeoutMs) {
    const response = await fetchWithRetry(fetchImpl, url, options, timeoutMs);
    assertStatus(response, label);
    assertContentType(response, label, "json");
    let value;
    try {
        value = await response.json();
    } catch {
        fail(`${label} returned invalid JSON`);
    }
    return { response, value };
}

function assertHash(bytes, metadata, label) {
    if (!metadata || typeof metadata !== "object") fail(`${label} hash metadata missing`);
    const sha256 = createHash("sha256").update(bytes).digest("hex");
    if (sha256 !== metadata.sha256) fail(`${label} SHA-256 mismatch`);
    if (bytes.byteLength !== metadata.size) fail(`${label} size mismatch`);
}

async function checkCors(fetchImpl, apiUrl, origins, timeoutMs) {
    const testedOrigins = [...new Set(origins.filter(Boolean))];
    if (!testedOrigins.length) fail("no app origins configured for CORS canary");
    for (const origin of testedOrigins) {
        const response = await fetchWithRetry(
            fetchImpl,
            `${apiUrl}/healthcheck`,
            {
                headers: { Origin: origin },
            },
            timeoutMs
        );
        assertStatus(response, `CORS GET ${origin}`);
        if (header(response, "access-control-allow-origin") !== origin) {
            fail(`CORS GET ${origin} did not echo its allowed origin`);
        }
        if (
            !header(response, "vary")
                .split(",")
                .map((value) => value.trim().toLowerCase())
                .includes("origin")
        ) {
            fail(`CORS GET ${origin} is missing Vary: Origin`);
        }

        const options = await fetchWithRetry(
            fetchImpl,
            `${apiUrl}/`,
            {
                method: "OPTIONS",
                headers: {
                    Origin: origin,
                    "Access-Control-Request-Method": "POST",
                },
            },
            timeoutMs
        );
        if (![200, 204].includes(options.status)) fail(`CORS OPTIONS ${origin} returned HTTP ${options.status}`);
        if (header(options, "access-control-allow-origin") !== origin) {
            fail(`CORS OPTIONS ${origin} did not echo its allowed origin`);
        }
        if (
            !header(options, "vary")
                .split(",")
                .map((value) => value.trim().toLowerCase())
                .includes("origin")
        ) {
            fail(`CORS OPTIONS ${origin} is missing Vary: Origin`);
        }
    }

    const unknownOrigin = "https://unknown-origin.invalid";
    const denied = await fetchWithRetry(
        fetchImpl,
        `${apiUrl}/healthcheck`,
        {
            headers: { Origin: unknownOrigin },
        },
        timeoutMs
    );
    const allowOrigin = header(denied, "access-control-allow-origin");
    if (allowOrigin === "*" || allowOrigin === unknownOrigin) fail("unknown CORS origin was allowed");
}

async function checkApi(fetchImpl, target, expectedSha, timeoutMs) {
    const { value: health } = await readJson(
        fetchImpl,
        `${target.apiBaseUrl}/healthcheck`,
        "new API healthcheck",
        {},
        timeoutMs
    );
    if (expectedSha && health.version !== expectedSha)
        fail(`new API SHA ${health.version} does not equal ${expectedSha}`);
    for (const field of ["status", "d1", "r2", "resend"]) {
        if (health[field] !== "ok") fail(`new API health ${field} is ${health[field] || "<missing>"}`);
    }
    await checkCors(fetchImpl, target.apiBaseUrl, [target.appUrl, ...target.legacyAppUrls], timeoutMs);

    if (!target.legacyApiBaseUrls.length) fail("no legacy API host configured");
    for (const legacyApiUrl of target.legacyApiBaseUrls) {
        const { value: legacyHealth } = await readJson(
            fetchImpl,
            `${legacyApiUrl}/healthcheck`,
            `legacy API ${legacyApiUrl} healthcheck`,
            { redirect: "manual" },
            timeoutMs
        );
        if (expectedSha && legacyHealth.version !== expectedSha) {
            fail(`legacy API ${legacyApiUrl} SHA ${legacyHealth.version} does not equal ${expectedSha}`);
        }
        if (legacyHealth.status !== "ok") fail(`legacy API ${legacyApiUrl} is not healthy`);
    }
    return { apiSha: health.version };
}

function provenancePath(metadata, isIndex) {
    if (isIndex) return "/";
    if (!metadata?.path) fail("PWA provenance path missing");
    return `/${metadata.path.replace(/^\/+/, "")}`;
}

async function fetchAsset(fetchImpl, target, metadata, label, isIndex = false, timeoutMs) {
    const response = await fetchWithRetry(
        fetchImpl,
        `${target.appUrl}${provenancePath(metadata, isIndex)}`,
        {},
        timeoutMs
    );
    assertStatus(response, `PWA ${label}`);
    return response;
}

async function checkPwa(fetchImpl, target, expectedSha, timeoutMs) {
    const { value: provenance } = await readJson(
        fetchImpl,
        `${target.appUrl}/build-provenance.json`,
        "PWA provenance",
        {},
        timeoutMs
    );
    if (provenance.schema !== "elf-vault.pwa-provenance.v1")
        fail(`unexpected PWA provenance schema ${provenance.schema}`);
    if (provenance.stage !== target.stage)
        fail(`PWA provenance stage ${provenance.stage} does not equal ${target.stage}`);
    if (expectedSha && provenance.sourceSha !== expectedSha) {
        fail(`PWA provenance SHA ${provenance.sourceSha} does not equal ${expectedSha}`);
    }
    if (provenance.appUrl !== target.appUrl || provenance.apiUrl !== target.apiBaseUrl) {
        fail("PWA provenance target URLs do not match the environment target map");
    }
    const { response: htmlResponse, value: htmlBytes } = await (async () => {
        const response = await fetchAsset(
            fetchImpl,
            target,
            provenance.hashes?.indexHtml,
            "index.html",
            true,
            timeoutMs
        );
        assertContentType(response, "PWA index.html", "text/html");
        return { response, value: Buffer.from(await response.arrayBuffer()) };
    })();
    const html = htmlBytes.toString("utf8");
    const brand = target.displayName || "Elf Vault";
    if (!html.includes(brand)) fail(`PWA index.html does not contain ${brand}`);
    const cspMetaValues = [...html.matchAll(/<meta\b[^>]*>/gi)]
        .map((match) => match[0])
        .filter((tag) => /http-equiv=["']Content-Security-Policy["']/i.test(tag))
        .map((tag) => tag.match(/content=["']([^"']+)["']/i)?.[1])
        .filter(Boolean);
    const cspParts = [header(htmlResponse, "content-security-policy"), ...cspMetaValues].join(" ");
    if (!cspParts) fail("PWA index.html has no Content-Security-Policy");
    if (!cspParts.includes(originOf(target.appUrl)) || !cspParts.includes(originOf(target.apiBaseUrl))) {
        fail("PWA CSP does not include the configured app and API origins");
    }
    assertHash(htmlBytes, provenance.hashes?.indexHtml, "PWA index.html");

    const manifestResponse = await fetchAsset(
        fetchImpl,
        target,
        provenance.hashes?.manifest,
        "manifest.json",
        false,
        timeoutMs
    );
    assertContentType(manifestResponse, "PWA manifest", "json");
    const manifestBytes = Buffer.from(await manifestResponse.arrayBuffer());
    let manifest;
    try {
        manifest = JSON.parse(manifestBytes.toString("utf8"));
    } catch {
        fail("PWA manifest is invalid JSON");
    }
    if (!String(manifest.name || manifest.short_name || "").includes(brand)) fail("PWA manifest is not branded");
    assertHash(manifestBytes, provenance.hashes?.manifest, "PWA manifest");

    const serviceWorkerResponse = await fetchAsset(
        fetchImpl,
        target,
        provenance.hashes?.serviceWorker,
        "service worker",
        false,
        timeoutMs
    );
    assertContentType(serviceWorkerResponse, "PWA service worker", "javascript");
    const serviceWorkerBytes = Buffer.from(await serviceWorkerResponse.arrayBuffer());
    assertHash(serviceWorkerBytes, provenance.hashes?.serviceWorker, "PWA service worker");

    const faviconResponse = await fetchAsset(
        fetchImpl,
        target,
        provenance.hashes?.favicon,
        "favicon",
        false,
        timeoutMs
    );
    assertContentType(faviconResponse, "PWA favicon", "image/png");
    const faviconBytes = Buffer.from(await faviconResponse.arrayBuffer());
    assertHash(faviconBytes, provenance.hashes?.favicon, "PWA favicon");

    const entryResponse = await fetchAsset(
        fetchImpl,
        target,
        provenance.hashes?.entryJavaScript,
        "entry JavaScript",
        false,
        timeoutMs
    );
    assertContentType(entryResponse, "PWA entry JavaScript", "javascript");
    const entryBytes = Buffer.from(await entryResponse.arrayBuffer());
    assertHash(entryBytes, provenance.hashes?.entryJavaScript, "PWA entry JavaScript");

    if (!target.legacyAppUrls.length) fail("no legacy PWA host configured");
    for (const legacyAppUrl of target.legacyAppUrls) {
        const legacyResponse = await fetchWithRetry(
            fetchImpl,
            `${legacyAppUrl}/`,
            { redirect: "manual" },
            timeoutMs
        );
        assertStatus(legacyResponse, `legacy PWA ${legacyAppUrl}`);
        assertContentType(legacyResponse, `legacy PWA ${legacyAppUrl}`, "text/html");
        const legacyHtml = await legacyResponse.text();
        if (!legacyHtml.includes(brand)) fail(`legacy PWA ${legacyAppUrl} is not branded`);
    }
    return { pwaSha: provenance.sourceSha };
}

export async function runCanary({
    stage,
    expectedSha = null,
    fetchImpl = globalThis.fetch,
    configPath,
    attemptTimeoutMs = DEFAULT_ATTEMPT_TIMEOUT_MS,
    receiptPath,
}) {
    if (typeof fetchImpl !== "function") throw new Error("global fetch is unavailable");
    const timeoutMs = attemptTimeout(attemptTimeoutMs);
    const target = await targetForStage(stage, configPath);
    const api = await checkApi(fetchImpl, target, expectedSha, timeoutMs);
    const pwa = await checkPwa(fetchImpl, target, expectedSha, timeoutMs);
    if (receiptPath) {
        await mkdir(path.dirname(receiptPath), { recursive: true });
        await writeFile(
            receiptPath,
            `${JSON.stringify(
                {
                    schema: "elf-vault.deployed-canary-receipt.v1",
                    stage: target.stage,
                    expectedSha,
                    apiSha: api.apiSha,
                    pwaSha: pwa.pwaSha,
                    checkedAt: new Date().toISOString(),
                },
                null,
                2
            )}\n`
        );
    }
    return target;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
    try {
        const args = parseArgs(process.argv.slice(2));
        const target = await runCanary({
            stage: args.stage,
            expectedSha: args.sha,
            configPath: args.configPath,
            attemptTimeoutMs: args.attemptTimeoutMs,
            receiptPath: args.receiptPath,
        });
        console.log(`verified ${target.stage} ${target.displayName || "Elf Vault"} ${args.sha || "deployed"}`);
    } catch (error) {
        console.error(error instanceof Error ? error.message : String(error));
        process.exitCode = 1;
    }
}

export { checkApi, checkCors, checkPwa, fetchWithRetry, parseArgs };
