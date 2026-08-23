import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";

const testDir = dirname(fileURLToPath(import.meta.url));
const entryPoint = resolve(testDir, "../src/server-factory.ts");
const [{ text: bundledFactory }] = (
    await build({
        entryPoints: [entryPoint],
        bundle: true,
        platform: "node",
        format: "cjs",
        target: "node16",
        write: false,
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
    // Omitting DB and ATTACHMENTS deliberately exercises the factory's stub bindings.
    return createServer(overrides);
}

test("explicit mock wins even when Resend credentials are complete", () => {
    const server = serverFor({
        EMAIL_BACKEND: "mock",
        RESEND_API_KEY: "test-api-key",
        EMAIL_FROM_ADDRESS: "sender@example.test",
    });

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

test("a missing RESEND_API_KEY falls back to the shared mock", () => {
    const server = serverFor({ EMAIL_FROM_ADDRESS: "sender@example.test" });

    assert.equal(server.messenger.constructor.name, "MockMessenger");
    assert.equal(server.messenger, getSharedMockMessenger());
});

test("a missing EMAIL_FROM_ADDRESS falls back to the shared mock", () => {
    const server = serverFor({ RESEND_API_KEY: "test-api-key" });

    assert.equal(server.messenger.constructor.name, "MockMessenger");
    assert.equal(server.messenger, getSharedMockMessenger());
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
