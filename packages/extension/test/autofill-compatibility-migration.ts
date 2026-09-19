import { expect } from "chai";
import { suite, test } from "mocha";
import {
    ENCRYPTED_AUTOFILL_PROFILE_ENVELOPE_SCHEMA,
    IMPORT_BEGIN_SCHEMA,
    IMPORT_COMMIT_SCHEMA,
    IMPORT_WRAP_ALGORITHM,
    beginCompatibilityImport,
    buildImportCommitResult,
    commitCompatibilityImport,
    parseEncryptedAutofillProfileEnvelope,
} from "../src/autofill-compatibility-migration";

suite("Autofill compatibility migration", () => {
    test("accepts ciphertext-only envelopes and rejects plaintext or grants", () => {
        const envelope = validEnvelope();
        expect(parseEncryptedAutofillProfileEnvelope(envelope)).to.deep.equal(envelope);
        expect(() => parseEncryptedAutofillProfileEnvelope({ ...envelope, value: "sentinel" })).to.throw();
        expect(() => parseEncryptedAutofillProfileEnvelope({ ...envelope, grantId: "grant" })).to.throw();
        expect(() => parseEncryptedAutofillProfileEnvelope({ ...envelope, rawKey: "raw" })).to.throw();
    });

    test("runs import-begin then import-commit and returns ImportResult only", async () => {
        const result = validImportResult();
        const custody = {
            async begin() {
                return {
                    importPublicKey: "synthetic-public-key",
                    importKeyId: "import-key-1",
                    expiresAt: "2026-09-18T13:00:00.000Z",
                };
            },
            async commit() {
                return result;
            },
        };
        const begun = await beginCompatibilityImport(
            {
                schema: IMPORT_BEGIN_SCHEMA,
                operation: "import-begin",
                requestId: "begin-1",
                consentNonce: "nonce-1",
            },
            custody
        );
        const committed = await commitCompatibilityImport(
            {
                schema: IMPORT_COMMIT_SCHEMA,
                operation: "import-commit",
                requestId: "commit-1",
                envelope: validEnvelope(),
            },
            custody,
            { importKeyId: begun.importKeyId, consentNonce: "nonce-1" }
        );

        expect(committed).to.deep.equal(result);
        expect(JSON.stringify(committed)).not.to.contain("grant");
        expect(buildImportCommitResult("commit-1", committed).result).to.deep.equal(result);
    });

    test("requires the one-time custody nonce", async () => {
        const custody = {
            async begin() {
                return {
                    importPublicKey: "synthetic-public-key",
                    importKeyId: "import-key-1",
                    expiresAt: "2026-09-18T13:00:00.000Z",
                };
            },
            async commit() {
                return validImportResult();
            },
        };
        let rejected = false;
        try {
            await commitCompatibilityImport(
                {
                    schema: IMPORT_COMMIT_SCHEMA,
                    operation: "import-commit",
                    requestId: "commit-1",
                    envelope: validEnvelope(),
                },
                custody,
                { importKeyId: "import-key-1", consentNonce: "wrong" }
            );
        } catch {
            rejected = true;
        }
        expect(rejected).to.equal(true);
    });
});

function validEnvelope() {
    return {
        schema: ENCRYPTED_AUTOFILL_PROFILE_ENVELOPE_SCHEMA,
        envelopeId: "envelope-1",
        formatVersion: 1,
        ciphertext: "Y2lwaGVydGV4dA==",
        wrappedKey: "d3JhcHBlZC1rZXk=",
        wrapAlgorithm: IMPORT_WRAP_ALGORITHM,
        sourceProvenance: {
            schema: "elf.import-provenance.v1",
            source: "synthetic",
            sourceId: "synthetic-source",
            importedAt: "2026-09-18T12:00:00.000Z",
            importerVersion: "test",
        },
        consentNonce: "nonce-1",
        recordCountHint: 1,
        createdAt: "2026-09-18T12:00:00.000Z",
    } as const;
}

function validImportResult() {
    return {
        schema: "elf.import-result.v1" as const,
        imported: 1,
        normalized: 0,
        skipped: 0,
        lossy: 0,
        provenance: {
            schema: "elf.import-provenance.v1" as const,
            source: "compatibility-envelope" as const,
            sourceId: "synthetic-source",
            importedAt: "2026-09-18T12:00:00.000Z",
            importerVersion: "test",
        },
        losses: [],
        sourceIdentifiers: ["synthetic-item"],
    };
}
