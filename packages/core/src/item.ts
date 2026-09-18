import { translate as $l } from "@padloc/locale/src/translate";
import { base32ToBytes, Serializable, AsSerializable, AsDate, Serialize } from "./encoding";
import { totp } from "./otp";
import { uuid } from "./util";
import { AccountID } from "./account";
import { AttachmentInfo } from "./attachment";
import { openExternalUrl } from "./platform";
import { add } from "date-fns";
import { PasskeyCredential } from "./passkey";
import { ImportProvenance, parseImportProvenance } from "./import-result";

/** A tag that can be assigned to a [[VaultItem]] */
export type Tag = string;

export interface TagInfo {
    name: Tag;
    unlisted?: boolean;
    color?: string;
    count?: number;
    readonly?: number;
}

/** Unique identifier for [[VaultItem]]s */
export type VaultItemID = string;

export enum FieldType {
    Username = "username",
    Password = "password",
    Url = "url",
    Email = "email",
    Date = "date",
    Month = "month",
    Credit = "credit",
    Phone = "phone",
    Pin = "pin",
    Totp = "totp",
    Note = "note",
    Text = "text",
}

export enum AutofillItemKind {
    PersonProfile = "person_profile",
    PostalAddress = "postal_address",
    PaymentCardPolicy = "payment_card_policy",
    GiftRecipient = "gift_recipient",
    MerchantProfile = "merchant_profile",
    Login = "login",
    GovernmentIdentity = "government_identity",
    FinancialAccount = "financial_account",
}

export enum AutofillFieldRole {
    Username = "username",
    Password = "password",
    Totp = "totp",
    LoginUrl = "login.url",
    PersonFullName = "person.full_name",
    PersonFirstName = "person.first_name",
    PersonLastName = "person.last_name",
    ContactEmail = "contact.email",
    ContactPhone = "contact.phone",
    AddressLine1 = "address.line1",
    AddressLine2 = "address.line2",
    AddressCity = "address.city",
    AddressRegion = "address.region",
    AddressPostalCode = "address.postal_code",
    AddressCountry = "address.country",
    PaymentCardPan = "payment.card.pan",
    PaymentCardholderName = "payment.card.cardholder_name",
    PaymentCardExpiry = "payment.card.expiry",
    PaymentCardExpiryMonth = "payment.card.expiry_month",
    PaymentCardExpiryYear = "payment.card.expiry_year",
    PaymentCardCvvTransient = "payment.card.cvv_transient",
    MerchantOrigin = "merchant.origin",
    GovernmentSsn = "government.ssn",
    GovernmentPassportNumber = "government.passport_number",
    GovernmentDriversLicenseNumber = "government.drivers_license_number",
    GovernmentNationalId = "government.national_id",
    FinancialAccountNumber = "financial.account_number",
    FinancialRoutingNumber = "financial.routing_number",
    FinancialIban = "financial.iban",
    FinancialBic = "financial.bic",
}

export type AutofillReleaseClass = "low" | "secret" | "high-risk";

const LOW_RISK_ROLES = new Set<AutofillFieldRole>([
    AutofillFieldRole.PersonFullName,
    AutofillFieldRole.PersonFirstName,
    AutofillFieldRole.PersonLastName,
    AutofillFieldRole.ContactEmail,
    AutofillFieldRole.ContactPhone,
    AutofillFieldRole.AddressLine1,
    AutofillFieldRole.AddressLine2,
    AutofillFieldRole.AddressCity,
    AutofillFieldRole.AddressRegion,
    AutofillFieldRole.AddressPostalCode,
    AutofillFieldRole.AddressCountry,
    AutofillFieldRole.LoginUrl,
    AutofillFieldRole.MerchantOrigin,
]);

const SECRET_ROLES = new Set<AutofillFieldRole>([
    AutofillFieldRole.Username,
    AutofillFieldRole.Password,
    AutofillFieldRole.Totp,
    AutofillFieldRole.PaymentCardPan,
    AutofillFieldRole.PaymentCardholderName,
    AutofillFieldRole.PaymentCardExpiry,
    AutofillFieldRole.PaymentCardExpiryMonth,
    AutofillFieldRole.PaymentCardExpiryYear,
]);

