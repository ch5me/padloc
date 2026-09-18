/**
 * Closed, value-free import reporting contracts shared by importers and the
 * vault model. These objects contain provenance and loss metadata only; they
 * never carry field values, keys, or ciphertext.
 */

export const IMPORT_PROVENANCE_SCHEMA = "elf.import-provenance.v1" as const;
export const IMPORT_LOSS_SCHEMA = "elf.import-loss.v1" as const;
export const IMPORT_RESULT_SCHEMA = "elf.import-result.v1" as const;

export type ImportProvenanceSource = "1pux" | "compatibility-envelope" | "create-item" | "synthetic";

export type ImportLossCategory =
    | "passkey"
    | "attachment"
    | "document"
    | "history"
    | "sharing"
    | "totp-parameters"
    | "unsupported-field"
    | "trashed"
    | "unknown-kind";

export type ImportLossOutcome = "skipped" | "lossy-normalized";

export type ImportLossReasonCode =
    | "UNSUPPORTED_PASSKEY"
    | "UNSUPPORTED_ATTACHMENT"
    | "UNSUPPORTED_DOCUMENT"
    | "UNSUPPORTED_HISTORY"
    | "UNSUPPORTED_SHARING"
    | "NONEXACT_TOTP_PARAMETERS"
    | "UNSUPPORTED_FIELD"
    | "TRASHED_ITEM"
    | "UNKNOWN_KIND";

export interface ImportProvenance {
    schema: typeof IMPORT_PROVENANCE_SCHEMA;
    source: ImportProvenanceSource;
    sourceId: string;
    importedAt: string;
    importerVersion: string;
    sourceItemId?: string | null;
}

export interface ImportLossEntry {
    schema: typeof IMPORT_LOSS_SCHEMA;
    sourceItemId: string;
    category: ImportLossCategory;
    outcome: ImportLossOutcome;
    reasonCode: ImportLossReasonCode;
    note?: string | null;
}

export interface ImportResult {
    schema: typeof IMPORT_RESULT_SCHEMA;
    imported: number;
    normalized: number;
    skipped: number;
    lossy: number;
    provenance: ImportProvenance;
    losses: ImportLossEntry[];
    sourceIdentifiers: string[];
}

const PROVENANCE_KEYS = new Set(["schema", "source", "sourceId", "importedAt", "importerVersion", "sourceItemId"]);
const LOSS_KEYS = new Set(["schema", "sourceItemId", "category", "outcome", "reasonCode", "note"]);
const RESULT_KEYS = new Set([
    "schema",
    "imported",
    "normalized",
    "skipped",
    "lossy",
    "provenance",
    "losses",
    "sourceIdentifiers",
]);

const PROVENANCE_SOURCES = new Set<ImportProvenanceSource>([
    "1pux",
    "compatibility-envelope",
    "create-item",
    "synthetic",
]);
const LOSS_CATEGORIES = new Set<ImportLossCategory>([
    "passkey",
    "attachment",
    "document",
    "history",
    "sharing",
    "totp-parameters",
    "unsupported-field",
    "trashed",
    "unknown-kind",
]);
const LOSS_OUTCOMES = new Set<ImportLossOutcome>(["skipped", "lossy-normalized"]);
const LOSS_REASON_CODES = new Set<ImportLossReasonCode>([
    "UNSUPPORTED_PASSKEY",
    "UNSUPPORTED_ATTACHMENT",
    "UNSUPPORTED_DOCUMENT",
    "UNSUPPORTED_HISTORY",
    "UNSUPPORTED_SHARING",
    "NONEXACT_TOTP_PARAMETERS",
    "UNSUPPORTED_FIELD",
    "TRASHED_ITEM",
    "UNKNOWN_KIND",
]);

function isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === "object" && value !== null && !Array.isArray(value);
}

function invalidContract(): Error {
    // Do not include input values in validation errors; contract failures must
    // not accidentally print imported identifiers or other sensitive data.
    return new Error("Invalid closed import contract");
}

function requireRecord(value: unknown): Record<string, unknown> {
    if (!isRecord(value)) {
        throw invalidContract();
    }
    return value;
}

function rejectUnknownKeys(value: Record<string, unknown>, keys: Set<string>) {
    for (const key of Object.keys(value)) {
        if (!keys.has(key)) {
            throw invalidContract();
        }
    }
}

function requireNonEmptyString(value: unknown): string {
    if (typeof value !== "string" || value.length === 0) {
        throw invalidContract();
    }
    return value;
}

function optionalString(value: unknown): string | null | undefined {
    if (typeof value === "undefined" || value === null) {
        return value;
    }
    return requireNonEmptyString(value);
}

