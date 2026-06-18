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
    frameId: string;
    fieldHashes: string[];
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
    audit: {
        operation: AutofillBrokerOperation;
        sessionId: string | null;
        origin: string | null;
        fieldCount: number;
        valuePolicy: string;
    };
}

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
            valuePolicy: "redacted audit only; no raw autofill values",
        },
    };
}
