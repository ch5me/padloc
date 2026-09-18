import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const targets = JSON.parse(readFileSync(new URL("../config/environment-targets.json", import.meta.url), "utf8"));
const reqs = JSON.parse(readFileSync(new URL("../config/runtime-requirements.json", import.meta.url), "utf8"));
const wranglerUrl = new URL("../packages/worker/wrangler.toml", import.meta.url);

const requiredStages = ["local", "staging", "production"];
const runtimeDerivedFields = new Set(["environment", "release", "serviceName"]);
const canonicalTargets = {
    local: {
        appUrl: "http://localhost:3000",
        apiBaseUrl: "http://127.0.0.1:8787",
        allowedOrigins: ["http://localhost:3000"],
    },
    staging: {
        appUrl: "https://staging.vault.elf.dance",
        apiBaseUrl: "https://staging.api.vault.elf.dance",
        legacyAppUrl: "https://pad-staging.ch5.me",
        legacyApiBaseUrl: "https://api-pad-staging.ch5.me",
        allowedOrigins: ["https://staging.vault.elf.dance", "https://pad-staging.ch5.me"],
    },
    production: {
        appUrl: "https://vault.elf.dance",
        apiBaseUrl: "https://api.vault.elf.dance",
        legacyAppUrl: "https://pad.ch5.me",
        legacyApiBaseUrl: "https://api-pad.ch5.me",
        allowedOrigins: ["https://vault.elf.dance", "https://pad.ch5.me"],
    },
};

function fail(message) {
    throw new Error(`runtime-config: ${message}`);
}

function assert(condition, message) {
    if (!condition) fail(message);
}

function sameList(left, right) {
    const sortedLeft = [...left].sort();
    const sortedRight = [...right].sort();
    return sortedLeft.length === sortedRight.length && sortedLeft.every((value, index) => value === sortedRight[index]);
}

function validateOrigin(value, label, stage) {
    assert(
        typeof value === "string" && value.length > 0 && value === value.trim(),
        `${label} must be a trimmed string`
    );
    let parsed;
    try {
        parsed = new URL(value);
    } catch {
        fail(`${label} is not a valid URL`);
    }
    assert(parsed.protocol === "http:" || parsed.protocol === "https:", `${label} must use HTTP(S)`);
    if (stage !== "local") assert(parsed.protocol === "https:", `${label} must use HTTPS outside local`);
    assert(parsed.origin === value, `${label} must be an origin without a path, query, or trailing slash`);
    assert(!parsed.username && !parsed.password, `${label} must not contain credentials`);
    return parsed;
}

function validateTargets() {
    assert(Array.isArray(targets.stages), "stages must be an array");
    assert(targets.stages.length === requiredStages.length, "stages must not contain duplicates or extras");
    assert(sameList(targets.stages, requiredStages), "stages must be exactly local, staging, production");
    assert(targets.targets && typeof targets.targets === "object", "targets must be an object");
    assert(sameList(Object.keys(targets.targets), requiredStages), "targets must contain only the canonical stages");

    for (const stage of requiredStages) {
        const target = targets.targets[stage];
        const expected = canonicalTargets[stage];
        assert(target && typeof target === "object", `missing environment target: ${stage}`);
        assert(target.stage === stage, `target ${stage} has stage=${target.stage ?? "<missing>"}`);
        for (const key of ["appUrl", "apiBaseUrl", "allowedOrigin", "allowedOrigins"]) {
            assert(target[key] !== undefined, `target ${stage} missing field ${key}`);
        }

        const app = validateOrigin(target.appUrl, `target ${stage}.appUrl`, stage);
        const api = validateOrigin(target.apiBaseUrl, `target ${stage}.apiBaseUrl`, stage);
        assert(app.host !== api.host, `target ${stage} app/API hosts must differ`);
        assert(target.allowedOrigin === target.appUrl, `target ${stage}.allowedOrigin must equal appUrl`);
        assert(
            Array.isArray(target.allowedOrigins) && target.allowedOrigins.length > 0,
            `target ${stage}.allowedOrigins must be non-empty`
        );
        assert(
            new Set(target.allowedOrigins).size === target.allowedOrigins.length,
            `target ${stage}.allowedOrigins must not contain duplicates`
        );
        for (const [index, origin] of target.allowedOrigins.entries()) {
            validateOrigin(origin, `target ${stage}.allowedOrigins[${index}]`, stage);
        }
        assert(target.allowedOrigins.includes(target.appUrl), `target ${stage}.allowedOrigins must include appUrl`);
        assert(
            sameList(target.allowedOrigins, expected.allowedOrigins),
            `target ${stage}.allowedOrigins must match the compatibility contract`
        );

        for (const key of ["appUrl", "apiBaseUrl"]) {
            assert(target[key] === expected[key], `target ${stage}.${key} disagrees with the canonical host map`);
        }
        if (stage !== "local") {
            for (const key of ["legacyAppUrl", "legacyApiBaseUrl"]) {
                validateOrigin(target[key], `target ${stage}.${key}`, stage);
                assert(
                    target[key] === expected[key],
                    `target ${stage}.${key} disagrees with the compatibility contract`
                );
            }
            assert(target.legacyAppUrl !== target.legacyApiBaseUrl, `target ${stage} legacy app/API hosts must differ`);
        }
    }
}

