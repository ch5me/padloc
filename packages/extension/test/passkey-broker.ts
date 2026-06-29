// @ts-nocheck
const { expect } = require("chai");
const { suite: mochaSuite, test: mochaTest } = require("mocha");
const requireModule = require;
const { bytesToBase64, stringToBytes } = requireModule("../../core/src/encoding");
const { FieldType, PasskeyCredentialPolicy, VaultItem, VaultItemKind } = requireModule("../../core/src/item");
const {
    enrollPasskeyCredential,
    requestPasskeyAssertion,
    verifyAssertionSignature,
} = requireModule("../src/passkey-broker");

const ALGORITHMS = [
    {
        label: "ES256",
        value: -7,
        generateKey: { name: "ECDSA", namedCurve: "P-256" },
    },
    {
        label: "Ed25519",
        value: -8,
        generateKey: { name: "Ed25519" },
    },
];

mochaSuite("Passkey broker", () => {
    for (const algorithm of ALGORITHMS) {
        mochaTest(`${algorithm.label} enroll-import stores private key in secret field and never leaks it in broker response`, async () => {
            const request = await enrollmentRequest({ algorithm: algorithm.value });
            const result = await enrollPasskeyCredential(request, new Date("2026-06-29T18:00:00.000Z"));
            const privateKeyField = result.fields[result.passkeyCredential.privateKeyFieldIndex];

            expect(privateKeyField.type).to.equal(FieldType.Password);
            expect(privateKeyField.value).to.equal(request.passkey.privateKeyPkcs8);
            expect(result.passkeyCredential.algorithm).to.equal(algorithm.value);
            expect(result.passkeyCredential.privateKeyFieldIndex).to.equal(0);
            expect(JSON.stringify(result.response)).not.to.contain(privateKeyField.value);
            expect(JSON.stringify(result.response)).not.to.contain("privateKey");
            expect(result.response.passkey.registration.attestationObject).to.be.a("string").and.not.equal("");
            expect(result.response.passkey.registration.algorithm).to.equal(algorithm.value);
        });

        mochaTest(`${algorithm.label} enroll-import -> assert -> signature verifies against stored public key`, async () => {
            const request = await enrollmentRequest({ algorithm: algorithm.value });
            const enrolled = await enrollPasskeyCredential(request, new Date("2026-06-29T18:00:00.000Z"));
            const item = asStoredItem(enrolled);
            const requestAssertion = assertionRequest(item.passkeyCredential.credentialId, "nonce-allow", "flow-allow");
            const result = await requestPasskeyAssertion(requestAssertion, [item], new Date("2026-06-29T18:05:00.000Z"));

            expect(result.response.ok).to.equal(true);
            expect(result.updatedItem.passkeyCredential.signCount).to.equal(1);
            expect(result.updatedItem.passkeyCredential.algorithm).to.equal(algorithm.value);
            expect(result.response.passkey.decision).to.equal("allow");
            expect(JSON.stringify(result.response)).not.to.contain(item.fields[0].value);

            const verified = await verifyAssertionSignature(
                result.updatedItem.passkeyCredential,
                result.response.passkey.assertion,
                requestAssertion.passkey
            );

            expect(verified).to.equal(true);
        });
    }

    mochaTest("denies disallowed rpId", async () => {
        const enrolled = await enrollPasskeyCredential(await enrollmentRequest(), new Date("2026-06-29T18:00:00.000Z"));
        const item = asStoredItem(enrolled);
        const request = assertionRequest(item.passkeyCredential.credentialId, "nonce-rp", "flow-rp");
        request.passkey.rpId = "evil.example";
        request.binding.rpId = "evil.example";
        const result = await requestPasskeyAssertion(request, [item], new Date("2026-06-29T18:05:00.000Z"));

        expect(result.response.ok).to.equal(false);
        expect(result.response.reason).to.equal("rp_id_not_allowed");
    });

    mochaTest("denies disallowed top origin", async () => {
        const enrolled = await enrollPasskeyCredential(await enrollmentRequest(), new Date("2026-06-29T18:00:00.000Z"));
        const item = asStoredItem(enrolled);
        const request = assertionRequest(item.passkeyCredential.credentialId, "nonce-origin", "flow-origin");
        request.passkey.topOrigin = "https://blocked.example.test";
        request.binding.origin = "https://blocked.example.test";
        request.binding.topOrigin = "https://blocked.example.test";
        const result = await requestPasskeyAssertion(request, [item], new Date("2026-06-29T18:05:00.000Z"));

        expect(result.response.ok).to.equal(false);
        expect(result.response.reason).to.equal("top_origin_not_allowed");
    });

    mochaTest("denies missing flow binding when required", async () => {
        const enrolled = await enrollPasskeyCredential(await enrollmentRequest(), new Date("2026-06-29T18:00:00.000Z"));
        const item = asStoredItem(enrolled);
        const request = assertionRequest(item.passkeyCredential.credentialId, "nonce-flow", undefined);
        delete request.passkey.flowId;
        delete request.binding.flowId;
        const result = await requestPasskeyAssertion(request, [item], new Date("2026-06-29T18:05:00.000Z"));

        expect(result.response.ok).to.equal(false);
        expect(result.response.reason).to.equal("flow_binding_required");
    });

    mochaTest("denies once daily rate limit is exhausted", async () => {
        const enrolled = await enrollPasskeyCredential(
            await enrollmentRequest({ policy: { ...basePolicy(), rateLimit: { maxPerDay: 1, maxPerWeek: 3 } } }),
            new Date("2026-06-29T18:00:00.000Z")
        );
        const item = asStoredItem(enrolled);
        const allow = await requestPasskeyAssertion(
            assertionRequest(item.passkeyCredential.credentialId, "nonce-first", "flow-rate"),
            [item],
            new Date("2026-06-29T18:05:00.000Z")
        );
        const deny = await requestPasskeyAssertion(
            assertionRequest(allow.updatedItem.passkeyCredential.credentialId, "nonce-second", "flow-rate"),
            [allow.updatedItem],
            new Date("2026-06-29T18:10:00.000Z")
        );

        expect(allow.response.ok).to.equal(true);
        expect(deny.response.ok).to.equal(false);
        expect(deny.response.reason).to.equal("rate_limit_day_exceeded");
    });

    mochaTest("denies emergency lockout", async () => {
        const enrolled = await enrollPasskeyCredential(
            await enrollmentRequest({ policy: { ...basePolicy(), emergencyLockout: true } }),
            new Date("2026-06-29T18:00:00.000Z")
        );
        const item = asStoredItem(enrolled);
        const result = await requestPasskeyAssertion(
            assertionRequest(item.passkeyCredential.credentialId, "nonce-lock", "flow-lock"),
            [item],
            new Date("2026-06-29T18:05:00.000Z")
        );

        expect(result.response.ok).to.equal(false);
        expect(result.response.reason).to.equal("emergency_lockout");
    });
});

