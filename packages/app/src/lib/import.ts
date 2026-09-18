import { unmarshal, bytesToString } from "@padloc/core/src/encoding";
import { PBES2Container } from "@padloc/core/src/container";
import { validateLegacyContainer, parseLegacyContainer } from "@padloc/core/src/legacy";
import {
    AutofillFieldRole,
    AutofillItemKind,
    VaultItem,
    Field,
    createVaultItem,
    FieldType,
    guessFieldType,
    deriveAutofillItemKind,
} from "@padloc/core/src/item";
import { Err, ErrorCode } from "@padloc/core/src/error";
import { uuid, capitalize } from "@padloc/core/src/util";
import { translate as $l } from "@padloc/locale/src/translate";
import { readFileAsText, readFileAsArrayBuffer } from "@padloc/core/src/attachment";
import {
    IMPORT_LOSS_SCHEMA,
    IMPORT_PROVENANCE_SCHEMA,
    IMPORT_RESULT_SCHEMA,
    ImportLossCategory,
    ImportLossEntry,
    ImportLossOutcome,
    ImportLossReasonCode,
    ImportProvenance,
    ImportResult,
} from "@padloc/core/src/import-result";

import { OnePuxExport, OnePuxItem } from "./1pux-parser";
import { BitwardenExport, BitwardenItem } from "./bitwarden-parser";

export interface ImportFormat {
    value:
        | "csv"
        | "padlock-legacy"
        | "lastpass"
        | "padloc"
        | "1pux"
        | "bitwarden"
        | "dashlane"
        | "keepass"
        | "nordpass"
        | "icloud"
        | "chrome"
        | "firefox";
    label: string;
}

export interface ImportCSVColumn {
    name: string;
    displayName: string;
    type: FieldType | "name" | "tags" | "skip";
    values: string[];
}

export const CSV: ImportFormat = {
    value: "csv",
    label: "CSV",
};

export const PADLOCK_LEGACY: ImportFormat = {
    value: "padlock-legacy",
    label: "Padlock (v2)",
};

export const LASTPASS: ImportFormat = {
    value: "lastpass",
    label: "LastPass",
};

export const PBES2: ImportFormat = {
    value: "padloc",
    label: "Encrypted Container",
};

export const ONEPUX: ImportFormat = {
    value: "1pux",
    label: "1Password (1pux)",
};

export const BITWARDEN: ImportFormat = {
    value: "bitwarden",
    label: "Bitwarden (JSON)",
};

export const DASHLANE: ImportFormat = {
    value: "dashlane",
    label: "Dashlane (CSV)",
};

export const KEEPASS: ImportFormat = {
    value: "keepass",
    label: "KeePass (CSV)",
};

export const NORDPASS: ImportFormat = {
    value: "nordpass",
    label: "NordPass (CSV)",
};

export const ICLOUD: ImportFormat = {
    value: "icloud",
    label: "iCloud (CSV)",
};

export const CHROME: ImportFormat = {
    value: "chrome",
    label: "Chrome (CSV)",
};

export const FIREFOX: ImportFormat = {
    value: "firefox",
    label: "Firefox (CSV)",
};

export const supportedFormats: ImportFormat[] = [
    CSV,
    PADLOCK_LEGACY,
    LASTPASS,
    PBES2,
    ONEPUX,
    BITWARDEN,
    DASHLANE,
    KEEPASS,
    NORDPASS,
    ICLOUD,
    CHROME,
    FIREFOX,
];

export const csvSupportedFormats: ImportFormat[] = [
    CSV,
    LASTPASS,
    DASHLANE,
    KEEPASS,
    NORDPASS,
    ICLOUD,
    CHROME,
    FIREFOX,
];

export function loadPapa(): Promise<any> {
    return import(/* webpackChunkName: "papaparse" */ "papaparse");
}

/**
 * Takes a data table (represented by a two-dimensional array) and converts it
 * into an array of items
 * @param  Array    data            Two-dimensional array containing tabular item data; The first 'row'
 *                                  might contain field names. All other rows represent items, containing
 *                                  the item name, field values and optionally a list of tags.
 * @param  Array    columnTypes     Array containing the type of field per column.
 * @param  Boolean  columnsOnFirstRow  Boolean, representing if there are columnms on the first row.
 */
async function fromTable(
    data: string[][],
    columnTypes: ImportCSVColumn[],
    columnsOnFirstRow: boolean
): Promise<VaultItem[]> {
    let nameColumnIndex = columnTypes.findIndex((columnType) => columnType.type === "name");
    const tagsColumnIndex = columnTypes.findIndex((columnType) => columnType.type === "tags");

    if (nameColumnIndex === -1) {
        nameColumnIndex = 0;
    }

    const dataRows = columnsOnFirstRow ? data.slice(1) : data;

    // All subsequent rows should contain values
    const items = dataRows
        .filter((row) => {
            // Skip empty rows
            if (row.length === 1 && row[0] === "") {
                return false;
            }

            return true;
        })
        .map((row) => {
            // Construct an array of field object from column names and values
            const fields: Field[] = [];
            for (let columnIndex = 0; columnIndex < row.length; ++columnIndex) {
                if (columnTypes[columnIndex]?.type === "skip") {
                    continue;
                }

                // Skip name column, category column (if any) and empty fields
                if (columnIndex !== nameColumnIndex && columnIndex !== tagsColumnIndex && row[columnIndex]) {
                    const name = columnTypes[columnIndex]?.displayName || "";
                    const value = row[columnIndex];
                    const type = columnTypes[columnIndex]?.type || undefined;
                    fields.push(
                        new Field().fromRaw({
                            name,
                            value,
                            type,
                        })
                    );
                }
            }

            const name = row[nameColumnIndex!];
            const tags = row[tagsColumnIndex!];
            return createVaultItem({ name, fields, tags: (tags && tags.split(",")) || [] });
        });

    return Promise.all(items);
}

export async function isCSV(data: string): Promise<Boolean> {
    const papa = await loadPapa();
    return papa.parse(data).errors.length === 0;
}

