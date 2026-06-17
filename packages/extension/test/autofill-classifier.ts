import { expect } from "chai";
import { createRequire } from "module";
import { suite, test } from "mocha";

const requireModule = createRequire(import.meta.url);
const { AutofillFieldRole, classifyAutofillField } = requireModule("../src/autofill-classifier");

suite("Autofill classifier", () => {
    function field(overrides: {
        type?: string;
        name?: string;
        id?: string;
        autocomplete?: string;
        placeholder?: string;
        labelText?: string;
        dataFieldType?: string;
        dataField?: string;
        maxLength?: number;
        pattern?: string;
        inputmode?: string;
    }) {
        return {
            type: "text",
            ...overrides,
        };
    }

    test("keeps login roles", () => {
        expect(classifyAutofillField(field({ autocomplete: "username" }))).to.equal(AutofillFieldRole.Username);
        expect(classifyAutofillField(field({ type: "password" }))).to.equal(AutofillFieldRole.Password);
        expect(classifyAutofillField(field({ autocomplete: "one-time-code" }))).to.equal(AutofillFieldRole.Totp);
    });

    test("classifies identity roles", () => {
        expect(classifyAutofillField(field({ autocomplete: "given-name" }))).to.equal(
            AutofillFieldRole.PersonFirstName
        );
        expect(classifyAutofillField(field({ autocomplete: "family-name" }))).to.equal(
            AutofillFieldRole.PersonLastName
        );
        expect(classifyAutofillField(field({ autocomplete: "name" }))).to.equal(AutofillFieldRole.PersonFullName);
        expect(classifyAutofillField(field({ autocomplete: "email" }))).to.equal(AutofillFieldRole.ContactEmail);
        expect(classifyAutofillField(field({ autocomplete: "tel" }))).to.equal(AutofillFieldRole.ContactPhone);
    });

    test("classifies address roles from autocomplete", () => {
        expect(classifyAutofillField(field({ autocomplete: "address-line1" }))).to.equal(
            AutofillFieldRole.AddressLine1
        );
        expect(classifyAutofillField(field({ autocomplete: "address-line2" }))).to.equal(
            AutofillFieldRole.AddressLine2
        );
        expect(classifyAutofillField(field({ autocomplete: "address-level2" }))).to.equal(
            AutofillFieldRole.AddressCity
        );
        expect(classifyAutofillField(field({ autocomplete: "address-level1" }))).to.equal(
            AutofillFieldRole.AddressRegion
        );
        expect(classifyAutofillField(field({ autocomplete: "postal-code" }))).to.equal(
            AutofillFieldRole.AddressPostalCode
        );
        expect(classifyAutofillField(field({ autocomplete: "country" }))).to.equal(
            AutofillFieldRole.AddressCountry
        );
    });

    test("classifies payment roles and keeps CVV transaction-only role distinct", () => {
        expect(classifyAutofillField(field({ autocomplete: "cc-name" }))).to.equal(
            AutofillFieldRole.PaymentCardholderName
        );
        expect(classifyAutofillField(field({ autocomplete: "cc-number" }))).to.equal(
            AutofillFieldRole.PaymentCardPan
        );
        expect(classifyAutofillField(field({ autocomplete: "cc-exp" }))).to.equal(
            AutofillFieldRole.PaymentCardExpiry
        );
        expect(classifyAutofillField(field({ autocomplete: "cc-exp-month" }))).to.equal(
            AutofillFieldRole.PaymentCardExpiryMonth
        );
        expect(classifyAutofillField(field({ autocomplete: "cc-exp-year" }))).to.equal(
            AutofillFieldRole.PaymentCardExpiryYear
        );
        expect(classifyAutofillField(field({ autocomplete: "cc-csc" }))).to.equal(
            AutofillFieldRole.PaymentCardCvvTransient
        );
    });

    test("uses label text when autocomplete is absent", () => {
        expect(classifyAutofillField(field({ labelText: "Street Address" }))).to.equal(
            AutofillFieldRole.AddressLine1
        );
        expect(classifyAutofillField(field({ labelText: "Security Code" }))).to.equal(
            AutofillFieldRole.PaymentCardCvvTransient
        );
    });

    test("ignores hidden fields", () => {
        expect(classifyAutofillField(field({ type: "hidden", name: "email" }))).to.equal(null);
    });
});
