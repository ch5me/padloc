import type { Field, VaultItem } from "@padloc/core/src/item";
import {
    AgentDataClass,
    AgentExecutionGrantRecord,
    AgentPermissionRequest,
    AgentStandingPolicy,
    beginAgentGrantUse,
    completeAgentGrantUse,
    createAgentGrantRecord,
    evaluateAgentPermission,
    mintAgentExecutionGrant,
    permissionRequestDigest,
    reserveAgentGrantUse,
    revokeAgentGrant,
} from "./agent-permission-engine";
import {
    AUTOFILL_BROKER_PROTOCOL_VERSION,
    AutofillBrokerInspectedField,
    AutofillBrokerPlanField,
    AutofillBrokerRequest,
    AutofillBrokerResponse,
    AutofillBrokerTarget,
    buildLockedBrokerResponse,
    buildUnlockedBrokerStatusResponse,
} from "./autofill-broker-protocol";

export interface BrokerItemSource {
    item: VaultItem;
}

export interface BrokerPrincipal {
    userId: string;
    sessionId: string;
    agentId?: string;
    runtimeId?: string;
}

export interface PendingBrokerPlanField extends AutofillBrokerPlanField {
    selector: string;
    itemId: string;
    itemName: string;
    fieldIndex: number;
    fieldName: string;
    valuePreview: string;
    dataClass: AgentDataClass;
}

export interface PendingBrokerPlan {
    planId: string;
    request: AutofillBrokerRequest;
    target: AutofillBrokerTarget;
    fields: PendingBrokerPlanField[];
    permissionRequest: AgentPermissionRequest;
    createdAt: number;
}

export interface BrokerApproval {
    approvalId: string;
    planId: string;
    approvedAt: number;
    expiresAt: number;
    policyRevision: number;
    revocationGeneration: number;
    confirmedRequestDigest: string;
    authorityPolicyId?: string;
}

export interface PendingBrokerBundleField extends PendingBrokerPlanField {}

export interface PendingBrokerBundle {
    bundleId: string;
    planId: string;
    approvalId: string;
    target: AutofillBrokerTarget;
    expiresAt: number;
    fields: PendingBrokerBundleField[];
    grantRecord: AgentExecutionGrantRecord;
}

export function buildBrokerStatusResponse(
    request: AutofillBrokerRequest,
    state: { locked: boolean; loggedIn: boolean }
): AutofillBrokerResponse {
    if (state.locked || !state.loggedIn) {
        return buildLockedBrokerResponse(request);
    }
    return buildUnlockedBrokerStatusResponse(request);
}

export function buildUnlockedBrokerPlanResponse(
    request: AutofillBrokerRequest,
    items: BrokerItemSource[],
    target: AutofillBrokerTarget,
    inspectedFields: AutofillBrokerInspectedField[],
    principal: BrokerPrincipal,
    now = Date.now()
): { response: AutofillBrokerResponse; pendingPlan: PendingBrokerPlan } {
    const binding = requireBinding(request);
    assertRequestMatchesTarget(binding.origin, binding.frameId, target);
    const fields = collectMatchingFields(items, inspectedFields);
    if (fields.length === 0) throw new Error("Autofill plan has no authorized field matches");
    const planId = opaqueId("plan");
    const permissionRequest = buildFillPermissionRequest(request, target, fields, principal, now);
    const pendingPlan = { planId, request, target, fields, permissionRequest, createdAt: now };
    return {
        pendingPlan,
        response: {
            ok: true,
            protocolVersion: AUTOFILL_BROKER_PROTOCOL_VERSION,
            requestId: request.requestId,
            vaultState: "unlocked",
            reason: null,
            planId,
            target,
            fields: fields.map(publicPlanField),
            audit: audit("plan-fill", request, fields.length, { reasonCode: "ASK_MISSING_AUTHORITY" }),
        },
    };
}

