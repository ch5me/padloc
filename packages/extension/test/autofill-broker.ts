// @ts-nocheck
const { expect } = require("chai");
const { suite: mochaSuite, test: mochaTest } = require("mocha");
const requireModule = require;
const {
    applyBrokerBundleResponse,
    approveBrokerPlanResponse,
    buildBrokerStatusResponse,
    buildUnsupportedBrokerOperationResponse,
    buildUnlockedBrokerPlanResponse,
    completeBrokerBundleFieldUse,
    mintBrokerBundleResponse,
    reserveBrokerBundleFieldUse,
    resolveBrokerBundleFieldValue,
    revokeBrokerBundleResponse,
} = requireModule("../src/autofill-broker");

mochaSuite("Autofill broker", () => {
    mochaTest("reports unlocked status only for a logged-in unlocked app", () => {
        const response = buildBrokerStatusResponse(
            { type: "status", protocolVersion: 1, requestId: "req-status-unlocked" },
            { locked: false, loggedIn: true }
        );

        expect(response.ok).to.equal(true);
        expect(response.vaultState).to.equal("unlocked");
        expect(response.reason).to.equal(null);
        expect(response.audit.operation).to.equal("status");
    });

    mochaTest("keeps status locked for locked or logged-out apps", () => {
        for (const state of [
            { locked: true, loggedIn: true },
            { locked: false, loggedIn: false },
        ]) {
            const response = buildBrokerStatusResponse(
                { type: "status", protocolVersion: 1, requestId: "req-status-locked" },
                state
            );

            expect(response.ok).to.equal(true);
            expect(response.vaultState).to.equal("locked");
            expect(response.reason).to.equal(null);
        }
    });

    mochaTest("fails closed for reveal and submit until separate grants exist", () => {
        const reveal = buildUnsupportedBrokerOperationResponse({
            type: "request-reveal",
            protocolVersion: 1,
            requestId: "reveal-1",
            binding: { sessionId: "session-1", origin: "https://checkout.example.test" },
        });
        const submit = buildUnsupportedBrokerOperationResponse({
            type: "submit",
            protocolVersion: 1,
            requestId: "submit-1",
            binding: { sessionId: "session-1", origin: "https://checkout.example.test" },
        });
        expect(reveal).to.include({ ok: false });
        expect(reveal.audit.reasonCode).to.equal("DENY_REVEAL_UNSUPPORTED");
        expect(submit.audit.reasonCode).to.equal("DENY_SUBMIT_REQUIRES_SEPARATE_GRANT");
        expect(JSON.stringify({ reveal, submit })).not.to.contain("sentinel@example.test");
    });

    mochaTest("plans with opaque references and no vault or selector metadata", () => {
        const { response, pendingPlan } = makePlan();
        const serialized = JSON.stringify(response);

        expect(response.ok).to.equal(true);
        expect(response.vaultState).to.equal("unlocked");
        expect(response.fields.map(readRole)).to.deep.equal([
            "contact.email",
            "payment.card.pan",
            "payment.card.cvv_transient",
        ]);
        expect(response.fields[0].fieldRef).to.match(/^field-/);
        expect(response.fields[0].sourceRef).to.match(/^source_/);
        expect(response.fields[2].transactionOnly).to.equal(true);
        expect(serialized).not.to.contain("#email");
        expect(serialized).not.to.contain("Person");
        expect(serialized).not.to.contain("Email");
        expect(serialized).not.to.contain("sentinel@example.test");
        expect(serialized).not.to.contain("4111111111111111");
        expect(serialized).not.to.contain("123");
        expect(pendingPlan.fields[1].valuePreview).to.equal("card:1111");
    });

    mochaTest("mints a grant without resolving values, then resolves one reserved field locally", async () => {
        const { pendingPlan } = makePlan();
        const { approval } = approve(pendingPlan);
        const { response, bundle: minted } = mintBrokerBundleResponse(
            {
                type: "mint-fill-bundle",
                protocolVersion: 1,
                planId: pendingPlan.planId,
                approvalId: approval.approvalId,
            },
            pendingPlan,
            approval,
            time("12:00:02")
        );
        const field = minted.fields[0];
        const bundle = reserveBrokerBundleFieldUse(minted, field.fieldRef, "attempt-1", time("12:00:03"));
        const value = await resolveBrokerBundleFieldValue(bundle, field.fieldRef, items());

        expect(response.grantId).to.match(/^grant_/);
        expect(response.bundleId).to.equal(minted.bundleId);
        expect(JSON.stringify(response)).not.to.contain("sentinel@example.test");
        expect(JSON.stringify(response)).not.to.contain("#email");
        expect(value).to.equal("sentinel@example.test");
        expect(bundle.grantRecord.reservations["attempt-1"]).to.equal("executing");
    });

    mochaTest("requires reservation before resolving and never resolves two values concurrently", async () => {
        const { pendingPlan } = makePlan();
        const { approval } = approve(pendingPlan);
        const { bundle: minted } = mintBrokerBundleResponse(
            {
                type: "mint-fill-bundle",
                protocolVersion: 1,
                planId: pendingPlan.planId,
                approvalId: approval.approvalId,
            },
            pendingPlan,
            approval,
            time("12:00:02")
        );
        let rejected = false;
        try {
            await resolveBrokerBundleFieldValue(minted, minted.fields[0].fieldRef, items());
        } catch {
            rejected = true;
        }
        expect(rejected).to.equal(true);
        const first = reserveBrokerBundleFieldUse(minted, minted.fields[0].fieldRef, "attempt-1", time("12:00:03"));
        expect(() =>
            reserveBrokerBundleFieldUse(first, minted.fields[1].fieldRef, "attempt-2", time("12:00:03"))
        ).to.throw();
    });

    mochaTest("rechecks use limits for every field and returns receipt-only completion", async () => {
        const { pendingPlan } = makePlan();
        const { approval } = approve(pendingPlan);
        let { bundle } = mintBrokerBundleResponse(
            {
                type: "mint-fill-bundle",
                protocolVersion: 1,
                planId: pendingPlan.planId,
                approvalId: approval.approvalId,
            },
            pendingPlan,
            approval,
            time("12:00:02")
        );
        const filled = [];
        for (const [index, field] of bundle.fields.entries()) {
            const attemptId = `attempt-${index}`;
            bundle = reserveBrokerBundleFieldUse(bundle, field.fieldRef, attemptId, time("12:00:03"));
            await resolveBrokerBundleFieldValue(bundle, field.fieldRef, items());
            bundle = completeBrokerBundleFieldUse(bundle, attemptId, "completed");
            filled.push(field.fieldRef);
        }
        const response = applyBrokerBundleResponse(
            { type: "apply-fill-bundle", protocolVersion: 1, planId: pendingPlan.planId, bundleId: bundle.bundleId },
            bundle,
            filled,
            "completed",
            time("12:00:04")
        );

        expect(bundle.grantRecord.status).to.equal("completed");
        expect(bundle.grantRecord.completedUses).to.equal(3);
        expect(response.receipt.status).to.equal("completed");
        expect(response.receipt.filledFieldRefs).to.deep.equal(filled);
        expect(response.receipt.modelDisclosure).to.equal("none");
        expect(response.receipt.submittedByExecutor).to.equal(false);
        expect(JSON.stringify(response)).not.to.contain("sentinel@example.test");
    });

    mochaTest("rejects the wrong browser origin or frame binding", () => {
        expect(() =>
            buildUnlockedBrokerPlanResponse(
                { ...request, binding: { ...request.binding, origin: "https://evil.example.test" } },
                items(),
                target,
                inspectedFields,
                principal,
                time("12:00:00")
            )
        ).to.throw("origin");
        expect(() =>
            buildUnlockedBrokerPlanResponse(
                { ...request, binding: { ...request.binding, frameId: 3 } },
                items(),
                target,
                inspectedFields,
                principal,
                time("12:00:00")
            )
        ).to.throw("frame");
    });

    mochaTest("rejects minting after approval expiry", () => {
        const { pendingPlan } = makePlan();
        const { approval } = approveBrokerPlanResponse(
            { type: "approve", protocolVersion: 1, planId: pendingPlan.planId, approved: true, ttlSeconds: 1 },
            pendingPlan,
            time("12:00:01")
        );
        expect(() =>
            mintBrokerBundleResponse(
                {
                    type: "mint-fill-bundle",
                    protocolVersion: 1,
                    planId: pendingPlan.planId,
                    approvalId: approval.approvalId,
                },
                pendingPlan,
                approval,
                time("12:00:03")
            )
        ).to.throw("expired");
    });

    mochaTest("revokes an unused grant without returning values", () => {
        const { pendingPlan } = makePlan();
        const { approval } = approve(pendingPlan);
        const { bundle } = mintBrokerBundleResponse(
            {
                type: "mint-fill-bundle",
                protocolVersion: 1,
                planId: pendingPlan.planId,
                approvalId: approval.approvalId,
            },
            pendingPlan,
            approval,
            time("12:00:02")
        );
        const revoked = revokeBrokerBundleResponse(
            { type: "revoke-fill-bundle", protocolVersion: 1, planId: pendingPlan.planId, bundleId: bundle.bundleId },
            bundle
        );
        expect(revoked.bundle.grantRecord.status).to.equal("revoked");
        expect(revoked.response.receipt.status).to.equal("revoked");
        expect(JSON.stringify(revoked.response)).not.to.contain("4111111111111111");
    });

    mochaTest("rejects applying after bundle expiry", () => {
        const { pendingPlan } = makePlan();
        const { approval } = approveBrokerPlanResponse(
            { type: "approve", protocolVersion: 1, planId: pendingPlan.planId, approved: true, ttlSeconds: 1 },
            pendingPlan,
            time("12:00:00")
        );
        const { bundle } = mintBrokerBundleResponse(
            {
                type: "mint-fill-bundle",
                protocolVersion: 1,
                planId: pendingPlan.planId,
                approvalId: approval.approvalId,
            },
            pendingPlan,
            approval,
            time("12:00:00")
        );
        expect(() =>
            applyBrokerBundleResponse(
                {
                    type: "apply-fill-bundle",
                    protocolVersion: 1,
                    planId: pendingPlan.planId,
                    bundleId: bundle.bundleId,
                },
                bundle,
                [],
                "outcome-unknown",
                time("12:00:02")
            )
        ).to.throw("expired");
    });
});