const HIGH_RISK_ROLES = new Set<AutofillFieldRole>([
    AutofillFieldRole.PaymentCardCvvTransient,
    AutofillFieldRole.GovernmentSsn,
    AutofillFieldRole.GovernmentPassportNumber,
    AutofillFieldRole.GovernmentDriversLicenseNumber,
    AutofillFieldRole.GovernmentNationalId,
    AutofillFieldRole.FinancialAccountNumber,
    AutofillFieldRole.FinancialRoutingNumber,
    AutofillFieldRole.FinancialIban,
    AutofillFieldRole.FinancialBic,
]);

export function isAutofillItemKind(value: unknown): value is AutofillItemKind {
    return typeof value === "string" && Object.values(AutofillItemKind).includes(value as AutofillItemKind);
}

export function isAutofillFieldRole(value: unknown): value is AutofillFieldRole {
    return typeof value === "string" && Object.values(AutofillFieldRole).includes(value as AutofillFieldRole);
}

/**
 * Returns the release class implied by a known role. Unknown roles return
 * undefined so callers cannot accidentally grant fill authority.
 */
export function getAutofillReleaseClass(
    role?: AutofillFieldRole | string | null
): AutofillReleaseClass | undefined {
    if (!isAutofillFieldRole(role)) {
        return undefined;
    }
    if (LOW_RISK_ROLES.has(role)) {
        return "low";
    }
    if (SECRET_ROLES.has(role)) {
        return "secret";
    }
    if (HIGH_RISK_ROLES.has(role)) {
        return "high-risk";
    }
    return undefined;
}

export const releaseClassForAutofillRole = getAutofillReleaseClass;

export function isAutofillTransactionOnlyRole(role?: AutofillFieldRole | string | null): boolean {
    return role === AutofillFieldRole.PaymentCardCvvTransient;
}

/**
 * Infer a role only when the template omitted one. Explicit unknown roles are
 * never replaced with a guessed role because that would grant authority.
 */
export function inferAutofillFieldRole({
    name = "",
    type,
    autofillRole,
}: {
    name?: string;
    type: FieldType;
    autofillRole?: unknown;
}): AutofillFieldRole | undefined {
    if (typeof autofillRole !== "undefined") {
        return isAutofillFieldRole(autofillRole) ? autofillRole : undefined;
    }

    const normalizedName = name.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();

    if (type === FieldType.Username) {
        return AutofillFieldRole.Username;
    }
    if (type === FieldType.Password) {
        return AutofillFieldRole.Password;
    }
    if (type === FieldType.Totp) {
        return AutofillFieldRole.Totp;
    }
    if (type === FieldType.Url) {
        return /merchant|origin/.test(normalizedName)
            ? AutofillFieldRole.MerchantOrigin
            : AutofillFieldRole.LoginUrl;
    }
    if (type === FieldType.Email) {
        return AutofillFieldRole.ContactEmail;
    }
    if (type === FieldType.Phone) {
        return AutofillFieldRole.ContactPhone;
    }
    if (type === FieldType.Credit) {
        return AutofillFieldRole.PaymentCardPan;
    }
    if (type === FieldType.Month) {
        return AutofillFieldRole.PaymentCardExpiry;
    }

    if (/cvv|cvc|security code/.test(normalizedName)) {
        return AutofillFieldRole.PaymentCardCvvTransient;
    }
    if (/passport number/.test(normalizedName)) {
        return AutofillFieldRole.GovernmentPassportNumber;
    }
    if (/driver.?s license number|drivers license/.test(normalizedName)) {
        return AutofillFieldRole.GovernmentDriversLicenseNumber;
    }
    if (/social security|^ssn$/.test(normalizedName)) {
        return AutofillFieldRole.GovernmentSsn;
    }
    if (/national id/.test(normalizedName)) {
        return AutofillFieldRole.GovernmentNationalId;
    }
    if (/account number/.test(normalizedName)) {
        return AutofillFieldRole.FinancialAccountNumber;
    }
    if (/routing number/.test(normalizedName)) {
        return AutofillFieldRole.FinancialRoutingNumber;
    }
    if (/^iban$/.test(normalizedName)) {
        return AutofillFieldRole.FinancialIban;
    }
    if (/^bic$/.test(normalizedName)) {
        return AutofillFieldRole.FinancialBic;
    }
    if (/card owner|cardholder/.test(normalizedName)) {
        return AutofillFieldRole.PaymentCardholderName;
    }
    if (/card number|^pan$/.test(normalizedName)) {
        return AutofillFieldRole.PaymentCardPan;
    }
    if (/full name/.test(normalizedName)) {
        return AutofillFieldRole.PersonFullName;
    }
    if (/^first name$/.test(normalizedName)) {
        return AutofillFieldRole.PersonFirstName;
    }
    if (/^last name$/.test(normalizedName)) {
        return AutofillFieldRole.PersonLastName;
    }
    if (/address line 1|street address/.test(normalizedName)) {
        return AutofillFieldRole.AddressLine1;
    }
    if (/address line 2/.test(normalizedName)) {
        return AutofillFieldRole.AddressLine2;
    }
    if (/^city$/.test(normalizedName)) {
        return AutofillFieldRole.AddressCity;
    }
    if (/state|region/.test(normalizedName)) {
        return AutofillFieldRole.AddressRegion;
    }
    if (/postal|zip/.test(normalizedName)) {
        return AutofillFieldRole.AddressPostalCode;
    }
    if (/^country$/.test(normalizedName)) {
        return AutofillFieldRole.AddressCountry;
    }

    return undefined;
}

