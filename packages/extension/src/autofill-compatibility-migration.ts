import {
    ImportProvenance,
    ImportResult,
    parseImportProvenance,
    parseImportResult,
} from "@padloc/core/src/import-result";

export const ENCRYPTED_AUTOFILL_PROFILE_ENVELOPE_SCHEMA =
    "elf.encrypted-autofill-profile-envelope.v1" as const;
export const IMPORT_BEGIN_SCHEMA = "elf.import-begin-request.v1" as const;
export const IMPORT_BEGIN_RESULT_SCHEMA = "elf.import-begin-result.v1" as const;
export const IMPORT_COMMIT_SCHEMA = "elf.import-commit-request.v1" as const;
export const IMPORT_COMMIT_RESULT_SCHEMA = "elf.import-commit-result.v1" as const;
export const IMPORT_WRAP_ALGORITHM = "padloc-import-key-v1" as const;

export interface EncryptedAutofillProfileEnvelope {
    schema: typeof ENCRYPTED_AUTOFILL_PROFILE_ENVELOPE_SCHEMA;
    envelopeId: string;
    formatVersion: 1;
    ciphertext: string;
    wrappedKey: string;
    wrapAlgorithm: typeof IMPORT_WRAP_ALGORITHM;
    sourceProvenance: ImportProvenance;
    consentNonce: string;
    recordCountHint: number;
    createdAt: string;
}

export interface ImportBeginRequest {
    schema: typeof IMPORT_BEGIN_SCHEMA;
    operation: "import-begin";
    requestId: string;
    consentNonce: string;
}

export interface ImportBeginResult {
    schema: typeof IMPORT_BEGIN_RESULT_SCHEMA;
    kind: "import-begin-result";
    requestId: string;
    ok: true;
    wrapAlgorithm: typeof IMPORT_WRAP_ALGORITHM;
    importPublicKey: string;
    importKeyId: string;
    expiresAt: string;
}

export interface ImportCommitRequest {
    schema: typeof IMPORT_COMMIT_SCHEMA;
    operation: "import-commit";
    requestId: string;
    envelope: EncryptedAutofillProfileEnvelope;
}

export interface ImportCommitResult {
    schema: typeof IMPORT_COMMIT_RESULT_SCHEMA;
    kind: "import-result";
    requestId: string;
    ok: true;
    result: ImportResult;
}

export interface ImportKeyCustody {
    begin(consentNonce: string, requestId: string): Promise<{
        importPublicKey: string;
        importKeyId: string;
        expiresAt: string;
    }>;
    commit(
        envelope: EncryptedAutofillProfileEnvelope,
        key: { importKeyId: string; consentNonce: string }
    ): Promise<ImportResult>;
}

const ENVELOPE_KEYS = new Set([
    "schema",
    "envelopeId",
    "formatVersion",
    "ciphertext",
    "wrappedKey",
    "wrapAlgorithm",
    "sourceProvenance",
    "consentNonce",
    "recordCountHint",
    "createdAt",
]);
const BEGIN_KEYS = new Set(["schema", "operation", "requestId", "consentNonce"]);
const BEGIN_RESULT_KEYS = new Set([
    "schema",
    "kind",
    "requestId",
    "ok",
    "wrapAlgorithm",
    "importPublicKey",
    "importKeyId",
    "expiresAt",
]);
const COMMIT_KEYS = new Set(["schema", "operation", "requestId", "envelope"]);
const COMMIT_RESULT_KEYS = new Set(["schema", "kind", "requestId", "ok", "result"]);

export function parseEncryptedAutofillProfileEnvelope(value: unknown): EncryptedAutofillProfileEnvelope {
    const raw = requireRecord(value);
    rejectUnknownKeys(raw, ENVELOPE_KEYS);
    if (
        raw.schema !== ENCRYPTED_AUTOFILL_PROFILE_ENVELOPE_SCHEMA ||
        raw.formatVersion !== 1 ||
        raw.wrapAlgorithm !== IMPORT_WRAP_ALGORITHM
    ) {
        throw invalidContract();
    }
    const envelope: EncryptedAutofillProfileEnvelope = {
        schema: ENCRYPTED_AUTOFILL_PROFILE_ENVELOPE_SCHEMA,
        envelopeId: requireNonEmptyString(raw.envelopeId),
        formatVersion: 1,
        ciphertext: requireBase64(raw.ciphertext),
        wrappedKey: requireBase64(raw.wrappedKey),
        wrapAlgorithm: IMPORT_WRAP_ALGORITHM,
        sourceProvenance: parseImportProvenance(raw.sourceProvenance),
        consentNonce: requireNonEmptyString(raw.consentNonce),
        recordCountHint: requireCount(raw.recordCountHint),
        createdAt: requireIsoDate(raw.createdAt),
    };
    if (hasPlaintextOrGrant(value)) throw invalidContract();
    return envelope;
}

