export type AgentApprovalMode = "plan" | "manual" | "auto" | "dontAsk" | "bypassPrompts";

/**
 * These labels are the only modes that may cross the user-facing boundary.
 * `bypassPrompts` stays in the internal enum for compatibility with old
 * synthetic fixtures, but is never accepted as a real approval mode.
 */
export type AgentUserFacingApprovalMode =
    | "plan-only"
    | "prompted"
    | "standing-policy-automatic"
    | "standing-policy automatic"
    | "noninteractive"
    | "noninteractive fail-closed"
    | "noninteractive-fail-closed";

export type AgentPublicApprovalMode = Exclude<AgentApprovalMode, "bypassPrompts">;

export type AgentReleaseClass = "low" | "secret" | "high-risk";

export interface AgentPermissionSecurityContext {
    roles?: string[];
    passkey?: boolean;
    isPasskey?: boolean;
    newPaymentOrigin?: boolean;
    isNewPaymentOrigin?: boolean;
    policyChange?: boolean;
    isPolicyChange?: boolean;
}

export interface AgentFreshVerification {
    requestDigest: string;
    verifiedAt?: number;
    expiresAt?: string;
}

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
    role?: string;
    releaseClass?: AgentReleaseClass;
    transactionOnly?: boolean;
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
    securityContext?: AgentPermissionSecurityContext;
    passkey?: boolean;
    isPasskey?: boolean;
    newPaymentOrigin?: boolean;
    isNewPaymentOrigin?: boolean;
    policyChange?: boolean;
    isPolicyChange?: boolean;
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
    roles?: string[];
    recipients: AgentRecipient[];
    representations: AgentRepresentation[];
    approvalModes?: AgentApprovalMode[];
    expiresAt?: string;
    requiresFreshUserConfirmation?: boolean;
    target?: AgentExecutionTarget;
}

export interface AgentExecutionGrant extends AgentPermissionRequest {
    id: string;
    parentGrantId?: string;
    policyId?: string;
    policyRevision: number;
    revocationGeneration: number;
    requestDigest: string;
    issuedAt: string;
    sessionGeneration?: string | number;
    restartGeneration?: string | number;
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
    | "ALLOW_PLAN_DESCRIPTION"
    | "ALLOW_MATCHED_POLICY"
    | "ASK_ALWAYS"
    | "ASK_CONFIRMATION_REQUIRED"
    | "ASK_MISSING_AUTHORITY"
    | "DENY_INVALID_REQUEST"
    | "DENY_INTERNAL_MODE"
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
    | "DENY_CONFIRMATION_REQUIRED"
    | "DENY_VAULT_LOCKED"
    | "DENY_RESTARTED"
    | "DENY_SUBMIT_REQUIRES_SEPARATE_GRANT";

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
    freshVerification?: AgentFreshVerification;
    vaultState?: "locked" | "unlocked" | "unknown";
    currentSessionId?: string;
    currentSessionGeneration?: string | number;
    currentRestartGeneration?: string | number;
    parentGrant?: AgentExecutionGrant;
}

export interface AgentGrantUseContext {
    now: number;
    currentPolicyRevision: number;
    currentRevocationGeneration: number;
    onlineAuthorityCurrent: boolean;
    vaultState?: "locked" | "unlocked" | "unknown";
    locked?: boolean;
    currentSessionId?: string;
    currentSessionGeneration?: string | number;
    currentRestartGeneration?: string | number;
}

const REPRESENTATION_RANK: Record<AgentRepresentation, number> = {
    "action-only": 0,
    derived: 1,
    coarse: 2,
    exact: 3,
};

const USER_FACING_MODE_MAP: Record<AgentUserFacingApprovalMode, AgentPublicApprovalMode> = {
    "plan-only": "plan",
    prompted: "manual",
    "standing-policy-automatic": "auto",
    "standing-policy automatic": "auto",
    noninteractive: "dontAsk",
    "noninteractive fail-closed": "dontAsk",
    "noninteractive-fail-closed": "dontAsk",
};

const KNOWN_AGENT_ROLES = new Set([
    "username",
    "password",
    "totp",
    "person.full_name",
    "person.first_name",
    "person.last_name",
    "contact.email",
    "contact.phone",
    "address.line1",
    "address.line2",
    "address.city",
    "address.region",
    "address.postal_code",
    "address.country",
    "payment.card.pan",
    "payment.card.cardholder_name",
    "payment.card.expiry",
    "payment.card.expiry_month",
    "payment.card.expiry_year",
    "payment.card.cvv_transient",
    "merchant.origin",
    "login.url",
    "government.ssn",
    "government.passport_number",
    "government.drivers_license_number",
    "government.national_id",
    "financial.account_number",
    "financial.routing_number",
    "financial.iban",
    "financial.bic",
]);

