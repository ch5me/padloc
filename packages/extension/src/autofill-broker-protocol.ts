export const AUTOFILL_BROKER_PROTOCOL_VERSION = 1;

export type AutofillBrokerOperation =
    | "status"
    | "classify"
    | "plan-fill"
    | "approve"
    | "mint-fill-bundle"
    | "apply-fill-bundle"
    | "revoke-fill-bundle";

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
    audit: BrokerAudit;
}

const SENSITIVE_KEY_PATTERN = /(^value$|secret|private[_-]?key)/i;

export function buildLockedBrokerResponse(request: AutofillBrokerRequest): AutofillBrokerResponse {
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
            profileId: request.binding?.profileId,
            vendor: request.binding?.vendor,
            rpId: request.binding?.rpId,
            topOrigin: request.binding?.topOrigin,
            flowId: request.binding?.flowId,
            nonce: request.binding?.nonce,
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
