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
    AUTOFILL_BROKER_RESPONSE_SCHEMA,
    AutofillBrokerInspectedField,
    AutofillBrokerPlanField,
    AutofillBrokerRequest,
    AutofillBrokerResponse,
    AutofillBrokerTarget,
    buildLockedBrokerResponse,
    buildUnlockedBrokerStatusResponse,
} from "./autofill-broker-protocol";
import { getAutofillReleaseClass, isAutofillFieldRole } from "@padloc/core/src/item";

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
    activeFieldRef?: string;
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

export function buildUnsupportedBrokerOperationResponse(request: AutofillBrokerRequest): AutofillBrokerResponse {
    const isSubmit = request.type === "submit";
    const reasonCode = isSubmit ? "DENY_SUBMIT_REQUIRES_SEPARATE_GRANT" : "DENY_REVEAL_UNSUPPORTED";
    if (request.protocolVersion === 2) {
        return {
            schema: AUTOFILL_BROKER_RESPONSE_SCHEMA,
            kind: "error",
            protocolVersion: 2,
            requestId: request.requestId || "missing-request-id",
            ok: false,
            error: {
                schema: "elf.padloc-broker-error.v1",
                code: "UNSUPPORTED",
                retryable: false,
                safeMessage: isSubmit
                    ? "Submission requires a separately implemented and approved action grant"
                    : "Model disclosure is not enabled by the secret-blind autofill profile",
            },
        } as unknown as AutofillBrokerResponse;
    }
    return {
        ok: false,
        protocolVersion: request.protocolVersion,
        requestId: request.requestId,
        vaultState: "unlocked",
        reason: isSubmit
            ? "Submission requires a separately implemented and approved action grant"
            : "Model disclosure is not enabled by the secret-blind autofill profile",
        audit: {
            operation: request.type,
            sessionId: request.binding?.sessionId || null,
            origin: request.binding?.origin || null,
            fieldCount: 0,
            valuePolicy: "fail closed; no vault values resolved or released",
            decision: "deny",
            reasonCode,
        },
    };
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
    const fields = collectMatchingFields(items, inspectedFields, request.protocolVersion === 2);
    if (fields.length === 0) throw new Error("Autofill plan has no authorized field matches");
    const planId = opaqueId("plan");
    const permissionRequest = buildFillPermissionRequest(request, target, fields, principal, now);
    const pendingPlan = { planId, request, target, fields, permissionRequest, createdAt: now };
    if (request.protocolVersion === 2) {
        return {
            pendingPlan,
            response: {
                schema: AUTOFILL_BROKER_RESPONSE_SCHEMA,
                kind: "plan",
                protocolVersion: 2,
                requestId: request.requestId || "missing-request-id",
                ok: true,
                target: exactTarget(target),
                planId,
                fields: fields.map(publicPlanField),
                expiresAt: pendingPlan.permissionRequest.expiresAt,
            } as unknown as AutofillBrokerResponse,
        };
    }
    return {
        pendingPlan,
        response: {
            ok: true,
            protocolVersion: request.protocolVersion,
            requestId: request.requestId,
            vaultState: "unlocked",
            reason: null,
            planId,
            target,
            fields: fields.map(publicPlanField),
            audit: audit(request.type, request, fields.length, { reasonCode: "ASK_MISSING_AUTHORITY" }),
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
    if (request.protocolVersion !== 2) throw new Error("Autofill approval requires protocol v2");
    if (request.planId !== pendingPlan.planId) throw new Error("Autofill approval plan mismatch");
    if (request.approved !== true) throw new Error("Autofill approval requires user approval");
    if (request.binding) {
        assertRequestMatchesTarget(request.binding.origin, request.binding.frameId, pendingPlan.target);
        if (request.binding.sessionId !== pendingPlan.target.sessionId) {
            throw new Error("Autofill approval session mismatch");
        }
    }
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
            schema: AUTOFILL_BROKER_RESPONSE_SCHEMA,
            kind: "approval-required",
            protocolVersion: 2,
            requestId: request.requestId || "missing-request-id",
            ok: true,
            target: exactTarget(pendingPlan.target),
            planId: pendingPlan.planId,
            reasonCode: authority.policyId ? "ALLOW_STANDING_POLICY" : "ALLOW_USER_APPROVED",
            mode: authority.policyId ? "auto" : "manual",
        } as unknown as AutofillBrokerResponse,
    };
}

