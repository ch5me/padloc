import { parseImportResult } from "@padloc/core/src/import-result";

export const AUTOFILL_BROKER_PROTOCOL_VERSION = 2 as const;
export const AUTOFILL_BROKER_PROTOCOL_V1 = 1 as const;
export const AUTOFILL_BROKER_RESPONSE_SCHEMA = "elf.padloc-broker-response.v2" as const;
export const AUTOFILL_BROKER_ERROR_SCHEMA = "elf.padloc-broker-error.v1" as const;

export type AutofillBrokerOperation =
    | "status"
    | "classify"
    | "plan-fill"
    | "approve"
    | "mint-fill-bundle"
    | "apply-fill-bundle"
    | "revoke-fill-bundle"
    | "privacy-status"
    | "autofill-observation-reset"
    | "permissions-explain"
    | "request-reveal"
    | "read-approved"
    | "submit"
    | "import-begin"
    | "import-commit";

export interface AutofillBrokerBinding {
    sessionId: string;
    origin: string;
    frameId?: number | string;
    fieldHashes?: string[];
    flowId?: string;
    nonce?: string;
    rpId?: string;
    topOrigin?: string;
    expiresAt?: string;
    profileId?: string;
    accountId?: string;
    vendor?: string;
    documentId?: string;
    formRef?: string;
    targetRevision?: string;
}

export interface AutofillBrokerRequest {
    type: AutofillBrokerOperation;
    protocolVersion: 1 | 2;
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
    consentNonce?: string;
    envelope?: unknown;
    target?: AutofillBrokerTarget;
}

export interface AutofillBrokerPlanField {
    fieldRef: string;
    role: string;
    sourceRef: string;
    transactionOnly: boolean;
    releaseClass?: "low" | "secret" | "high-risk";
}

export interface AutofillBrokerTarget {
    tabId: number;
    frameId: number;
    origin: string;
    documentId: string;
    formRef: string;
    targetRevision: string;
    sessionId: string;
    topOrigin: string;
    frameOrigin: string;
}

export interface ExactAutofillBrokerTarget {
    tabId: number;
    frameId: number;
    origin: string;
    documentId: string;
    formRef: string;
    targetRevision: string;
    sessionId: string;
    topOrigin: string;
    frameOrigin: string;
}

export interface AutofillBrokerReceipt {
    receiptId: string;
    status: "completed" | "partial" | "revoked" | "outcome-unknown";
    filledFieldRefs: string[];
    modelDisclosure: "none" | "approved";
    submittedByExecutor: boolean;
}

export interface AutofillBrokerObservationState {
    documentId: string;
    state: "clean" | "potentially-private" | "unknown";
    genericObservation: "allowed" | "blocked" | "requires-separate-disclosure";
    observationRevision?: number;
    reason?: string;
    contaminatedAt?: string;
    target?: ExactAutofillBrokerTarget;
}

export interface AutofillBrokerInspectedField {
    selector: string;
    role: string;
    fieldRef: string;
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
    grantId?: string | null;
    receiptId?: string | null;
    reasonCode?: string | null;
    flowId?: string | null;
    nonce?: string | null;
}

/**
 * This is the v1 compatibility shape. It remains readable for old clients,
 * but it never grants authority to the caller.
 */
export interface AutofillBrokerResponse {
    ok: boolean;
    protocolVersion: 1 | 2;
    requestId?: string;
    vaultState: "locked" | "unlocked" | "unknown";
    reason: string | null;
    schema?: typeof AUTOFILL_BROKER_RESPONSE_SCHEMA;
    kind?: AutofillBrokerResponseV2["kind"];
    planId?: string;
    approvalId?: string;
    bundleId?: string;
    grantId?: string;
    expiresAt?: string;
    maxUses?: number;
    fields?: AutofillBrokerPlanField[];
    target?: AutofillBrokerTarget;
    receipt?: AutofillBrokerReceipt;
    observation?: AutofillBrokerObservationState;
    error?: AutofillBrokerError;
    result?: unknown;
    authorizing?: false;
    audit: BrokerAudit;
}

export type AutofillBrokerResponseKind =
    | "status"
    | "classified"
    | "plan"
    | "approval-required"
    | "granted"
    | "applied"
    | "revoked"
    | "privacy-status"
    | "import-result"
    | "error";

