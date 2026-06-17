import { expect } from "chai";
import { spawnSync } from "child_process";
import { createRequire } from "module";
import { dirname, resolve } from "path";
import { fileURLToPath } from "url";
import { mkdtempSync } from "fs";
import { tmpdir } from "os";
import { suite, test } from "mocha";

const requireModule = createRequire(import.meta.url);
const { buildLockedBrokerResponse } = requireModule("../src/autofill-broker-protocol");
const currentDir = dirname(fileURLToPath(import.meta.url));

suite("Autofill broker protocol", () => {
    test("builds redacted locked response", () => {
        const response = buildLockedBrokerResponse({
            type: "plan-fill",
            protocolVersion: 1,
            requestId: "req-1",
            binding: {
                sessionId: "session-1",
                origin: "https://checkout.example.test",
                frameId: "main",
                fieldHashes: ["field-hash"],
            },
            fields: [{ selector: "#card", role: "payment.card.pan", fieldHash: "field-hash" }],
        });

        expect(response.ok).to.equal(false);
        expect(response.vaultState).to.equal("locked");
        expect(response.audit.origin).to.equal("https://checkout.example.test");
        expect(JSON.stringify(response)).not.to.contain("4111111111111111");
    });

    test("native host status handshake returns metadata only", () => {
        const request = Buffer.from(JSON.stringify({ type: "status", protocolVersion: 1, requestId: "req-2" }));
        const header = Buffer.alloc(4);
        header.writeUInt32LE(request.length, 0);
        const hostPath = resolve(currentDir, "../native-host/padloc-autofill-host.mjs");
        const result = spawnSync(process.execPath, [hostPath], {
            input: Buffer.concat([header, request]),
        });

        expect(result.status).to.equal(0);
        const length = result.stdout.readUInt32LE(0);
        const response = JSON.parse(result.stdout.subarray(4, 4 + length).toString("utf8"));
        expect(response.ok).to.equal(true);
        expect(response.vaultState).to.equal("locked");
        expect(response.audit.valuePolicy).to.equal("redacted audit only; no raw autofill values");
    });

    test("native host caches only redacted broker responses", () => {
        const stateDir = mkdtempSync(`${tmpdir()}/padloc-bridge-`);
        const hostPath = resolve(currentDir, "../native-host/padloc-autofill-host.mjs");
        const cached = nativeHostRequest(hostPath, {
            type: "cache-redacted-response",
            protocolVersion: 1,
            response: {
                ok: true,
                protocolVersion: 1,
                vaultState: "unlocked",
                reason: null,
                bundleFields: [{ selector: "#email", value: "" }],
                audit: { valuePolicy: "redacted audit only; no raw autofill values" },
            },
        }, stateDir);
        const latest = nativeHostRequest(hostPath, { type: "latest-redacted-response", protocolVersion: 1 }, stateDir);
        const rejected = nativeHostRequest(hostPath, {
            type: "cache-redacted-response",
            protocolVersion: 1,
            response: {
                ok: true,
                protocolVersion: 1,
                vaultState: "unlocked",
                reason: null,
                bundleFields: [{ selector: "#email", value: "sentinel@example.test" }],
            },
        }, stateDir);

        expect(cached.ok).to.equal(true);
        expect(latest.ok).to.equal(true);
        expect(latest.cached.response.bundleFields[0].value).to.equal("");
        expect(rejected.ok).to.equal(false);
        expect(rejected.reason).to.contain("non-redacted");
    });
});

function nativeHostRequest(hostPath: string, request: unknown, stateDir: string) {
    const payload = Buffer.from(JSON.stringify(request));
    const header = Buffer.alloc(4);
    header.writeUInt32LE(payload.length, 0);
    const result = spawnSync(process.execPath, [hostPath], {
        input: Buffer.concat([header, payload]),
        env: { ...process.env, PADLOC_AGENTIC_AUTOFILL_STATE_DIR: stateDir },
    });
    expect(result.status).to.equal(0);
    const length = result.stdout.readUInt32LE(0);
    return JSON.parse(result.stdout.subarray(4, 4 + length).toString("utf8"));
}
