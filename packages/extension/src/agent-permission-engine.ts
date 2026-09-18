export type AgentApprovalMode = "plan" | "manual" | "auto" | "dontAsk" | "bypassPrompts";

export type AgentPermissionOperation = "describe" | "fill" | "authenticate" | "derive" | "reveal" | "submit";

export type AgentDataClass = "profile" | "payment" | "authentication-secret" | "private-note" | "other";

export type AgentRepresentation = "action-only" | "derived" | "coarse" | "exact";

export type AgentRecipient =
    | { kind: "page"; topOrigin: string; frameOrigin: string }
    | { kind: "model-route"; routeId: string; routeRevision: number }
    | { kind: "user-ui"; deviceId: string }
    | { kind: "executor"; deviceId: string; executorId: string };

export interface AgentPrincipal {
    userId: string;
    initiatingOrigin: string;
    sessionId: string;
    agentId?: string;
    runtimeId?: string;
}

export interface AgentDataBinding {
    sourceRef: string;
    dataClass: AgentDataClass;
    sourceVersion?: string;
    fieldRef?: string;
    transformId?: string;
}

export interface AgentExecutionTarget {
    tabId: number;
    frameId: number;
    documentId: string;
    formRef: string;
    targetRevision: string;
}

export interface AgentPermissionRequest {
    principal: AgentPrincipal;
    operation: AgentPermissionOperation;
    bindings: AgentDataBinding[];
    recipient: AgentRecipient;
    target?: AgentExecutionTarget;
    representation: AgentRepresentation;
    expiresAt: string;
    maxUses: number;
    enforcement: {
        localExecutorOnly: boolean;
        allowModelDisclosure: boolean;
        requiresFreshUserConfirmation: boolean;
        revocationMode: "online-required" | "leased" | "local-only";
        leaseExpiresAt?: string;
    };
}

export interface AgentStandingPolicy {
    id: string;
    revision: number;
    revocationGeneration: number;
    status: "active" | "revoked";
    effect: "allow" | "deny" | "alwaysAsk";
    operations: AgentPermissionOperation[];
    initiatingOrigins: string[];
    sourceRefs: string[];
    fieldRefs?: string[];
    recipients: AgentRecipient[];
    representations: AgentRepresentation[];
    approvalModes?: AgentApprovalMode[];
    expiresAt?: string;
    requiresFreshUserConfirmation?: boolean;
}

export interface AgentExecutionGrant extends AgentPermissionRequest {
    id: string;
    parentGrantId?: string;
    policyId?: string;
    policyRevision: number;
    revocationGeneration: number;
    requestDigest: string;
    issuedAt: string;
}

export type AgentGrantStatus =
    | "active"
    | "reserved"
    | "executing"
    | "completed"
    | "partial"
    | "denied"
    | "revoked"
    | "outcome-unknown";

export interface AgentExecutionGrantRecord {
    grant: AgentExecutionGrant;
    status: AgentGrantStatus;
    reservedUses: number;
    completedUses: number;
    reservations: { [attemptId: string]: "reserved" | "executing" | "completed" | "outcome-unknown" };
}

export type AgentPermissionReasonCode =
    | "ALLOW_MATCHED_POLICY"
    | "ASK_ALWAYS"
    | "ASK_CONFIRMATION_REQUIRED"
    | "ASK_MISSING_AUTHORITY"
    | "DENY_INVALID_REQUEST"
    | "DENY_PLAN_MODE"
    | "DENY_MISSING_AUTHORITY"
    | "DENY_HARD_POLICY"
    | "DENY_AUTH_SECRET_REVEAL"
    | "DENY_MODEL_DISCLOSURE"
    | "DENY_REVOKED"
    | "DENY_EXPIRED"
    | "DENY_LEASE_EXPIRED"
    | "DENY_ONLINE_AUTHORITY_UNAVAILABLE"
    | "DENY_PARENT_SCOPE"
    | "DENY_CONFIRMATION_REQUIRED";

export interface AgentPermissionDecision {
    outcome: "allow" | "ask" | "deny";
    reasonCode: AgentPermissionReasonCode;
    matchedPolicyIds: string[];
    requestDigest: string;
    policyId?: string;
    policyRevision: number;
    revocationGeneration: number;
}