export function assertEncryptedAutofillProfileEnvelope(value: unknown): EncryptedAutofillProfileEnvelope {
    return parseEncryptedAutofillProfileEnvelope(value);
}

export function isEncryptedAutofillProfileEnvelope(value: unknown): value is EncryptedAutofillProfileEnvelope {
    try {
        parseEncryptedAutofillProfileEnvelope(value);
        return true;
    } catch {
        return false;
    }
}

export function parseImportBeginRequest(value: unknown): ImportBeginRequest {
    const raw = requireRecord(value);
    rejectUnknownKeys(raw, BEGIN_KEYS);
    if (raw.schema !== IMPORT_BEGIN_SCHEMA || raw.operation !== "import-begin") throw invalidContract();
    return {
        schema: IMPORT_BEGIN_SCHEMA,
        operation: "import-begin",
        requestId: requireNonEmptyString(raw.requestId),
        consentNonce: requireNonEmptyString(raw.consentNonce),
    };
}

export function parseImportCommitRequest(value: unknown): ImportCommitRequest {
    const raw = requireRecord(value);
    rejectUnknownKeys(raw, COMMIT_KEYS);
    if (raw.schema !== IMPORT_COMMIT_SCHEMA || raw.operation !== "import-commit") throw invalidContract();
    return {
        schema: IMPORT_COMMIT_SCHEMA,
        operation: "import-commit",
        requestId: requireNonEmptyString(raw.requestId),
        envelope: parseEncryptedAutofillProfileEnvelope(raw.envelope),
    };
}

export function parseImportBeginResult(value: unknown): ImportBeginResult {
    const raw = requireRecord(value);
    rejectUnknownKeys(raw, BEGIN_RESULT_KEYS);
    if (
        raw.schema !== IMPORT_BEGIN_RESULT_SCHEMA ||
        raw.kind !== "import-begin-result" ||
        raw.ok !== true ||
        raw.wrapAlgorithm !== IMPORT_WRAP_ALGORITHM
    ) {
        throw invalidContract();
    }
    return {
        schema: IMPORT_BEGIN_RESULT_SCHEMA,
        kind: "import-begin-result",
        requestId: requireNonEmptyString(raw.requestId),
        ok: true,
        wrapAlgorithm: IMPORT_WRAP_ALGORITHM,
        importPublicKey: requireNonEmptyString(raw.importPublicKey),
        importKeyId: requireNonEmptyString(raw.importKeyId),
        expiresAt: requireIsoDate(raw.expiresAt),
    };
}

export function parseImportCommitResult(value: unknown): ImportCommitResult {
    const raw = requireRecord(value);
    rejectUnknownKeys(raw, COMMIT_RESULT_KEYS);
    if (raw.schema !== IMPORT_COMMIT_RESULT_SCHEMA || raw.kind !== "import-result" || raw.ok !== true) {
        throw invalidContract();
    }
    return {
        schema: IMPORT_COMMIT_RESULT_SCHEMA,
        kind: "import-result",
        requestId: requireNonEmptyString(raw.requestId),
        ok: true,
        result: parseImportResult(raw.result),
    };
}

export function assertImportBeginResult(value: unknown): ImportBeginResult {
    return parseImportBeginResult(value);
}

export function assertImportCommitResult(value: unknown): ImportCommitResult {
    return parseImportCommitResult(value);
}