const request = {
    type: "plan-fill",
    protocolVersion: 1,
    requestId: "req-1",
    binding: {
        sessionId: "session-1",
        origin: "https://checkout.example.test",
        frameId: 0,
    },
    fields: [
        { selector: "#email", role: "contact.email" },
        { selector: "#card", role: "payment.card.pan" },
        { selector: "#cvv", role: "payment.card.cvv_transient" },
    ],
};

const target = {
    tabId: 42,
    frameId: 0,
    documentId: "document-1",
    formRef: "form-1",
    targetRevision: "revision-1",
    topOrigin: "https://checkout.example.test",
    frameOrigin: "https://checkout.example.test",
};

const inspectedFields = [
    { selector: "#email", role: "contact.email", fieldRef: "field-email" },
    { selector: "#card", role: "payment.card.pan", fieldRef: "field-card" },
    { selector: "#cvv", role: "payment.card.cvv_transient", fieldRef: "field-cvv" },
];

const principal = { userId: "account-1", sessionId: "vault-session-1" };

function makePlan() {
    return buildUnlockedBrokerPlanResponse(request, items(), target, inspectedFields, principal, time("12:00:00"));
}

function approve(pendingPlan) {
    return approveBrokerPlanResponse(
        { type: "approve", protocolVersion: 1, planId: pendingPlan.planId, approved: true, ttlSeconds: 60 },
        pendingPlan,
        time("12:00:01")
    );
}

function time(clock: string) {
    return Date.parse(`2026-09-18T${clock}.000Z`);
}

function items() {
    const person = {
        id: "person",
        name: "Person",
        fields: [makeField({ name: "Email", value: "sentinel@example.test", autofillRole: "contact.email" })],
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
