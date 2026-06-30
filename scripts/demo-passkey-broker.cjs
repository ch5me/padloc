#!/usr/bin/env node

process.env.TS_NODE_TRANSPILE_ONLY = process.env.TS_NODE_TRANSPILE_ONLY || "1";
process.env.TS_NODE_COMPILER_OPTIONS = process.env.TS_NODE_COMPILER_OPTIONS || '{"module":"commonjs"}';

require("ts-node/register");

const { bytesToBase64, stringToBytes } = require("../packages/core/src/encoding");
const { PasskeyCredentialPolicy, VaultItem, VaultItemKind } = require("../packages/core/src/item");
const {
    enrollPasskeyCredential,
    requestPasskeyAssertion,
    verifyAssertionSignature,
} = require("../packages/extension/src/passkey-broker");

async function main() {
    const enrolled = await enrollPasskeyCredential(enrollmentRequest(), new Date("2026-06-29T18:00:00.000Z"));
    const storedItem = new VaultItem({
        id: "demo-passkey-item",
        name: enrolled.itemName,
        itemKind: VaultItemKind.PasskeyCredential,
        fields: enrolled.fields,
        passkeyCredential: enrolled.passkeyCredential,
    });

    const allowRequest = assertionRequest(
        storedItem.passkeyCredential.credentialId,
        "demo-nonce-allow",
        "demo-flow-allow"
    );
    const allowResult = await requestPasskeyAssertion(allowRequest, [storedItem], new Date("2026-06-29T18:05:00.000Z"));
    const verified = await verifyAssertionSignature(
        allowResult.updatedItem.passkeyCredential,
        allowResult.response.passkey.assertion,
        allowRequest.passkey
    );

    const denyRequest = assertionRequest(
        allowResult.updatedItem.passkeyCredential.credentialId,
        "demo-nonce-deny",
        undefined
    );
    delete denyRequest.passkey.flowId;
    delete denyRequest.binding.flowId;
    const denyResult = await requestPasskeyAssertion(
        denyRequest,
        [allowResult.updatedItem],
        new Date("2026-06-29T18:06:00.000Z")
    );

    const proof = {
        enrolled: enrolled.response.ok,
        rpId: enrolled.passkeyCredential.rpId,
        allowDecision: allowResult.response.passkey.decision,
        signatureVerified: verified,
        signCount: allowResult.updatedItem.passkeyCredential.signCount,
        denyDecision: denyResult.response.passkey.decision,
        denyReason: denyResult.response.reason,
    };

    console.log(JSON.stringify(proof, null, 2));
}

function enrollmentRequest() {
    return {
        type: "enroll-passkey",
        protocolVersion: 1,
        requestId: "demo-enroll",
        binding: {
            sessionId: "demo-session-enroll",
            origin: "https://accounts.example-rp.test",
            topOrigin: "https://accounts.example-rp.test",
            vendor: "throwaway-test-rp",
            profileId: "profile-demo",
            accountId: "account-demo",
        },
        passkey: {
            itemName: "Demo Example RP Passkey",
            rpId: "example-rp.test",
            userHandle: "user@example-rp.test",
            vendor: "throwaway-test-rp",
            policy: new PasskeyCredentialPolicy({
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
            }),
        },
    };
}

function assertionRequest(credentialId, nonce, flowId) {
    const challenge = bytesToBase64(stringToBytes("demo-passkey-challenge"));
    return {
        type: "request-assertion",
        protocolVersion: 1,
        requestId: `demo-assert-${nonce}`,
        binding: {
            sessionId: "demo-session-assert",
            origin: "https://accounts.example-rp.test",
            topOrigin: "https://accounts.example-rp.test",
            rpId: "example-rp.test",
            flowId,
            nonce,
            expiresAt: "2026-06-29T18:20:00.000Z",
            vendor: "throwaway-test-rp",
            profileId: "profile-demo",
            accountId: "account-demo",
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

main().catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
});