export async function beginCompatibilityImport(
    request: ImportBeginRequest,
    custody: ImportKeyCustody
): Promise<ImportBeginResult> {
    const key = await custody.begin(request.consentNonce, request.requestId);
    if (
        !isNonEmptyString(key.importPublicKey) ||
        !isNonEmptyString(key.importKeyId) ||
        !isIsoDate(key.expiresAt)
    ) {
        throw new Error("Import key custody returned invalid metadata");
    }
    return {
        schema: IMPORT_BEGIN_RESULT_SCHEMA,
        kind: "import-begin-result",
        requestId: request.requestId,
        ok: true,
        wrapAlgorithm: IMPORT_WRAP_ALGORITHM,
        importPublicKey: key.importPublicKey,
        importKeyId: key.importKeyId,
        expiresAt: key.expiresAt,
    };
}

export async function commitCompatibilityImport(
    request: ImportCommitRequest,
    custody: ImportKeyCustody,
    key: { importKeyId: string; consentNonce: string }
): Promise<ImportResult> {
    if (request.envelope.consentNonce !== key.consentNonce) {
        throw new Error("Import consent nonce mismatch");
    }
    const result = await custody.commit(request.envelope, key);
    const parsed = parseImportResult(result);
    if (hasPlaintextOrGrant(parsed)) throw new Error("Import result contains an unsafe payload");
    return parsed;
}

export function buildImportCommitResult(requestId: string, result: ImportResult): ImportCommitResult {
    const parsed = parseImportResult(result);
    return {
        schema: IMPORT_COMMIT_RESULT_SCHEMA,
        kind: "import-result",
        requestId: requireNonEmptyString(requestId),
        ok: true,
        result: parsed,
    };
}

/**
 * This adapter is intentionally incapable of producing broker grants. Its
 * only successful output is the value-free ImportResult report.
 */
export async function handleCompatibilityMigration(
    value: unknown,
    custody: ImportKeyCustody,
    key?: { importKeyId: string; consentNonce: string }
): Promise<ImportBeginResult | ImportResult> {
    const raw = requireRecord(value);
    if (raw.operation === "import-begin") {
        return beginCompatibilityImport(parseImportBeginRequest(raw), custody);
    }
    if (raw.operation === "import-commit") {
        if (!key) throw new Error("Import key custody is unavailable");
        return commitCompatibilityImport(parseImportCommitRequest(raw), custody, key);
    }
    throw new Error("Unsupported compatibility migration operation");
}

function requireRecord(value: unknown): Record<string, unknown> {
    if (!value || typeof value !== "object" || Array.isArray(value)) throw invalidContract();
    return value as Record<string, unknown>;
}

function rejectUnknownKeys(value: Record<string, unknown>, keys: Set<string>): void {
    if (Object.keys(value).some((key) => !keys.has(key))) throw invalidContract();
}

function requireNonEmptyString(value: unknown): string {
    if (typeof value !== "string" || value.length === 0) throw invalidContract();
    return value;
}

function requireCount(value: unknown): number {
    if (typeof value !== "number" || !Number.isInteger(value) || value < 0) throw invalidContract();
    return value;
}

function requireIsoDate(value: unknown): string {
    const result = requireNonEmptyString(value);
    if (!isIsoDate(result)) throw invalidContract();
    return result;
}

function requireBase64(value: unknown): string {
    const result = requireNonEmptyString(value);
    if (!/^[A-Za-z0-9+/]+={0,2}$/.test(result) || result.length % 4 !== 0) throw invalidContract();
    return result;
}

function isIsoDate(value: unknown): value is string {
    return typeof value === "string" && value.length > 0 && Number.isFinite(Date.parse(value));
}

function hasPlaintextOrGrant(value: unknown): boolean {
    if (!value || typeof value !== "object") return false;
    if (Array.isArray(value)) return value.some(hasPlaintextOrGrant);
    return Object.entries(value as Record<string, unknown>).some(([key, nested]) => {
        if (/^(value|rawKey|privateKey|grant|grantId|bundle|bundleId|secret)$/i.test(key)) {
            return nested !== undefined && nested !== null && nested !== "";
        }
        return hasPlaintextOrGrant(nested);
    });
}

function invalidContract(): Error {
    return new Error("Invalid closed encrypted autofill profile contract");
}

function isNonEmptyString(value: unknown): value is string {
    return typeof value === "string" && value.length > 0;
}