export function deriveAutofillItemKind(
    fields: Array<{ autofillRole?: AutofillFieldRole | string | null }>
): AutofillItemKind | undefined {
    const roles = fields.map((field) => field.autofillRole).filter(isAutofillFieldRole);

    if (
        roles.some(
            (role) =>
                role === AutofillFieldRole.GovernmentSsn ||
                role === AutofillFieldRole.GovernmentPassportNumber ||
                role === AutofillFieldRole.GovernmentDriversLicenseNumber ||
                role === AutofillFieldRole.GovernmentNationalId
        )
    ) {
        return AutofillItemKind.GovernmentIdentity;
    }
    if (
        roles.some(
            (role) =>
                role === AutofillFieldRole.FinancialAccountNumber ||
                role === AutofillFieldRole.FinancialRoutingNumber ||
                role === AutofillFieldRole.FinancialIban ||
                role === AutofillFieldRole.FinancialBic
        )
    ) {
        return AutofillItemKind.FinancialAccount;
    }
    if (
        roles.some(
            (role) =>
                role === AutofillFieldRole.PaymentCardPan ||
                role === AutofillFieldRole.PaymentCardholderName ||
                role === AutofillFieldRole.PaymentCardExpiry ||
                role === AutofillFieldRole.PaymentCardExpiryMonth ||
                role === AutofillFieldRole.PaymentCardExpiryYear ||
                role === AutofillFieldRole.PaymentCardCvvTransient
        )
    ) {
        return AutofillItemKind.PaymentCardPolicy;
    }
    if (
        roles.some(
            (role) =>
                role === AutofillFieldRole.AddressLine1 ||
                role === AutofillFieldRole.AddressLine2 ||
                role === AutofillFieldRole.AddressCity ||
                role === AutofillFieldRole.AddressRegion ||
                role === AutofillFieldRole.AddressPostalCode ||
                role === AutofillFieldRole.AddressCountry
        )
    ) {
        return AutofillItemKind.PostalAddress;
    }
    if (
        roles.some(
            (role) =>
                role === AutofillFieldRole.PersonFullName ||
                role === AutofillFieldRole.PersonFirstName ||
                role === AutofillFieldRole.PersonLastName ||
                role === AutofillFieldRole.ContactEmail ||
                role === AutofillFieldRole.ContactPhone
        )
    ) {
        return AutofillItemKind.PersonProfile;
    }
    if (roles.includes(AutofillFieldRole.MerchantOrigin)) {
        return AutofillItemKind.MerchantProfile;
    }
    if (
        roles.some(
            (role) =>
                role === AutofillFieldRole.Username ||
                role === AutofillFieldRole.Password ||
                role === AutofillFieldRole.LoginUrl ||
                role === AutofillFieldRole.Totp
        )
    ) {
        return AutofillItemKind.Login;
    }

    return undefined;
}

/**
 * Field definition containing meta data for a certain field type
 */
