import { PasskeyApprovalMode, PasskeyCredentialPolicy } from "../../core/src/item";

export const AUTOFILL_BROKER_PROTOCOL_VERSION = 1;

export type AutofillBrokerOperation =
    | "status"
    | "classify"
    | "plan-fill"
    | "approve"
    | "mint-fill-bundle"
    | "apply-fill-bundle"
    | "revoke-fill-bundle"
    | "enroll-passkey"
    | "request-assertion";

export interface AutofillBrokerBinding {
    sessionId: string;
    origin: string;
    frameId?: string;
    fieldHashes?: string[];
    flowId?: string;
    nonce?: string;
    rpId?: string;
    topOrigin?: string;
    expiresAt?: string;
    profileId?: string;
    accountId?: string;
    vendor?: string;
}

export interface PasskeyEnrollmentRequest {
    itemName?: string;
    vaultId?: string;
    tags?: string[];
    rpId: string;
    userHandle?: string;
    algorithm?: string;
    topOrigin?: string;
    vendor?: string;
    policy: PasskeyCredentialPolicy;
}

export interface PasskeyAssertionRequest {
    credentialId: string;
    rpId: string;
    topOrigin: string;
    challenge?: string;
    clientDataHash?: string;
    flowId?: string;
    profileId?: string;
    accountId?: string;
    vendor?: string;
    approvalId?: string;
    nonce?: string;
}

export interface AutofillBrokerRequest {
    type: AutofillBrokerOperation;
    protocolVersion: 1;
    requestId?: string;
    binding?: AutofillBrokerBinding;
    fields?: Array<{
        selector: string;
        label?: string;
        role?: string;
        autocomplete?: string;
        fieldHash?: string;
        finalSubmit?: boolean;
    }>;
    planId?: string;
    approvalId?: string;
    bundleId?: string;
    approved?: boolean;
    ttlSeconds?: number;
    valuePolicy?: string;
    passkey?: PasskeyEnrollmentRequest | PasskeyAssertionRequest;
}

export interface AutofillBrokerPlanField {
    selector: string;
    role: string;
    fieldHash: string;
    itemId: string;
    itemName: string;
    fieldIndex: number;
    fieldName: string;
    valuePreview: string;
    transactionOnly: boolean;
}

export interface AutofillBrokerBundleField {
    selector: string;
    role: string;
    fieldHash: string;
    value: string;
    transactionOnly: boolean;
}

export interface PasskeyRegistrationPayload {
    credentialId: string;
    rpId: string;
    algorithm: string;
    userHandle: string;
    createdAt: string;
    publicKeySpki: string;
    publicKeyJwk?: Record<string, unknown>;
    credentialPublicKeyCose: string;
    authenticatorData: string;
    attestationObject: string;
    policy: {
        approval: PasskeyApprovalMode;
        requireFlowBinding: boolean;
    };
}

export interface PasskeyAssertionPayload {
    credentialId: string;
    authenticatorData: string;
    signature: string;
    userHandle: string;
    signCount: number;
}

export interface PasskeyRateLimitState {
    dayCount: number;
    weekCount: number;
    maxPerDay: number | null;
    maxPerWeek: number | null;
}

export interface PasskeyBrokerResponsePayload {
    itemId?: string;
    itemName?: string;
    rpId?: string;
    topOrigin?: string;
    vendor?: string | null;
    flowId?: string | null;
    nonce?: string | null;
    approval?: PasskeyApprovalMode;
    registration?: PasskeyRegistrationPayload;
    assertion?: PasskeyAssertionPayload;
    decision?: "allow" | "deny";
    reasonCode?: string | null;
    rateLimit?: PasskeyRateLimitState;
}

