import { expect } from "chai";
import {
    AgentPermissionEvaluationInput,
    AgentPermissionRequest,
    AgentStandingPolicy,
    beginAgentGrantUse,
    completeAgentGrantUse,
    createAgentGrantRecord,
    evaluateAgentPermission,
    isAgentPermissionRequest,
    mintAgentExecutionGrant,
    permissionRequestDigest,
    reserveAgentGrantUse,
} from "../src/agent-permission-engine";

suite("Agent permission engine", () => {
    test("allows only an exact standing-policy cross product", () => {
        const input = evaluation();
        const decision = evaluateAgentPermission(input);
        expect(decision.outcome).to.equal("allow");
        expect(decision.reasonCode).to.equal("ALLOW_MATCHED_POLICY");

        const widened = evaluation({
            request: request({
                bindings: [binding("source-person", "field-email"), binding("source-address", "field-postal")],
            }),
        });
        const widenedDecision = evaluateAgentPermission(widened);
        expect(widenedDecision.outcome).to.equal("ask");
        expect(widenedDecision.reasonCode).to.equal("ASK_MISSING_AUTHORITY");
    });

    test("preserves hard denies in bypassPrompts mode", () => {
        const secretReveal = request({
            operation: "reveal",
            representation: "exact",
            recipient: { kind: "model-route", routeId: "codex/gpt-test", routeRevision: 3 },
            target: undefined,
            bindings: [binding("source-login", "field-password", "authentication-secret")],
            enforcement: {
                localExecutorOnly: false,
                allowModelDisclosure: true,
                requiresFreshUserConfirmation: false,
                revocationMode: "online-required",
            },
        });
        const decision = evaluateAgentPermission(evaluation({ mode: "bypassPrompts", request: secretReveal }));
        expect(decision).to.include({ outcome: "deny", reasonCode: "DENY_AUTH_SECRET_REVEAL" });
    });

    test("never treats missing authority as implicit bypass permission", () => {
        const decision = evaluateAgentPermission(evaluation({ mode: "bypassPrompts", policies: [] }));
        expect(decision).to.include({ outcome: "deny", reasonCode: "DENY_MISSING_AUTHORITY" });
    });

    test("requires exact origins and a concrete browser target", () => {
        const invalid = request({
            principal: { userId: "user-1", sessionId: "session-1", initiatingOrigin: "https://shop.example/path" },
        });
        const decision = evaluateAgentPermission(evaluation({ request: invalid }));
        expect(decision).to.include({ outcome: "deny", reasonCode: "DENY_INVALID_REQUEST" });
    });

    test("runtime-validates malformed external requests without throwing", () => {
        expect(isAgentPermissionRequest({ operation: "fill" })).to.equal(false);
        const decision = evaluateAgentPermission(
            evaluation({ request: { operation: "fill" } as AgentPermissionRequest })
        );
        expect(decision).to.include({ outcome: "deny", reasonCode: "DENY_INVALID_REQUEST" });
    });

    test("requires digest-bound confirmation without letting dontAsk pause", () => {
        const protectedRequest = request({
            enforcement: {
                localExecutorOnly: true,
                allowModelDisclosure: false,
                requiresFreshUserConfirmation: true,
                revocationMode: "online-required",
            },
        });
        const manual = evaluateAgentPermission(evaluation({ request: protectedRequest }));
        expect(manual).to.include({ outcome: "ask", reasonCode: "ASK_CONFIRMATION_REQUIRED" });

        const dontAsk = evaluateAgentPermission(evaluation({ mode: "dontAsk", request: protectedRequest }));
        expect(dontAsk).to.include({ outcome: "deny", reasonCode: "DENY_CONFIRMATION_REQUIRED" });

        const confirmed = evaluateAgentPermission(
            evaluation({ request: protectedRequest, confirmedRequestDigest: permissionRequestDigest(protectedRequest) })
        );
        expect(confirmed.outcome).to.equal("allow");
    });

    test("rejects stale policy, revocation, lease, and use-count state before release", () => {
        const input = evaluation();
        const decision = evaluateAgentPermission(input);
        const grant = mintAgentExecutionGrant(input, decision, "grant-1");
        let record = createAgentGrantRecord(grant);
        const current = {
            now: input.now + 1,
            currentPolicyRevision: grant.policyRevision,
            currentRevocationGeneration: grant.revocationGeneration,
            onlineAuthorityCurrent: true,
        };

        record = reserveAgentGrantUse(record, "attempt-1", current);
        expect(() => reserveAgentGrantUse(record, "attempt-2", current)).to.throw("use limit");
        record = beginAgentGrantUse(record, "attempt-1");
        record = completeAgentGrantUse(record, "attempt-1", "completed");
        expect(record.status).to.equal("completed");
        expect(record.completedUses).to.equal(1);

        const freshRecord = createAgentGrantRecord(grant);
        expect(() =>
            reserveAgentGrantUse(freshRecord, "stale-policy", {
                ...current,
                currentPolicyRevision: current.currentPolicyRevision + 1,
            })
        ).to.throw("policy is stale");
        expect(() =>
            reserveAgentGrantUse(freshRecord, "revoked", {
                ...current,
                currentRevocationGeneration: current.currentRevocationGeneration + 1,
            })
        ).to.throw("revoked by generation");
    });

    test("makes repeat reservation of the same attempt idempotent", () => {
        const input = evaluation();
        const grant = mintAgentExecutionGrant(input, evaluateAgentPermission(input), "grant-idempotent");
        const record = createAgentGrantRecord(grant);
        const current = {
            now: input.now + 1,
            currentPolicyRevision: grant.policyRevision,
            currentRevocationGeneration: grant.revocationGeneration,
            onlineAuthorityCurrent: true,
        };
        const first = reserveAgentGrantUse(record, "attempt-1", current);
        const replay = reserveAgentGrantUse(first, "attempt-1", current);
        expect(replay.reservedUses).to.equal(1);
        expect(replay.reservations["attempt-1"]).to.equal("reserved");
    });

    test("prevents delegated grants from widening recipient, data, or expiry", () => {
        const parentInput = evaluation();
        const parent = mintAgentExecutionGrant(parentInput, evaluateAgentPermission(parentInput), "parent");
        const childRequest = request({ expiresAt: "2026-09-18T12:06:00.000Z" });
        const decision = evaluateAgentPermission(evaluation({ request: childRequest, parentGrant: parent }));
        expect(decision).to.include({ outcome: "deny", reasonCode: "DENY_PARENT_SCOPE" });
    });
});

