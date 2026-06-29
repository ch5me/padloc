// @ts-nocheck
const { expect } = require("chai");
const { suite: mochaSuite, test: mochaTest } = require("mocha");
const requireModule = require;
const {
    applyBrokerBundleResponse,
    approveBrokerPlanResponse,
    buildUnlockedBrokerPlanResponse,
    mintBrokerBundleResponse,
    redactBrokerResponse,
    revokeBrokerBundleResponse,
} = requireModule("../src/autofill-broker");

mochaSuite("Autofill broker", () => {
    const request = {
        type: "plan-fill",
        protocolVersion: 1,
        requestId: "req-1",
        binding: {
            sessionId: "session-1",
            origin: "https://checkout.example.test",
            frameId: "main",
            fieldHashes: ["hash-email", "hash-card", "hash-cvv"],
        },
        fields: [
            { selector: "#email", role: "contact.email", fieldHash: "hash-email" },
            { selector: "#card", role: "payment.card.pan", fieldHash: "hash-card" },
            { selector: "#cvv", role: "payment.card.cvv_transient", fieldHash: "hash-cvv" },
        ],
    };

    mochaTest("plans matching unlocked Padloc fields without raw values", () => {
        const { response } = buildUnlockedBrokerPlanResponse(request, items());
        const roles = response.fields.map(readRole);

        expect(response.ok).to.equal(true);
        expect(response.vaultState).to.equal("unlocked");
        expect(roles).to.deep.equal([
            "contact.email",
            "payment.card.pan",
            "payment.card.cvv_transient",
        ]);
        expect(response.fields[1].valuePreview).to.equal("card:1111");
        expect(response.fields[2].transactionOnly).to.equal(true);
        expect(JSON.stringify(response)).not.to.contain("sentinel@example.test");
        expect(JSON.stringify(response)).not.to.contain("4111111111111111");
        expect(JSON.stringify(response)).not.to.contain("123");
    });

    mochaTest("approves and mints a short-lived bundle, then redacts returned values", async () => {
        const { pendingPlan } = buildUnlockedBrokerPlanResponse(request, items(), Date.parse("2026-06-17T12:00:00.000Z"));
        const { approval, response: approvalResponse } = approveBrokerPlanResponse(
            { type: "approve", protocolVersion: 1, planId: pendingPlan.planId, approved: true, ttlSeconds: 60 },
            pendingPlan,
            Date.parse("2026-06-17T12:00:01.000Z")
        );
        const bundleResponse = await mintBrokerBundleResponse(
            { type: "mint-fill-bundle", protocolVersion: 1, planId: pendingPlan.planId, approvalId: approval.approvalId },
            pendingPlan,
            approval,
            items(),
            Date.parse("2026-06-17T12:00:02.000Z")
        );
        const redacted = redactBrokerResponse(bundleResponse);

        expect(approvalResponse.approvalId).to.equal(approval.approvalId);
        expect(bundleResponse.bundleFields[0].value).to.equal("sentinel@example.test");
        expect(redacted.bundleFields[0].value).to.equal("");
        expect(JSON.stringify(redacted)).not.to.contain("sentinel@example.test");
        expect(JSON.stringify(redacted)).not.to.contain("4111111111111111");
        expect(JSON.stringify(redacted)).not.to.contain("123");
    });

    mochaTest("rejects minting after approval expiry", async () => {
        const { pendingPlan } = buildUnlockedBrokerPlanResponse(request, items(), Date.parse("2026-06-17T12:00:00.000Z"));
        const { approval } = approveBrokerPlanResponse(
            { type: "approve", protocolVersion: 1, planId: pendingPlan.planId, approved: true, ttlSeconds: 1 },
            pendingPlan,
            Date.parse("2026-06-17T12:00:01.000Z")
        );

        try {
            await mintBrokerBundleResponse(
                { type: "mint-fill-bundle", protocolVersion: 1, planId: pendingPlan.planId, approvalId: approval.approvalId },
                pendingPlan,
                approval,
                items(),
                Date.parse("2026-06-17T12:00:03.000Z")
            );
            throw new Error("expected failure");
        } catch (error) {
            expect(String(error)).to.contain("expired");
        }
    });

    mochaTest("acknowledges apply and revoke without returning raw bundle values", async () => {
        const { pendingPlan } = buildUnlockedBrokerPlanResponse(request, items(), Date.parse("2026-06-17T12:00:00.000Z"));
        const { approval } = approveBrokerPlanResponse(
            { type: "approve", protocolVersion: 1, planId: pendingPlan.planId, approved: true, ttlSeconds: 60 },
            pendingPlan,
            Date.parse("2026-06-17T12:00:01.000Z")
        );
        const bundleResponse = await mintBrokerBundleResponse(
            { type: "mint-fill-bundle", protocolVersion: 1, planId: pendingPlan.planId, approvalId: approval.approvalId },
            pendingPlan,
            approval,
            items(),
            Date.parse("2026-06-17T12:00:02.000Z")
        );
        const redacted = redactBrokerResponse(bundleResponse);
        const applyResponse = applyBrokerBundleResponse(
            { type: "apply-fill-bundle", protocolVersion: 1, planId: pendingPlan.planId, bundleId: redacted.bundleId },
            redacted,
            Date.parse("2026-06-17T12:00:03.000Z")
        );
        const revokeResponse = revokeBrokerBundleResponse(
            { type: "revoke-fill-bundle", protocolVersion: 1, planId: pendingPlan.planId, bundleId: redacted.bundleId },
            redacted
        );

        expect(applyResponse.ok).to.equal(true);
        expect(applyResponse.audit.operation).to.equal("apply-fill-bundle");
        expect(revokeResponse.ok).to.equal(true);
        expect(revokeResponse.audit.operation).to.equal("revoke-fill-bundle");
        expect(JSON.stringify(applyResponse)).not.to.contain("sentinel@example.test");
        expect(JSON.stringify(revokeResponse)).not.to.contain("4111111111111111");
    });

    mochaTest("rejects applying after bundle expiry", async () => {
        const { pendingPlan } = buildUnlockedBrokerPlanResponse(request, items(), Date.parse("2026-06-17T12:00:00.000Z"));
        const { approval } = approveBrokerPlanResponse(
            { type: "approve", protocolVersion: 1, planId: pendingPlan.planId, approved: true, ttlSeconds: 1 },
            pendingPlan,
            Date.parse("2026-06-17T12:00:00.000Z")
        );
        const bundleResponse = await mintBrokerBundleResponse(
            { type: "mint-fill-bundle", protocolVersion: 1, planId: pendingPlan.planId, approvalId: approval.approvalId },
            pendingPlan,
            approval,
            items(),
            Date.parse("2026-06-17T12:00:00.000Z")
        );

        expect(() => applyBrokerBundleResponse(
            { type: "apply-fill-bundle", protocolVersion: 1, planId: pendingPlan.planId, bundleId: bundleResponse.bundleId },
            bundleResponse,
            Date.parse("2026-06-17T12:00:02.000Z")
        )).to.throw("expired");
    });
});

function items() {
    const person = {
        id: "person",
        name: "Person",
        fields: [
            makeField({ name: "Email", value: "sentinel@example.test", autofillRole: "contact.email" }),
        ],
    };
    const card = {
        id: "card",
        name: "Card",
        fields: [
            makeField({ name: "Card Number", value: "4111111111111111", autofillRole: "payment.card.pan" }),
            makeField({ name: "CVC", value: "123", autofillRole: "payment.card.cvv_transient", transactionOnly: true }),
        ],
    };
    return [{ item: person }, { item: card }];
}

function readRole(candidate: { role: string }) {
    return candidate.role;
}

function makeField(values: { name: string; value: string; autofillRole: string; transactionOnly?: boolean }) {
    return {
        transactionOnly: false,
        async transform() {
            return this.value;
        },
        ...values,
    };
}
