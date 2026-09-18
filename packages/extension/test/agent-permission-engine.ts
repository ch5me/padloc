import { expect } from "chai";
import {
    AgentPermissionEvaluationInput,
    AgentPermissionRequest,
    AgentStandingPolicy,
    beginAgentGrantUse,
    completeAgentGrantUse,
    createAgentGrantRecord,
    evaluateAgentPermission,
    mapUserFacingAgentApprovalMode,
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

    test("maps user-facing modes and rejects bypassPrompts as an external mode", () => {
        expect(mapUserFacingAgentApprovalMode("plan-only")).to.equal("plan");
        expect(mapUserFacingAgentApprovalMode("prompted")).to.equal("manual");
        expect(mapUserFacingAgentApprovalMode("standing-policy-automatic")).to.equal("auto");
        expect(mapUserFacingAgentApprovalMode("noninteractive")).to.equal("dontAsk");

        const decision = evaluateAgentPermission(evaluation({ mode: "bypassPrompts" }));
        expect(decision).to.include({ outcome: "deny", reasonCode: "DENY_INTERNAL_MODE" });
    });

    test("plan mode allows descriptions only", () => {
        const described = request({ operation: "describe" });
        expect(evaluateAgentPermission(evaluation({ mode: "plan", request: described }))).to.include({
            outcome: "allow",
            reasonCode: "ALLOW_PLAN_DESCRIPTION",
        });
        expect(evaluateAgentPermission(evaluation({ mode: "plan", request: request() }))).to.include({
            outcome: "deny",
            reasonCode: "DENY_PLAN_MODE",
        });
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

    test("requires fresh verification for high-risk roles, passkeys, new origins, and policy changes", () => {
        const cases: AgentPermissionRequest[] = [
            request({
                bindings: [binding("source-ssn", "field-ssn", "profile", "government.ssn")],
            }),
            request({ securityContext: { passkey: true } }),
            request({ securityContext: { newPaymentOrigin: true } }),
            request({ securityContext: { policyChange: true } }),
        ];
        for (const protectedRequest of cases) {
            const policyForRequest = policy({
                sourceRefs: protectedRequest.bindings.map((entry) => entry.sourceRef),
                fieldRefs: protectedRequest.bindings.map((entry) => entry.fieldRef || ""),
                ...(protectedRequest.bindings.some((entry) => entry.role)
                    ? { roles: protectedRequest.bindings.map((entry) => entry.role || "").filter(Boolean) }
                    : {}),
            });
            const manual = evaluateAgentPermission(
                evaluation({ request: protectedRequest, policies: [policyForRequest] })
            );
            expect(manual).to.include({ outcome: "ask", reasonCode: "ASK_CONFIRMATION_REQUIRED" });

            const confirmed = evaluateAgentPermission(
                evaluation({
                    request: protectedRequest,
                    policies: [policyForRequest],
                    confirmedRequestDigest: permissionRequestDigest(protectedRequest),
                })
            );
            expect(confirmed.outcome).to.equal("allow");

            const dontAsk = evaluateAgentPermission(
                evaluation({ mode: "dontAsk", request: protectedRequest, policies: [policyForRequest] })
            );
            expect(dontAsk).to.include({ outcome: "deny", reasonCode: "DENY_CONFIRMATION_REQUIRED" });
        }
    });

    test("always-ask and hard-deny policies override an allow policy", () => {
        const alwaysAsk = evaluateAgentPermission(
            evaluation({
                policies: [policy(), policy({ id: "ask", effect: "alwaysAsk", revision: 7 })],
                confirmedRequestDigest: permissionRequestDigest(request()),
            })
        );
        expect(alwaysAsk).to.include({ outcome: "ask", reasonCode: "ASK_ALWAYS" });

        const hardDeny = evaluateAgentPermission(
            evaluation({ policies: [policy(), policy({ id: "deny", effect: "deny", revision: 7 })] })
        );
        expect(hardDeny).to.include({ outcome: "deny", reasonCode: "DENY_HARD_POLICY" });
    });

    test("does not infer submit authority from a fill policy", () => {
        const submit = request({ operation: "submit", bindings: [] });
        const manual = evaluateAgentPermission(evaluation({ request: submit }));
        expect(manual).to.include({ outcome: "ask", reasonCode: "ASK_MISSING_AUTHORITY" });
        const dontAsk = evaluateAgentPermission(evaluation({ mode: "dontAsk", request: submit }));
        expect(dontAsk).to.include({ outcome: "deny", reasonCode: "DENY_MISSING_AUTHORITY" });
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
        expect(() =>
            reserveAgentGrantUse(freshRecord, "offline", {
                ...current,
                onlineAuthorityCurrent: false,
            })
        ).to.throw("online authority");
        expect(() =>
            reserveAgentGrantUse(freshRecord, "expired", {
                ...current,
                now: Date.parse("2026-09-18T12:06:00.000Z"),
            })
        ).to.throw("expired");
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

    test("invalidates grants after lock and service-worker restart", () => {
        const input = evaluation({ currentSessionGeneration: 4, currentRestartGeneration: 9 });
        const grant = mintAgentExecutionGrant(input, evaluateAgentPermission(input), "grant-lifecycle");
        const record = createAgentGrantRecord(grant);
        const context = {
            now: input.now + 1,
            currentPolicyRevision: grant.policyRevision,
            currentRevocationGeneration: grant.revocationGeneration,
            onlineAuthorityCurrent: true,
            currentSessionGeneration: 4,
            currentRestartGeneration: 9,
        };
        expect(() => reserveAgentGrantUse(record, "locked", { ...context, vaultState: "locked" })).to.throw(
            "locked"
        );
        expect(() =>
            reserveAgentGrantUse(record, "restarted-session", { ...context, currentSessionGeneration: 5 })
        ).to.throw("restarted session");
        expect(() =>
            reserveAgentGrantUse(record, "restarted-worker", { ...context, currentRestartGeneration: 10 })
        ).to.throw("restarted worker");
    });

    test("fails closed on unknown roles", () => {
        const invalid = request({
            bindings: [binding("source-unknown", "field-unknown", "profile", "government.tax_secret")],
        });
        expect(isAgentPermissionRequest(invalid)).to.equal(false);
        expect(evaluateAgentPermission(evaluation({ request: invalid }))).to.include({
            outcome: "deny",
            reasonCode: "DENY_INVALID_REQUEST",
        });
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
    dataClass: AgentPermissionRequest["bindings"][number]["dataClass"] = "profile",
    role?: string
) {
    return { sourceRef, fieldRef, dataClass, ...(role ? { role } : {}) };
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
