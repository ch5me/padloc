import { expect } from "chai";
import { spawn, spawnSync } from "child_process";
import { resolve } from "path";
import { mkdtempSync, readFileSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { suite, test } from "mocha";

const { buildLockedBrokerResponse, buildUnlockedBrokerStatusResponse } = require("../src/autofill-broker-protocol");
const protocol = require("../src/autofill-broker-protocol");
const currentDir = __dirname;

suite("Autofill broker protocol", () => {
    test("accepts an exact metadata-only target inspection request and assembles its target", () => {
        const inspection = {
            tabId: 7,
            frameId: 2,
            sessionId: "session-inspect",
            topOrigin: "https://checkout.example.test",
        };
        const metadata = {
            documentId: "document-1",
            formRef: "form-1",
            targetRevision: "revision-1",
            frameOrigin: "https://checkout.example.test",
        };

        expect(protocol.isExactAutofillBrokerTargetInspection(inspection)).to.equal(true);
        expect(
            protocol.isExactAutofillBrokerTargetInspectionMetadata(metadata)
        ).to.equal(true);
        expect(() =>
            protocol.validateAutofillBrokerTargetInspectionTab(inspection, {
                id: 7,
                url: "https://checkout.example.test/cart",
                incognito: false,
            })
        ).not.to.throw();
        const target = protocol.assembleAutofillBrokerTarget(inspection, metadata);
        expect(target).to.deep.equal({
            tabId: 7,
            frameId: 2,
            origin: "https://checkout.example.test",
            documentId: "document-1",
            formRef: "form-1",
            targetRevision: "revision-1",
            sessionId: "session-inspect",
            topOrigin: "https://checkout.example.test",
            frameOrigin: "https://checkout.example.test",
        });
        expect(
            protocol.assertAutofillBrokerResponseV2({
                schema: "elf.padloc-broker-response.v2",
                kind: "status",
                protocolVersion: 2,
                requestId: "inspect-response",
                ok: true,
                vaultState: "locked",
                target,
            }).kind
        ).to.equal("status");
    });

    test("rejects target inspection input that is not the closed metadata shape", () => {
        expect(
            protocol.isExactAutofillBrokerTargetInspection({
                tabId: 7,
                frameId: 0,
                sessionId: "session-inspect",
                topOrigin: "https://checkout.example.test",
                origin: "https://checkout.example.test",
            })
        ).to.equal(false);
        expect(
            protocol.isExactAutofillBrokerTargetInspection({
                tabId: 7,
                frameId: 0,
                sessionId: "session-inspect",
                topOrigin: "chrome://settings",
            })
        ).to.equal(false);
        expect(() =>
            protocol.validateAutofillBrokerTargetInspectionTab(
                {
                    tabId: 7,
                    frameId: 0,
                    sessionId: "session-inspect",
                    topOrigin: "https://checkout.example.test",
                },
                { id: 8, url: "https://checkout.example.test/cart", incognito: false }
            )
        ).to.throw("tab mismatch");
        expect(() =>
            protocol.validateAutofillBrokerTargetInspectionTab(
                {
                    tabId: 7,
                    frameId: 0,
                    sessionId: "session-inspect",
                    topOrigin: "https://checkout.example.test",
                },
                { id: 7, url: "https://checkout.example.test/cart", incognito: true }
            )
        ).to.throw("incognito");
        expect(() =>
            protocol.validateAutofillBrokerTargetInspectionTab(
                {
                    tabId: 7,
                    frameId: 0,
                    sessionId: "session-inspect",
                    topOrigin: "https://checkout.example.test",
                },
                { id: 7, url: "https://other.example.test/cart", incognito: false }
            )
        ).to.throw("origin changed");
    });

    test("routes target inspection through the exact tab and frame without active-tab lookup or privacy ledger work", () => {
        const source = readFileSync(resolve(currentDir, "../src/background.ts"), "utf8");
        const inspectStart = source.indexOf('if (request.type === "inspect-target")');
        const lockGuard = source.indexOf(
            "if (application.state.locked || !application.state.loggedIn)",
            inspectStart
        );
        const statusBranch = source.indexOf('if (request.type === "status")', inspectStart);
        expect(inspectStart).to.be.greaterThan(-1);
        expect(lockGuard).to.be.greaterThan(inspectStart);
        expect(statusBranch).to.be.greaterThan(inspectStart);
        const inspectBlock = source.slice(inspectStart, statusBranch);
        expect(inspectBlock).to.contain("browser.tabs.get(inspection.tabId)");
        expect(inspectBlock).to.contain("browser.tabs.sendMessage(");
        expect(inspectBlock).to.contain("frameId: inspection.frameId");
        expect(inspectBlock).to.contain('{ type: "inspectAgenticBrowserTarget" }');
        expect(inspectBlock).not.to.contain("getActiveTab");
        expect(inspectBlock).not.to.contain("tabs.query");
        expect(inspectBlock).not.to.contain("autofillObservationLedger");
    });

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
        const hostPath = resolve(currentDir, "../native-host/elf-vault-autofill-host.mjs");
        const result = spawnSync(process.execPath, [hostPath], {
            input: Buffer.concat([header, request]),
        });

        expect(result.status).to.equal(0);
        const length = result.stdout.readUInt32LE(0);
        const response = JSON.parse(result.stdout.subarray(4, 4 + length).toString("utf8"));
        expect(response.ok).to.equal(true);
        expect(response.vaultState).to.equal("locked");
        expect(Object.keys(response.audit)).to.deep.equal(["valuePolicy"]);
        expect(response.audit.valuePolicy).to.equal("redacted audit only; no raw autofill values or passkey secrets");
    });

    test("unlocked broker status reports the live vault state", () => {
        const response = buildUnlockedBrokerStatusResponse({
            type: "status",
            protocolVersion: 1,
            requestId: "req-unlocked",
        });

        expect(response).to.deep.include({
            ok: true,
            protocolVersion: 1,
            requestId: "req-unlocked",
            vaultState: "unlocked",
            reason: null,
        });
        expect(response.audit.valuePolicy).to.contain("redacted");
    });

    test("native host replies before Chrome closes the native messaging pipe", async () => {
        const hostPath = resolve(currentDir, "../native-host/elf-vault-autofill-host.mjs");
        const child = spawn(process.execPath, [hostPath], { stdio: ["pipe", "pipe", "pipe"] });
        const request = Buffer.from(JSON.stringify({ type: "status", protocolVersion: 1 }));
        const header = Buffer.alloc(4);
        header.writeUInt32LE(request.length, 0);
        child.stdin.write(Buffer.concat([header, request]));

        const response = await new Promise<Record<string, unknown>>((resolveResponse, reject) => {
            let buffered = Buffer.alloc(0);
            const timeout = setTimeout(() => reject(new Error("native host response timed out")), 2_000);
            child.stdout.on("data", (chunk) => {
                buffered = Buffer.concat([buffered, chunk]);
                if (buffered.length < 4) return;
                const length = buffered.readUInt32LE(0);
                if (buffered.length < 4 + length) return;
                clearTimeout(timeout);
                resolveResponse(JSON.parse(buffered.subarray(4, 4 + length).toString("utf8")));
            });
            child.once("error", reject);
        });

        expect(response.ok).to.equal(true);
        child.stdin.end();
        child.kill();
    });

    test("native host handles multiple messages on one Chrome pipe", async () => {
        const hostPath = resolve(currentDir, "../native-host/elf-vault-autofill-host.mjs");
        const child = spawn(process.execPath, [hostPath], { stdio: ["pipe", "pipe", "pipe"] });
        const request = nativeMessageFrame({ type: "status", protocolVersion: 1 });
        child.stdin.write(Buffer.concat([request, request]));

        const responses = await readNativeResponses(child, 2);

        expect(responses.map((response) => response.ok)).to.deep.equal([true, true]);
        child.stdin.end();
        child.kill();
    });

    test("native host reads a fragmented message frame", async () => {
        const hostPath = resolve(currentDir, "../native-host/elf-vault-autofill-host.mjs");
        const child = spawn(process.execPath, [hostPath], { stdio: ["pipe", "pipe", "pipe"] });
        const request = nativeMessageFrame({ type: "status", protocolVersion: 1 });

        child.stdin.write(request.subarray(0, 2));
        child.stdin.write(request.subarray(2, 7));
        child.stdin.write(request.subarray(7));
        const [response] = await readNativeResponses(child, 1);

        expect(response.ok).to.equal(true);
        child.stdin.end();
        child.kill();
    });

    test("native host rejects oversized input frames", () => {
        const hostPath = resolve(currentDir, "../native-host/elf-vault-autofill-host.mjs");
        const header = Buffer.alloc(4);
        header.writeUInt32LE(1024 * 1024 + 1, 0);
        const result = spawnSync(process.execPath, [hostPath], { input: header });

        expect(result.status).not.to.equal(0);
        expect(result.stderr.toString("utf8")).to.contain("native message exceeds 1 MiB");
    });

    test("native host replaces oversized responses with a bounded error", () => {
        const stateDir = mkdtempSync(`${tmpdir()}/padloc-bridge-oversized-response-`);
        const hostPath = resolve(currentDir, "../native-host/elf-vault-autofill-host.mjs");
        writeFileSync(
            resolve(stateDir, "latest-redacted-response.json"),
            JSON.stringify({
                cachedAt: "2026-07-23T00:00:00.000Z",
                response: { fields: [{ itemName: "x".repeat(1024 * 1024) }] },
            })
        );

        const response = nativeHostRequest(
            hostPath,
            { type: "latest-redacted-response", protocolVersion: 1 },
            stateDir
        );

        expect(response.ok).to.equal(false);
        expect(response.reason).to.equal("native response exceeds 1 MiB");
    });

    test("native host drains stdout before accepting more pipe output", async () => {
        const hostPath = resolve(currentDir, "../native-host/elf-vault-autofill-host.mjs");
        const child = spawn(process.execPath, [hostPath], { stdio: ["pipe", "pipe", "pipe"] });
        const frame = nativeMessageFrame({ type: "status", protocolVersion: 1 });
        child.stdout.pause();
        child.stdin.write(Buffer.concat(Array.from({ length: 5_000 }, () => frame)));

        await new Promise((resolveDelay) => setTimeout(resolveDelay, 25));
        child.stdout.resume();
        const responses = await readNativeResponses(child, 5_000, 10_000);

        expect(responses).to.have.length(5_000);
        expect(responses.every((response) => response.ok === true)).to.equal(true);
        child.stdin.end();
        child.kill();
    });

    test("fixture seeding remains disabled, lock-gated, and auto-lock cleanup is shared", () => {
        const source = readFileSync(resolve(currentDir, "../src/background.ts"), "utf8");

        expect(source).to.contain(
            'const AGENTIC_AUTOFILL_FIXTURES_ENABLED = process.env.PL_AGENTIC_AUTOFILL_FIXTURES === "true";'
        );
        expect(source).to.match(
            /case "seedAgenticAutofillFixtures":[\s\S]*?if \(!AGENTIC_AUTOFILL_FIXTURES_ENABLED\)[\s\S]*?if \(application\.state\.locked \|\| !application\.state\.loggedIn\)/
        );
        expect(source).to.match(
            /async function handleAgenticAutofillBroker[\s\S]*?if \(application\.state\.locked \|\| !application\.state\.loggedIn\) \{/
        );
        expect(source).to.match(/case "loggedOut":[\s\S]*?case "locked":[\s\S]*?await clearAgenticAutofillState\(\)/);
        expect(source).to.match(
            /async function doLock\(\)[\s\S]*?await clearAgenticAutofillState\(\)[\s\S]*?await application\.lock\(\)/
        );
        expect(source).to.match(
            /async function clearAgenticAutofillState\(\)[\s\S]*?fixtureAutofillItems = \[\][\s\S]*?pendingAutofillPlans\.clear\(\)[\s\S]*?pendingAutofillApprovals\.clear\(\)[\s\S]*?pendingAutofillBundles\.clear\(\)[\s\S]*?pendingAutofillPromptNonces\.clear\(\)[\s\S]*?FIXTURE_SESSION_KEY[\s\S]*?FIXTURE_CIPHERTEXT_KEY/
        );
    });

    test("native host caches only redacted broker responses", () => {
        const stateDir = mkdtempSync(`${tmpdir()}/padloc-bridge-`);
        const hostPath = resolve(currentDir, "../native-host/elf-vault-autofill-host.mjs");
        const cached = nativeHostRequest(
            hostPath,
            {
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
            },
            stateDir
        );
        const latest = nativeHostRequest(hostPath, { type: "latest-redacted-response", protocolVersion: 1 }, stateDir);
        const rejected = nativeHostRequest(
            hostPath,
            {
                type: "cache-redacted-response",
                protocolVersion: 1,
                response: {
                    ok: true,
                    protocolVersion: 1,
                    vaultState: "unlocked",
                    reason: null,
                    bundleFields: [{ selector: "#email", value: "sentinel@example.test" }],
                },
            },
            stateDir
        );

        expect(cached.ok).to.equal(true);
        expect(latest.ok).to.equal(true);
        expect(latest.cached.response.bundleFields[0].value).to.equal("");
        expect(rejected.ok).to.equal(false);
        expect(rejected.reason).to.contain("non-redacted");
    });

    test("native host rejects nested raw values from stale cached responses", () => {
        const stateDir = mkdtempSync(`${tmpdir()}/padloc-bridge-stale-`);
        const hostPath = resolve(currentDir, "../native-host/elf-vault-autofill-host.mjs");
        writeFileSync(
            resolve(stateDir, "latest-redacted-response.json"),
            JSON.stringify({
                cachedAt: "2026-06-17T00:00:00.000Z",
                response: {
                    ok: true,
                    protocolVersion: 1,
                    vaultState: "unlocked",
                    reason: null,
                    cached: {
                        response: {
                            bundleFields: [{ selector: "#email", value: "sentinel@example.test" }],
                        },
                    },
                },
            })
        );

        const latest = nativeHostRequest(hostPath, { type: "latest-redacted-response", protocolVersion: 1 }, stateDir);

        expect(latest.ok).to.equal(false);
        expect(latest.reason).to.contain("non-redacted");
    });

    test("native host rejects stale fields value aliases", () => {
        const stateDir = mkdtempSync(`${tmpdir()}/padloc-bridge-fields-`);
        const hostPath = resolve(currentDir, "../native-host/elf-vault-autofill-host.mjs");
        writeFileSync(
            resolve(stateDir, "latest-redacted-response.json"),
            JSON.stringify({
                cachedAt: "2026-06-17T00:00:00.000Z",
                response: {
                    ok: true,
                    protocolVersion: 1,
                    vaultState: "unlocked",
                    reason: null,
                    fields: [{ selector: "#email", value: "sentinel@example.test" }],
                },
            })
        );

        const latest = nativeHostRequest(hostPath, { type: "latest-redacted-response", protocolVersion: 1 }, stateDir);

        expect(latest.ok).to.equal(false);
        expect(latest.reason).to.contain("non-redacted");
    });

    test("native host rejects nested privateKey and secret payloads in cached responses", () => {
        const stateDir = mkdtempSync(`${tmpdir()}/padloc-bridge-private-key-`);
        const hostPath = resolve(currentDir, "../native-host/elf-vault-autofill-host.mjs");
        const privateKey = nativeHostRequest(
            hostPath,
            {
                type: "cache-redacted-response",
                protocolVersion: 1,
                response: {
                    ok: true,
                    protocolVersion: 1,
                    passkey: {
                        registration: {
                            privateKey: "raw-private-key",
                        },
                    },
                },
            },
            stateDir
        );
        const secret = nativeHostRequest(
            hostPath,
            {
                type: "cache-redacted-response",
                protocolVersion: 1,
                response: {
                    ok: true,
                    protocolVersion: 1,
                    passkey: {
                        assertion: {
                            secretToken: "raw-secret",
                        },
                    },
                },
            },
            stateDir
        );

        expect(privateKey.ok).to.equal(false);
        expect(secret.ok).to.equal(false);
    });

    test("native host rejects non-string value payloads", () => {
        const stateDir = mkdtempSync(`${tmpdir()}/padloc-bridge-object-value-`);
        const hostPath = resolve(currentDir, "../native-host/elf-vault-autofill-host.mjs");
        const objectValue = nativeHostRequest(
            hostPath,
            {
                type: "cache-redacted-response",
                protocolVersion: 1,
                response: {
                    ok: true,
                    protocolVersion: 1,
                    fields: [{ selector: "#email", value: { raw: "sentinel" } }],
                },
            },
            stateDir
        );
        const numericValue = nativeHostRequest(
            hostPath,
            {
                type: "cache-redacted-response",
                protocolVersion: 1,
                response: {
                    ok: true,
                    protocolVersion: 1,
                    fields: [{ selector: "#email", value: 123 }],
                },
            },
            stateDir
        );

        expect(objectValue.ok).to.equal(false);
        expect(numericValue.ok).to.equal(false);
    });

    test("native host rejects passkey secrets in queued printable paths", () => {
        const stateDir = mkdtempSync(`${tmpdir()}/padloc-bridge-passkey-request-`);
        const hostPath = resolve(currentDir, "../native-host/elf-vault-autofill-host.mjs");
        const queued = nativeHostRequest(
            hostPath,
            {
                type: "broker-request",
                protocolVersion: 1,
                request: {
                    type: "request-assertion",
                    protocolVersion: 1,
                    requestId: "req-passkey-unsafe",
                    passkey: {
                        credentialId: "cred-1",
                        rpId: "example-rp.test",
                        topOrigin: "https://accounts.example-rp.test",
                        privateKey: "should-not-print",
                    },
                },
            },
            stateDir
        );

        expect(queued.ok).to.equal(false);
        expect(queued.reason).to.contain("sensitive payload");
    });

    test("native host caches redacted approval metadata", () => {
        const stateDir = mkdtempSync(`${tmpdir()}/padloc-bridge-approval-`);
        const hostPath = resolve(currentDir, "../native-host/elf-vault-autofill-host.mjs");
        const cached = nativeHostRequest(
            hostPath,
            {
                type: "cache-redacted-response",
                protocolVersion: 1,
                response: {
                    ok: true,
                    protocolVersion: 1,
                    vaultState: "unlocked",
                    reason: null,
                    planId: "plan-1",
                    approvalId: "approval-1",
                    audit: { operation: "approve", valuePolicy: "redacted audit only; no raw autofill values" },
                },
            },
            stateDir
        );
        const latest = nativeHostRequest(hostPath, { type: "latest-redacted-response", protocolVersion: 1 }, stateDir);

        expect(cached.ok).to.equal(true);
        expect(latest.ok).to.equal(true);
        expect(latest.cached.response.approvalId).to.equal("approval-1");
    });

    test("native host queues broker requests and returns matching redacted responses", () => {
        const stateDir = mkdtempSync(`${tmpdir()}/padloc-bridge-queue-`);
        const hostPath = resolve(currentDir, "../native-host/elf-vault-autofill-host.mjs");
        const queued = nativeHostRequest(
            hostPath,
            {
                type: "broker-request",
                protocolVersion: 1,
                request: {
                    type: "plan-fill",
                    protocolVersion: 1,
                    requestId: "req-native-1",
                    binding: {
                        sessionId: "session-1",
                        origin: "https://checkout.example.test",
                        frameId: "main",
                        fieldHashes: ["hash-email"],
                    },
                    fields: [{ selector: "#email", role: "contact.email", fieldHash: "hash-email" }],
                },
            },
            stateDir
        );
        const claimed = nativeHostRequest(hostPath, { type: "claim-broker-request", protocolVersion: 1 }, stateDir);
        const emptyClaim = nativeHostRequest(hostPath, { type: "claim-broker-request", protocolVersion: 1 }, stateDir);
        nativeHostRequest(
            hostPath,
            {
                type: "cache-redacted-response",
                protocolVersion: 1,
                response: {
                    ok: true,
                    protocolVersion: 1,
                    requestId: "req-native-1",
                    vaultState: "unlocked",
                    reason: null,
                    fields: [{ selector: "#email", role: "contact.email", valuePreview: "stored" }],
                    audit: { operation: "plan-fill", valuePolicy: "redacted audit only; no raw autofill values" },
                },
            },
            stateDir
        );
        const response = nativeHostRequest(
            hostPath,
            {
                type: "broker-response",
                protocolVersion: 1,
                requestId: "req-native-1",
            },
            stateDir
        );

        expect(queued.ok).to.equal(true);
        expect(queued.pending).to.equal(true);
        expect(claimed.pending.request.requestId).to.equal("req-native-1");
        expect(emptyClaim.pending).to.equal(null);
        expect(response.ok).to.equal(true);
        expect(response.cached.response.requestId).to.equal("req-native-1");
        expect(JSON.stringify(response)).not.to.contain("sentinel@example.test");
    });

    test("native host forwards cached protocol-v2 privacy-status from broker-response", () => {
        const stateDir = mkdtempSync(`${tmpdir()}/padloc-bridge-v2-privacy-`);
        const hostPath = resolve(currentDir, "../native-host/elf-vault-autofill-host.mjs");
        const target = {
            tabId: 1,
            frameId: 0,
            origin: "https://checkout.example.test",
            documentId: "document-1",
            formRef: "form-1",
            targetRevision: "revision-1",
            sessionId: "session-1",
            topOrigin: "https://checkout.example.test",
            frameOrigin: "https://checkout.example.test",
        };
        const privacy = {
            schema: "dance.elf.vault.broker-response.v2",
            kind: "privacy-status",
            protocolVersion: 2,
            requestId: "privacy-native-1",
            ok: true,
            target,
            state: "unknown",
            observationRevision: 0,
            genericObservation: "requires-separate-disclosure",
        };
        const cached = nativeHostRequest(
            hostPath,
            { type: "cache-redacted-response", protocolVersion: 1, response: privacy },
            stateDir
        );
        const response = nativeHostRequest(
            hostPath,
            { type: "broker-response", protocolVersion: 1, requestId: "privacy-native-1" },
            stateDir
        );
        expect(cached.ok).to.equal(true);
        expect(response.kind).to.equal("privacy-status");
        expect(response.protocolVersion).to.equal(2);
        expect(response.state).to.equal("unknown");
        expect(response).not.to.have.property("vaultState");
        expect(response).not.to.have.property("audit");
    });

    test("parses closed v2 privacy and receipt variants and rejects unknown nested keys", () => {
        const target = exactTarget();
        const privacy = {
            schema: "dance.elf.vault.broker-response.v2",
            kind: "privacy-status",
            protocolVersion: 2,
            requestId: "privacy-1",
            ok: true,
            target,
            state: "clean",
            observationRevision: 1,
            genericObservation: "allowed",
        };
        expect(protocol.assertAutofillBrokerResponseV2(privacy).kind).to.equal("privacy-status");

        const applied = {
            schema: "dance.elf.vault.broker-response.v2",
            kind: "applied",
            protocolVersion: 2,
            requestId: "applied-1",
            ok: true,
            target,
            grantId: "grant-1",
            receipt: {
                receiptId: "receipt-1",
                status: "completed",
                filledFieldRefs: ["field-1"],
                modelDisclosure: "none",
                submittedByExecutor: true,
            },
        };
        expect(protocol.assertAutofillBrokerResponseV2(applied).kind).to.equal("applied");
        expect(() =>
            protocol.assertAutofillBrokerResponseV2({
                ...applied,
                receipt: { ...applied.receipt, nested: "unknown" },
            })
        ).to.throw();
    });

    test("keeps protocol v1 readable only as non-authorizing compatibility data", () => {
        const legacy = protocol.parseAutofillBrokerResponse({
            ok: true,
            protocolVersion: 1,
            requestId: "legacy-1",
            vaultState: "unlocked",
            reason: null,
            grantId: "legacy-grant",
            audit: { operation: "status", valuePolicy: "redacted" },
        });
        expect(protocol.isProtocolV1NonAuthorizing(legacy)).to.equal(true);
        expect(legacy.authorizing).to.equal(false);
    });

    test("rejects unknown keys on protocol-v1 compatibility responses", () => {
        expect(() =>
            protocol.parseAutofillBrokerResponse({
                ok: true,
                protocolVersion: 1,
                requestId: "legacy-unknown",
                vaultState: "unlocked",
                reason: null,
                audit: { operation: "status", valuePolicy: "redacted" },
                invented: "must-reject",
            })
        ).to.throw();
    });

    test("native host refuses protocol-v1 authorizing requests", () => {
        const stateDir = mkdtempSync(`${tmpdir()}/padloc-bridge-v1-authorizing-`);
        const hostPath = resolve(currentDir, "../native-host/elf-vault-autofill-host.mjs");
        const response = nativeHostRequest(
            hostPath,
            {
                type: "broker-request",
                protocolVersion: 1,
                request: {
                    type: "approve",
                    protocolVersion: 1,
                    requestId: "native-approve",
                    planId: "plan_fixture",
                    approved: true,
                },
            },
            stateDir
        );

        expect(response.ok).to.equal(false);
        expect(response.reason).to.contain("authorizing");
        expect(nativeHostRequest(hostPath, { type: "claim-broker-request" }, stateDir).pending).to.equal(null);
    });
});