export async function asCSV(
    file: File,
    mappedItemColumns: ImportCSVColumn[],
    columnsOnFirstRow: boolean
): Promise<{ items: VaultItem[]; itemColumns: ImportCSVColumn[] }> {
    const data = await readFileAsText(file);
    const papa = await loadPapa();
    const parsed = papa.parse(data);
    if (parsed.errors.length) {
        throw new Err(ErrorCode.INVALID_CSV, "Failed to parse .csv file.");
    }
    const rows = parsed.data as string[][];

    if (rows.length === 0) {
        throw new Err(ErrorCode.INVALID_CSV, "No rows found in .csv file.");
    }

    const columnNames = columnsOnFirstRow
        ? rows[0].map((column) => column.toLowerCase())
        : rows[0].map((_value, index) => $l("Column {0}", index.toString()));

    let hasNameColumn = false;
    let hasTagsColumn = false;

    const itemColumns =
        mappedItemColumns.length > 0
            ? mappedItemColumns
            : columnNames.map((columnName, columnIndex) => {
                  const values = (columnsOnFirstRow ? rows.slice(1) : rows).map((row) => row[columnIndex] || "");

                  // Guess field type based on first non-empty value
                  // TODO: Sample all values for more reliable results?
                  let type = guessFieldType({
                      name: columnsOnFirstRow ? columnName : "",
                      value: values.find((value) => Boolean(value)),
                  }) as ImportCSVColumn["type"];

                  // If we're not given field names by the first row, base the name on the type
                  const name = columnsOnFirstRow ? columnName.toLocaleLowerCase() : type;

                  if (!hasNameColumn && name === "name") {
                      type = "name";
                      hasNameColumn = true;
                  }

                  if (!hasTagsColumn && ["tags", "category"].includes(name)) {
                      type = "tags";
                      hasTagsColumn = true;
                  }

                  return {
                      name,
                      displayName: capitalize(name),
                      type,
                      values,
                  };
              });

    // Ensure there's at least one nameColumn
    if (mappedItemColumns.length === 0 && !hasNameColumn) {
        itemColumns[0].type = "name";
    }

    const items = await fromTable(rows, itemColumns, columnsOnFirstRow);

    return { items, itemColumns };
}
export async function isPadlockV1(file: File): Promise<boolean> {
    try {
        const data = await readFileAsText(file);
        return validateLegacyContainer(unmarshal(data));
    } catch (e) {
        return false;
    }
}

export async function asPadlockLegacy(file: File, password: string): Promise<VaultItem[]> {
    const data = await readFileAsText(file);
    const container = parseLegacyContainer(unmarshal(data));
    await container.unlock(password);
    return importLegacyContainer(container);
}

export async function importLegacyContainer(container: PBES2Container) {
    const records = unmarshal(bytesToString(await container.getData())) as any[];
    const items = records
        .filter(({ removed }) => !removed)
        .map(async ({ name = "Unnamed", fields = [], tags, category, updated }) => {
            return new VaultItem().fromRaw({
                id: await uuid(),
                name,
                fields,
                tags: tags || [category],
                updated,
                updatedBy: "",
                attachments: [],
            });
        });

    return Promise.all(items);
}

export async function isPBES2Container(file: File) {
    try {
        const data = await readFileAsText(file);
        new PBES2Container().fromRaw(unmarshal(data));
        return true;
    } catch (error) {
        return false;
    }
}

export async function asPBES2Container(file: File, password: string): Promise<VaultItem[]> {
    const data = await readFileAsText(file);
    const container = new PBES2Container().fromRaw(unmarshal(data));
    await container.unlock(password);

    const raw = unmarshal(bytesToString(await container.getData())) as any;

    const items = raw.items.map((item: any) => {
        // Due to a bug in < v1.3.4 items were not serialized properly, so we may
        // need this additional step
        if (typeof item === "string") {
            try {
                item = unmarshal(item);
            } catch (e) {}
        }
        return new VaultItem().fromRaw(item);
    });

    return items;
}

/*
 * Lastpass secure notes are exported by putting non-standard fields into the 'extra' column. Every line
 * represents a field in the following format:
 *
 *     field_name:data
 *
 * We're parsing that information to retrieve the individual fields
 */
function lpParseNotes(str: string): Field[] {
    const lines = str.split("\n");
    const fields = lines
        .filter((line) => !!line)
        .map((line) => {
            const split = line.indexOf(":");
            return new Field({
                name: line.substring(0, split),
                value: line.substring(split + 1),
                type: FieldType.Text,
            });
        });
    return fields;
}

/*
 * Parses a single row in a LastPass CSV file. Apart from extracting the default fields, we also parse
 * the 'extra' column for 'special notes' and remove any special fields that are not needed outside of
 * LastPass
 */
async function lpParseRow(row: string[], legacyFormat: boolean): Promise<VaultItem> {
    let nameIndex, categoryIndex, urlIndex, usernameIndex, passwordIndex, notesIndex, totpIndex;

    if (legacyFormat) {
        nameIndex = 4;
        categoryIndex = 5;
        urlIndex = 0;
        usernameIndex = 1;
        passwordIndex = 2;
        notesIndex = 3;
        totpIndex = 7;
    } else {
        nameIndex = 5;
        categoryIndex = 6;
        urlIndex = 0;
        usernameIndex = 1;
        passwordIndex = 2;
        notesIndex = 4;
        totpIndex = 3;
    }

    let fields: Field[] = [
        new Field({ name: $l("Username"), value: row[usernameIndex], type: FieldType.Username }),
        new Field({ name: $l("Password"), value: row[passwordIndex], type: FieldType.Password }),
        new Field({ name: $l("URL"), value: row[urlIndex], type: FieldType.Url }),
    ];
    const notes = row[notesIndex];

    if (row[urlIndex] === "http://sn") {
        // The 'http://sn' url indicates that this line represents a 'secure note', which means
        // we'll have to parse the 'extra' column to retrieve the individual fields
        fields.push(...lpParseNotes(notes));
        // In case of 'secure notes' we don't want the url and NoteType field
        fields = fields.filter((f) => f.name != "url" && f.name != "NoteType");
    } else {
        // We've got a regular 'site' item, so the 'extra' column simply contains notes
        fields.push(new Field({ name: $l("Notes"), value: notes, type: FieldType.Note }));
    }

    if (row[totpIndex]) {
        fields.push(new Field({ name: $l("One-Time Password"), value: row[totpIndex], type: FieldType.Totp }));
    }

    const dir = row[categoryIndex];
    // Create a basic item using the standard fields
    return createVaultItem({ name: row[nameIndex], fields, tags: dir ? [dir] : [] });
}

export async function asLastPass(file: File): Promise<VaultItem[]> {
    const data = await readFileAsText(file);
    const papa = await loadPapa();
    const isLegacyFormat =
        data.split("\n")[0].trim() === "url,username,password,totp,extra,name,grouping,fav" ? false : true;
    const items = papa
        .parse(data)
        .data // Remove first row as it only contains field names
        .slice(1)
        // Filter out empty rows
        .filter((row: string[]) => row.length > 1)
        .map((row: string[]) => lpParseRow(row, isLegacyFormat));

    return Promise.all(items);
}