export interface FieldDef {
    /** content type */
    type: FieldType;
    /** regular expression describing pattern of field contents (used for validation) */
    pattern: RegExp;
    /** regular expression describing pattern of field contents (used for matching) */
    matchPattern: RegExp;
    /** whether the field should be masked when displayed */
    mask: boolean;
    /** whether the field value can have multiple lines */
    multiline: boolean;
    /** icon used for display */
    icon: string;
    /** display name */
    name: string;
    /** display formatting */
    format?: (value: string, masked: boolean) => string;
    /** for values that need to be prepared before being copied / filled */
    transform?: (value: string) => Promise<string>;
    actions?: { icon: string; label: string; action: (value: string) => void }[];
}

/** Available field types and respective meta data (order matters for pattern matching) */
export const FIELD_DEFS: { [t in FieldType]: FieldDef } = {
    [FieldType.Username]: {
        type: FieldType.Username,
        pattern: /.*/,
        matchPattern: /.*/,
        mask: false,
        multiline: false,
        icon: "user",
        get name() {
            return $l("Username");
        },
    },
    [FieldType.Password]: {
        type: FieldType.Password,
        pattern: /.*/,
        matchPattern: /.*/,
        mask: true,
        multiline: true,
        icon: "lock",
        get name() {
            return $l("Password");
        },
        format(value, masked) {
            return masked ? value.replace(/./g, "\u2022") : value;
        },
    },
    [FieldType.Email]: {
        type: FieldType.Email,
        pattern: /(.*)@(.*)/,
        matchPattern: /^[\w-\.]+@([\w-]+\.)+[\w-]{2,8}$/,
        mask: false,
        multiline: false,
        icon: "email",
        get name() {
            return $l("Email Address");
        },
    },
    [FieldType.Url]: {
        type: FieldType.Url,
        pattern: /.*/,
        matchPattern: /[(http(s)?):\/\/(www\.)?a-zA-Z0-9@:%._\+~#=]{2,256}\.[a-z]{2,8}\b([-a-zA-Z0-9@:%_\+.~#?&//=]*)/i,
        mask: false,
        multiline: false,
        icon: "web",
        get name() {
            return $l("URL");
        },
        actions: [
            {
                icon: "web",
                label: $l("Open"),
                action: (value: string) => openExternalUrl(value.startsWith("http") ? value : `https://${value}`),
            },
        ],
    },
    [FieldType.Date]: {
        type: FieldType.Date,
        pattern: /^\d{4}-(0[1-9]|1[012])-(0[1-9]|[12][0-9]|3[0-1])$/,
        matchPattern: /^\d{4}-(0[1-9]|1[012])-(0[1-9]|[12][0-9]|3[0-1])$/,
        mask: false,
        multiline: false,
        icon: "date",
        get name() {
            return $l("Date");
        },
        format(value) {
            return new Date(value).toLocaleDateString();
        },
    },
    [FieldType.Month]: {
        type: FieldType.Month,
        pattern: /^\d{4}-(0[1-9]|1[012])$/,
        matchPattern: /^\d{4}-(0[1-9]|1[012])$/,
        mask: false,
        multiline: false,
        icon: "month",
        get name() {
            return $l("Month");
        },
    },
    [FieldType.Credit]: {
        type: FieldType.Credit,
        pattern: /.*/,
        matchPattern: /^\d{16}/,
        mask: true,
        multiline: false,
        icon: "credit",
        get name() {
            return $l("Credit Card Number");
        },
        format(value, masked) {
            const parts = [];

            for (let i = 0; i < value.length; i += 4) {
                const part = value.slice(i, i + 4);
                parts.push(masked && i < value.length - 4 ? part.replace(/./g, "\u2022") : part);
            }

            return parts.join(" ");
        },
    },
    [FieldType.Phone]: {
        type: FieldType.Phone,
        pattern: /.*/,
        matchPattern: /\d+/,
        mask: false,
        multiline: false,
        icon: "phone",
        get name() {
            return $l("Phone Number");
        },
    },
    [FieldType.Pin]: {
        type: FieldType.Pin,
        pattern: /.*/,
        matchPattern: /\d+/,
        mask: true,
        multiline: false,
        icon: "lock",
        get name() {
            return $l("PIN");
        },
        format(value, masked) {
            return masked ? value.replace(/./g, "\u2022") : value;
        },
    },
    [FieldType.Text]: {
        type: FieldType.Text,
        pattern: /.*/,
        matchPattern: /.*/,
        mask: false,
        multiline: true,
        icon: "text",
        get name() {
            return $l("Plain Text");
        },
    },
    [FieldType.Note]: {
        type: FieldType.Note,
        pattern: /.*/,
        matchPattern: /(.*)(\n)?(.*)/,
        mask: false,
        multiline: true,
        icon: "note",
        get name() {
            return $l("Richtext / Markdown");
        },
        format(value: string) {
            return value.split("\n")[0] || "";
        },
    },
    [FieldType.Totp]: {
        type: FieldType.Totp,
        pattern: /^([A-Z2-7=]{8})+$/i,
        matchPattern: /^([A-Z2-7=]{8})+$/i,
        mask: false,
        multiline: false,
        icon: "totp",
        get name() {
            return $l("One-Time Password");
        },
        async transform(value: string) {
            return await totp(base32ToBytes(value));
        },
    },
};

export class Field extends Serializable {
    constructor(vals: Partial<Field> = {}) {
        super();
        Object.assign(this, vals);
        this._normalizeAutofillMetadata();
    }

    /**
     * field type, determining meta data via the corresponding field definition
     * in [[FIELD_DEFS]]
     */
    type: FieldType = FieldType.Text;
    /** field name */
    name: string = "";
    /** field content */
    value: string = "";
    /** semantic autofill role used by extension/broker approval flows */
    autofillRole?: AutofillFieldRole = undefined;
    /** values such as CVV may only be released into a user-approved transaction bundle */
    transactionOnly: boolean = false;
    /** release policy derived from the semantic role */
    releaseClass?: AutofillReleaseClass = undefined;

    get def(): FieldDef {
        return FIELD_DEFS[this.type] || FIELD_DEFS[FieldType.Text];
    }

    get icon() {
        return this.def.icon;
    }

    async transform() {
        return this.def.transform ? await this.def.transform(this.value) : this.value;
    }

    format(masked: boolean) {
        return this.def.format ? this.def.format(this.value, masked) : this.value;
    }

    protected _fromRaw(raw: any) {
        if (!raw.type) {
            raw.type = guessFieldType(raw);
        }
        super._fromRaw(raw);
        this._normalizeAutofillMetadata();
        return this;
    }

    private _normalizeAutofillMetadata() {
        if (typeof this.autofillRole !== "undefined" && !isAutofillFieldRole(this.autofillRole)) {
            this.autofillRole = undefined;
        }
        this.releaseClass = getAutofillReleaseClass(this.autofillRole);
        if (isAutofillTransactionOnlyRole(this.autofillRole)) {
            this.transactionOnly = true;
        }
    }
}

/**
 * Apply creation-path semantics to fields. Deserialization deliberately does
 * not call this helper so old records remain byte-compatible and absent item
 * kinds never gain authority.
 */
export function normalizeAutofillFields(fields: Array<Field | Partial<Field>> = []): Field[] {
    return fields.map((input) => {
        const field = input instanceof Field ? input : new Field(input);
        if (typeof field.autofillRole === "undefined" && typeof input.autofillRole === "undefined") {
            field.autofillRole = inferAutofillFieldRole(field);
        }
        field.releaseClass = getAutofillReleaseClass(field.autofillRole);
        if (isAutofillTransactionOnlyRole(field.autofillRole)) {
            field.transactionOnly = true;
        }
        return field;
    });
}

/** Normalizes a tag value by removing invalid characters */
export function normalizeTag(tag: string): Tag {
    return tag.replace(",", "");
}

export enum AuditType {
    WeakPassword = "weak_password",
    ReusedPassword = "reused_password",
    CompromisedPassword = "compromised_password",
    ExpiredItem = "expired_item",
}

export interface AuditResult {
    type: AuditType;
    fieldIndex: number;
}

export class ItemHistoryEntry extends Serializable {
    constructor(item?: VaultItem) {
        super();
        if (item) {
            this.name = item.name;
            this.tags = item.tags;
            this.fields = item.fields;
            this.updated = item.updated;
            this.updatedBy = item.updatedBy;
        }
    }

    created: Date = new Date();

    updatedBy: AccountID = "";

    updated: Date = new Date();

    name: string = "";

    @AsSerializable(Field)
    fields: Field[] = [];

    tags: Tag[] = [];
}

export const ITEM_HISTORY_ENTRIES_LIMIT = 10;

/** Represents an entry within a vault */
export class VaultItem extends Serializable {
    constructor(vals: Partial<VaultItem> = {}) {
        super();
        Object.assign(this, vals);
        this._normalizeAutofillMetadata();
    }

    /** unique identfier */
    id: VaultItemID = "";

    /** item name */
    name: string = "";

    /** icon to be displayed for this item */
    icon?: string = undefined;

    /** item fields */
    @AsSerializable(Field)
    fields: Field[] = [];

    /** semantic kind used by the autofill broker; absent means no authority */
    autofillKind?: AutofillItemKind = undefined;

    /** source metadata for imported or creation-path records */
    @Serialize({
        toRaw: (value: ImportProvenance) => value,
        fromRaw: (raw: unknown) => parseImportProvenance(raw),
    })
    provenance?: ImportProvenance = undefined;

    /** passkeys, including private key material, stored in the encrypted item payload */
    @AsSerializable(PasskeyCredential)
    passkeys: PasskeyCredential[] = [];

    /** array of tags assigned with this item */
    tags: Tag[] = [];

    /** Date and time of last update */
    @AsDate()
    updated: Date = new Date();

    /** [[Account]] the item was last updated by */
    updatedBy: AccountID = "";

    /**
     * @DEPRECATED
     * Accounts that have favorited this item
     */
    favorited: AccountID[] = [];

    /** attachments associated with this item */
    @AsSerializable(AttachmentInfo)
    attachments: AttachmentInfo[] = [];

    auditResults: AuditResult[] = [];

    @AsDate()
    lastAudited?: Date = undefined;

    /** Number of days after which the item expires */
    expiresAfter?: number = undefined;

    /** Expiration date, calculated based on [[updated]] and [[expiresAfter]] properties */
    get expiresAt() {
        if (!this.expiresAfter) {
            return undefined;
        }

        return add(this.updated, { days: this.expiresAfter });
    }

    /** item history (first is the most recent change) */
    @AsSerializable(ItemHistoryEntry)
    history: ItemHistoryEntry[] = [];

    protected _fromRaw(raw: any) {
        super._fromRaw(raw);
        this._normalizeAutofillMetadata();
        return this;
    }

    private _normalizeAutofillMetadata() {
        if (typeof this.autofillKind !== "undefined" && !isAutofillItemKind(this.autofillKind)) {
            this.autofillKind = undefined;
        }
    }
}

/** Creates a new vault item */
export async function createVaultItem({
    name = "Unnamed",
    fields = [],
    passkeys = [],
    tags = [],
    icon,
    autofillKind,
    provenance,
}: Partial<VaultItem>): Promise<VaultItem> {
    const normalizedFields = normalizeAutofillFields(fields);
    const normalizedKind = isAutofillItemKind(autofillKind)
        ? autofillKind
        : deriveAutofillItemKind(normalizedFields);

    return new VaultItem({
        name,
        fields: normalizedFields,
        passkeys,
        tags,
        icon,
        autofillKind: normalizedKind,
        provenance,
        id: await uuid(),
    });
}

/** Guesses the most appropriate field type based on field name and value */
export function guessFieldType({
    name,
    value = "",
    masked = false,
}: {
    name: string;
    value?: string;
    masked?: boolean;
}): FieldType {
    if (masked) {
        return FieldType.Password;
    }

    const matchedTypeByName = Object.keys(FIELD_DEFS).filter((fieldType) =>
        new RegExp(fieldType, "i").test(name)
    )[0] as FieldType;

    if (matchedTypeByName) {
        return matchedTypeByName;
    }

    // We skip some because they can match anything, and are only really valuable when matched by name
    const fieldTypesToSkipByValue = [FieldType.Username, FieldType.Password];

    const matchedTypeByValue = Object.keys(FIELD_DEFS)
        // @ts-ignore this is a string, deal with it, TypeScript (can't `as` as well)
        .filter((fieldType) => !fieldTypesToSkipByValue.includes(fieldType))
        .filter((fieldType) => FIELD_DEFS[fieldType].matchPattern.test(value))[0] as FieldType;

    if (value !== "" && matchedTypeByValue) {
        return matchedTypeByValue;
    }

    return FieldType.Text;
}

export interface ItemTemplate {
    name?: string;
    autofillKind?: AutofillItemKind;
    provenance?: ImportProvenance;
    fields: {
        name: string;
        value?: string;
        type: FieldType;
        autofillRole?: AutofillFieldRole;
        transactionOnly?: boolean;
        releaseClass?: AutofillReleaseClass;
    }[];
    icon: string;
    iconSrc?: string;
    toString(): string;
    subTitle?: string;
    attachment?: boolean;
}

export const ITEM_TEMPLATES: ItemTemplate[] = [
    {
        toString: () => $l("Website / App"),
        icon: "web",
        autofillKind: AutofillItemKind.Login,
        fields: [
            {
                get name() {
                    return $l("Username");
                },
                type: FieldType.Username,
                autofillRole: AutofillFieldRole.Username,
            },
            {
                get name() {
                    return $l("Password");
                },
                type: FieldType.Password,
                autofillRole: AutofillFieldRole.Password,
            },
            {
                get name() {
                    return $l("URL");
                },
                type: FieldType.Url,
                autofillRole: AutofillFieldRole.LoginUrl,
            },
        ],
    },
    {
        toString: () => $l("Computer"),
        icon: "desktop",
        autofillKind: AutofillItemKind.Login,
        fields: [
            {
                get name() {
                    return $l("Username");
                },
                type: FieldType.Username,
                autofillRole: AutofillFieldRole.Username,
            },
            {
                get name() {
                    return $l("Password");
                },
                type: FieldType.Password,
                autofillRole: AutofillFieldRole.Password,
            },
        ],
    },
    {
        toString: () => $l("Credit Card"),
        icon: "credit",
        autofillKind: AutofillItemKind.PaymentCardPolicy,
        fields: [
            {
                get name() {
                    return $l("Card Number");
                },
                type: FieldType.Credit,
                autofillRole: AutofillFieldRole.PaymentCardPan,
            },
            {
                get name() {
                    return $l("Card Owner");
                },
                type: FieldType.Text,
                autofillRole: AutofillFieldRole.PaymentCardholderName,
            },
            {
                get name() {
                    return $l("Valid Until");
                },
                type: FieldType.Month,
                autofillRole: AutofillFieldRole.PaymentCardExpiry,
            },
            {
                get name() {
                    return $l("CVC");
                },
                type: FieldType.Pin,
                autofillRole: AutofillFieldRole.PaymentCardCvvTransient,
                transactionOnly: true,
            },
            {
                get name() {
                    return $l("PIN");
                },
                type: FieldType.Pin,
            },
        ],
    },
    {
        toString: () => $l("Person Profile"),
        icon: "user",
        autofillKind: AutofillItemKind.PersonProfile,
        fields: [
            {
                get name() {
                    return $l("Full Name");
                },
                type: FieldType.Text,
                autofillRole: AutofillFieldRole.PersonFullName,
            },
            {
                get name() {
                    return $l("First Name");
                },
                type: FieldType.Text,
                autofillRole: AutofillFieldRole.PersonFirstName,
            },
            {
                get name() {
                    return $l("Last Name");
                },
                type: FieldType.Text,
                autofillRole: AutofillFieldRole.PersonLastName,
            },
            {
                get name() {
                    return $l("Email Address");
                },
                type: FieldType.Email,
                autofillRole: AutofillFieldRole.ContactEmail,
            },
            {
                get name() {
                    return $l("Phone Number");
                },
                type: FieldType.Phone,
                autofillRole: AutofillFieldRole.ContactPhone,
            },
        ],
    },
    {
        toString: () => $l("Postal Address"),
        icon: "passport",
        autofillKind: AutofillItemKind.PostalAddress,
        fields: [
            {
                get name() {
                    return $l("Address Line 1");
                },
                type: FieldType.Text,
                autofillRole: AutofillFieldRole.AddressLine1,
            },
            {
                get name() {
                    return $l("Address Line 2");
                },
                type: FieldType.Text,
                autofillRole: AutofillFieldRole.AddressLine2,
            },
            {
                get name() {
                    return $l("City");
                },
                type: FieldType.Text,
                autofillRole: AutofillFieldRole.AddressCity,
            },
            {
                get name() {
                    return $l("State / Region");
                },
                type: FieldType.Text,
                autofillRole: AutofillFieldRole.AddressRegion,
            },
            {
                get name() {
                    return $l("Postal Code");
                },
                type: FieldType.Text,
                autofillRole: AutofillFieldRole.AddressPostalCode,
            },
            {
                get name() {
                    return $l("Country");
                },
                type: FieldType.Text,
                autofillRole: AutofillFieldRole.AddressCountry,
            },
        ],
    },
    {
        toString: () => $l("Gift Recipient"),
        icon: "user",
        autofillKind: AutofillItemKind.GiftRecipient,
        fields: [
            {
                get name() {
                    return $l("Recipient Name");
                },
                type: FieldType.Text,
                autofillRole: AutofillFieldRole.PersonFullName,
            },
            {
                get name() {
                    return $l("Recipient Email");
                },
                type: FieldType.Email,
                autofillRole: AutofillFieldRole.ContactEmail,
            },
        ],
    },
    {
        toString: () => $l("Merchant Profile"),
        icon: "web",
        autofillKind: AutofillItemKind.MerchantProfile,
        fields: [
            {
                get name() {
                    return $l("Merchant Origin");
                },
                type: FieldType.Url,
                autofillRole: AutofillFieldRole.MerchantOrigin,
            },
        ],
    },
    {
        toString: () => $l("Bank Account"),
        icon: "bank",
        autofillKind: AutofillItemKind.FinancialAccount,
        fields: [
            {
                get name() {
                    return $l("Account Owner");
                },
                type: FieldType.Text,
            },
            {
                get name() {
                    return $l("IBAN");
                },
                type: FieldType.Text,
                autofillRole: AutofillFieldRole.FinancialIban,
            },
            {
                get name() {
                    return $l("BIC");
                },
                type: FieldType.Text,
                autofillRole: AutofillFieldRole.FinancialBic,
            },
            {
                get name() {
                    return $l("Card PIN");
                },
                type: FieldType.Pin,
            },
        ],
    },
    {
        toString: () => $l("WIFI Password"),
        icon: "wifi",
        fields: [
            {
                get name() {
                    return $l("Name");
                },
                type: FieldType.Text,
            },
            {
                get name() {
                    return $l("Password");
                },
                type: FieldType.Password,
            },
        ],
    },
    {
        toString: () => $l("Passport"),
        icon: "passport",
        autofillKind: AutofillItemKind.GovernmentIdentity,
        fields: [
            {
                get name() {
                    return $l("Full Name");
                },
                type: FieldType.Text,
                autofillRole: AutofillFieldRole.PersonFullName,
            },
            {
                get name() {
                    return $l("Passport Number");
                },
                type: FieldType.Text,
                autofillRole: AutofillFieldRole.GovernmentPassportNumber,
            },
            {
                get name() {
                    return $l("Country");
                },
                type: FieldType.Text,
                autofillRole: AutofillFieldRole.AddressCountry,
            },
            {
                get name() {
                    return $l("Birthdate");
                },
                type: FieldType.Date,
            },
            {
                get name() {
                    return $l("Birthplace");
                },
                type: FieldType.Text,
            },
            {
                get name() {
                    return $l("Issued On");
                },
                type: FieldType.Date,
            },
            {
                get name() {
                    return $l("Expires");
                },
                type: FieldType.Date,
            },
        ],
    },
    {
        toString: () => $l("Note"),
        icon: "note",
        fields: [
            {
                get name() {
                    return $l("Note");
                },
                type: FieldType.Note,
            },
        ],
    },
    {
        toString: () => $l("Authenticator"),
        icon: "totp",
        autofillKind: AutofillItemKind.Login,
        fields: [
            {
                get name() {
                    return $l("One-Time Password");
                },
                type: FieldType.Totp,
                autofillRole: AutofillFieldRole.Totp,
            },
        ],
    },
    {
        toString: () => $l("Document"),
        icon: "attachment",
        fields: [],
        attachment: true,
    },
    {
        toString: () => $l("Custom"),
        icon: "custom",
        fields: [],
    },
];