export function approveBrokerPlanResponse(
    request: AutofillBrokerRequest,
    pendingPlan: PendingBrokerPlan,
    now = Date.now(),
    authority: { policyRevision: number; revocationGeneration: number; policyId?: string } = {
        policyRevision: 1,
        revocationGeneration: 0,
    }
): { response: AutofillBrokerResponse; approval: BrokerApproval } {
    if (request.planId !== pendingPlan.planId) throw new Error("Autofill approval plan mismatch");
    if (request.approved !== true) throw new Error("Autofill approval requires user approval");
    const ttlMs = Math.max(1, request.ttlSeconds || 120) * 1000;
    const expiresAt = Math.min(now + ttlMs, Date.parse(pendingPlan.permissionRequest.expiresAt));
    const approval = {
        approvalId: opaqueId("approval"),
        planId: pendingPlan.planId,
        approvedAt: now,
        expiresAt,
        policyRevision: authority.policyRevision,
        revocationGeneration: authority.revocationGeneration,
        confirmedRequestDigest: permissionRequestDigest({
            ...pendingPlan.permissionRequest,
            expiresAt: new Date(expiresAt).toISOString(),
        }),
        authorityPolicyId: authority.policyId,
    };
    return {
        approval,
        response: {
            ok: true,
            protocolVersion: AUTOFILL_BROKER_PROTOCOL_VERSION,
            requestId: request.requestId,
            vaultState: "unlocked",
            reason: null,
            planId: pendingPlan.planId,
            approvalId: approval.approvalId,
            expiresAt: new Date(approval.expiresAt).toISOString(),
            audit: audit("approve", pendingPlan.request, pendingPlan.fields.length, {
                decision: "allow",
                approvalId: approval.approvalId,
            }),
        },
    };
}

export function mintBrokerBundleResponse(
    request: AutofillBrokerRequest,
    pendingPlan: PendingBrokerPlan,
    approval: BrokerApproval,
    now = Date.now()
): { response: AutofillBrokerResponse; bundle: PendingBrokerBundle } {
    if (request.planId !== pendingPlan.planId) throw new Error("Autofill bundle plan mismatch");
    if (request.approvalId !== approval.approvalId) throw new Error("Autofill bundle approval mismatch");
    if (approval.expiresAt <= now) throw new Error("Autofill approval expired");

    const permissionRequest: AgentPermissionRequest = {
        ...pendingPlan.permissionRequest,
        expiresAt: new Date(approval.expiresAt).toISOString(),
    };
    const policy = approvalPolicy(pendingPlan, approval);
    const evaluationInput = {
        mode: "manual" as const,
        request: permissionRequest,
        policies: [policy],
        now,
        currentPolicyRevision: approval.policyRevision,
        currentRevocationGeneration: approval.revocationGeneration,
        onlineAuthorityCurrent: true,
        confirmedRequestDigest: approval.confirmedRequestDigest,
    };
    if (permissionRequestDigest(permissionRequest) !== approval.confirmedRequestDigest) {
        throw new Error("Autofill approval does not match the execution request");
    }
    const decision = evaluateAgentPermission(evaluationInput);
    if (decision.outcome !== "allow") throw new Error(`Autofill permission denied: ${decision.reasonCode}`);
    const grant = mintAgentExecutionGrant(evaluationInput, decision, opaqueId("grant"));
    const bundleId = opaqueId("bundle");
    const bundle: PendingBrokerBundle = {
        bundleId,
        planId: pendingPlan.planId,
        approvalId: approval.approvalId,
        target: pendingPlan.target,
        expiresAt: approval.expiresAt,
        fields: pendingPlan.fields.map((field) => ({ ...field })),
        grantRecord: createAgentGrantRecord(grant),
    };
    return {
        bundle,
        response: {
            ok: true,
            protocolVersion: AUTOFILL_BROKER_PROTOCOL_VERSION,
            requestId: request.requestId,
            vaultState: "unlocked",
            reason: null,
            planId: pendingPlan.planId,
            approvalId: approval.approvalId,
            bundleId,
            grantId: grant.id,
            expiresAt: new Date(approval.expiresAt).toISOString(),
            target: pendingPlan.target,
            audit: audit("mint-fill-bundle", pendingPlan.request, pendingPlan.fields.length, {
                decision: "allow",
                approvalId: approval.approvalId,
                grantId: grant.id,
                reasonCode: decision.reasonCode,
            }),
        },
    };
}