export interface AgentPermissionEvaluationInput {
    mode: AgentApprovalMode;
    request: AgentPermissionRequest;
    policies: AgentStandingPolicy[];
    now: number;
    currentPolicyRevision: number;
    currentRevocationGeneration: number;
    onlineAuthorityCurrent: boolean;
    confirmedRequestDigest?: string;
    parentGrant?: AgentExecutionGrant;
}

export interface AgentGrantUseContext {
    now: number;
    currentPolicyRevision: number;
    currentRevocationGeneration: number;
    onlineAuthorityCurrent: boolean;
}

const REPRESENTATION_RANK: Record<AgentRepresentation, number> = {
    "action-only": 0,
    derived: 1,
    coarse: 2,
    exact: 3,
};

export function evaluateAgentPermission(input: AgentPermissionEvaluationInput): AgentPermissionDecision {
    const requestDigest = permissionRequestDigest(input.request);
    const base = {
        matchedPolicyIds: [] as string[],
        requestDigest,
        policyRevision: input.currentPolicyRevision,
        revocationGeneration: input.currentRevocationGeneration,
    };
    if (!isAgentPermissionRequest(input.request, input.now)) {
        return { ...base, outcome: "deny", reasonCode: "DENY_INVALID_REQUEST" };
    }
    if (input.mode === "plan" && input.request.operation !== "describe") {
        return { ...base, outcome: "deny", reasonCode: "DENY_PLAN_MODE" };
    }
    if (
        input.request.operation === "reveal" &&
        input.request.bindings.some((binding) => binding.dataClass === "authentication-secret")
    ) {
        return { ...base, outcome: "deny", reasonCode: "DENY_AUTH_SECRET_REVEAL" };
    }
    if (input.request.recipient.kind === "model-route" && !input.request.enforcement.allowModelDisclosure) {
        return { ...base, outcome: "deny", reasonCode: "DENY_MODEL_DISCLOSURE" };
    }
    if (Date.parse(input.request.expiresAt) <= input.now) {
        return { ...base, outcome: "deny", reasonCode: "DENY_EXPIRED" };
    }
    if (input.request.enforcement.revocationMode === "online-required" && !input.onlineAuthorityCurrent) {
        return { ...base, outcome: "deny", reasonCode: "DENY_ONLINE_AUTHORITY_UNAVAILABLE" };
    }
    if (input.request.enforcement.revocationMode === "leased") {
        const leaseExpiresAt = Date.parse(input.request.enforcement.leaseExpiresAt || "");
        if (!Number.isFinite(leaseExpiresAt) || leaseExpiresAt <= input.now) {
            return { ...base, outcome: "deny", reasonCode: "DENY_LEASE_EXPIRED" };
        }
    }
    if (input.parentGrant && !isRequestWithinParentGrant(input.request, input.parentGrant)) {
        return { ...base, outcome: "deny", reasonCode: "DENY_PARENT_SCOPE" };
    }

    const matchingPolicies = input.policies.filter((policy) =>
        policyMatches(policy, input.request, input.mode, input.now)
    );
    const matchedPolicyIds = matchingPolicies.map((policy) => policy.id);
    const policyBase = { ...base, matchedPolicyIds };
    if (matchingPolicies.some((policy) => policy.status === "revoked")) {
        return { ...policyBase, outcome: "deny", reasonCode: "DENY_REVOKED" };
    }
    if (matchingPolicies.some((policy) => policy.effect === "deny")) {
        return { ...policyBase, outcome: "deny", reasonCode: "DENY_HARD_POLICY" };
    }

    const alwaysAsk = matchingPolicies.find((policy) => policy.effect === "alwaysAsk");
    const allow = matchingPolicies.find((policy) => policy.effect === "allow");
    if (
        allow &&
        (allow.revision !== input.currentPolicyRevision ||
            allow.revocationGeneration !== input.currentRevocationGeneration)
    ) {
        return { ...policyBase, outcome: "deny", reasonCode: "DENY_REVOKED" };
    }
    const needsConfirmation =
        input.request.enforcement.requiresFreshUserConfirmation ||
        Boolean(alwaysAsk) ||
        Boolean(allow && allow.requiresFreshUserConfirmation);
    if (needsConfirmation && input.confirmedRequestDigest !== requestDigest) {
        if (input.mode === "manual" || input.mode === "auto") {
            return {
                ...policyBase,
                outcome: "ask",
                reasonCode: alwaysAsk ? "ASK_ALWAYS" : "ASK_CONFIRMATION_REQUIRED",
            };
        }
        return { ...policyBase, outcome: "deny", reasonCode: "DENY_CONFIRMATION_REQUIRED" };
    }
    if (allow) {
        return {
            ...policyBase,
            outcome: "allow",
            reasonCode: "ALLOW_MATCHED_POLICY",
            policyId: allow.id,
            policyRevision: allow.revision,
            revocationGeneration: allow.revocationGeneration,
        };
    }
    if (input.mode === "manual" || input.mode === "auto") {
        return { ...policyBase, outcome: "ask", reasonCode: "ASK_MISSING_AUTHORITY" };
    }
    return { ...policyBase, outcome: "deny", reasonCode: "DENY_MISSING_AUTHORITY" };
}