export function mapUserFacingAgentApprovalMode(
    mode: AgentUserFacingApprovalMode
): AgentPublicApprovalMode {
    const mapped = USER_FACING_MODE_MAP[mode];
    if (!mapped) throw new Error("Unsupported user-facing agent approval mode");
    return mapped;
}

export function isAgentApprovalMode(value: unknown): value is AgentApprovalMode {
    return value === "plan" || value === "manual" || value === "auto" || value === "dontAsk" || value === "bypassPrompts";
}

export function isAgentUserFacingApprovalMode(value: unknown): value is AgentUserFacingApprovalMode {
    return typeof value === "string" && Object.prototype.hasOwnProperty.call(USER_FACING_MODE_MAP, value);
}

export function agentReleaseClassForRole(role: string): AgentReleaseClass | null {
    if (!KNOWN_AGENT_ROLES.has(role)) return null;
    if (
        role === "payment.card.cvv_transient" ||
        role.startsWith("government.") ||
        role.startsWith("financial.")
    ) {
        return "high-risk";
    }
    if (
        role === "username" ||
        role === "password" ||
        role === "totp" ||
        role.startsWith("payment.card.")
    ) {
        return "secret";
    }
    return "low";
}

export function isAgentRoleKnown(role: string): boolean {
    return isKnownRole(role);
}

export function agentRequestRequiresFreshVerification(request: AgentPermissionRequest): boolean {
    if (
        request.isPasskey ||
        request.passkey ||
        request.newPaymentOrigin ||
        request.isNewPaymentOrigin ||
        request.policyChange ||
        request.isPolicyChange ||
        request.securityContext?.passkey ||
        request.securityContext?.isPasskey ||
        request.securityContext?.newPaymentOrigin ||
        request.securityContext?.isNewPaymentOrigin ||
        request.securityContext?.policyChange ||
        request.securityContext?.isPolicyChange
    ) {
        return true;
    }
    if (
        request.securityContext?.roles?.some(
            (role) =>
                agentReleaseClassForRole(role) === "high-risk" ||
                role === "passkey" ||
                role.startsWith("passkey.")
        )
    ) {
        return true;
    }
    return request.bindings.some((binding) => {
        const role = binding.role || binding.fieldRef || "";
        return (
            binding.releaseClass === "high-risk" ||
            agentReleaseClassForRole(role) === "high-risk" ||
            role === "passkey" ||
            role.startsWith("passkey.")
        );
    });
}