export async function isLastPass(file: File): Promise<boolean> {
    try {
        const data = await readFileAsText(file);
        const headerRow = data.split("\n")[0].trim();
        return (
            headerRow === "url,username,password,extra,name,grouping,fav" ||
            headerRow === "url,username,password,extra,name,grouping,fav,totp" ||
            headerRow === "url,username,password,totp,extra,name,grouping,fav"
        );
    } catch (error) {
        return false;
    }
}

const ONEPUX_IMPORTER_VERSION = "padloc-1pux-import-v1";
const FALLBACK_IMPORT_TIME = "1970-01-01T00:00:00.000Z";

export interface OnePuxImportOptions {
    sourceId?: string;
    importedAt?: string;
    importerVersion?: string;
}

export interface OnePuxImport {
    items: VaultItem[];
    result: ImportResult;
}

export type OnePuxImportedItems = VaultItem[] & {
    importResult: ImportResult;
};

type OnePuxFieldCandidate = {
    name: string;
    value: string;
    role?: AutofillFieldRole;
    type: FieldType;
};

type OnePuxNormalizedItem = {
    item?: VaultItem;
    losses: ImportLossEntry[];
};

type OnePuxCategory =
    | "passkey"
    | "attachment"
    | "document"
    | "history"
    | "sharing"
    | "totp-parameters"
    | "unsupported-field"
    | "trashed"
    | "unknown-kind";

function asRecord(value: unknown): Record<string, unknown> | undefined {
    return typeof value === "object" && value !== null && !Array.isArray(value)
        ? (value as Record<string, unknown>)
        : undefined;
}

function hasOwn(value: Record<string, unknown> | undefined, key: string): boolean {
    return Boolean(value && Object.prototype.hasOwnProperty.call(value, key));
}

function normalizedLabel(value: string): string {
    return value
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, " ")
        .trim();
}

function nonEmptyString(value: unknown): string | undefined {
    return typeof value === "string" && value.length > 0 ? value : undefined;
}

function itemSourceId(item: OnePuxItem["item"], fallback: string): string {
    return nonEmptyString(item?.uuid) || fallback;
}

function importLoss(
    sourceItemId: string,
    category: ImportLossCategory,
    outcome: ImportLossOutcome,
    reasonCode: ImportLossReasonCode
): ImportLossEntry {
    return {
        schema: IMPORT_LOSS_SCHEMA,
        sourceItemId,
        category,
        outcome,
        reasonCode,
    };
}

function lossCategoryToReason(category: OnePuxCategory): ImportLossReasonCode {
    switch (category) {
        case "passkey":
            return "UNSUPPORTED_PASSKEY";
        case "attachment":
            return "UNSUPPORTED_ATTACHMENT";
        case "document":
            return "UNSUPPORTED_DOCUMENT";
        case "history":
            return "UNSUPPORTED_HISTORY";
        case "sharing":
            return "UNSUPPORTED_SHARING";
        case "totp-parameters":
            return "NONEXACT_TOTP_PARAMETERS";
        case "unsupported-field":
            return "UNSUPPORTED_FIELD";
        case "trashed":
            return "TRASHED_ITEM";
        case "unknown-kind":
            return "UNKNOWN_KIND";
    }
}

function valueFromSectionField(value: unknown): { value: string; valueType: string } | undefined {
    if (typeof value === "string") {
        return { value, valueType: "string" };
    }

    const record = asRecord(value);
    if (!record) {
        return;
    }

    const keys = [
        "concealed",
        "reference",
        "string",
        "email",
        "phone",
        "url",
        "totp",
        "gender",
        "creditCardType",
        "creditCardNumber",
        "monthYear",
        "date",
    ];

    for (const key of keys) {
        const candidate = record[key];
        if (typeof candidate === "string" && candidate.length > 0) {
            return { value: candidate, valueType: key };
        }
        if (typeof candidate === "number" && Number.isFinite(candidate)) {
            return { value: String(candidate), valueType: key };
        }
    }

    return;
}

function kindFromCategory(categoryUuid: string | undefined): AutofillItemKind | undefined {
    const category = normalizedLabel(categoryUuid || "");
    if (!category) {
        return;
    }

    if (category === "001" || /(^| )login(s)?$|website|web app|password/.test(category)) {
        return AutofillItemKind.Login;
    }
    if (category === "003" || /credit card|creditcard|payment|card/.test(category)) {
        return AutofillItemKind.PaymentCardPolicy;
    }
    if (category === "005" || /identity|profile|person|contact/.test(category)) {
        return AutofillItemKind.PersonProfile;
    }
    if (/postal|address/.test(category)) {
        return AutofillItemKind.PostalAddress;
    }
    if (
        category === "100" ||
        category === "101" ||
        category === "103" ||
        /government|passport|driver|license|ssn|social security|national id/.test(category)
    ) {
        return AutofillItemKind.GovernmentIdentity;
    }
    if (category === "106" || /financial|bank|routing|iban|bic|account/.test(category)) {
        return AutofillItemKind.FinancialAccount;
    }
    if (/merchant|origin/.test(category)) {
        return AutofillItemKind.MerchantProfile;
    }

    return;
}