export function reserveBrokerBundleFieldUse(
    bundle: PendingBrokerBundle,
    fieldRef: string,
    attemptId: string,
    now = Date.now(),
    authority: { policyRevision: number; revocationGeneration: number; onlineAuthorityCurrent: boolean } = {
        policyRevision: bundle.grantRecord.grant.policyRevision,
        revocationGeneration: bundle.grantRecord.grant.revocationGeneration,
        onlineAuthorityCurrent: true,
    }
): PendingBrokerBundle {
    if (!bundle.fields.some((field) => field.fieldRef === fieldRef))
        throw new Error("Autofill field reference not found");
    return {
        ...bundle,
        grantRecord: beginAgentGrantUse(
            reserveAgentGrantUse(bundle.grantRecord, attemptId, {
                now,
                currentPolicyRevision: authority.policyRevision,
                currentRevocationGeneration: authority.revocationGeneration,
                onlineAuthorityCurrent: authority.onlineAuthorityCurrent,
            }),
            attemptId
        ),
    };
}

export async function resolveBrokerBundleFieldValue(
    bundle: PendingBrokerBundle,
    fieldRef: string,
    items: BrokerItemSource[]
): Promise<string> {
    const planned = bundle.fields.find((field) => field.fieldRef === fieldRef);
    if (!planned) throw new Error("Autofill field reference not found");
    const source = items.find(({ item }) => item.id === planned.itemId)?.item.fields[planned.fieldIndex];
    if (!source) throw new Error("Autofill field source missing");
    return source.transform();
}

export function completeBrokerBundleFieldUse(
    bundle: PendingBrokerBundle,
    attemptId: string,
    outcome: "completed" | "partial" | "outcome-unknown"
): PendingBrokerBundle {
    return { ...bundle, grantRecord: completeAgentGrantUse(bundle.grantRecord, attemptId, outcome) };
}

export function applyBrokerBundleResponse(
    request: AutofillBrokerRequest,
    bundle: PendingBrokerBundle,
    filledFieldRefs: string[],
    status: "completed" | "partial" | "outcome-unknown",
    now = Date.now()
): AutofillBrokerResponse {
    assertBundleRequest(request, bundle, now);
    const receiptId = opaqueId("receipt");
    return {
        ok: status === "completed",
        protocolVersion: AUTOFILL_BROKER_PROTOCOL_VERSION,
        requestId: request.requestId,
        vaultState: "unlocked",
        reason: status === "completed" ? null : "Autofill execution did not complete every approved field",
        planId: bundle.planId,
        approvalId: bundle.approvalId,
        bundleId: bundle.bundleId,
        grantId: bundle.grantRecord.grant.id,
        target: bundle.target,
        receipt: {
            receiptId,
            status,
            filledFieldRefs: [...filledFieldRefs],
            modelDisclosure: "none",
            submittedByExecutor: false,
        },
        audit: audit("apply-fill-bundle", request, filledFieldRefs.length, {
            grantId: bundle.grantRecord.grant.id,
            receiptId,
        }),
    };
}