export function mintAgentExecutionGrant(
    input: AgentPermissionEvaluationInput,
    decision: AgentPermissionDecision,
    grantId: string
): AgentExecutionGrant {
    if (decision.outcome !== "allow") throw new Error("Execution grant requires an allow decision");
    if (!grantId) throw new Error("Execution grant id is required");
    return {
        ...clonePermissionRequest(input.request),
        id: grantId,
        parentGrantId: input.parentGrant?.id,
        policyId: decision.policyId,
        policyRevision: decision.policyRevision,
        revocationGeneration: decision.revocationGeneration,
        requestDigest: decision.requestDigest,
        issuedAt: new Date(input.now).toISOString(),
    };
}

export function createAgentGrantRecord(grant: AgentExecutionGrant): AgentExecutionGrantRecord {
    return { grant, status: "active", reservedUses: 0, completedUses: 0, reservations: {} };
}

export function reserveAgentGrantUse(
    record: AgentExecutionGrantRecord,
    attemptId: string,
    context: AgentGrantUseContext
): AgentExecutionGrantRecord {
    if (!attemptId) throw new Error("Grant use attempt id is required");
    const existing = record.reservations[attemptId];
    if (existing) return cloneGrantRecord(record);
    assertGrantCurrent(record, context);
    if (record.reservedUses >= record.grant.maxUses) throw new Error("Execution grant use limit reached");
    const next = cloneGrantRecord(record);
    next.reservations[attemptId] = "reserved";
    next.reservedUses += 1;
    next.status = "reserved";
    return next;
}

export function beginAgentGrantUse(record: AgentExecutionGrantRecord, attemptId: string): AgentExecutionGrantRecord {
    if (record.reservations[attemptId] !== "reserved") throw new Error("Execution grant use is not reserved");
    const next = cloneGrantRecord(record);
    next.reservations[attemptId] = "executing";
    next.status = "executing";
    return next;
}

export function completeAgentGrantUse(
    record: AgentExecutionGrantRecord,
    attemptId: string,
    outcome: "completed" | "partial" | "outcome-unknown"
): AgentExecutionGrantRecord {
    if (record.reservations[attemptId] !== "executing") throw new Error("Execution grant use is not executing");
    const next = cloneGrantRecord(record);
    next.reservations[attemptId] = outcome === "completed" ? "completed" : "outcome-unknown";
    if (outcome === "completed") next.completedUses += 1;
    next.status = outcome === "completed" && next.completedUses < next.grant.maxUses ? "active" : outcome;
    return next;
}

export function revokeAgentGrant(record: AgentExecutionGrantRecord): AgentExecutionGrantRecord {
    const next = cloneGrantRecord(record);
    next.status = "revoked";
    return next;
}

export function permissionRequestDigest(request: AgentPermissionRequest): string {
    return `request_${fnv1a(stableJson(request))}`;
}