export interface BrokerAudit {
    operation: AutofillBrokerOperation;
    sessionId: string | null;
    origin: string | null;
    fieldCount: number;
    valuePolicy: string;
    actor?: string | null;
    profileId?: string | null;
    vendor?: string | null;
    rpId?: string | null;
    topOrigin?: string | null;
    decision?: "allow" | "deny" | null;
    reason?: string | null;
    approvalId?: string | null;
    flowId?: string | null;
    nonce?: string | null;
    rateLimit?: PasskeyRateLimitState;
}

export interface AutofillBrokerResponse {
    ok: boolean;
    protocolVersion: 1;
    requestId?: string;
    vaultState: "locked" | "unlocked" | "unknown";
    reason: string | null;
    planId?: string;
    approvalId?: string;
    bundleId?: string;
    expiresAt?: string;
    fields?: AutofillBrokerPlanField[];
    bundleFields?: AutofillBrokerBundleField[];
    passkey?: PasskeyBrokerResponsePayload;
    audit: BrokerAudit;
}

const SENSITIVE_KEY_PATTERN = /(^value$|secret|private[_-]?key)/i;

export function buildLockedBrokerResponse(request: AutofillBrokerRequest): AutofillBrokerResponse {
    const passkey = request.passkey || null;
    return {
        ok: request.type === "status",
        protocolVersion: AUTOFILL_BROKER_PROTOCOL_VERSION,
        requestId: request.requestId,
        vaultState: "locked",
        reason: request.type === "status" ? null : "Padloc vault locked or approval UI unavailable",
        audit: {
            operation: request.type,
            sessionId: request.binding ? request.binding.sessionId : null,
            origin: request.binding ? request.binding.origin : null,
            fieldCount: request.fields ? request.fields.length : 0,
            valuePolicy: "redacted audit only; no raw autofill values or passkey secrets",
            profileId: request.binding?.profileId || readPasskeyAuditString(passkey, "profileId"),
            vendor: request.binding?.vendor || readPasskeyAuditString(passkey, "vendor"),
            rpId: request.binding?.rpId || readPasskeyAuditString(passkey, "rpId"),
            topOrigin: request.binding?.topOrigin || readPasskeyAuditString(passkey, "topOrigin"),
            flowId: request.binding?.flowId || readPasskeyAuditString(passkey, "flowId"),
            nonce: request.binding?.nonce || readPasskeyAuditString(passkey, "nonce"),
        },
    };
}

export function hasSensitivePayloadValue(payload: unknown): boolean {
    return findSensitivePayloadPath(payload) !== null;
}

export function findSensitivePayloadPath(payload: unknown, path = "root"): string | null {
    if (!payload || typeof payload !== "object") return null;
    if (Array.isArray(payload)) {
        for (let index = 0; index < payload.length; index += 1) {
            const found = findSensitivePayloadPath(payload[index], `${path}[${index}]`);
            if (found) return found;
        }
        return null;
    }
    for (const [key, value] of Object.entries(payload as Record<string, unknown>)) {
        const nextPath = `${path}.${key}`;
        if (SENSITIVE_KEY_PATTERN.test(key) && hasNonEmptySensitiveValue(value)) {
            return nextPath;
        }
        const found = findSensitivePayloadPath(value, nextPath);
        if (found) return found;
    }
    return null;
}

function hasNonEmptySensitiveValue(value: unknown): boolean {
    if (value === undefined || value === null) return false;
    if (typeof value === "string") return value !== "";
    if (typeof value === "number" || typeof value === "boolean") return true;
    if (Array.isArray(value)) return value.length > 0;
    if (typeof value === "object") return Object.keys(value as Record<string, unknown>).length > 0;
    return true;
}

function readPasskeyAuditString(
    passkey: AutofillBrokerRequest["passkey"] | null,
    key: "profileId" | "vendor" | "rpId" | "topOrigin" | "flowId" | "nonce"
): string | null {
    if (!passkey) return null;
    const value = (passkey as unknown as Record<string, unknown>)[key];
    return typeof value === "string" && value ? value : null;
}