export type AutofillBrokerErrorCode =
    | "LOCKED"
    | "DENIED"
    | "ASK_REQUIRED"
    | "TARGET_MISMATCH"
    | "STALE"
    | "UNKNOWN_PRIVACY"
    | "POTENTIALLY_PRIVATE"
    | "INVALID_REQUEST"
    | "UNKNOWN_KEY"
    | "UNSUPPORTED"
    | "EXPIRED"
    | "REVOKED";

export interface AutofillBrokerError {
    schema: typeof AUTOFILL_BROKER_ERROR_SCHEMA;
    code: AutofillBrokerErrorCode;
    retryable: boolean;
    safeMessage?: string;
}

export interface AutofillBrokerResponseV2Base {
    schema: typeof AUTOFILL_BROKER_RESPONSE_SCHEMA;
    protocolVersion: 2;
    requestId: string;
    ok: boolean;
}

export interface AutofillBrokerStatusResponseV2 extends AutofillBrokerResponseV2Base {
    kind: "status";
    vaultState: "locked" | "unlocked" | "unknown";
    target?: ExactAutofillBrokerTarget;
}

export interface AutofillBrokerClassifiedResponseV2 extends AutofillBrokerResponseV2Base {
    kind: "classified";
    target: ExactAutofillBrokerTarget;
    fields: AutofillBrokerInspectedField[];
}

export interface AutofillBrokerPlanResponseV2 extends AutofillBrokerResponseV2Base {
    kind: "plan";
    target: ExactAutofillBrokerTarget;
    planId: string;
    fields: AutofillBrokerPlanField[];
    expiresAt: string;
}

export interface AutofillBrokerApprovalRequiredResponseV2 extends AutofillBrokerResponseV2Base {
    kind: "approval-required";
    target: ExactAutofillBrokerTarget;
    planId: string;
    reasonCode: string;
    mode: "plan" | "manual" | "auto" | "dontAsk";
}

export interface AutofillBrokerGrantedResponseV2 extends AutofillBrokerResponseV2Base {
    kind: "granted";
    target: ExactAutofillBrokerTarget;
    grantId: string;
    planId: string;
    expiresAt: string;
    maxUses: number;
}

export interface AutofillBrokerAppliedResponseV2 extends AutofillBrokerResponseV2Base {
    kind: "applied";
    target: ExactAutofillBrokerTarget;
    grantId: string;
    receipt: AutofillBrokerReceipt;
}

export interface AutofillBrokerRevokedResponseV2 extends AutofillBrokerResponseV2Base {
    kind: "revoked";
    target: ExactAutofillBrokerTarget;
    grantId: string;
    status: "revoked";
}

export interface AutofillBrokerPrivacyStatusResponseV2 extends AutofillBrokerResponseV2Base {
    kind: "privacy-status";
    target: ExactAutofillBrokerTarget;
    state: "unknown" | "clean" | "potentially-private";
    observationRevision: number;
    genericObservation: "allowed" | "blocked" | "requires-separate-disclosure";
}

export interface AutofillBrokerImportResultResponseV2 extends AutofillBrokerResponseV2Base {
    kind: "import-result";
    result: unknown;
    target?: ExactAutofillBrokerTarget;
}

export interface AutofillBrokerErrorResponseV2 extends AutofillBrokerResponseV2Base {
    kind: "error";
    error: AutofillBrokerError;
    target?: ExactAutofillBrokerTarget;
}

export type AutofillBrokerResponseV2 =
    | AutofillBrokerStatusResponseV2
    | AutofillBrokerClassifiedResponseV2
    | AutofillBrokerPlanResponseV2
    | AutofillBrokerApprovalRequiredResponseV2
    | AutofillBrokerGrantedResponseV2
    | AutofillBrokerAppliedResponseV2
    | AutofillBrokerRevokedResponseV2
    | AutofillBrokerPrivacyStatusResponseV2
    | AutofillBrokerImportResultResponseV2
    | AutofillBrokerErrorResponseV2;