export function isAgentPermissionRequest(value: unknown, _now = Date.now()): value is AgentPermissionRequest {
    try {
        const request = value as AgentPermissionRequest;
        if (!request || typeof request !== "object" || !isPrincipalValid(request.principal)) return false;
        if (!["describe", "fill", "authenticate", "derive", "reveal", "submit"].includes(request.operation)) {
            return false;
        }
        if (!["action-only", "derived", "coarse", "exact"].includes(request.representation)) return false;
        if (!Number.isInteger(request.maxUses) || request.maxUses < 1) return false;
        const expiresAt = Date.parse(request.expiresAt);
        if (!Number.isFinite(expiresAt)) return false;
        if (!isRecipientValid(request.recipient)) return false;
        if (!Array.isArray(request.bindings)) return false;
        if (request.operation !== "describe" && request.operation !== "submit" && request.bindings.length === 0) {
            return false;
        }
        if (
            request.bindings.some(
                (binding) =>
                    !binding ||
                    !binding.sourceRef ||
                    !["profile", "payment", "authentication-secret", "private-note", "other"].includes(
                        binding.dataClass
                    )
            )
        ) {
            return false;
        }
        if (["fill", "authenticate", "submit"].includes(request.operation) && !isTargetValid(request.target)) {
            return false;
        }
        if (request.operation === "fill" && request.representation !== "action-only") return false;
        if (request.operation === "authenticate" && request.representation === "exact") return false;
        if (request.recipient.kind === "page" && !request.target) return false;
        if (!request.enforcement || typeof request.enforcement !== "object") return false;
        if (typeof request.enforcement.localExecutorOnly !== "boolean") return false;
        if (typeof request.enforcement.allowModelDisclosure !== "boolean") return false;
        if (typeof request.enforcement.requiresFreshUserConfirmation !== "boolean") return false;
        if (!["online-required", "leased", "local-only"].includes(request.enforcement.revocationMode)) return false;
        if (request.enforcement.localExecutorOnly && request.recipient.kind === "model-route") return false;
        if (request.enforcement.revocationMode === "leased") {
            const leaseExpiresAt = Date.parse(request.enforcement.leaseExpiresAt || "");
            if (!Number.isFinite(leaseExpiresAt) || leaseExpiresAt > expiresAt) return false;
        }
        return true;
    } catch {
        return false;
    }
}

function isPrincipalValid(principal: AgentPrincipal): boolean {
    return Boolean(principal && principal.userId && principal.sessionId && isExactOrigin(principal.initiatingOrigin));
}

function isRecipientValid(recipient: AgentRecipient): boolean {
    if (!recipient) return false;
    if (recipient.kind === "page") {
        return isExactOrigin(recipient.topOrigin) && isExactOrigin(recipient.frameOrigin);
    }
    if (recipient.kind === "model-route") {
        return Boolean(recipient.routeId && Number.isInteger(recipient.routeRevision) && recipient.routeRevision >= 0);
    }
    if (recipient.kind === "user-ui") return Boolean(recipient.deviceId);
    return Boolean(recipient.deviceId && recipient.executorId);
}

function isTargetValid(target: AgentExecutionTarget | undefined): target is AgentExecutionTarget {
    return Boolean(
        target &&
            Number.isInteger(target.tabId) &&
            target.tabId >= 0 &&
            Number.isInteger(target.frameId) &&
            target.frameId >= 0 &&
            target.documentId &&
            target.formRef &&
            target.targetRevision
    );
}

function isExactOrigin(value: string): boolean {
    try {
        const parsed = new URL(value);
        return (
            parsed.origin === value &&
            parsed.origin !== "null" &&
            (parsed.protocol === "https:" || parsed.protocol === "http:")
        );
    } catch {
        return false;
    }
}

function policyMatches(
    policy: AgentStandingPolicy,
    request: AgentPermissionRequest,
    mode: AgentApprovalMode,
    now: number
): boolean {
    if (policy.expiresAt && Date.parse(policy.expiresAt) <= now) return false;
    if (policy.approvalModes && !policy.approvalModes.includes(mode)) return false;
    if (!policy.operations.includes(request.operation)) return false;
    if (!policy.initiatingOrigins.includes(request.principal.initiatingOrigin)) return false;
    if (!policy.representations.includes(request.representation)) return false;
    if (!policy.recipients.some((recipient) => recipientsEqual(recipient, request.recipient))) return false;
    if (!request.bindings.every((binding) => policy.sourceRefs.includes(binding.sourceRef))) return false;
    if (
        policy.fieldRefs &&
        !request.bindings.every((binding) => binding.fieldRef && policy.fieldRefs!.includes(binding.fieldRef))
    ) {
        return false;
    }
    return true;
}