export function revokeBrokerBundleResponse(
    request: AutofillBrokerRequest,
    bundle: PendingBrokerBundle
): { response: AutofillBrokerResponse; bundle: PendingBrokerBundle } {
    if (request.planId !== bundle.planId) throw new Error("Autofill revoke plan mismatch");
    if (request.bundleId !== bundle.bundleId) throw new Error("Autofill revoke bundle mismatch");
    const revokedBundle = { ...bundle, grantRecord: revokeAgentGrant(bundle.grantRecord) };
    const receiptId = opaqueId("receipt");
    return {
        bundle: revokedBundle,
        response: {
            ok: true,
            protocolVersion: AUTOFILL_BROKER_PROTOCOL_VERSION,
            requestId: request.requestId,
            vaultState: "unlocked",
            reason: null,
            planId: bundle.planId,
            approvalId: bundle.approvalId,
            bundleId: bundle.bundleId,
            grantId: bundle.grantRecord.grant.id,
            target: bundle.target,
            receipt: {
                receiptId,
                status: "revoked",
                filledFieldRefs: [],
                modelDisclosure: "none",
                submittedByExecutor: false,
            },
            audit: audit("revoke-fill-bundle", request, 0, {
                grantId: bundle.grantRecord.grant.id,
                receiptId,
            }),
        },
    };
}

export function redactBrokerResponse(response: AutofillBrokerResponse): AutofillBrokerResponse {
    return JSON.parse(JSON.stringify(response)) as AutofillBrokerResponse;
}

function collectMatchingFields(
    items: BrokerItemSource[],
    inspectedFields: AutofillBrokerInspectedField[]
): PendingBrokerPlanField[] {
    const matches: PendingBrokerPlanField[] = [];
    const seenFieldRefs = new Set<string>();
    for (const inspected of inspectedFields) {
        const requestedRole = normalizeRole(inspected.role);
        if (!requestedRole || !inspected.selector || !inspected.fieldRef || seenFieldRefs.has(inspected.fieldRef))
            continue;
        const match = findFirstFieldForRole(items, requestedRole);
        if (!match) continue;
        seenFieldRefs.add(inspected.fieldRef);
        matches.push({
            selector: inspected.selector,
            role: inspected.role || requestedRole,
            fieldRef: inspected.fieldRef,
            sourceRef: opaqueId("source"),
            itemId: match.item.id,
            itemName: match.item.name,
            fieldIndex: match.index,
            fieldName: match.field.name,
            valuePreview: previewValue(match.field, requestedRole),
            transactionOnly: Boolean(match.field.transactionOnly),
            dataClass: dataClassForRole(requestedRole),
        });
    }
    return matches;
}

function buildFillPermissionRequest(
    request: AutofillBrokerRequest,
    target: AutofillBrokerTarget,
    fields: PendingBrokerPlanField[],
    principal: BrokerPrincipal,
    now: number
): AgentPermissionRequest {
    return {
        principal: {
            userId: principal.userId,
            initiatingOrigin: target.topOrigin,
            sessionId: request.binding?.sessionId || principal.sessionId,
            agentId: principal.agentId,
            runtimeId: principal.runtimeId,
        },
        operation: "fill",
        bindings: fields.map((field) => ({
            sourceRef: field.sourceRef,
            fieldRef: field.fieldRef,
            dataClass: field.dataClass,
        })),
        recipient: { kind: "page", topOrigin: target.topOrigin, frameOrigin: target.frameOrigin },
        target: {
            tabId: target.tabId,
            frameId: target.frameId,
            documentId: target.documentId,
            formRef: target.formRef,
            targetRevision: target.targetRevision,
        },
        representation: "action-only",
        expiresAt: new Date(now + 2 * 60 * 1000).toISOString(),
        maxUses: fields.length,
        enforcement: {
            localExecutorOnly: true,
            allowModelDisclosure: false,
            requiresFreshUserConfirmation: true,
            revocationMode: "online-required",
        },
    };
}