function roleForLabel(
    name: string,
    kind: AutofillItemKind | undefined,
    valueType?: string,
    fieldType?: string
): AutofillFieldRole | undefined {
    const label = normalizedLabel(name);
    const type = normalizedLabel(fieldType || "");
    const valueKind = normalizedLabel(valueType || "");

    if (type === "t" || valueKind === "totp" || /totp|otp|one time password|authenticator/.test(label)) {
        return AutofillFieldRole.Totp;
    }
    if (/user(name)?|login id|sign in|account name/.test(label)) {
        return AutofillFieldRole.Username;
    }
    if (/password|passcode/.test(label)) {
        return AutofillFieldRole.Password;
    }

    if (/social security|(^| )ssn($| )/.test(label)) {
        return AutofillFieldRole.GovernmentSsn;
    }
    if (/passport/.test(label)) {
        return AutofillFieldRole.GovernmentPassportNumber;
    }
    if (/driver.?s license|drivers license|license number/.test(label)) {
        return AutofillFieldRole.GovernmentDriversLicenseNumber;
    }
    if (/national id|national identification/.test(label)) {
        return AutofillFieldRole.GovernmentNationalId;
    }

    if (/routing number|routing/.test(label)) {
        return AutofillFieldRole.FinancialRoutingNumber;
    }
    if (/iban/.test(label)) {
        return AutofillFieldRole.FinancialIban;
    }
    if (/bic|swift/.test(label)) {
        return AutofillFieldRole.FinancialBic;
    }
    if (/account number|bank account|account/.test(label) && kind === AutofillItemKind.FinancialAccount) {
        return AutofillFieldRole.FinancialAccountNumber;
    }

    if (/card number|credit card number|pan/.test(label)) {
        return AutofillFieldRole.PaymentCardPan;
    }
    if (/cardholder|card owner|owner name|name on card/.test(label)) {
        return AutofillFieldRole.PaymentCardholderName;
    }
    if (/cvv|cvc|security code/.test(label)) {
        return AutofillFieldRole.PaymentCardCvvTransient;
    }
    if (/expiry|expiration|valid until|valid thru/.test(label)) {
        if (/month/.test(label)) {
            return AutofillFieldRole.PaymentCardExpiryMonth;
        }
        if (/year/.test(label)) {
            return AutofillFieldRole.PaymentCardExpiryYear;
        }
        return AutofillFieldRole.PaymentCardExpiry;
    }

    if (/full name|display name/.test(label)) {
        return AutofillFieldRole.PersonFullName;
    }
    if (/first name|given name/.test(label)) {
        return AutofillFieldRole.PersonFirstName;
    }
    if (/last name|family name|surname/.test(label)) {
        return AutofillFieldRole.PersonLastName;
    }
    if (/email|e mail/.test(label) || valueKind === "email") {
        return AutofillFieldRole.ContactEmail;
    }
    if (/phone|mobile|telephone/.test(label) || valueKind === "phone") {
        return AutofillFieldRole.ContactPhone;
    }
    if (/address line 1|address1|line 1|line1|street address|street/.test(label)) {
        return AutofillFieldRole.AddressLine1;
    }
    if (/address line 2|address2|line 2|line2|unit|apt|suite/.test(label)) {
        return AutofillFieldRole.AddressLine2;
    }
    if (/city|town/.test(label)) {
        return AutofillFieldRole.AddressCity;
    }
    if (/state|province|region/.test(label)) {
        return AutofillFieldRole.AddressRegion;
    }
    if (/postal|zip/.test(label)) {
        return AutofillFieldRole.AddressPostalCode;
    }
    if (/country/.test(label)) {
        return AutofillFieldRole.AddressCountry;
    }

    if (valueKind === "url" || /url|website|web site|homepage|origin/.test(label)) {
        return kind === AutofillItemKind.MerchantProfile
            ? AutofillFieldRole.MerchantOrigin
            : AutofillFieldRole.LoginUrl;
    }

    if (kind === AutofillItemKind.PersonProfile && /name/.test(label)) {
        return AutofillFieldRole.PersonFullName;
    }
    if (kind === AutofillItemKind.PostalAddress && /address/.test(label)) {
        return AutofillFieldRole.AddressLine1;
    }

    return;
}

function fieldTypeForRole(role: AutofillFieldRole | undefined, valueType?: string): FieldType {
    switch (role) {
        case AutofillFieldRole.Username:
            return FieldType.Username;
        case AutofillFieldRole.Password:
            return FieldType.Password;
        case AutofillFieldRole.Totp:
            return FieldType.Totp;
        case AutofillFieldRole.LoginUrl:
        case AutofillFieldRole.MerchantOrigin:
            return FieldType.Url;
        case AutofillFieldRole.ContactEmail:
            return FieldType.Email;
        case AutofillFieldRole.ContactPhone:
            return FieldType.Phone;
        case AutofillFieldRole.PaymentCardPan:
            return FieldType.Credit;
        case AutofillFieldRole.PaymentCardCvvTransient:
            return FieldType.Pin;
        case AutofillFieldRole.PaymentCardExpiry:
        case AutofillFieldRole.PaymentCardExpiryMonth:
        case AutofillFieldRole.PaymentCardExpiryYear:
            return FieldType.Month;
        default:
            return valueType === "url" ? FieldType.Url : FieldType.Text;
    }
}

function exactTotpSecret(value: string): { secret: string } | { nonExact: true } {
    const candidate = value.trim();
    if (/^[A-Z2-7]+=*$/i.test(candidate)) {
        return { secret: candidate };
    }

    try {
        const uri = new URL(candidate);
        if (uri.protocol !== "otpauth:" || uri.hostname !== "totp") {
            return { nonExact: true };
        }

        const secret = uri.searchParams.get("secret");
        const algorithm = (uri.searchParams.get("algorithm") || "SHA1").toUpperCase();
        const digits = uri.searchParams.get("digits") || "6";
        const period = uri.searchParams.get("period") || "30";
        if (!secret || algorithm !== "SHA1" || digits !== "6" || period !== "30") {
            return { nonExact: true };
        }
        return { secret };
    } catch {
        return { nonExact: true };
    }
}

function categoryLosses(item: OnePuxItem["item"], sourceItemId: string): ImportLossEntry[] {
    const rawItem = asRecord(item);
    const details = asRecord(item?.details);
    const overview = asRecord(item?.overview);
    const losses: ImportLossEntry[] = [];

    if (
        hasOwn(rawItem, "passkeys") ||
        hasOwn(details, "passkeys") ||
        hasOwn(details, "passkey") ||
        hasOwn(details, "webauthn")
    ) {
        losses.push(importLoss(sourceItemId, "passkey", "skipped", lossCategoryToReason("passkey")));
    }
    if (hasOwn(rawItem, "attachments") || hasOwn(details, "attachments") || hasOwn(rawItem, "file")) {
        losses.push(importLoss(sourceItemId, "attachment", "lossy-normalized", lossCategoryToReason("attachment")));
    }
    if (hasOwn(details, "documentAttributes") || hasOwn(details, "documents")) {
        losses.push(importLoss(sourceItemId, "document", "lossy-normalized", lossCategoryToReason("document")));
    }
    if (Array.isArray(details?.passwordHistory) && details!.passwordHistory.length > 0) {
        losses.push(importLoss(sourceItemId, "history", "lossy-normalized", lossCategoryToReason("history")));
    }
    if (
        hasOwn(rawItem, "sharing") ||
        hasOwn(rawItem, "shared") ||
        hasOwn(rawItem, "permissions") ||
        hasOwn(details, "sharing") ||
        hasOwn(details, "shared") ||
        hasOwn(details, "permissions") ||
        hasOwn(overview, "sharing") ||
        hasOwn(overview, "shared") ||
        hasOwn(overview, "permissions")
    ) {
        losses.push(importLoss(sourceItemId, "sharing", "lossy-normalized", lossCategoryToReason("sharing")));
    }
    return losses;
}

