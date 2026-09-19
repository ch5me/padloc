// Keep values aligned with AutofillFieldRole in packages/core/src/item.ts.
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

export interface AutofillFieldCandidate {
    type: string;
    name?: string;
    id?: string;
    autocomplete?: string | null;
    placeholder?: string;
    labelText?: string;
    dataFieldType?: string;
    dataField?: string;
    maxLength?: number;
    pattern?: string | null;
    inputmode?: string | null;
}

export function isFillableInputType(type: string): boolean {
    return ["text", "number", "email", "password", "tel", "date", "month", "search", "url"].includes(
        type.toLowerCase()
    );
}

export function classifyAutofillField(candidate: AutofillFieldCandidate): AutofillFieldRole | null {
    const type = candidate.type.toLowerCase();
    if (!isFillableInputType(type)) return null;

    const name = (candidate.name || "").toLowerCase();
    const id = (candidate.id || "").toLowerCase();
    const autocomplete = (candidate.autocomplete || "").toLowerCase();
    const placeholder = (candidate.placeholder || "").toLowerCase();
    const labelText = (candidate.labelText || "").toLowerCase();
    const dataAttr = `${candidate.dataFieldType || ""} ${candidate.dataField || ""}`.toLowerCase();
    const maxLength = candidate.maxLength ?? 0;
    const pattern = candidate.pattern || "";
    const inputmode = (candidate.inputmode || "").toLowerCase();
    const haystack = `${name} ${id} ${autocomplete} ${placeholder} ${labelText} ${dataAttr}`;

    if (autocomplete === "off" || autocomplete === "false") return null;

    if (
        autocomplete === "ssn" ||
        autocomplete === "government-id" ||
        /\b(ssn|social security(?: number)?|social-security-number)\b/.test(haystack)
    ) {
        return AutofillFieldRole.GovernmentSsn;
    }
    if (
        autocomplete === "passport-number" ||
        /\b(passport(?: number| no)?|passport-number)\b/.test(haystack)
    ) {
        return AutofillFieldRole.GovernmentPassportNumber;
    }
    if (
        autocomplete === "drivers-license-number" ||
        /\b(driver'?s license(?: number| no)?|driving license(?: number| no)?|license number)\b/.test(haystack)
    ) {
        return AutofillFieldRole.GovernmentDriversLicenseNumber;
    }
    if (
        autocomplete === "national-id" ||
        /\b(national id(?: number)?|national-id|identity number)\b/.test(haystack)
    ) {
        return AutofillFieldRole.GovernmentNationalId;
    }
    if (autocomplete === "iban" || /\b(iban)\b/.test(haystack)) {
        return AutofillFieldRole.FinancialIban;
    }
    if (autocomplete === "bic" || /\b(bic|swift code)\b/.test(haystack)) {
        return AutofillFieldRole.FinancialBic;
    }
    if (autocomplete === "routing-number" || /\b(routing number|routing-number|aba number)\b/.test(haystack)) {
        return AutofillFieldRole.FinancialRoutingNumber;
    }
    if (
        autocomplete === "account-number" ||
        /\b(bank account(?: number)?|account number|account-number)\b/.test(haystack)
    ) {
        return AutofillFieldRole.FinancialAccountNumber;
    }

    if (autocomplete === "cc-csc" || /\b(cvv|cvc|security code|card code|cid)\b/.test(haystack)) {
        return AutofillFieldRole.PaymentCardCvvTransient;
    }
    if (autocomplete === "cc-number" || /\b(card number|cardnumber|cc-number|credit card number)\b/.test(haystack)) {
        return AutofillFieldRole.PaymentCardPan;
    }
    if (autocomplete === "cc-name" || /\b(cardholder|card holder|name on card|card owner)\b/.test(haystack)) {
        return AutofillFieldRole.PaymentCardholderName;
    }
    if (autocomplete === "cc-exp") return AutofillFieldRole.PaymentCardExpiry;
    if (autocomplete === "cc-exp-month") return AutofillFieldRole.PaymentCardExpiryMonth;
    if (autocomplete === "cc-exp-year") return AutofillFieldRole.PaymentCardExpiryYear;

    if (autocomplete === "username") return AutofillFieldRole.Username;
    if (autocomplete === "current-password" || autocomplete === "new-password") {
        return AutofillFieldRole.Password;
    }
    if (autocomplete === "one-time-code") return AutofillFieldRole.Totp;

    const usernameSignal = /\b(user|login|account|username|identifier|screen[\s_-]?name|team)\b/.test(haystack);
    const emailSignal = /\b(email|email address)\b/.test(haystack);
    if (usernameSignal && emailSignal && !autocomplete) return null;

    if (autocomplete === "given-name" || /\b(first name|firstname|given name)\b/.test(haystack)) {
        return AutofillFieldRole.PersonFirstName;
    }
    if (autocomplete === "family-name" || /\b(last name|lastname|surname|family name)\b/.test(haystack)) {
        return AutofillFieldRole.PersonLastName;
    }
    if (autocomplete === "name" || /\b(full name|recipient name|contact name)\b/.test(haystack)) {
        return AutofillFieldRole.PersonFullName;
    }
    if (autocomplete === "email" || type === "email" || /\b(email|email address)\b/.test(haystack)) {
        return AutofillFieldRole.ContactEmail;
    }
    if (autocomplete === "tel" || type === "tel" || /\b(phone|telephone|mobile)\b/.test(haystack)) {
        return AutofillFieldRole.ContactPhone;
    }
    if (autocomplete === "address-line1" || /\b(address line 1|address1|street address|street)\b/.test(haystack)) {
        return AutofillFieldRole.AddressLine1;
    }
    if (autocomplete === "address-line2" || /\b(address line 2|address2|apt|apartment|suite)\b/.test(haystack)) {
        return AutofillFieldRole.AddressLine2;
    }
    if (autocomplete === "address-level2" || /\b(city|town)\b/.test(haystack)) {
        return AutofillFieldRole.AddressCity;
    }
    if (autocomplete === "address-level1" || /\b(state|province|region)\b/.test(haystack)) {
        return AutofillFieldRole.AddressRegion;
    }
    if (autocomplete === "postal-code" || /\b(zip|postal|postcode)\b/.test(haystack)) {
        return AutofillFieldRole.AddressPostalCode;
    }
    if (autocomplete === "country" || autocomplete === "country-name" || /\bcountry\b/.test(haystack)) {
        return AutofillFieldRole.AddressCountry;
    }

    if (
        autocomplete === "url" ||
        type === "url" ||
        /\b(login url|website url|site url|account url)\b/.test(haystack)
    ) {
        if (/\b(merchant|shop|store|origin)\b/.test(haystack)) return AutofillFieldRole.MerchantOrigin;
        return AutofillFieldRole.LoginUrl;
    }

    if (type === "password") {
        return AutofillFieldRole.Password;
    }

    const isTotpSignal = /\b(totp|otp|one-time|verification|code)\b/.test(haystack);
    const normalizedPattern = pattern.replace(/^\^|\$$/g, "");
    const isDigitPattern = /^(?:\\d|\[0-9\])(?:\+|\{\d+(?:,\d*)?\})$/.test(normalizedPattern);
    const isOtpLength = maxLength >= 4 && maxLength <= 8;
    const isNumericInputmode = inputmode === "numeric";

    if (isTotpSignal || (isDigitPattern && isOtpLength) || (isNumericInputmode && isOtpLength)) {
        return AutofillFieldRole.Totp;
    }

    if (usernameSignal) {
        return AutofillFieldRole.Username;
    }

    return null;
}
