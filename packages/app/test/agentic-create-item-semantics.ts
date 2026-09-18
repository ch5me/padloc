import { expect } from "chai";
import { suite, test } from "mocha";
import {
    AutofillFieldRole,
    AutofillItemKind,
    Field,
    FieldType,
    ITEM_TEMPLATES,
    deriveAutofillItemKind,
    normalizeAutofillFields,
} from "@padloc/core/src/item";

suite("agentic create-item semantics", () => {
    test("propagates template kind and roles through the creation boundary", () => {
        const template = ITEM_TEMPLATES[0];
        const fields = normalizeAutofillFields(template.fields.map((field) => new Field({ ...field, value: "" })));

        expect(template.autofillKind).to.equal(AutofillItemKind.Login);
        expect(deriveAutofillItemKind(fields)).to.equal(AutofillItemKind.Login);
        expect(fields.map((field) => field.autofillRole)).to.deep.equal([
            AutofillFieldRole.Username,
            AutofillFieldRole.Password,
            AutofillFieldRole.LoginUrl,
        ]);
        expect(fields.map((field) => field.releaseClass)).to.deep.equal(["secret", "secret", "low"]);
    });

    test("derives government and financial kinds conservatively when templates omit kind", () => {
        const governmentFields = normalizeAutofillFields([
            new Field({ name: "SSN", type: FieldType.Text, value: "" }),
        ]);
        const financialFields = normalizeAutofillFields([
            new Field({ name: "Routing Number", type: FieldType.Text, value: "" }),
        ]);

        expect(deriveAutofillItemKind(governmentFields)).to.equal(AutofillItemKind.GovernmentIdentity);
        expect(deriveAutofillItemKind(financialFields)).to.equal(AutofillItemKind.FinancialAccount);
        expect(governmentFields[0].releaseClass).to.equal("high-risk");
        expect(financialFields[0].releaseClass).to.equal("high-risk");
    });
});