function collectCandidates(
    item: OnePuxItem["item"],
    kind?: AutofillItemKind
): { candidates: OnePuxFieldCandidate[]; unsupportedField: boolean; nonExactTotp: boolean } {
    const candidates: OnePuxFieldCandidate[] = [];
    let unsupportedField = false;
    let nonExactTotp = false;
    const details = item?.details;

    for (const loginField of details?.loginFields || []) {
        const value = nonEmptyString(loginField.value);
        if (!value) {
            continue;
        }
        if (loginField.fieldType === "I" || loginField.fieldType === "C" || loginField.id.includes(";opid=__")) {
            unsupportedField = true;
            continue;
        }

        const name = nonEmptyString(loginField.name) || nonEmptyString(loginField.id) || "Imported field";
        const role =
            loginField.designation === "username"
                ? AutofillFieldRole.Username
                : loginField.designation === "password"
                ? AutofillFieldRole.Password
                : roleForLabel(name, kind, undefined, loginField.fieldType);

        if (!role) {
            unsupportedField = true;
            continue;
        }
        if (role === AutofillFieldRole.Totp) {
            const totpResult = exactTotpSecret(value);
            if ("secret" in totpResult) {
                candidates.push({ name, value: totpResult.secret, role, type: FieldType.Totp });
            } else {
                nonExactTotp = true;
            }
            continue;
        }
        candidates.push({ name, value, role, type: fieldTypeForRole(role) });
    }

    for (const section of details?.sections || []) {
        for (const sectionField of section.fields || []) {
            const extracted = valueFromSectionField(sectionField.value);
            if (!extracted || extracted.value.length === 0) {
                continue;
            }

            const name = nonEmptyString(sectionField.title) || nonEmptyString(sectionField.id) || "Imported field";
            const role = roleForLabel(name, kind, extracted.valueType);
            if (!role) {
                unsupportedField = true;
                continue;
            }
            if (role === AutofillFieldRole.Totp) {
                const totpResult = exactTotpSecret(extracted.value);
                if ("secret" in totpResult) {
                    candidates.push({ name, value: totpResult.secret, role, type: FieldType.Totp });
                } else {
                    nonExactTotp = true;
                }
                continue;
            }
            candidates.push({
                name,
                value: extracted.value,
                role,
                type: fieldTypeForRole(role, extracted.valueType),
            });
        }
    }

    const overviewUrl = nonEmptyString(item?.overview.url);
    if (overviewUrl && kind === AutofillItemKind.Login) {
        const alreadyHasUrl = candidates.some(
            (candidate) => candidate.role === AutofillFieldRole.LoginUrl && candidate.value === overviewUrl
        );
        if (!alreadyHasUrl) {
            candidates.push({
                name: $l("URL"),
                value: overviewUrl,
                role: AutofillFieldRole.LoginUrl,
                type: FieldType.Url,
            });
        }
    } else if (overviewUrl && kind === AutofillItemKind.MerchantProfile) {
        candidates.push({
            name: $l("Origin"),
            value: overviewUrl,
            role: AutofillFieldRole.MerchantOrigin,
            type: FieldType.Url,
        });
    }

    const notes = nonEmptyString(item?.details.notesPlain);
    if (notes) {
        candidates.push({ name: $l("Notes"), value: notes, type: FieldType.Note });
    }

    return { candidates, unsupportedField, nonExactTotp };
}

async function normalize1PuxItem(
    accountName: string,
    vaultName: string,
    item: OnePuxItem["item"],
    fallbackSourceItemId: string,
    provenanceBase: Omit<ImportProvenance, "sourceItemId">
): Promise<OnePuxNormalizedItem> {
    if (!item) {
        return { losses: [] };
    }

    const sourceItemId = itemSourceId(item, fallbackSourceItemId);
    const losses = categoryLosses(item, sourceItemId);
    const categoryKind = kindFromCategory(item.categoryUuid);
    const rawCandidates = collectCandidates(item, categoryKind);
    const inferredKind =
        categoryKind ||
        deriveAutofillItemKind(rawCandidates.candidates.map((candidate) => ({ autofillRole: candidate.role })));
    const kind = categoryKind || inferredKind;

    if (!kind) {
        losses.push(importLoss(sourceItemId, "unknown-kind", "skipped", lossCategoryToReason("unknown-kind")));
        return { losses };
    }

    const candidates = collectCandidates(item, kind);
    if (candidates.nonExactTotp) {
        losses.push(importLoss(sourceItemId, "totp-parameters", "skipped", lossCategoryToReason("totp-parameters")));
    }
    if (candidates.unsupportedField) {
        losses.push(
            importLoss(sourceItemId, "unsupported-field", "skipped", lossCategoryToReason("unsupported-field"))
        );
    }

    const fields = candidates.candidates.map(
        (candidate) =>
            new Field({
                name: candidate.name,
                value: candidate.value,
                type: candidate.type,
                autofillRole: candidate.role,
            })
    );
    if (fields.length === 0 && !item.trashed) {
        return { losses };
    }

    const tags = [accountName, vaultName, ...((item.overview.tags || []).filter(Boolean) as string[])].filter(Boolean);
    if (item.trashed) {
        tags.push("trashed");
        losses.push(importLoss(sourceItemId, "trashed", "lossy-normalized", lossCategoryToReason("trashed")));
    }

    const provenance: ImportProvenance = {
        ...provenanceBase,
        sourceItemId,
    };
    const importedItem = await createVaultItem({
        name: nonEmptyString(item.overview.title) || "Unnamed",
        fields,
        tags,
        autofillKind: kind,
        provenance,
    });

    // A trashed record remains inspectable and keeps provenance, but it must
    // not become a new autofill authority merely because it was imported.
    if (item.trashed) {
        importedItem.autofillKind = undefined;
    }

    return { item: importedItem, losses };
}

function importedAtForExport(dataExport: OnePuxExport, requested?: string): string {
    if (requested && !Number.isNaN(Date.parse(requested))) {
        return requested;
    }

    const createdAt = dataExport.attributes && dataExport.attributes.createdAt;
    if (typeof createdAt === "number" && Number.isFinite(createdAt)) {
        const millis = createdAt < 100000000000 ? createdAt * 1000 : createdAt;
        const date = new Date(millis);
        if (!Number.isNaN(date.getTime())) {
            return date.toISOString();
        }
    }
    return FALLBACK_IMPORT_TIME;
}

function sourceIdForFile(file: File, requested?: string): string {
    if (requested && requested.length > 0) {
        return requested;
    }
    const fileName = file && typeof file.name === "string" ? file.name : "";
    return fileName || "1pux-export";
}

