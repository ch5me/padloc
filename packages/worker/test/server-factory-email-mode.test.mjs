import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { existsSync, readFileSync } from "node:fs";
import { build } from "esbuild";

const testDir = dirname(fileURLToPath(import.meta.url));
const entryPoint = resolve(testDir, "../src/server-factory.ts");
const coreNodeModules = [
    resolve(testDir, "../../core/node_modules"),
    "/Users/hassoncs/src/ch5/padloc/packages/core/node_modules",
].find((dir) => existsSync(dir));
const [{ text: bundledFactory }] = (
    await build({
        entryPoints: [entryPoint],
        bundle: true,
        platform: "node",
        format: "cjs",
        target: "node16",
        write: false,
        alias: {
            "@elf-vault/locale": resolve(testDir, "../../locale"),
        },
        nodePaths: coreNodeModules ? [coreNodeModules] : [],
    })
).outputFiles;
const factoryModule = { exports: {} };

new Function("require", "module", "exports", "__filename", "__dirname", bundledFactory)(
    createRequire(import.meta.url),
    factoryModule,
    factoryModule.exports,
    entryPoint,
    dirname(entryPoint)
);

const { createServer, getSharedMockMessenger } = factoryModule.exports;
const cases = [];

function test(name, run) {
    cases.push({ name, run });
}

function serverFor(overrides = {}) {
    // Omitting DB and ATTACHMENTS deliberately exercises the factory's stub bindings
    // in development/test. Live environments must pass those bindings.
    return createServer(overrides);
}

function liveBindings(overrides = {}) {
    return {
        DB: {},
        ATTACHMENTS: {},
        HINTS: {},
        ...overrides,
    };
}

test("explicit mock wins even when Resend credentials are complete", () => {
    const server = serverFor({
        EMAIL_BACKEND: "mock",
        HQ_ENVIRONMENT: "development",
        RESEND_API_KEY: "test-api-key",
        EMAIL_FROM_ADDRESS: "sender@example.test",
    });

    assert.equal(server.messenger.constructor.name, "MockMessenger");
    assert.equal(server.messenger, getSharedMockMessenger());
});

test("explicit mock works in test", () => {
    const server = serverFor({ EMAIL_BACKEND: "mock", HQ_ENVIRONMENT: "test" });
    assert.equal(server.messenger.constructor.name, "MockMessenger");
    assert.equal(server.messenger, getSharedMockMessenger());
});

test("complete Resend credentials select Resend", () => {
    const server = serverFor({
        RESEND_API_KEY: "test-api-key",
        EMAIL_FROM_ADDRESS: "sender@example.test",
    });

    assert.equal(server.messenger.constructor.name, "ResendMessenger");
    assert.notEqual(server.messenger, getSharedMockMessenger());
});

test("a missing RESEND_API_KEY throws in every environment", () => {
    assert.throws(
        () => serverFor({ EMAIL_FROM_ADDRESS: "sender@example.test" }),
        /RESEND_API_KEY is required when EMAIL_BACKEND is not mock/
    );
    assert.throws(
        () =>
            serverFor(
                liveBindings({
                    HQ_ENVIRONMENT: "staging",
                    EMAIL_FROM_ADDRESS: "sender@example.test",
                })
            ),
        /RESEND_API_KEY is required when EMAIL_BACKEND is not mock/
    );
});

test("a missing EMAIL_FROM_ADDRESS throws in every environment", () => {
    assert.throws(
        () => serverFor({ RESEND_API_KEY: "test-api-key" }),
        /EMAIL_FROM_ADDRESS is required when EMAIL_BACKEND is not mock/
    );
    assert.throws(
        () =>
            serverFor(
                liveBindings({
                    HQ_ENVIRONMENT: "production",
                    RESEND_API_KEY: "test-api-key",
                })
            ),
        /EMAIL_FROM_ADDRESS is required when EMAIL_BACKEND is not mock/
    );
});

test("live env plus EMAIL_BACKEND=mock throws", () => {
    for (const hq of ["staging", "production", "preview"]) {
        assert.throws(
            () => serverFor(liveBindings({ HQ_ENVIRONMENT: hq, EMAIL_BACKEND: "mock" })),
            /EMAIL_BACKEND=mock is not allowed when HQ_ENVIRONMENT is staging, production, or preview/,
            hq
        );
    }
});

test("CLIENT_URL takes precedence over ALLOW_ORIGIN", () => {
    const server = serverFor({
        EMAIL_BACKEND: "mock",
        CLIENT_URL: "https://client.example.test",
        ALLOW_ORIGIN: "https://origin.example.test",
    });

    assert.equal(server.config.clientUrl, "https://client.example.test");
});

test("ALLOW_ORIGIN supplies clientUrl when CLIENT_URL is absent", () => {
    const server = serverFor({
        EMAIL_BACKEND: "mock",
        ALLOW_ORIGIN: "https://origin.example.test",
    });

    assert.equal(server.config.clientUrl, "https://origin.example.test");
});

test("wildcard ALLOW_ORIGIN does not replace the safe default clientUrl", () => {
    const server = serverFor({ EMAIL_BACKEND: "mock", ALLOW_ORIGIN: "*" });

    assert.equal(server.config.clientUrl, "http://localhost:8080");
});

test("allowDisableMFA stays false in live env even when the flag is set", () => {
    const server = serverFor(
        liveBindings({
            HQ_ENVIRONMENT: "staging",
            RESEND_API_KEY: "test-api-key",
            EMAIL_FROM_ADDRESS: "sender@example.test",
            ALLOW_DISABLE_MFA: "true",
        })
    );
    assert.equal(server.config.allowDisableMFA, false);
    assert.equal(server.config.environment, "staging");
});

test("allowDisableMFA requires an explicit test/dev flag", () => {
    const off = serverFor({ EMAIL_BACKEND: "mock", HQ_ENVIRONMENT: "development" });
    assert.equal(off.config.allowDisableMFA, false);
    const on = serverFor({
        EMAIL_BACKEND: "mock",
        HQ_ENVIRONMENT: "development",
        ALLOW_DISABLE_MFA: "true",
    });
    assert.equal(on.config.allowDisableMFA, true);
});

test("core server ignores disableMFA unless allowDisableMFA is set outside live env", () => {
    const serverSrc = readFileSync(resolve(testDir, "../../core/src/server.ts"), "utf8");
    assert.match(
        serverSrc,
        /this\.config\.allowDisableMFA && !isLiveEnvironment\(this\.config\.environment\) && auth\.disableMFA/
    );
    assert.doesNotMatch(serverSrc, /^\s*auth\.disableMFA \|\|/m);
});

let failures = 0;
for (const { name, run } of cases) {
    try {
        await run();
        console.log(`ok - ${name}`);
    } catch (error) {
        failures += 1;
        console.error(`not ok - ${name}`);
        console.error(error);
    }
}

if (failures) {
    process.exitCode = 1;
} else {
    console.log(`All ${cases.length} server factory email-mode cases passed.`);
}