function requireIsoDate(value: unknown): string {
    const stringValue = requireNonEmptyString(value);
    if (Number.isNaN(Date.parse(stringValue))) {
        throw invalidContract();
    }
    return stringValue;
}

function requireCount(value: unknown): number {
    if (typeof value !== "number" || !Number.isInteger(value) || value < 0) {
        throw invalidContract();
    }
    return value;
}

function requireEnum<T extends string>(value: unknown, values: Set<T>): T {
    if (typeof value !== "string" || !values.has(value as T)) {
        throw invalidContract();
    }
    return value as T;
}

function optionalProperty<T>(
    source: Record<string, unknown>,
    key: string,
    parser: (value: unknown) => T
): T | undefined {
    if (!Object.prototype.hasOwnProperty.call(source, key)) {
        return undefined;
    }
    return parser(source[key]);
}

export function parseImportProvenance(value: unknown): ImportProvenance {
    const raw = requireRecord(value);
    rejectUnknownKeys(raw, PROVENANCE_KEYS);

    if (raw.schema !== IMPORT_PROVENANCE_SCHEMA) {
        throw invalidContract();
    }

    const provenance: ImportProvenance = {
        schema: IMPORT_PROVENANCE_SCHEMA,
        source: requireEnum(raw.source, PROVENANCE_SOURCES),
        sourceId: requireNonEmptyString(raw.sourceId),
        importedAt: requireIsoDate(raw.importedAt),
        importerVersion: requireNonEmptyString(raw.importerVersion),
    };

    const sourceItemId = optionalProperty(raw, "sourceItemId", optionalString);
    if (typeof sourceItemId !== "undefined") {
        provenance.sourceItemId = sourceItemId;
    }

    return provenance;
}

export function parseImportLossEntry(value: unknown): ImportLossEntry {
    const raw = requireRecord(value);
    rejectUnknownKeys(raw, LOSS_KEYS);

    if (raw.schema !== IMPORT_LOSS_SCHEMA) {
        throw invalidContract();
    }

    const loss: ImportLossEntry = {
        schema: IMPORT_LOSS_SCHEMA,
        sourceItemId: requireNonEmptyString(raw.sourceItemId),
        category: requireEnum(raw.category, LOSS_CATEGORIES),
        outcome: requireEnum(raw.outcome, LOSS_OUTCOMES),
        reasonCode: requireEnum(raw.reasonCode, LOSS_REASON_CODES),
    };

    const note = optionalProperty(raw, "note", optionalString);
    if (typeof note !== "undefined") {
        loss.note = note;
    }

    return loss;
}

export function parseImportResult(value: unknown): ImportResult {
    const raw = requireRecord(value);
    rejectUnknownKeys(raw, RESULT_KEYS);

    if (raw.schema !== IMPORT_RESULT_SCHEMA) {
        throw invalidContract();
    }
    if (!Array.isArray(raw.losses) || !Array.isArray(raw.sourceIdentifiers)) {
        throw invalidContract();
    }

    const sourceIdentifiers = raw.sourceIdentifiers.map(requireNonEmptyString);
    const losses = raw.losses.map(parseImportLossEntry);

    return {
        schema: IMPORT_RESULT_SCHEMA,
        imported: requireCount(raw.imported),
        normalized: requireCount(raw.normalized),
        skipped: requireCount(raw.skipped),
        lossy: requireCount(raw.lossy),
        provenance: parseImportProvenance(raw.provenance),
        losses,
        sourceIdentifiers,
    };
}

export function assertImportProvenance(value: unknown): ImportProvenance {
    return parseImportProvenance(value);
}

export function assertImportLossEntry(value: unknown): ImportLossEntry {
    return parseImportLossEntry(value);
}

export function assertImportResult(value: unknown): ImportResult {
    return parseImportResult(value);
}

export function isImportProvenance(value: unknown): value is ImportProvenance {
    try {
        parseImportProvenance(value);
        return true;
    } catch {
        return false;
    }
}

export function isImportLossEntry(value: unknown): value is ImportLossEntry {
    try {
        parseImportLossEntry(value);
        return true;
    } catch {
        return false;
    }
}

export function isImportResult(value: unknown): value is ImportResult {
    try {
        parseImportResult(value);
        return true;
    } catch {
        return false;
    }
}

/**
 * Value namespaces make the parser discoverable without changing the wire
 * representation. They intentionally expose only constructors/parsers.
 */
export const ImportProvenanceContract = {
    parse: parseImportProvenance,
    assert: assertImportProvenance,
};

export const ImportLossEntryContract = {
    parse: parseImportLossEntry,
    assert: assertImportLossEntry,
};

export const ImportResultContract = {
    parse: parseImportResult,
    assert: assertImportResult,
};
