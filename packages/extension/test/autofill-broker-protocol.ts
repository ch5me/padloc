import { expect } from "chai";
import { spawnSync } from "child_process";
import { createRequire } from "module";
import { dirname, resolve } from "path";
import { fileURLToPath } from "url";
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
});