function approvalPolicy(plan: PendingBrokerPlan, approval: BrokerApproval): AgentStandingPolicy {
    const permission = plan.permissionRequest;
    return {
        id: approval.authorityPolicyId || approval.approvalId,
        revision: approval.policyRevision,
        revocationGeneration: approval.revocationGeneration,
        status: "active",
        effect: "allow",
        operations: ["fill"],
        initiatingOrigins: [permission.principal.initiatingOrigin],
        sourceRefs: permission.bindings.map((binding) => binding.sourceRef),
        fieldRefs: permission.bindings.map((binding) => binding.fieldRef || ""),
        recipients: [permission.recipient],
        representations: ["action-only"],
        approvalModes: ["manual", "auto", "bypassPrompts"],
        expiresAt: new Date(approval.expiresAt).toISOString(),
        requiresFreshUserConfirmation: true,
    };
}

function publicPlanField(field: PendingBrokerPlanField): AutofillBrokerPlanField {
    return {
        fieldRef: field.fieldRef,
        role: field.role,
        sourceRef: field.sourceRef,
        transactionOnly: field.transactionOnly,
    };
}

function findFirstFieldForRole(
    items: BrokerItemSource[],
    role: string
): { item: VaultItem; field: Field; index: number } | null {
    for (const { item } of items) {
        const index = item.fields.findIndex((field) => normalizeRole(field.autofillRole || "") === role);
        if (index >= 0) {
            const field = item.fields[index];
            if (field) return { item, field, index };
        }
    }
    return null;
}

function requireBinding(request: AutofillBrokerRequest) {
    if (!request.binding) throw new Error("Autofill broker request missing binding");
    if (!request.binding.sessionId) throw new Error("Autofill broker request missing session binding");
    return request.binding;
}

function assertRequestMatchesTarget(
    origin: string,
    frameId: number | string | undefined,
    target: AutofillBrokerTarget
) {
    if (origin !== target.topOrigin) throw new Error("Autofill request origin does not match browser target");
    if (target.topOrigin !== target.frameOrigin)
        throw new Error("Cross-origin autofill frames require a separate recipient grant");
    if (frameId !== undefined && frameId !== "main" && Number(frameId) !== target.frameId) {
        throw new Error("Autofill request frame does not match browser target");
    }
}

function assertBundleRequest(request: AutofillBrokerRequest, bundle: PendingBrokerBundle, now: number) {
    if (request.planId !== bundle.planId) throw new Error("Autofill apply plan mismatch");
    if (request.bundleId !== bundle.bundleId) throw new Error("Autofill apply bundle mismatch");
    if (bundle.expiresAt <= now) throw new Error("Autofill bundle expired");
}

function audit(
    operation: AutofillBrokerResponse["audit"]["operation"],
    request: AutofillBrokerRequest,
    fieldCount: number,
    extra: Partial<AutofillBrokerResponse["audit"]> = {}
) {
    return {
        operation,
        sessionId: request.binding ? request.binding.sessionId : null,
        origin: request.binding ? request.binding.origin : null,
        fieldCount,
        valuePolicy: "reference-only agent transport; values resolve inside the trusted extension executor",
        ...extra,
    };
}

function normalizeRole(role: string): string {
    const normalized = role.replace(/^billing\./, "");
    if (normalized === "payment.cardholder_name") return "payment.card.cardholder_name";
    if (normalized === "payment.card.expiry_mm_yy") return "payment.card.expiry";
    return normalized;
}

function dataClassForRole(role: string): AgentDataClass {
    if (role === "password" || role === "totp" || role.startsWith("authentication.")) {
        return "authentication-secret";
    }
    if (role.startsWith("payment.")) return "payment";
    return "profile";
}

function previewValue(field: Field, role: string): string {
    if (role === "payment.card.pan") return `card:${field.value.replace(/\D/g, "").slice(-4) || "unknown"}`;
    if (field.transactionOnly) return "transaction-only";
    return "stored";
}

function opaqueId(prefix: string): string {
    const bytes = new Uint8Array(16);
    crypto.getRandomValues(bytes);
    const value = Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
    return `${prefix}_${value}`;
}