export function mintBrokerBundleResponse(
    request: AutofillBrokerRequest,
    pendingPlan: PendingBrokerPlan,
    approval: BrokerApproval,
    now = Date.now()
): { response: AutofillBrokerResponse; bundle: PendingBrokerBundle } {
    if (request.protocolVersion !== 2) throw new Error("Autofill bundle mint requires protocol v2");
    if (request.planId !== pendingPlan.planId) throw new Error("Autofill bundle plan mismatch");
    if (request.approvalId !== approval.approvalId) throw new Error("Autofill bundle approval mismatch");
    if (approval.expiresAt <= now) throw new Error("Autofill approval expired");
    if (request.binding) {
        assertRequestMatchesTarget(request.binding.origin, request.binding.frameId, pendingPlan.target);
        if (request.binding.sessionId !== pendingPlan.target.sessionId) {
            throw new Error("Autofill bundle session mismatch");
        }
    }

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
            schema: AUTOFILL_BROKER_RESPONSE_SCHEMA,
            kind: "granted",
            protocolVersion: 2,
            requestId: request.requestId || "missing-request-id",
            ok: true,
            target: exactTarget(pendingPlan.target),
            grantId: grant.id,
            planId: pendingPlan.planId,
            expiresAt: new Date(approval.expiresAt).toISOString(),
            maxUses: permissionRequest.maxUses,
        } as unknown as AutofillBrokerResponse,
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
    if (bundle.activeFieldRef && bundle.activeFieldRef !== fieldRef) {
        throw new Error("Autofill executor already has an active field resolution");
    }
    return {
        ...bundle,
        activeFieldRef: fieldRef,
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
    if (bundle.activeFieldRef !== fieldRef) {
        throw new Error("Autofill field must be reserved before value resolution");
    }
    const source = items.find(({ item }) => item.id === planned.itemId)?.item.fields[planned.fieldIndex];
    if (!source) throw new Error("Autofill field source missing");
    return source.transform();
}

export function completeBrokerBundleFieldUse(
    bundle: PendingBrokerBundle,
    attemptId: string,
    outcome: "completed" | "partial" | "outcome-unknown"
): PendingBrokerBundle {
    return {
        ...bundle,
        activeFieldRef: undefined,
        grantRecord: completeAgentGrantUse(bundle.grantRecord, attemptId, outcome),
    };
}

export function applyBrokerBundleResponse(
    request: AutofillBrokerRequest,
    bundle: PendingBrokerBundle,
    filledFieldRefs: string[],
    status: "completed" | "partial" | "outcome-unknown",
    now = Date.now()
): AutofillBrokerResponse {
    if (request.protocolVersion !== 2) throw new Error("Autofill bundle apply requires protocol v2");
    assertBundleRequest(request, bundle, now);
    const receiptId = opaqueId("receipt");
    return {
        schema: AUTOFILL_BROKER_RESPONSE_SCHEMA,
        kind: "applied",
        protocolVersion: 2,
        requestId: request.requestId || "missing-request-id",
        ok: status === "completed",
        target: exactTarget(bundle.target),
        grantId: bundle.grantRecord.grant.id,
        receipt: {
            receiptId,
            status,
            filledFieldRefs: [...filledFieldRefs],
            modelDisclosure: "none",
            submittedByExecutor: true,
        },
    } as unknown as AutofillBrokerResponse;
}

export function revokeBrokerBundleResponse(
    request: AutofillBrokerRequest,
    bundle: PendingBrokerBundle
): { response: AutofillBrokerResponse; bundle: PendingBrokerBundle } {
    if (request.protocolVersion !== 2) throw new Error("Autofill bundle revoke requires protocol v2");
    if (request.planId !== bundle.planId) throw new Error("Autofill revoke plan mismatch");
    if (request.bundleId !== bundle.bundleId) throw new Error("Autofill revoke bundle mismatch");
    if (request.binding) {
        assertRequestMatchesTarget(request.binding.origin, request.binding.frameId, bundle.target);
        if (request.binding.sessionId !== bundle.target.sessionId) {
            throw new Error("Autofill revoke session mismatch");
        }
    }
    const revokedBundle = { ...bundle, grantRecord: revokeAgentGrant(bundle.grantRecord) };
    return {
        bundle: revokedBundle,
        response: {
            schema: AUTOFILL_BROKER_RESPONSE_SCHEMA,
            kind: "revoked",
            protocolVersion: 2,
            requestId: request.requestId || "missing-request-id",
            ok: true,
            target: exactTarget(bundle.target),
            grantId: bundle.grantRecord.grant.id,
            status: "revoked",
        } as unknown as AutofillBrokerResponse,
    };
}

export function redactBrokerResponse(response: AutofillBrokerResponse): AutofillBrokerResponse {
    return JSON.parse(JSON.stringify(response)) as AutofillBrokerResponse;
}