function asStoredItem(enrolled: { itemName: string; fields: unknown[]; passkeyCredential: Record<string, unknown> }) {
    return new VaultItem({
        id: "passkey-item-1",
        name: enrolled.itemName,
        itemKind: VaultItemKind.PasskeyCredential,
        fields: enrolled.fields,
        passkeyCredential: enrolled.passkeyCredential,
    });
}

async function enrollmentRequest(
    overrides: { algorithm?: number; fixtureSeed?: string; policy?: Record<string, unknown>; passkey?: Record<string, unknown> } = {}
) {
    const fixture = await makeImportedCredentialFixture(overrides.algorithm || -7, overrides.fixtureSeed || "default");
    const policy = new PasskeyCredentialPolicy({
        ...basePolicy(),
        ...(overrides.policy || {}),
    });
    return {
        type: "enroll-passkey",
        protocolVersion: 1,
        requestId: "enroll-1",
        binding: {
            sessionId: "session-enroll",
            origin: "https://accounts.example-rp.test",
            topOrigin: "https://accounts.example-rp.test",
            vendor: "throwaway-test-rp",
            profileId: "profile-1",
            accountId: "account-1",
        },
        passkey: {
            itemName: "Example RP Passkey",
            rpId: "example-rp.test",
            credentialId: fixture.credentialId,
            privateKeyPkcs8: fixture.privateKeyPkcs8,
            userHandle: fixture.userHandle,
            signCount: fixture.signCount,
            algorithm: fixture.algorithm,
            vendor: "throwaway-test-rp",
            policy,
            ...(overrides.passkey || {}),
        },
    };
}

function assertionRequest(credentialId: string, nonce: string, flowId?: string) {
    const challenge = bytesToBase64(stringToBytes("challenge-for-passkey"));
    return {
        type: "request-assertion",
        protocolVersion: 1,
        requestId: `assert-${nonce}`,
        binding: {
            sessionId: "session-assert",
            origin: "https://accounts.example-rp.test",
            topOrigin: "https://accounts.example-rp.test",
            rpId: "example-rp.test",
            flowId,
            nonce,
            expiresAt: "2026-06-29T18:20:00.000Z",
            vendor: "throwaway-test-rp",
            profileId: "profile-1",
            accountId: "account-1",
        },
        passkey: {
            credentialId,
            rpId: "example-rp.test",
            topOrigin: "https://accounts.example-rp.test",
            challenge,
            flowId,
            nonce,
            vendor: "throwaway-test-rp",
        },
    };
}

function basePolicy() {
    return {
        allowedRpIds: ["example-rp.test"],
        allowedTopOrigins: ["https://accounts.example-rp.test"],
        allowedVendorFlows: ["throwaway-test-rp"],
        approval: "none",
        rateLimit: {
            maxPerDay: 5,
            maxPerWeek: 10,
        },
        timeWindows: [],
        requireFlowBinding: true,
        emergencyLockout: false,
    };
}

async function makeImportedCredentialFixture(algorithm: number, seed: string) {
    const subtle = globalThis.crypto.subtle;
    const generateKey = ALGORITHMS.find((entry) => entry.value === algorithm)?.generateKey;
    if (!generateKey) {
        throw new Error(`Unsupported fixture algorithm ${algorithm}`);
    }
    const keyPair = await subtle.generateKey(generateKey, true, ["sign", "verify"]);
    if (!("privateKey" in keyPair) || !keyPair.privateKey) {
        throw new Error(`Fixture key generation failed for algorithm ${algorithm}`);
    }
    return {
        algorithm,
        credentialId: bytesToBase64(stringToBytes(`credential-${seed}-${algorithm}`)),
        privateKeyPkcs8: bytesToBase64(new Uint8Array(await subtle.exportKey("pkcs8", keyPair.privateKey))),
        userHandle: bytesToBase64(stringToBytes(`user-${seed}-${algorithm}`)),
        signCount: 0,
    };
}