export function evaluateAgentPermission(input: AgentPermissionEvaluationInput): AgentPermissionDecision {
    const requestDigest = permissionRequestDigest(input.request);
    const base = {
        matchedPolicyIds: [] as string[],
        requestDigest,
        policyRevision: input.currentPolicyRevision,
        revocationGeneration: input.currentRevocationGeneration,
    };
    if (!isAgentApprovalMode(input.mode)) {
        return { ...base, outcome: "deny", reasonCode: "DENY_INTERNAL_MODE" };
    }
    if (!isAgentPermissionRequest(input.request, input.now)) {
        return { ...base, outcome: "deny", reasonCode: "DENY_INVALID_REQUEST" };
    }
    if (input.mode === "bypassPrompts") {
        return { ...base, outcome: "deny", reasonCode: "DENY_INTERNAL_MODE" };
    }
    if (input.vaultState && input.vaultState !== "unlocked") {
        return { ...base, outcome: "deny", reasonCode: "DENY_VAULT_LOCKED" };
    }
    if (input.currentSessionId && input.currentSessionId !== input.request.principal.sessionId) {
        return { ...base, outcome: "deny", reasonCode: "DENY_RESTARTED" };
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
    if (alwaysAsk) {
        if (input.mode === "manual" || input.mode === "auto") {
            return { ...policyBase, outcome: "ask", reasonCode: "ASK_ALWAYS", policyId: alwaysAsk.id };
        }
        return { ...policyBase, outcome: "deny", reasonCode: "DENY_CONFIRMATION_REQUIRED", policyId: alwaysAsk.id };
    }
    if (
        allow &&
        (allow.revision !== input.currentPolicyRevision ||
            allow.revocationGeneration !== input.currentRevocationGeneration)
    ) {
        return { ...policyBase, outcome: "deny", reasonCode: "DENY_REVOKED" };
    }
    if (input.mode === "plan" && input.request.operation === "describe") {
        return { ...policyBase, outcome: "allow", reasonCode: "ALLOW_PLAN_DESCRIPTION" };
    }
    if (input.mode === "plan") {
        return { ...policyBase, outcome: "deny", reasonCode: "DENY_PLAN_MODE" };
    }
    const needsConfirmation =
        input.request.enforcement.requiresFreshUserConfirmation ||
        agentRequestRequiresFreshVerification(input.request) ||
        Boolean(allow && allow.requiresFreshUserConfirmation);
    const confirmedRequestDigest = input.confirmedRequestDigest || input.freshVerification?.requestDigest;
    const verificationExpired =
        input.freshVerification?.expiresAt !== undefined &&
        (!Number.isFinite(Date.parse(input.freshVerification.expiresAt)) ||
            Date.parse(input.freshVerification.expiresAt) <= input.now);
    if (
        needsConfirmation &&
        (verificationExpired || confirmedRequestDigest !== requestDigest)
    ) {
        if (input.mode === "manual" || input.mode === "auto") {
            return {
                ...policyBase,
                outcome: "ask",
                reasonCode: "ASK_CONFIRMATION_REQUIRED",
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
        sessionGeneration: input.currentSessionGeneration,
        restartGeneration: input.currentRestartGeneration,
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
    assertGrantCurrent(record, context);
    const existing = record.reservations[attemptId];
    if (existing) return cloneGrantRecord(record);
    if (record.reservedUses >= record.grant.maxUses) throw new Error("Execution grant use limit reached");
    const next = cloneGrantRecord(record);
    next.reservations[attemptId] = "reserved";
    next.reservedUses += 1;
    next.status = "reserved";
    return next;
}

export function beginAgentGrantUse(
    record: AgentExecutionGrantRecord,
    attemptId: string,
    context?: AgentGrantUseContext
): AgentExecutionGrantRecord {
    if (record.reservations[attemptId] !== "reserved") throw new Error("Execution grant use is not reserved");
    if (context) assertGrantCurrent(record, context);
    const next = cloneGrantRecord(record);
    next.reservations[attemptId] = "executing";
    next.status = "executing";
    return next;
}

export function completeAgentGrantUse(
    record: AgentExecutionGrantRecord,
    attemptId: string,
    outcome: "completed" | "partial" | "outcome-unknown",
    context?: AgentGrantUseContext
): AgentExecutionGrantRecord {
    if (record.reservations[attemptId] !== "executing") throw new Error("Execution grant use is not executing");
    if (context) assertGrantCurrent(record, context);
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
        if (
            request.bindings.some((binding) => {
                if (binding.role !== undefined && !isKnownRole(binding.role)) return true;
                if (binding.releaseClass !== undefined && !isReleaseClass(binding.releaseClass)) return true;
                if (binding.transactionOnly !== undefined && typeof binding.transactionOnly !== "boolean") return true;
                const role = binding.role || binding.fieldRef;
                if (!role) return false;
                const expectedClass = agentReleaseClassForRole(role);
                if (expectedClass && binding.releaseClass && expectedClass !== binding.releaseClass) return true;
                if (role === "payment.card.cvv_transient" && binding.transactionOnly === false) return true;
                return false;
            })
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
        if (request.securityContext !== undefined) {
            const security = request.securityContext;
            if (typeof security !== "object" || security === null) return false;
            for (const flag of [
                security.passkey,
                security.isPasskey,
                security.newPaymentOrigin,
                security.isNewPaymentOrigin,
                security.policyChange,
                security.isPolicyChange,
            ]) {
                if (flag !== undefined && typeof flag !== "boolean") return false;
            }
            if (
                security.roles !== undefined &&
                (!Array.isArray(security.roles) || security.roles.some((role) => !isKnownRole(role)))
            ) {
                return false;
            }
        }
        for (const flag of [
            request.passkey,
            request.isPasskey,
            request.newPaymentOrigin,
            request.isNewPaymentOrigin,
            request.policyChange,
            request.isPolicyChange,
        ]) {
            if (flag !== undefined && typeof flag !== "boolean") return false;
        }
        return true;
    } catch {
        return false;
    }
}

export function isAgentStandingPolicy(value: unknown): value is AgentStandingPolicy {
    try {
        const policy = value as AgentStandingPolicy;
        if (
            !policy ||
            typeof policy !== "object" ||
            !policy.id ||
            !Number.isInteger(policy.revision) ||
            policy.revision < 0 ||
            !Number.isInteger(policy.revocationGeneration) ||
            policy.revocationGeneration < 0 ||
            (policy.status !== "active" && policy.status !== "revoked") ||
            (policy.effect !== "allow" && policy.effect !== "deny" && policy.effect !== "alwaysAsk") ||
            !Array.isArray(policy.operations) ||
            policy.operations.some((operation) => !["describe", "fill", "authenticate", "derive", "reveal", "submit"].includes(operation)) ||
            !Array.isArray(policy.initiatingOrigins) ||
            policy.initiatingOrigins.some((origin) => !isExactOrigin(origin)) ||
            !Array.isArray(policy.sourceRefs) ||
            policy.sourceRefs.some((sourceRef) => !sourceRef) ||
            (policy.fieldRefs !== undefined &&
                (!Array.isArray(policy.fieldRefs) || policy.fieldRefs.some((fieldRef) => !fieldRef))) ||
            (policy.roles !== undefined &&
                (!Array.isArray(policy.roles) || policy.roles.some((role) => !isKnownRole(role)))) ||
            !Array.isArray(policy.recipients) ||
            policy.recipients.some((recipient) => !isRecipientValid(recipient)) ||
            !Array.isArray(policy.representations) ||
            policy.representations.some((representation) => !["action-only", "derived", "coarse", "exact"].includes(representation))
        ) {
            return false;
        }
        if (policy.approvalModes !== undefined) {
            if (!Array.isArray(policy.approvalModes) || policy.approvalModes.some((mode) => !isAgentApprovalMode(mode))) {
                return false;
            }
        }
        if (policy.expiresAt !== undefined && !Number.isFinite(Date.parse(policy.expiresAt))) return false;
        if (policy.target !== undefined && !isTargetValid(policy.target)) return false;
        return policy.requiresFreshUserConfirmation === undefined || typeof policy.requiresFreshUserConfirmation === "boolean";
    } catch {
        return false;
    }
}

function isPrincipalValid(principal: AgentPrincipal): boolean {
    return Boolean(principal && principal.userId && principal.sessionId && isExactOrigin(principal.initiatingOrigin));
}

function isKnownRole(role: string): boolean {
    return (
        KNOWN_AGENT_ROLES.has(role) ||
        role === "passkey" ||
        role.startsWith("passkey.")
    );
}

function isReleaseClass(value: unknown): value is AgentReleaseClass {
    return value === "low" || value === "secret" || value === "high-risk";
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
    if (!isAgentStandingPolicy(policy)) return false;
    if (!policy.operations.includes(request.operation)) return false;
    if (!policy.initiatingOrigins.includes(request.principal.initiatingOrigin)) return false;
    if (!policy.representations.includes(request.representation)) return false;
    if (!policy.recipients.some((recipient) => recipientsEqual(recipient, request.recipient))) return false;
    if (
        request.operation !== "describe" &&
        request.operation !== "submit" &&
        !policy.fieldRefs &&
        !policy.roles
    ) {
        return false;
    }
    if (!request.bindings.every((binding) => policy.sourceRefs.includes(binding.sourceRef))) return false;
    if (
        policy.fieldRefs &&
        !request.bindings.every((binding) => binding.fieldRef && policy.fieldRefs!.includes(binding.fieldRef))
    ) {
        return false;
    }
    if (
        policy.roles &&
        !request.bindings.every((binding) => binding.role && policy.roles!.includes(binding.role))
    ) {
        return false;
    }
    if (policy.target && (!request.target || !targetsEqual(request.target, policy.target))) return false;
    if (policy.status === "revoked") return true;
    if (policy.expiresAt && Date.parse(policy.expiresAt) <= now) return false;
    if (
        policy.effect === "allow" &&
        policy.approvalModes &&
        !policy.approvalModes.includes(mode)
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
    if (context.vaultState && context.vaultState !== "unlocked") {
        throw new Error("Execution grant unavailable while vault is locked");
    }
    if (context.locked) throw new Error("Execution grant unavailable while vault is locked");
    if (context.currentSessionId && context.currentSessionId !== record.grant.principal.sessionId) {
        throw new Error("Execution grant belongs to a restarted session");
    }
    if (
        context.currentSessionGeneration !== undefined &&
        context.currentSessionGeneration !== record.grant.sessionGeneration
    ) {
        throw new Error("Execution grant belongs to a restarted session");
    }
    if (
        context.currentRestartGeneration !== undefined &&
        context.currentRestartGeneration !== record.grant.restartGeneration
    ) {
        throw new Error("Execution grant belongs to a restarted worker");
    }
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