function collectMatchingFields(
    items: BrokerItemSource[],
    inspectedFields: AutofillBrokerInspectedField[],
    strictRedaction = false
): PendingBrokerPlanField[] {
    const matches: PendingBrokerPlanField[] = [];
    const seenFieldRefs = new Set<string>();
    for (const inspected of inspectedFields) {
        const requestedRole = normalizeRole(inspected.role);
        if (
            !requestedRole ||
            !isAutofillFieldRole(requestedRole) ||
            !inspected.selector ||
            !inspected.fieldRef ||
            seenFieldRefs.has(inspected.fieldRef)
        )
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
            valuePreview: strictRedaction ? "stored" : previewValue(match.field, requestedRole),
            transactionOnly: Boolean(match.field.transactionOnly),
            releaseClass: getAutofillReleaseClass(requestedRole),
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
            role: field.role,
            releaseClass: field.releaseClass,
            transactionOnly: field.transactionOnly,
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
        target: permission.target,
        roles: permission.bindings.map((binding) => binding.role || ""),
    };
}

function publicPlanField(field: PendingBrokerPlanField): AutofillBrokerPlanField {
    return {
        fieldRef: field.fieldRef,
        role: field.role,
        sourceRef: field.sourceRef,
        transactionOnly: field.transactionOnly,
        releaseClass: field.releaseClass,
    };
}

function exactTarget(target: AutofillBrokerTarget) {
    const origin = target.origin;
    const sessionId = target.sessionId;
    const frameOrigin = target.frameOrigin || origin;
    const topOrigin = target.topOrigin || origin;
    if (!origin || !sessionId || origin !== frameOrigin || !topOrigin || !target.documentId || !target.formRef) {
        throw new Error("Autofill exact target binding is required");
    }
    return {
        tabId: target.tabId,
        frameId: target.frameId,
        origin,
        documentId: target.documentId,
        formRef: target.formRef,
        targetRevision: target.targetRevision,
        sessionId,
        topOrigin,
        frameOrigin,
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
    if (target.origin && target.origin !== target.frameOrigin) {
        throw new Error("Autofill request origin does not match frame target");
    }
    if (frameId !== undefined && frameId !== "main" && Number(frameId) !== target.frameId) {
        throw new Error("Autofill request frame does not match browser target");
    }
}

function assertBundleRequest(request: AutofillBrokerRequest, bundle: PendingBrokerBundle, now: number) {
    if (request.planId !== bundle.planId) throw new Error("Autofill apply plan mismatch");
    if (request.bundleId !== bundle.bundleId) throw new Error("Autofill apply bundle mismatch");
    if (bundle.expiresAt <= now) throw new Error("Autofill bundle expired");
    const binding = request.binding;
    if (binding) {
        if (binding.origin !== bundle.target.topOrigin) throw new Error("Autofill apply origin mismatch");
        if (binding.sessionId && bundle.target.sessionId && binding.sessionId !== bundle.target.sessionId) {
            throw new Error("Autofill apply session mismatch");
        }
        if (binding.frameId !== undefined && binding.frameId !== "main" && Number(binding.frameId) !== bundle.target.frameId) {
            throw new Error("Autofill apply frame mismatch");
        }
        if (binding.documentId && binding.documentId !== bundle.target.documentId) {
            throw new Error("Autofill apply document mismatch");
        }
        if (binding.formRef && binding.formRef !== bundle.target.formRef) {
            throw new Error("Autofill apply form mismatch");
        }
        if (binding.targetRevision && binding.targetRevision !== bundle.target.targetRevision) {
            throw new Error("Autofill apply target revision mismatch");
        }
    }
    if (request.target && !targetsEqual(request.target, bundle.target)) {
        throw new Error("Autofill apply target mismatch");
    }
}

function targetsEqual(left: AutofillBrokerTarget, right: AutofillBrokerTarget): boolean {
    return (
        left.tabId === right.tabId &&
        left.frameId === right.frameId &&
        left.origin === right.origin &&
        left.documentId === right.documentId &&
        left.formRef === right.formRef &&
        left.targetRevision === right.targetRevision &&
        left.sessionId === right.sessionId &&
        left.topOrigin === right.topOrigin &&
        left.frameOrigin === right.frameOrigin
    );
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
    const alphabet = "abcdefghijklmnop";
    const value = Array.from(bytes, (byte) => `${alphabet[byte >>> 4]}${alphabet[byte & 0x0f]}`).join("");
    return `${prefix}_${value}`;
}
