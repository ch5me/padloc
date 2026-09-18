import { expect } from "chai";
import { suite, test } from "mocha";
import {
    AutofillFieldRole,
    AutofillItemKind,
    Field,
    FieldType,
    ITEM_TEMPLATES,
    VaultItem,
    createVaultItem,
    getAutofillReleaseClass,
    normalizeAutofillFields,
} from "../src/item";

const syntheticProvenance = {
    schema: "elf.import-provenance.v1" as const,
    source: "synthetic" as const,
    sourceId: "fixture-source",
    importedAt: "2026-09-18T00:00:00.000Z",
    importerVersion: "fixture-v1",
    sourceItemId: "fixture-item",
};

suite("agentic autofill item semantics", () => {
    test("keeps old records compatible when item kind is absent", () => {
        const restored = new VaultItem().fromRaw({
            kind: "vaultitem",
            id: "legacy-item",
            name: "Legacy",
            fields: [{ type: FieldType.Text, name: "Unclassified", value: "" }],
        });

        expect(restored.autofillKind).to.equal(undefined);
        expect(restored.fields[0].autofillRole).to.equal(undefined);
        expect(restored.fields[0].releaseClass).to.equal(undefined);
        expect(JSON.parse(restored.toJSON())).to.not.have.property("autofillKind");
    });

    test("round-trips semantic kind, role, transaction marker, provenance, and release class", async () => {
        const item = await createVaultItem({
            id: "synthetic-item",
            name: "Synthetic",
            autofillKind: AutofillItemKind.FinancialAccount,
            provenance: syntheticProvenance,
            fields: [
                new Field({
                    type: FieldType.Text,
                    name: "Account Number",
                    value: "",
                    autofillRole: AutofillFieldRole.FinancialAccountNumber,
                }),
                new Field({
                    type: FieldType.Pin,
                    name: "CVV",
                    value: "",
                    autofillRole: AutofillFieldRole.PaymentCardCvvTransient,
                }),
            ],
        });

        const restored = new VaultItem().fromRaw(item.toRaw());
        expect(restored.autofillKind).to.equal(AutofillItemKind.FinancialAccount);
        expect(restored.provenance?.source).to.equal("synthetic");
        expect(restored.fields.map((field) => field.releaseClass)).to.deep.equal(["high-risk", "high-risk"]);
        expect(restored.fields[1].transactionOnly).to.equal(true);
    });

    test("derives release class exactly and fails closed for unknown roles", () => {
        expect(getAutofillReleaseClass(AutofillFieldRole.ContactEmail)).to.equal("low");
        expect(getAutofillReleaseClass(AutofillFieldRole.LoginUrl)).to.equal("low");
        expect(getAutofillReleaseClass(AutofillFieldRole.Password)).to.equal("secret");
        expect(getAutofillReleaseClass(AutofillFieldRole.PaymentCardExpiry)).to.equal("secret");
        expect(getAutofillReleaseClass(AutofillFieldRole.GovernmentSsn)).to.equal("high-risk");
        expect(getAutofillReleaseClass("future.role")).to.equal(undefined);

        const unknown = new Field({
            name: "Unknown role",
            type: FieldType.Text,
            value: "",
            autofillRole: "future.role" as AutofillFieldRole,
        });
        expect(unknown.autofillRole).to.equal(undefined);
        expect(unknown.releaseClass).to.equal(undefined);
    });

    test("normalizes omitted template metadata without exposing values", () => {
        const fields = normalizeAutofillFields([
            new Field({ name: "Username", type: FieldType.Username, value: "" }),
            new Field({ name: "Password", type: FieldType.Password, value: "" }),
            new Field({ name: "Website", type: FieldType.Url, value: "" }),
            new Field({ name: "CVV", type: FieldType.Pin, value: "" }),
        ]);

        expect(fields.map((field) => field.autofillRole)).to.deep.equal([
            AutofillFieldRole.Username,
            AutofillFieldRole.Password,
            AutofillFieldRole.LoginUrl,
            AutofillFieldRole.PaymentCardCvvTransient,
        ]);
        expect(fields.map((field) => field.releaseClass)).to.deep.equal([
            "secret",
            "secret",
            "low",
            "high-risk",
        ]);
        expect(fields[3].transactionOnly).to.equal(true);
    });

    test("marks Website/App and Computer templates as login records", () => {
        const website = ITEM_TEMPLATES[0];
        const computer = ITEM_TEMPLATES[1];

        expect(website.autofillKind).to.equal(AutofillItemKind.Login);
        expect(website.fields.map((field) => field.autofillRole)).to.deep.equal([
            AutofillFieldRole.Username,
            AutofillFieldRole.Password,
            AutofillFieldRole.LoginUrl,
        ]);

        expect(computer.autofillKind).to.equal(AutofillItemKind.Login);
        expect(computer.fields.map((field) => field.autofillRole)).to.deep.equal([
            AutofillFieldRole.Username,
            AutofillFieldRole.Password,
        ]);
        expect(computer.fields.some((field) => field.autofillRole === AutofillFieldRole.LoginUrl)).to.equal(false);
    });
});