const SENSITIVE_KEY_PATTERN = /(^value$|secret|private[_-]?key|ciphertext|wrappedkey)/i;
const RESPONSE_SHARED_KEYS = new Set(["schema", "kind", "protocolVersion", "requestId", "ok"]);
const TARGET_KEYS = new Set([
    "tabId",
    "frameId",
    "origin",
    "documentId",
    "formRef",
    "targetRevision",
    "sessionId",
    "topOrigin",
    "frameOrigin",
]);
const INSPECTED_FIELD_KEYS = new Set(["selector", "role", "fieldRef"]);
const PLAN_FIELD_KEYS = new Set(["fieldRef", "role", "sourceRef", "transactionOnly", "releaseClass"]);
const RECEIPT_KEYS = new Set(["receiptId", "status", "filledFieldRefs", "modelDisclosure", "submittedByExecutor"]);
const ERROR_KEYS = new Set(["schema", "code", "retryable", "safeMessage"]);
const RESPONSE_KINDS = new Set<AutofillBrokerResponseKind>([
    "status",
    "classified",
    "plan",
    "approval-required",
    "granted",
    "applied",
    "revoked",
    "privacy-status",
    "import-result",
    "error",
]);

export function buildLockedBrokerResponse(request: AutofillBrokerRequest): AutofillBrokerResponse {
    if (request.protocolVersion === 2) {
        if (request.type !== "status") {
            return {
                schema: AUTOFILL_BROKER_RESPONSE_SCHEMA,
                kind: "error",
                protocolVersion: 2,
                requestId: request.requestId || "missing-request-id",
                ok: false,
                error: {
                    schema: AUTOFILL_BROKER_ERROR_SCHEMA,
                    code: "LOCKED",
                    retryable: true,
                    safeMessage: "Elf Vault is locked or approval UI is unavailable",
                },
            } as unknown as AutofillBrokerResponse;
        }
        return {
            schema: AUTOFILL_BROKER_RESPONSE_SCHEMA,
            kind: "status",
            protocolVersion: 2,
            requestId: request.requestId || "missing-request-id",
            ok: request.type === "status",
            vaultState: "locked",
        } as unknown as AutofillBrokerResponse;
    }
    return {
        ok: request.type === "status",
        protocolVersion: 1,
        requestId: request.requestId,
        vaultState: "locked",
        reason: request.type === "status" ? null : "Elf Vault is locked or approval UI is unavailable",
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

export function buildUnlockedBrokerStatusResponse(request: AutofillBrokerRequest): AutofillBrokerResponse {
    if (request.protocolVersion === 2) {
        return {
            schema: AUTOFILL_BROKER_RESPONSE_SCHEMA,
            kind: "status",
            protocolVersion: 2,
            requestId: request.requestId || "missing-request-id",
            ok: true,
            vaultState: "unlocked",
        } as unknown as AutofillBrokerResponse;
    }
    return {
        ...buildLockedBrokerResponse(request),
        vaultState: "unlocked",
        reason: null,
    };
}

export function buildV2ErrorResponse(
    requestId: string,
    code: AutofillBrokerErrorCode,
    retryable: boolean,
    safeMessage?: string,
    target?: ExactAutofillBrokerTarget
): AutofillBrokerErrorResponseV2 {
    const error: AutofillBrokerError = {
        schema: AUTOFILL_BROKER_ERROR_SCHEMA,
        code,
        retryable,
        ...(safeMessage ? { safeMessage } : {}),
    };
    return {
        schema: AUTOFILL_BROKER_RESPONSE_SCHEMA,
        kind: "error",
        protocolVersion: 2,
        requestId,
        ok: false,
        error,
        ...(target ? { target } : {}),
    };
}

export function isExactAutofillBrokerTarget(value: unknown): value is ExactAutofillBrokerTarget {
    if (!isRecord(value) || !hasExactlyKeys(value, TARGET_KEYS)) return false;
    return (
        isNonNegativeInteger(value.tabId) &&
        isNonNegativeInteger(value.frameId) &&
        isNonEmptyString(value.origin) &&
        isNonEmptyString(value.documentId) &&
        isNonEmptyString(value.formRef) &&
        isNonEmptyString(value.targetRevision) &&
        isNonEmptyString(value.sessionId) &&
        isExactHttpOrigin(value.origin) &&
        isExactHttpOrigin(value.topOrigin) &&
        isExactHttpOrigin(value.frameOrigin) &&
        value.origin === value.frameOrigin
    );
}

export function parseAutofillBrokerResponse(value: unknown): AutofillBrokerResponseV2 | AutofillBrokerResponse {
    if (!isRecord(value)) throw invalidResponse();
    if (value.protocolVersion === 1) return readProtocolV1Response(value);
    return parseAutofillBrokerResponseV2(value);
}

export function assertAutofillBrokerResponseV2(value: unknown): AutofillBrokerResponseV2 {
    return parseAutofillBrokerResponseV2(value);
}

export function isAutofillBrokerResponseV2(value: unknown): value is AutofillBrokerResponseV2 {
    try {
        parseAutofillBrokerResponseV2(value);
        return true;
    } catch {
        return false;
    }
}

/**
 * v1 is retained only for compatibility reads. It is never used as an
 * approval, grant, receipt, or privacy authorization.
 */
export function readProtocolV1Response(value: unknown): AutofillBrokerResponse {
    if (!isRecord(value) || value.protocolVersion !== 1) throw invalidResponse();
    if (typeof value.ok !== "boolean") throw invalidResponse();
    if (value.requestId !== undefined && !isNonEmptyString(value.requestId)) throw invalidResponse();
    const legacy = value as unknown as AutofillBrokerResponse;
    return { ...legacy, authorizing: false };
}

export function isProtocolV1NonAuthorizing(value: unknown): value is AutofillBrokerResponse {
    try {
        return readProtocolV1Response(value).authorizing === false;
    } catch {
        return false;
    }
}

function parseAutofillBrokerResponseV2(value: unknown): AutofillBrokerResponseV2 {
    if (!isRecord(value) || !Array.from(RESPONSE_SHARED_KEYS).every((key) => key in value)) {
        throw invalidResponse();
    }
    if (
        value.schema !== AUTOFILL_BROKER_RESPONSE_SCHEMA ||
        value.protocolVersion !== 2 ||
        !isNonEmptyString(value.requestId) ||
        typeof value.ok !== "boolean" ||
        typeof value.kind !== "string" ||
        !RESPONSE_KINDS.has(value.kind as AutofillBrokerResponseKind)
    ) {
        throw invalidResponse();
    }
    switch (value.kind as AutofillBrokerResponseKind) {
        case "status":
            return parseStatusResponse(value);
        case "classified":
            return parseClassifiedResponse(value);
        case "plan":
            return parsePlanResponse(value);
        case "approval-required":
            return parseApprovalRequiredResponse(value);
        case "granted":
            return parseGrantedResponse(value);
        case "applied":
            return parseAppliedResponse(value);
        case "revoked":
            return parseRevokedResponse(value);
        case "privacy-status":
            return parsePrivacyStatusResponse(value);
        case "import-result":
            return parseImportResultResponse(value);
        case "error":
            return parseErrorResponse(value);
    }
}

function parseStatusResponse(value: Record<string, unknown>): AutofillBrokerStatusResponseV2 {
    expectKeys(value, new Set([...RESPONSE_SHARED_KEYS, "kind", "target", "vaultState"]));
    if (!["locked", "unlocked", "unknown"].includes(String(value.vaultState))) throw invalidResponse();
    if (value.target !== undefined && !isExactAutofillBrokerTarget(value.target)) throw invalidResponse();
    return value as unknown as AutofillBrokerStatusResponseV2;
}

function parseClassifiedResponse(value: Record<string, unknown>): AutofillBrokerClassifiedResponseV2 {
    expectKeys(value, new Set([...RESPONSE_SHARED_KEYS, "kind", "target", "fields"]));
    if (!isExactAutofillBrokerTarget(value.target) || !Array.isArray(value.fields)) throw invalidResponse();
    for (const field of value.fields) {
        if (!isRecord(field) || !hasExactlyKeys(field, INSPECTED_FIELD_KEYS)) throw invalidResponse();
        if (![field.selector, field.role, field.fieldRef].every(isNonEmptyString)) throw invalidResponse();
    }
    return value as unknown as AutofillBrokerClassifiedResponseV2;
}

function parsePlanResponse(value: Record<string, unknown>): AutofillBrokerPlanResponseV2 {
    expectKeys(value, new Set([...RESPONSE_SHARED_KEYS, "kind", "target", "planId", "fields", "expiresAt"]));
    if (
        !isExactAutofillBrokerTarget(value.target) ||
        !isNonEmptyString(value.planId) ||
        !isIsoDateString(value.expiresAt) ||
        !Array.isArray(value.fields)
    ) {
        throw invalidResponse();
    }
    for (const field of value.fields) parsePlanField(field);
    return value as unknown as AutofillBrokerPlanResponseV2;
}

function parseApprovalRequiredResponse(value: Record<string, unknown>): AutofillBrokerApprovalRequiredResponseV2 {
    expectKeys(value, new Set([...RESPONSE_SHARED_KEYS, "kind", "target", "planId", "reasonCode", "mode"]));
    if (
        !isExactAutofillBrokerTarget(value.target) ||
        !isNonEmptyString(value.planId) ||
        !isNonEmptyString(value.reasonCode) ||
        !["plan", "manual", "auto", "dontAsk"].includes(String(value.mode))
    ) {
        throw invalidResponse();
    }
    return value as unknown as AutofillBrokerApprovalRequiredResponseV2;
}

function parseGrantedResponse(value: Record<string, unknown>): AutofillBrokerGrantedResponseV2 {
    expectKeys(value, new Set([...RESPONSE_SHARED_KEYS, "kind", "target", "grantId", "planId", "expiresAt", "maxUses"]));
    if (
        !isExactAutofillBrokerTarget(value.target) ||
        !isNonEmptyString(value.grantId) ||
        !isNonEmptyString(value.planId) ||
        !isIsoDateString(value.expiresAt) ||
        !isNonNegativeInteger(value.maxUses)
    ) {
        throw invalidResponse();
    }
    return value as unknown as AutofillBrokerGrantedResponseV2;
}

function parseAppliedResponse(value: Record<string, unknown>): AutofillBrokerAppliedResponseV2 {
    expectKeys(value, new Set([...RESPONSE_SHARED_KEYS, "kind", "target", "grantId", "receipt"]));
    if (!isExactAutofillBrokerTarget(value.target) || !isNonEmptyString(value.grantId)) throw invalidResponse();
    parseReceipt(value.receipt);
    return value as unknown as AutofillBrokerAppliedResponseV2;
}

function parseRevokedResponse(value: Record<string, unknown>): AutofillBrokerRevokedResponseV2 {
    expectKeys(value, new Set([...RESPONSE_SHARED_KEYS, "kind", "target", "grantId", "status"]));
    if (
        !isExactAutofillBrokerTarget(value.target) ||
        !isNonEmptyString(value.grantId) ||
        value.status !== "revoked"
    ) {
        throw invalidResponse();
    }
    return value as unknown as AutofillBrokerRevokedResponseV2;
}

function parsePrivacyStatusResponse(value: Record<string, unknown>): AutofillBrokerPrivacyStatusResponseV2 {
    expectKeys(
        value,
        new Set([...RESPONSE_SHARED_KEYS, "kind", "target", "state", "observationRevision", "genericObservation"])
    );
    if (
        !isExactAutofillBrokerTarget(value.target) ||
        !["unknown", "clean", "potentially-private"].includes(String(value.state)) ||
        !isNonNegativeInteger(value.observationRevision) ||
        !["allowed", "blocked", "requires-separate-disclosure"].includes(String(value.genericObservation))
    ) {
        throw invalidResponse();
    }
    return value as unknown as AutofillBrokerPrivacyStatusResponseV2;
}

function parseImportResultResponse(value: Record<string, unknown>): AutofillBrokerImportResultResponseV2 {
    expectKeys(value, new Set([...RESPONSE_SHARED_KEYS, "kind", "result", "target"]));
    parseImportResult(value.result);
    if (value.target !== undefined && !isExactAutofillBrokerTarget(value.target)) throw invalidResponse();
    return value as unknown as AutofillBrokerImportResultResponseV2;
}

function parseErrorResponse(value: Record<string, unknown>): AutofillBrokerErrorResponseV2 {
    expectKeys(value, new Set([...RESPONSE_SHARED_KEYS, "kind", "error", "target"]));
    parseError(value.error);
    if (value.ok !== false) throw invalidResponse();
    if (value.target !== undefined && !isExactAutofillBrokerTarget(value.target)) throw invalidResponse();
    return value as unknown as AutofillBrokerErrorResponseV2;
}

function parsePlanField(value: unknown): AutofillBrokerPlanField {
    if (!isRecord(value) || !hasExactlyKeys(value, PLAN_FIELD_KEYS)) throw invalidResponse();
    if (
        !isNonEmptyString(value.fieldRef) ||
        !isNonEmptyString(value.role) ||
        !isNonEmptyString(value.sourceRef) ||
        typeof value.transactionOnly !== "boolean" ||
        !["low", "secret", "high-risk"].includes(String(value.releaseClass))
    ) {
        throw invalidResponse();
    }
    return value as unknown as AutofillBrokerPlanField;
}

function parseReceipt(value: unknown): AutofillBrokerReceipt {
    if (!isRecord(value) || !hasExactlyKeys(value, RECEIPT_KEYS)) throw invalidResponse();
    if (
        !isNonEmptyString(value.receiptId) ||
        !["completed", "partial", "revoked", "outcome-unknown"].includes(String(value.status)) ||
        !Array.isArray(value.filledFieldRefs) ||
        value.filledFieldRefs.some((entry) => !isNonEmptyString(entry)) ||
        !["none", "approved"].includes(String(value.modelDisclosure)) ||
        typeof value.submittedByExecutor !== "boolean"
    ) {
        throw invalidResponse();
    }
    return value as unknown as AutofillBrokerReceipt;
}

function parseError(value: unknown): AutofillBrokerError {
    if (!isRecord(value) || !hasExactlyKeys(value, ERROR_KEYS)) throw invalidResponse();
    if (
        value.schema !== AUTOFILL_BROKER_ERROR_SCHEMA ||
        ![
            "LOCKED",
            "DENIED",
            "ASK_REQUIRED",
            "TARGET_MISMATCH",
            "STALE",
            "UNKNOWN_PRIVACY",
            "POTENTIALLY_PRIVATE",
            "INVALID_REQUEST",
            "UNKNOWN_KEY",
            "UNSUPPORTED",
            "EXPIRED",
            "REVOKED",
        ].includes(String(value.code)) ||
        typeof value.retryable !== "boolean" ||
        (value.safeMessage !== undefined && !isNonEmptyString(value.safeMessage))
    ) {
        throw invalidResponse();
    }
    return value as unknown as AutofillBrokerError;
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
        if (SENSITIVE_KEY_PATTERN.test(key) && hasNonEmptySensitiveValue(value)) return nextPath;
        const found = findSensitivePayloadPath(value, nextPath);
        if (found) return found;
    }
    return null;
}

function hasExactlyKeys(value: Record<string, unknown>, keys: Set<string>): boolean {
    const actual = Object.keys(value);
    return actual.length === keys.size && actual.every((key) => keys.has(key));
}

function expectKeys(value: Record<string, unknown>, keys: Set<string>): void {
    if (!Object.keys(value).every((key) => keys.has(key))) throw invalidResponse();
}

function isRecord(value: unknown): value is Record<string, unknown> {
    return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

function isNonEmptyString(value: unknown): value is string {
    return typeof value === "string" && value.length > 0;
}

function isIsoDateString(value: unknown): value is string {
    return isNonEmptyString(value) && Number.isFinite(Date.parse(value));
}

function isNonNegativeInteger(value: unknown): value is number {
    return typeof value === "number" && Number.isInteger(value) && value >= 0;
}

function isExactHttpOrigin(value: unknown): value is string {
    if (typeof value !== "string") return false;
    try {
        const url = new URL(value);
        return url.origin === value && (url.protocol === "https:" || url.protocol === "http:");
    } catch {
        return false;
    }
}

function invalidResponse(): Error {
    return new Error("Invalid closed autofill broker response");
}

function hasNonEmptySensitiveValue(value: unknown): boolean {
    if (value === undefined || value === null) return false;
    if (typeof value === "string") return value !== "";
    if (typeof value === "number" || typeof value === "boolean") return true;
    if (Array.isArray(value)) return value.length > 0;
    if (typeof value === "object") return Object.keys(value as Record<string, unknown>).length > 0;
    return true;
}