async function normalize1PuxExport(dataExport: OnePuxExport, options: OnePuxImportOptions = {}): Promise<OnePuxImport> {
    const sourceId = options.sourceId || "1pux-export";
    const importedAt = importedAtForExport(dataExport, options.importedAt);
    const importerVersion = options.importerVersion || ONEPUX_IMPORTER_VERSION;
    const provenanceBase: Omit<ImportProvenance, "sourceItemId"> = {
        schema: IMPORT_PROVENANCE_SCHEMA,
        source: "1pux",
        sourceId,
        importedAt,
        importerVersion,
    };
    const items: VaultItem[] = [];
    const losses: ImportLossEntry[] = [];
    const sourceIdentifiers: string[] = [];
    let skipped = 0;
    let lossy = 0;
    let itemIndex = 0;

    for (const account of dataExport.data.accounts || []) {
        for (const vault of account.vaults || []) {
            for (const vaultItem of vault.items || []) {
                const rawItem = vaultItem.item;
                const fallbackSourceItemId = `${account.attrs.uuid || account.attrs.name}/${
                    vault.attrs.uuid || vault.attrs.name
                }/${itemIndex}`;
                itemIndex += 1;
                if (!rawItem) {
                    skipped += 1;
                    continue;
                }

                const sourceItemId = itemSourceId(rawItem, fallbackSourceItemId);
                if (!sourceIdentifiers.includes(sourceItemId)) {
                    sourceIdentifiers.push(sourceItemId);
                }

                const normalized = await normalize1PuxItem(
                    account.attrs.name,
                    vault.attrs.name,
                    rawItem,
                    fallbackSourceItemId,
                    provenanceBase
                );
                losses.push(...normalized.losses);
                if (normalized.item) {
                    items.push(normalized.item);
                    if (normalized.losses.length > 0) {
                        lossy += 1;
                    }
                } else {
                    skipped += 1;
                }
            }
        }
    }

    const result: ImportResult = {
        schema: IMPORT_RESULT_SCHEMA,
        imported: items.length,
        normalized: items.length,
        skipped,
        lossy,
        provenance: provenanceBase,
        losses,
        sourceIdentifiers,
    };
    return { items, result };
}

/**
 * Normalize an already-parsed synthetic export. Keeping this boundary
 * separate makes importer tests deterministic and avoids real exports.
 */
export async function import1PuxExport(
    dataExport: OnePuxExport,
    options: OnePuxImportOptions = {}
): Promise<OnePuxImport> {
    return normalize1PuxExport(dataExport, options);
}

/** Parse and normalize a 1PUX file while returning the value-free report. */
export async function import1Pux(file: File, options: OnePuxImportOptions = {}): Promise<OnePuxImport> {
    try {
        const { parse1PuxFile } = await import("./1pux-parser");
        const data = await readFileAsArrayBuffer(file);
        const dataExport = await parse1PuxFile(data);
        return normalize1PuxExport(dataExport, {
            ...options,
            sourceId: sourceIdForFile(file, options.sourceId),
        });
    } catch (error) {
        throw new Err(ErrorCode.INVALID_1PUX, "Failed to parse .1pux file.");
    }
}

/** Result-only boundary for callers that do not need decrypted item values. */
export async function import1PuxResult(file: File, options: OnePuxImportOptions = {}): Promise<ImportResult> {
    const imported = await import1Pux(file, options);
    return imported.result;
}

export async function as1PuxResult(file: File, options: OnePuxImportOptions = {}): Promise<ImportResult> {
    return import1PuxResult(file, options);
}

export async function as1PuxWithResult(file: File, options: OnePuxImportOptions = {}): Promise<OnePuxImport> {
    return import1Pux(file, options);
}

/**
 * Legacy UI callers still receive the item array. The result is attached as a
 * non-enumerable property so the existing import dialog remains unchanged.
 */
export async function as1Pux(file: File): Promise<OnePuxImportedItems> {
    const imported = await import1Pux(file);
    Object.defineProperty(imported.items, "importResult", {
        configurable: false,
        enumerable: false,
        value: imported.result,
        writable: false,
    });
    return imported.items as OnePuxImportedItems;
}

/**
 * Checks if a given file name ends with .1pux to avoid trying to parse unnecessarily
 */
export function is1Pux(file: File): boolean {
    return file.name.endsWith(".1pux");
}

async function parseBitwardenItem(
    vaultName: string,
    item: BitwardenItem,
    folders: BitwardenExport["folders"]
): Promise<VaultItem | undefined> {
    if (!item) {
        return;
    }

    const { parseToRowData } = await import("./bitwarden-parser");

    const rowData = parseToRowData(item, [vaultName], folders);

    if (!rowData) {
        return;
    }

    const itemName = rowData.name;
    const tags = rowData.tags.split(",");

    const fields: Field[] = [];

    if (rowData.username) {
        fields.push(new Field({ name: $l("Username"), value: rowData.username, type: FieldType.Username }));
    }

    if (rowData.password) {
        fields.push(new Field({ name: $l("Password"), value: rowData.password, type: FieldType.Password }));
    }

    if (rowData.url) {
        fields.push(new Field({ name: $l("URL"), value: rowData.url, type: FieldType.Url }));
    }

    if (rowData.notes) {
        fields.push(new Field({ name: $l("Notes"), value: rowData.notes, type: FieldType.Note }));
    }

    for (const extraField of rowData.extraFields) {
        if (extraField.type === "totp") {
            // Extract just the secret
            try {
                const secret = new URL(extraField.value).searchParams.get("secret");
                if (secret) {
                    fields.push(new Field({ name: extraField.name, value: secret, type: FieldType.Totp }));
                }
            } catch (error) {
                // Do nothing
            }
        } else {
            fields.push(
                new Field({ name: extraField.name, value: extraField.value, type: extraField.type as FieldType })
            );
        }
    }

    return createVaultItem({ name: itemName, fields, tags });
}

export async function asBitwarden(file: File): Promise<VaultItem[]> {
    try {
        const { parseBitwardenFile } = await import("./bitwarden-parser");
        const contents = await readFileAsText(file);
        const dataExport = await parseBitwardenFile(contents);

        const items = [];

        for (const vaultItem of dataExport.items) {
            if (vaultItem) {
                const parsedItem = await parseBitwardenItem(
                    file.name.replace(".json", ""),
                    vaultItem,
                    dataExport.folders
                );
                if (parsedItem) {
                    items.push(parsedItem);
                }
            }
        }

        return items;
    } catch (error) {
        throw new Err(ErrorCode.INVALID_BITWARDEN, "Failed to parse Bitwarden .json file.");
    }
}

export async function isBitwarden(file: File): Promise<boolean> {
    try {
        const content = await readFileAsText(file);
        const data = JSON.parse(content);
        return Object.prototype.hasOwnProperty.call(data, "items");
    } catch (error) {
        return false;
    }
}

