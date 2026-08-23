import { expect } from "chai";
import { suite, test } from "mocha";

const { AutofillFieldRole, classifyAutofillField } = require("../src/autofill-classifier");

interface FixtureField {
    type: string;
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
    hidden?: boolean;
    disabled?: boolean;
    readOnly?: boolean;
}

interface FixtureRoot {
    fields: FixtureField[];
    shadowRoots?: FixtureRoot[];
}

suite("Autofill classifier adversarial fixtures", () => {
    const field = (overrides: Partial<FixtureField> = {}): FixtureField => ({
        type: "text",
        ...overrides,
    });

    function collectEligible(root: FixtureRoot): Array<[FixtureField, string]> {
        const results: Array<[FixtureField, string]> = [];

        for (const candidate of root.fields) {
            const autocomplete = (candidate.autocomplete || "").toLowerCase();
            if (
                candidate.hidden ||
                candidate.disabled ||
                candidate.readOnly ||
                autocomplete === "off" ||
                autocomplete === "false"
            ) {
                continue;
            }

            const role = classifyAutofillField(candidate);
            if (role !== null) results.push([candidate, role]);
        }

        for (const shadowRoot of root.shadowRoots || []) {
            results.push(...collectEligible(shadowRoot));
        }

        return results;
    }

    test("rejects hidden, disabled, and read-only credential-shaped fields", () => {
        const root: FixtureRoot = {
            fields: [
                field({ type: "hidden", name: "username" }),
                field({ type: "password", hidden: true }),
                field({ type: "password", disabled: true }),
                field({ name: "username", readOnly: true }),
                field({ name: "username" }),
            ],
        };

        expect(collectEligible(root).map(([, role]) => role)).to.deep.equal([AutofillFieldRole.Username]);
        expect(classifyAutofillField(root.fields[0])).to.equal(null);
    });

    test("honors autocomplete off before interpreting hostile credential hints", () => {
        const root: FixtureRoot = {
            fields: [
                field({ type: "search", name: "username", autocomplete: "off" }),
                field({ type: "password", autocomplete: "off" }),
                field({ name: "otp", autocomplete: "false" }),
                field({ autocomplete: "username" }),
            ],
        };

        expect(collectEligible(root).map(([, role]) => role)).to.deep.equal([AutofillFieldRole.Username]);
    });

    test("keeps a password triple password-only without inventing username or OTP roles", () => {
        const triple = [
            field({ type: "password", autocomplete: "current-password", labelText: "Current password" }),
            field({ type: "password", autocomplete: "new-password", labelText: "New password" }),
            field({ type: "password", name: "confirm_password", labelText: "Confirm password" }),
        ];

        expect(triple.map(classifyAutofillField)).to.deep.equal([
            AutofillFieldRole.Password,
            AutofillFieldRole.Password,
            AutofillFieldRole.Password,
        ]);
    });

    test("distinguishes payment secrets from login credentials", () => {
        const paymentFields = [
            field({ inputmode: "numeric", autocomplete: "cc-number" }),
            field({ autocomplete: "cc-exp" }),
            field({ autocomplete: "cc-csc", maxLength: 3 }),
        ];

        expect(paymentFields.map(classifyAutofillField)).to.deep.equal([
            AutofillFieldRole.PaymentCardPan,
            AutofillFieldRole.PaymentCardExpiry,
            AutofillFieldRole.PaymentCardCvvTransient,
        ]);
        expect(classifyAutofillField(field({ type: "search", labelText: "Search card transactions" }))).to.equal(null);
    });

    test("classifies fields inside nested shadow roots exactly once", () => {
        const shadowPassword = field({ type: "password", id: "shadow-password" });
        const root: FixtureRoot = {
            fields: [field({ name: "username" })],
            shadowRoots: [
                {
                    fields: [],
                    shadowRoots: [{ fields: [shadowPassword] }],
                },
            ],
        };

        const collected = collectEligible(root);
        expect(collected.map(([, role]) => role)).to.deep.equal([
            AutofillFieldRole.Username,
            AutofillFieldRole.Password,
        ]);
        expect(collected.filter(([candidate]) => candidate === shadowPassword)).to.have.length(1);
    });

    test("uses language-neutral autocomplete tokens with multilingual labels", () => {
        const multilingual = [
            field({ labelText: "Correo electrónico", autocomplete: "email" }),
            field({ labelText: "Téléphone", autocomplete: "tel" }),
            field({ labelText: "Código postal", autocomplete: "postal-code" }),
            field({ labelText: "カード番号", autocomplete: "cc-number" }),
        ];

        expect(multilingual.map(classifyAutofillField)).to.deep.equal([
            AutofillFieldRole.ContactEmail,
            AutofillFieldRole.ContactPhone,
            AutofillFieldRole.AddressPostalCode,
            AutofillFieldRole.PaymentCardPan,
        ]);
        expect(classifyAutofillField(field({ type: "search", labelText: "Buscar contraseñas" }))).to.equal(null);
    });

    test("a fresh scan discovers dynamically inserted fields without retaining stale results", () => {
        const root: FixtureRoot = { fields: [field({ name: "username" })] };
        const firstScan = collectEligible(root);

        root.fields.push(field({ type: "password", autocomplete: "current-password" }));
        const secondScan = collectEligible(root);

        expect(firstScan.map(([, role]) => role)).to.deep.equal([AutofillFieldRole.Username]);
        expect(secondScan.map(([, role]) => role)).to.deep.equal([
            AutofillFieldRole.Username,
            AutofillFieldRole.Password,
        ]);
    });
});