function evaluation(overrides: Partial<AgentPermissionEvaluationInput> = {}): AgentPermissionEvaluationInput {
    return {
        mode: "manual",
        request: request(),
        policies: [policy()],
        now: Date.parse("2026-09-18T12:00:00.000Z"),
        currentPolicyRevision: 7,
        currentRevocationGeneration: 2,
        onlineAuthorityCurrent: true,
        ...overrides,
    };
}

function request(overrides: Partial<AgentPermissionRequest> = {}): AgentPermissionRequest {
    return {
        principal: { userId: "user-1", sessionId: "session-1", initiatingOrigin: "https://shop.example" },
        operation: "fill",
        bindings: [binding("source-person", "field-email")],
        recipient: { kind: "page", topOrigin: "https://shop.example", frameOrigin: "https://shop.example" },
        target: { tabId: 42, frameId: 0, documentId: "document-1", formRef: "form-checkout", targetRevision: "rev-1" },
        representation: "action-only",
        expiresAt: "2026-09-18T12:05:00.000Z",
        maxUses: 1,
        enforcement: {
            localExecutorOnly: true,
            allowModelDisclosure: false,
            requiresFreshUserConfirmation: false,
            revocationMode: "online-required",
        },
        ...overrides,
    };
}

function binding(
    sourceRef: string,
    fieldRef: string,
    dataClass: AgentPermissionRequest["bindings"][number]["dataClass"] = "profile"
) {
    return { sourceRef, fieldRef, dataClass };
}

function policy(overrides: Partial<AgentStandingPolicy> = {}): AgentStandingPolicy {
    return {
        id: "policy-1",
        revision: 7,
        revocationGeneration: 2,
        status: "active",
        effect: "allow",
        operations: ["fill"],
        initiatingOrigins: ["https://shop.example"],
        sourceRefs: ["source-person"],
        fieldRefs: ["field-email"],
        recipients: [{ kind: "page", topOrigin: "https://shop.example", frameOrigin: "https://shop.example" }],
        representations: ["action-only"],
        ...overrides,
    };
}
