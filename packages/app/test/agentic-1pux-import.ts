import { expect } from "chai";
import { suite, test } from "mocha";
import { AutofillFieldRole, AutofillItemKind, FieldType } from "@padloc/core/src/item";
import { IMPORT_RESULT_SCHEMA, parseImportResult } from "@padloc/core/src/import-result";
import { import1PuxExport } from "../src/lib/import";
import { OnePuxExport } from "../src/lib/1pux-parser";

const IMPORTED_AT = "2026-09-18T00:00:00.000Z";

function field(title: string, value: string, valueType: "string" | "email" | "phone" | "url" | "totp" = "string") {
    return {
        title,
        id: title.toLowerCase().replace(/[^a-z0-9]+/g, "-"),
        value: { [valueType]: value },
        indexAtSource: 0,
        guarded: false,
        multiline: false,
        dontGenerate: false,
        inputTraits: { keyboard: "default", correction: "default", capitalization: "none" },
    };
}

function item(
    uuid: string,
    categoryUuid: string,
    title: string,
    loginFields: Array<Record<string, unknown>> = [],
    sections: Array<Record<string, unknown>> = [],
    overrides: Record<string, unknown> = {}
) {
    const { details: overrideDetails, overview: overrideOverview, ...rest } = overrides;
    return {
        uuid,
        favIndex: 0,
        createdAt: 0,
        updatedAt: 0,
        categoryUuid,
        trashed: false,
        details: {
            loginFields,
            sections: sections.length ? [{ title: "Synthetic Section", name: "synthetic", fields: sections }] : [],
            passwordHistory: [],
            ...((overrideDetails as Record<string, unknown> | undefined) || {}),
        },
        overview: {
            subtitle: "",
            title,
            url: "",
            ...((overrideOverview as Record<string, unknown> | undefined) || {}),
        },
        ...rest,
    };
}

function exportFixture(items: Array<Record<string, unknown>>): OnePuxExport {
    return {
        attributes: {
            version: 1,
            description: "synthetic fixture",
            createdAt: 1789689600000,
        },
        data: {
            accounts: [
                {
                    attrs: {
                        accountName: "Synthetic Account",
                        name: "Synthetic Account",
                        avatar: "",
                        email: "fixture@example.invalid",
                        uuid: "account-fixture",
                        domain: "example.invalid",
                    },
                    vaults: [
                        {
                            attrs: {
                                uuid: "vault-fixture",
                                desc: "",
                                avatar: "",
                                name: "Synthetic Vault",
                                type: "P",
                            },
                            items: items.map((value) => ({ item: value })),
                        },
                    ],
                },
            ],
        },
    } as unknown as OnePuxExport;
}