const requiredVars = {
    api: [
        "ALLOW_ORIGIN",
        "CLIENT_URL",
        "HQ_SENTRY_DSN",
        "HQ_OTLP_ENDPOINT",
        "HQ_ENVIRONMENT",
        "HQ_RELEASE",
        "HQ_SERVICE_NAME",
        "EMAIL_FROM_ADDRESS",
        "RESEND_API_KEY",
        "WEBAUTHN_RP_ID",
        "WEBAUTHN_RP_NAME",
    ],
    web: ["PL_SERVER_URL", "PL_PWA_URL", "PL_SUPPORT_EMAIL"],
    mobile: ["PL_SERVER_URL"],
};

function validateRequirements() {
    assert(reqs.surfaces && typeof reqs.surfaces === "object", "surfaces must be an object");
    for (const [surface, config] of Object.entries(reqs.surfaces)) {
        assert(Array.isArray(config.vars), `surface ${surface} is missing vars[]`);
        const names = new Set();
        for (const item of config.vars) {
            assert(item && typeof item === "object", `invalid runtime requirement on surface ${surface}`);
            assert(
                typeof item.name === "string" && item.name.length > 0,
                `runtime requirement on ${surface} is missing name`
            );
            assert(!names.has(item.name), `duplicate runtime requirement ${surface}.${item.name}`);
            names.add(item.name);
            assert(
                item.delivery === "derived" || item.delivery === "secret",
                `invalid delivery for ${surface}.${item.name}`
            );
            assert(
                Array.isArray(item.requiredIn),
                `runtime requirement ${surface}.${item.name} is missing requiredIn[]`
            );
            assert(
                new Set(item.requiredIn).size === item.requiredIn.length,
                `duplicate required stage ${surface}.${item.name}`
            );
            for (const stage of item.requiredIn) {
                assert(
                    requiredStages.includes(stage),
                    `runtime requirement ${surface}.${item.name} uses unknown stage ${stage}`
                );
            }
            if (item.delivery === "derived") {
                assert(
                    typeof item.derivedFrom === "string" && item.derivedFrom.length > 0,
                    `derived runtime requirement ${surface}.${item.name} is missing derivedFrom`
                );
                if (!runtimeDerivedFields.has(item.derivedFrom)) {
                    for (const stage of item.requiredIn) {
                        assert(
                            targets.targets[stage][item.derivedFrom] !== undefined,
                            `${surface}.${item.name} derives from missing target field ${item.derivedFrom}`
                        );
                    }
                }
            }
        }
        for (const name of requiredVars[surface] || []) {
            assert(names.has(name), `surface ${surface} is missing required runtime variable ${name}`);
        }
    }

    const sentry = reqs.surfaces.api.vars.find(({ name }) => name === "HQ_SENTRY_DSN");
    const otlp = reqs.surfaces.api.vars.find(({ name }) => name === "HQ_OTLP_ENDPOINT");
    assert(
        /Must target logs\.ch5\.me/.test(sentry.description) && /never sentry\.io/i.test(sentry.description),
        "HQ_SENTRY_DSN must target CH5 logs"
    );
    assert(/Must target logs\.ch5\.me/.test(otlp.description), "HQ_OTLP_ENDPOINT must target CH5 logs");
}

function workerEnvBlock(source, envName) {
    const header = `[env.${envName}]`;
    const start = source.indexOf(header);
    assert(start >= 0, `wrangler.toml is missing ${header}`);
    const body = source.slice(start + header.length);
    const next = body.search(/\n\[env\.[^.\]]+\]/);
    return next >= 0 ? body.slice(0, next) : body;
}

function workerValue(block, key) {
    return block.match(new RegExp(`^${key}\\s*=\\s*"([^"]*)"`, "m"))?.[1];
}

function workerRoutes(block) {
    return [...block.matchAll(/pattern\s*=\s*"([^"]+)"/g)].map((match) => match[1]);
}

function validateWrangler() {
    assert(existsSync(fileURLToPath(wranglerUrl)), "missing packages/worker/wrangler.toml");
    const source = readFileSync(wranglerUrl, "utf8");
    for (const stage of requiredStages) {
        const target = targets.targets[stage];
        const envName = stage === "local" ? target.workerEnv : stage;
        const block = workerEnvBlock(source, envName);
        assert(
            workerValue(block, "name") === target.workerName,
            `wrangler ${envName}.name disagrees with target ${stage}`
        );
        assert(
            workerValue(block, "CLIENT_URL") === target.appUrl,
            `wrangler ${envName}.vars.CLIENT_URL disagrees with target ${stage}`
        );
        const configuredOrigins = workerValue(block, "ALLOW_ORIGIN");
        assert(configuredOrigins, `wrangler ${envName}.vars.ALLOW_ORIGIN is missing`);
        if (stage === "local") {
            assert(configuredOrigins === "*", "local Wrangler CORS must remain wildcard for dev tooling");
        } else {
            assert(
                sameList(configuredOrigins.split(","), target.allowedOrigins),
                `wrangler ${envName}.vars.ALLOW_ORIGIN disagrees with target ${stage}`
            );
            const routes = workerRoutes(block);
            assert(
                routes.includes(`${new URL(target.apiBaseUrl).host}/*`),
                `wrangler ${envName} is missing the canonical API route`
            );
            assert(
                routes.includes(`${new URL(target.legacyApiBaseUrl).host}/*`),
                `wrangler ${envName} is missing the legacy API route`
            );
        }
    }
}

validateTargets();
validateRequirements();
validateWrangler();
console.log("runtime-config:check ok");