async function dashlaneParseRow(row: string[]): Promise<VaultItem> {
    const nameIndex = 3;
    const categoryIndex = 7;
    const urlIndex = 6;
    const usernameIndex = 0;
    const otherUsernameIndexes = [1, 2];
    const passwordIndex = 4;
    const notesIndex = 5;
    const totpIndex = 8;

    const fields: Field[] = [
        new Field({ name: $l("Username"), value: row[usernameIndex], type: FieldType.Username }),
        new Field({ name: $l("Password"), value: row[passwordIndex], type: FieldType.Password }),
        new Field({ name: $l("URL"), value: row[urlIndex], type: FieldType.Url }),
    ];

    for (const otherUsernameIndex of otherUsernameIndexes) {
        if (row[otherUsernameIndex]) {
            fields.push(
                new Field({ name: $l("Other Username"), value: row[otherUsernameIndex], type: FieldType.Username })
            );
        }
    }

    if (row[notesIndex]) {
        fields.push(new Field({ name: $l("Notes"), value: row[notesIndex], type: FieldType.Note }));
    }

    if (row[totpIndex]) {
        fields.push(new Field({ name: $l("One-Time Password"), value: row[totpIndex], type: FieldType.Totp }));
    }

    const tags = row[categoryIndex] ? [row[categoryIndex]] : [];

    return createVaultItem({ name: row[nameIndex], fields, tags });
}

export async function asDashlane(file: File): Promise<VaultItem[]> {
    const data = await readFileAsText(file);
    const papa = await loadPapa();
    const items = papa
        .parse(data)
        .data // Remove first row as it only contains field names
        .slice(1)
        // Filter out empty rows
        .filter((row: string[]) => row.length > 1)
        .map(dashlaneParseRow);

    return Promise.all(items);
}

export async function isDashlane(file: File): Promise<boolean> {
    try {
        const data = await readFileAsText(file);
        const headerRow = data.split("\n")[0].trim();
        return headerRow === "username,username2,username3,title,password,note,url,category,otpSecret";
    } catch (error) {
        return false;
    }
}

async function keePassParseRow(row: string[]): Promise<VaultItem> {
    const nameIndex = 0;
    const urlIndex = 3;
    const usernameIndex = 1;
    const passwordIndex = 2;
    const notesIndex = 4;

    const fields: Field[] = [
        new Field({ name: $l("Username"), value: row[usernameIndex], type: FieldType.Username }),
        new Field({ name: $l("Password"), value: row[passwordIndex], type: FieldType.Password }),
        new Field({ name: $l("URL"), value: row[urlIndex], type: FieldType.Url }),
    ];

    if (row[notesIndex]) {
        fields.push(new Field({ name: $l("Notes"), value: row[notesIndex], type: FieldType.Note }));
    }

    return createVaultItem({ name: row[nameIndex], fields, tags: [] });
}

export async function asKeePass(file: File): Promise<VaultItem[]> {
    const data = await readFileAsText(file);
    const papa = await loadPapa();
    const items = papa
        .parse(data)
        .data // Remove first row as it only contains field names
        .slice(1)
        // Filter out empty rows
        .filter((row: string[]) => row.length > 1)
        .map(keePassParseRow);

    return Promise.all(items);
}

export async function isKeePass(file: File): Promise<boolean> {
    try {
        const data = await readFileAsText(file);
        const headerRow = data.split("\n")[0].trim();
        return headerRow === '"Account","Login Name","Password","Web Site","Comments"';
    } catch (error) {
        return false;
    }
}

async function nordPassParseRow(row: string[]): Promise<VaultItem> {
    const nameIndex = 0;
    const urlIndex = 1;
    const usernameIndex = 2;
    const passwordIndex = 3;
    const notesIndex = 4;
    const cardHolderNameIndex = 5;
    const cardNumberIndex = 6;
    const cvcIndex = 7;
    const expiryDateIndex = 8;
    const zipCodeIndex = 9;
    const folderIndex = 10;
    const fullNameIndex = 11;
    const phoneIndex = 12;
    const emailIndex = 13;
    const address1Index = 14;
    const address2Index = 15;
    const cityIndex = 16;
    const countryIndex = 17;
    const stateIndex = 18;

    const fields: Field[] = [
        new Field({ name: $l("Username"), value: row[usernameIndex], type: FieldType.Username }),
        new Field({ name: $l("Password"), value: row[passwordIndex], type: FieldType.Password }),
        new Field({ name: $l("URL"), value: row[urlIndex], type: FieldType.Url }),
    ];

    if (row[notesIndex]) {
        fields.push(new Field({ name: $l("Notes"), value: row[notesIndex], type: FieldType.Note }));
    }

    if (row[cardHolderNameIndex]) {
        fields.push(new Field({ name: $l("Cardholder Name"), value: row[cardHolderNameIndex], type: FieldType.Text }));
    }

    if (row[cardNumberIndex]) {
        fields.push(new Field({ name: $l("Card Number"), value: row[cardNumberIndex], type: FieldType.Credit }));
    }

    if (row[cvcIndex]) {
        fields.push(new Field({ name: $l("CVC"), value: row[cvcIndex], type: FieldType.Pin }));
    }

    if (row[expiryDateIndex]) {
        fields.push(new Field({ name: $l("Expiry Date"), value: row[expiryDateIndex], type: FieldType.Date }));
    }

    if (row[zipCodeIndex]) {
        fields.push(new Field({ name: $l("Zip Code"), value: row[zipCodeIndex], type: FieldType.Text }));
    }

    if (row[fullNameIndex]) {
        fields.push(new Field({ name: $l("Full Name"), value: row[fullNameIndex], type: FieldType.Text }));
    }

    if (row[phoneIndex]) {
        fields.push(new Field({ name: $l("Phone Number"), value: row[phoneIndex], type: FieldType.Text }));
    }

    if (row[emailIndex]) {
        fields.push(new Field({ name: $l("Email"), value: row[emailIndex], type: FieldType.Email }));
    }

    if (row[address1Index]) {
        fields.push(new Field({ name: $l("Address 1"), value: row[address1Index], type: FieldType.Text }));
    }

    if (row[address2Index]) {
        fields.push(new Field({ name: $l("Address 2"), value: row[address2Index], type: FieldType.Text }));
    }

    if (row[cityIndex]) {
        fields.push(new Field({ name: $l("City"), value: row[cityIndex], type: FieldType.Text }));
    }

    if (row[countryIndex]) {
        fields.push(new Field({ name: $l("Country"), value: row[countryIndex], type: FieldType.Text }));
    }

    if (row[stateIndex]) {
        fields.push(new Field({ name: $l("State"), value: row[stateIndex], type: FieldType.Text }));
    }

    const tags = row[folderIndex] ? [row[folderIndex]] : [];

    return createVaultItem({ name: row[nameIndex], fields, tags });
}