suite("agentic 1PUX import", () => {
    test("normalizes frozen login, profile, address, payment, government, and financial roles", async () => {
        const result = await import1PuxExport(
            exportFixture([
                item(
                    "login-fixture",
                    "login",
                    "Synthetic Login",
                    [
                        {
                            value: "fixture-user",
                            id: "username",
                            name: "Username",
                            fieldType: "A",
                            designation: "username",
                        },
                        {
                            value: "fixture-pass",
                            id: "password",
                            name: "Password",
                            fieldType: "P",
                            designation: "password",
                        },
                    ],
                    [field("One-Time Password", "JBSWY3DPEHPK3PXP", "totp")]
                ),
                item(
                    "profile-fixture",
                    "identity",
                    "Synthetic Profile",
                    [],
                    [field("Full Name", "Fixture Person"), field("Email", "fixture@example.invalid", "email")]
                ),
                item(
                    "address-fixture",
                    "address",
                    "Synthetic Address",
                    [],
                    [
                        field("Address Line 1", "1 Fixture Way"),
                        field("City", "Fixtureville"),
                        field("Postal Code", "00000"),
                    ]
                ),
                item(
                    "payment-fixture",
                    "credit card",
                    "Synthetic Card",
                    [],
                    [
                        field("Card Number", "synthetic-pan"),
                        field("Cardholder Name", "Fixture Person"),
                        field("Expiry Month", "12"),
                        field("Expiry Year", "2099"),
                        field("CVV", "synthetic-cvv"),
                    ]
                ),
                item("government-fixture", "government", "Synthetic Government", [], [field("SSN", "synthetic-ssn")]),
                item(
                    "financial-fixture",
                    "financial",
                    "Synthetic Financial",
                    [],
                    [field("Account Number", "synthetic-account"), field("Routing Number", "synthetic-routing")]
                ),
            ]),
            { sourceId: "synthetic-1pux", importedAt: IMPORTED_AT }
        );

        expect(result.result).to.deep.include({
            schema: IMPORT_RESULT_SCHEMA,
            imported: 6,
            normalized: 6,
            skipped: 0,
            lossy: 0,
        });
        expect(result.result.provenance).to.deep.equal({
            schema: "elf.import-provenance.v1",
            source: "1pux",
            sourceId: "synthetic-1pux",
            importedAt: IMPORTED_AT,
            importerVersion: "padloc-1pux-import-v1",
        });
        expect(result.result.sourceIdentifiers).to.deep.equal([
            "login-fixture",
            "profile-fixture",
            "address-fixture",
            "payment-fixture",
            "government-fixture",
            "financial-fixture",
        ]);

        expect(result.items.map((value) => value.autofillKind)).to.deep.equal([
            AutofillItemKind.Login,
            AutofillItemKind.PersonProfile,
            AutofillItemKind.PostalAddress,
            AutofillItemKind.PaymentCardPolicy,
            AutofillItemKind.GovernmentIdentity,
            AutofillItemKind.FinancialAccount,
        ]);
        expect(result.items[0].fields.map((value) => value.autofillRole)).to.deep.equal([
            AutofillFieldRole.Username,
            AutofillFieldRole.Password,
            AutofillFieldRole.Totp,
        ]);
        expect(result.items[2].fields.map((value) => value.autofillRole)).to.deep.equal([
            AutofillFieldRole.AddressLine1,
            AutofillFieldRole.AddressCity,
            AutofillFieldRole.AddressPostalCode,
        ]);
        expect(result.items[3].fields.map((value) => value.autofillRole)).to.deep.equal([
            AutofillFieldRole.PaymentCardPan,
            AutofillFieldRole.PaymentCardholderName,
            AutofillFieldRole.PaymentCardExpiryMonth,
            AutofillFieldRole.PaymentCardExpiryYear,
            AutofillFieldRole.PaymentCardCvvTransient,
        ]);
        expect(result.items[3].fields[4].transactionOnly).to.equal(true);
        expect(result.items.every((value) => value.provenance?.source === "1pux")).to.equal(true);
    });

    test("reports unsupported data deterministically without putting values in ImportResult", async () => {
        const lossFixture = item(
            "loss-fixture",
            "login",
            "Synthetic Loss Fixture",
            [
                { value: "fixture-user", id: "username", name: "Username", fieldType: "A", designation: "username" },
                { value: "fixture-pass", id: "password", name: "Password", fieldType: "P", designation: "password" },
                {
                    value: "otpauth://totp/fixture?secret=JBSWY3DPEHPK3PXP&algorithm=SHA256&digits=8&period=60",
                    id: "totp",
                    name: "TOTP",
                    fieldType: "T",
                },
            ],
            [field("Unsupported", "fixture-unsupported")],
            {
                trashed: true,
                file: {
                    attrs: { uuid: "attachment-fixture", name: "fixture.txt", type: "document" },
                    path: "fixture.txt",
                },
                details: {
                    passwordHistory: [{ value: "old-fixture-pass", time: 1 }],
                    documentAttributes: {
                        fileName: "fixture.txt",
                        documentId: "document-fixture",
                        decryptedSize: 1,
                    },
                    passkeys: [{ id: "passkey-fixture" }],
                    sharing: { memberCount: 2 },
                },
            }
        );
        const imported = await import1PuxExport(exportFixture([lossFixture]), {
            sourceId: "synthetic-loss",
            importedAt: IMPORTED_AT,
        });

        expect(imported.result).to.deep.equal({
            schema: IMPORT_RESULT_SCHEMA,
            imported: 1,
            normalized: 1,
            skipped: 0,
            lossy: 1,
            provenance: {
                schema: "elf.import-provenance.v1",
                source: "1pux",
                sourceId: "synthetic-loss",
                importedAt: IMPORTED_AT,
                importerVersion: "padloc-1pux-import-v1",
            },
            losses: [
                {
                    schema: "elf.import-loss.v1",
                    sourceItemId: "loss-fixture",
                    category: "passkey",
                    outcome: "skipped",
                    reasonCode: "UNSUPPORTED_PASSKEY",
                },
                {
                    schema: "elf.import-loss.v1",
                    sourceItemId: "loss-fixture",
                    category: "attachment",
                    outcome: "lossy-normalized",
                    reasonCode: "UNSUPPORTED_ATTACHMENT",
                },
                {
                    schema: "elf.import-loss.v1",
                    sourceItemId: "loss-fixture",
                    category: "document",
                    outcome: "lossy-normalized",
                    reasonCode: "UNSUPPORTED_DOCUMENT",
                },
                {
                    schema: "elf.import-loss.v1",
                    sourceItemId: "loss-fixture",
                    category: "history",
                    outcome: "lossy-normalized",
                    reasonCode: "UNSUPPORTED_HISTORY",
                },
                {
                    schema: "elf.import-loss.v1",
                    sourceItemId: "loss-fixture",
                    category: "sharing",
                    outcome: "lossy-normalized",
                    reasonCode: "UNSUPPORTED_SHARING",
                },
                {
                    schema: "elf.import-loss.v1",
                    sourceItemId: "loss-fixture",
                    category: "totp-parameters",
                    outcome: "skipped",
                    reasonCode: "NONEXACT_TOTP_PARAMETERS",
                },
                {
                    schema: "elf.import-loss.v1",
                    sourceItemId: "loss-fixture",
                    category: "unsupported-field",
                    outcome: "skipped",
                    reasonCode: "UNSUPPORTED_FIELD",
                },
                {
                    schema: "elf.import-loss.v1",
                    sourceItemId: "loss-fixture",
                    category: "trashed",
                    outcome: "lossy-normalized",
                    reasonCode: "TRASHED_ITEM",
                },
            ],
            sourceIdentifiers: ["loss-fixture"],
        });
        expect(JSON.stringify(imported.result)).to.not.contain("fixture-user");
        expect(JSON.stringify(imported.result)).to.not.contain("fixture-pass");
        expect(JSON.stringify(imported.result)).to.not.contain("fields");
        expect(imported.items[0].provenance?.sourceItemId).to.equal("loss-fixture");
        expect(imported.items[0].autofillKind).to.equal(undefined);
        expect(imported.items[0].tags).to.include("trashed");
        expect(imported.items[0].fields.some((value) => value.autofillRole === AutofillFieldRole.Totp)).to.equal(false);
    });

    test("skips document-only and unknown-kind records with explicit losses", async () => {
        const imported = await import1PuxExport(
            exportFixture([
                item("document-only-fixture", "secure note", "Synthetic Document", [], [], {
                    file: {
                        attrs: { uuid: "document-file", name: "fixture.txt", type: "document" },
                        path: "fixture.txt",
                    },
                    details: {
                        documentAttributes: {
                            fileName: "fixture.txt",
                            documentId: "document-fixture",
                            decryptedSize: 1,
                        },
                    },
                }),
                item(
                    "unknown-fixture",
                    "future-category",
                    "Synthetic Unknown",
                    [],
                    [field("Mystery", "fixture-value")]
                ),
            ]),
            { sourceId: "synthetic-skipped", importedAt: IMPORTED_AT }
        );

        expect(imported.items).to.have.length(0);
        expect(imported.result.skipped).to.equal(2);
        expect(imported.result.losses.map((value) => [value.sourceItemId, value.reasonCode])).to.deep.equal([
            ["document-only-fixture", "UNSUPPORTED_ATTACHMENT"],
            ["document-only-fixture", "UNSUPPORTED_DOCUMENT"],
            ["document-only-fixture", "UNKNOWN_KIND"],
            ["unknown-fixture", "UNKNOWN_KIND"],
        ]);
        expect(() => parseImportResult({ ...imported.result, extra: true })).to.throw();
        expect(parseImportResult(imported.result).schema).to.equal(IMPORT_RESULT_SCHEMA);
    });

    test("marks only exact default TOTP parameters as migrated", async () => {
        const imported = await import1PuxExport(
            exportFixture([
                item(
                    "totp-fixture",
                    "login",
                    "Synthetic TOTP",
                    [],
                    [
                        field(
                            "TOTP",
                            "otpauth://totp/fixture?secret=JBSWY3DPEHPK3PXP&algorithm=SHA1&digits=6&period=30",
                            "totp"
                        ),
                    ]
                ),
            ]),
            { sourceId: "synthetic-totp", importedAt: IMPORTED_AT }
        );

        expect(imported.result.losses).to.deep.equal([]);
        expect(imported.items[0].fields.map((value) => value.type)).to.deep.equal([FieldType.Totp]);
        expect(imported.items[0].fields[0].autofillRole).to.equal(AutofillFieldRole.Totp);
    });
});