function isRequestWithinParentGrant(request: AgentPermissionRequest, parent: AgentExecutionGrant): boolean {
    if (request.principal.userId !== parent.principal.userId) return false;
    if (request.principal.sessionId !== parent.principal.sessionId) return false;
    if (request.operation !== parent.operation) return false;
    if (!recipientsEqual(request.recipient, parent.recipient)) return false;
    if (REPRESENTATION_RANK[request.representation] > REPRESENTATION_RANK[parent.representation]) return false;
    if (Date.parse(request.expiresAt) > Date.parse(parent.expiresAt)) return false;
    if (request.maxUses > parent.maxUses) return false;
    if (request.target && (!parent.target || !targetsEqual(request.target, parent.target))) return false;
    return request.bindings.every((binding) =>
        parent.bindings.some(
            (candidate) =>
                candidate.sourceRef === binding.sourceRef &&
                candidate.fieldRef === binding.fieldRef &&
                candidate.transformId === binding.transformId
        )
    );
}

function assertGrantCurrent(record: AgentExecutionGrantRecord, context: AgentGrantUseContext): void {
    if (["completed", "denied", "revoked", "outcome-unknown"].includes(record.status)) {
        throw new Error(`Execution grant is ${record.status}`);
    }
    if (Date.parse(record.grant.expiresAt) <= context.now) throw new Error("Execution grant expired");
    if (record.grant.policyRevision !== context.currentPolicyRevision)
        throw new Error("Execution grant policy is stale");
    if (record.grant.revocationGeneration !== context.currentRevocationGeneration) {
        throw new Error("Execution grant revoked by generation change");
    }
    if (record.grant.enforcement.revocationMode === "online-required" && !context.onlineAuthorityCurrent) {
        throw new Error("Execution grant requires current online authority");
    }
    if (record.grant.enforcement.revocationMode === "leased") {
        const leaseExpiresAt = Date.parse(record.grant.enforcement.leaseExpiresAt || "");
        if (!Number.isFinite(leaseExpiresAt) || leaseExpiresAt <= context.now) {
            throw new Error("Execution grant lease expired");
        }
    }
}

function recipientsEqual(left: AgentRecipient, right: AgentRecipient): boolean {
    return stableJson(left) === stableJson(right);
}

function targetsEqual(left: AgentExecutionTarget, right: AgentExecutionTarget): boolean {
    return stableJson(left) === stableJson(right);
}

function clonePermissionRequest(request: AgentPermissionRequest): AgentPermissionRequest {
    return JSON.parse(JSON.stringify(request)) as AgentPermissionRequest;
}

function cloneGrantRecord(record: AgentExecutionGrantRecord): AgentExecutionGrantRecord {
    return {
        grant: record.grant,
        status: record.status,
        reservedUses: record.reservedUses,
        completedUses: record.completedUses,
        reservations: { ...record.reservations },
    };
}

function stableJson(value: unknown): string {
    if (value === null || typeof value !== "object") return JSON.stringify(value);
    if (Array.isArray(value)) return `[${value.map((entry) => stableJson(entry)).join(",")}]`;
    const record = value as Record<string, unknown>;
    const entries = Object.keys(record)
        .sort()
        .filter((key) => record[key] !== undefined)
        .map((key) => `${JSON.stringify(key)}:${stableJson(record[key])}`);
    return `{${entries.join(",")}}`;
}

function fnv1a(value: string): string {
    let hash = 0x811c9dc5;
    for (let index = 0; index < value.length; index += 1) {
        hash ^= value.charCodeAt(index);
        hash = Math.imul(hash, 0x01000193);
    }
    return (hash >>> 0).toString(16).padStart(8, "0");
}