function nativeHostRequest(hostPath: string, request: unknown, stateDir: string) {
    const payload = Buffer.from(JSON.stringify(request));
    const header = Buffer.alloc(4);
    header.writeUInt32LE(payload.length, 0);
    const result = spawnSync(process.execPath, [hostPath], {
        input: Buffer.concat([header, payload]),
        env: { ...process.env, ELF_VAULT_AGENTIC_AUTOFILL_STATE_DIR: stateDir },
    });
    expect(result.status).to.equal(0);
    const length = result.stdout.readUInt32LE(0);
    return JSON.parse(result.stdout.subarray(4, 4 + length).toString("utf8"));
}

function nativeMessageFrame(request: Record<string, unknown>) {
    const payload = Buffer.from(JSON.stringify(request));
    const header = Buffer.alloc(4);
    header.writeUInt32LE(payload.length, 0);
    return Buffer.concat([header, payload]);
}

function readNativeResponses(
    child: ReturnType<typeof spawn>,
    count: number,
    timeoutMs = 2_000
): Promise<Array<Record<string, unknown>>> {
    return new Promise((resolveResponses, reject) => {
        let buffered = Buffer.alloc(0);
        const responses: Array<Record<string, unknown>> = [];
        const timeout = setTimeout(() => reject(new Error("native host responses timed out")), timeoutMs);
        child.stdout.on("data", (chunk) => {
            buffered = Buffer.concat([buffered, chunk]);
            while (buffered.length >= 4) {
                const length = buffered.readUInt32LE(0);
                if (buffered.length < 4 + length) return;
                responses.push(JSON.parse(buffered.subarray(4, 4 + length).toString("utf8")));
                buffered = buffered.subarray(4 + length);
                if (responses.length === count) {
                    clearTimeout(timeout);
                    resolveResponses(responses);
                    return;
                }
            }
        });
        child.once("error", reject);
    });
}

function exactTarget() {
    return {
        tabId: 7,
        frameId: 0,
        origin: "https://checkout.example.test",
        documentId: "document-1",
        formRef: "form-1",
        targetRevision: "revision-1",
        sessionId: "session-1",
        topOrigin: "https://checkout.example.test",
        frameOrigin: "https://checkout.example.test",
    };
}