export async function asNordPass(file: File): Promise<VaultItem[]> {
    const data = await readFileAsText(file);
    const papa = await loadPapa();
    const typeIndex = 19;
    const items = papa
        .parse(data)
        .data // Remove first row as it only contains field names
        .slice(1)
        // Filter out empty rows
        .filter((row: string[]) => row.length > 1)
        // Filter out folders
        .filter((row: string[]) => row[typeIndex] !== "folder")
        .map(nordPassParseRow);

    return Promise.all(items);
}

export async function isNordPass(file: File): Promise<boolean> {
    try {
        const data = await readFileAsText(file);
        const headerRow = data.split("\n")[0].trim();
        return (
            headerRow ===
            "name,url,username,password,note,cardholdername,cardnumber,cvc,expirydate,zipcode,folder,full_name,phone_number,email,address1,address2,city,country,state,type"
        );
    } catch (error) {
        return false;
    }
}

async function iCloudParseRow(row: string[]): Promise<VaultItem> {
    const nameIndex = 0;
    const urlIndex = 1;
    const usernameIndex = 2;
    const passwordIndex = 3;
    const notesIndex = 4;
    const totpIndex = 5;

    const fields: Field[] = [
        new Field({ name: $l("Username"), value: row[usernameIndex], type: FieldType.Username }),
        new Field({ name: $l("Password"), value: row[passwordIndex], type: FieldType.Password }),
        new Field({ name: $l("URL"), value: row[urlIndex], type: FieldType.Url }),
    ];

    if (row[notesIndex]) {
        fields.push(new Field({ name: $l("Notes"), value: row[notesIndex], type: FieldType.Note }));
    }

    if (row[totpIndex]) {
        // Extract just the secret
        try {
            const secret = new URL(row[totpIndex]).searchParams.get("secret");
            if (secret) {
                fields.push(new Field({ name: $l("One-Time Password"), value: secret, type: FieldType.Totp }));
            }
        } catch (error) {
            // Do nothing
        }
    }

    return createVaultItem({ name: row[nameIndex], fields, tags: [] });
}

export async function asICloud(file: File): Promise<VaultItem[]> {
    const data = await readFileAsText(file);
    const papa = await loadPapa();
    const items = papa
        .parse(data)
        .data // Remove first row as it only contains field names
        .slice(1)
        // Filter out empty rows
        .filter((row: string[]) => row.length > 1)
        .map(iCloudParseRow);

    return Promise.all(items);
}

export async function isICloud(file: File): Promise<boolean> {
    try {
        const data = await readFileAsText(file);
        const headerRow = data.split("\n")[0].trim();
        return headerRow === "Title,URL,Username,Password,Notes,OTPAuth";
    } catch (error) {
        return false;
    }
}

async function chromeParseRow(row: string[]): Promise<VaultItem> {
    const nameIndex = 0;
    const urlIndex = 1;
    const usernameIndex = 2;
    const passwordIndex = 3;

    const fields: Field[] = [
        new Field({ name: $l("Username"), value: row[usernameIndex], type: FieldType.Username }),
        new Field({ name: $l("Password"), value: row[passwordIndex], type: FieldType.Password }),
        new Field({ name: $l("URL"), value: row[urlIndex], type: FieldType.Url }),
    ];

    return createVaultItem({ name: row[nameIndex], fields, tags: [] });
}

export async function asChrome(file: File): Promise<VaultItem[]> {
    const data = await readFileAsText(file);
    const papa = await loadPapa();
    const items = papa
        .parse(data)
        .data // Remove first row as it only contains field names
        .slice(1)
        // Filter out empty rows
        .filter((row: string[]) => row.length > 1)
        .map(chromeParseRow);

    return Promise.all(items);
}

export async function isChrome(file: File): Promise<boolean> {
    try {
        const data = await readFileAsText(file);
        const headerRow = data.split("\n")[0].trim();
        return headerRow === "name,url,username,password";
    } catch (error) {
        return false;
    }
}

async function firefoxParseRow(row: string[]): Promise<VaultItem> {
    const nameIndex = 0;
    const urlIndex = 0;
    const usernameIndex = 1;
    const passwordIndex = 2;

    const fields: Field[] = [
        new Field({ name: $l("Username"), value: row[usernameIndex], type: FieldType.Username }),
        new Field({ name: $l("Password"), value: row[passwordIndex], type: FieldType.Password }),
        new Field({ name: $l("URL"), value: row[urlIndex], type: FieldType.Url }),
    ];

    return createVaultItem({ name: row[nameIndex].replace("https://", "").replace("http://", ""), fields, tags: [] });
}

export async function asFirefox(file: File): Promise<VaultItem[]> {
    const data = await readFileAsText(file);
    const papa = await loadPapa();
    const urlIndex = 0;
    const items = papa
        .parse(data)
        .data // Remove first row as it only contains field names
        .slice(1)
        // Filter out empty rows
        .filter((row: string[]) => row.length > 1)
        // Filter out Firefox Sync identity
        .filter((row: string[]) => row[urlIndex] !== "chrome://FirefoxAccounts")
        .map(firefoxParseRow);

    return Promise.all(items);
}

export async function isFirefox(file: File): Promise<boolean> {
    try {
        const data = await readFileAsText(file);
        const headerRow = data.split("\n")[0].trim();
        return (
            headerRow ===
            '"url","username","password","httpRealm","formActionOrigin","guid","timeCreated","timeLastUsed","timePasswordChanged"'
        );
    } catch (error) {
        return false;
    }
}

export async function guessFormat(file: File): Promise<ImportFormat> {
    // Try to guess 1pux first (won't need parsing)
    if (is1Pux(file)) {
        return ONEPUX;
    }
    if (await isBitwarden(file)) {
        return BITWARDEN;
    }
    if (await isPBES2Container(file)) {
        return PBES2;
    }
    if (await isPadlockV1(file)) {
        return PADLOCK_LEGACY;
    }
    if (await isLastPass(file)) {
        return LASTPASS;
    }
    if (await isDashlane(file)) {
        return DASHLANE;
    }
    if (await isKeePass(file)) {
        return KEEPASS;
    }
    if (await isNordPass(file)) {
        return NORDPASS;
    }
    if (await isICloud(file)) {
        return ICLOUD;
    }
    if (await isChrome(file)) {
        return CHROME;
    }
    if (await isFirefox(file)) {
        return FIREFOX;
    }

    return CSV;
}
