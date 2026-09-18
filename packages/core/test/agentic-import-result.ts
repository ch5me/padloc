import { expect } from "chai";
import { suite, test } from "mocha";
import {
    IMPORT_LOSS_SCHEMA,
    IMPORT_PROVENANCE_SCHEMA,
    IMPORT_RESULT_SCHEMA,
    parseImportLossEntry,
    parseImportProvenance,
    parseImportResult,
} from "../src/import-result";

const provenance = {
    schema: IMPORT_PROVENANCE_SCHEMA,
    source: "synthetic" as const,
    sourceId: "source-fixture",
    importedAt: "2026-09-18T00:00:00.000Z",
    importerVersion: "fixture-v1",
    sourceItemId: "item-fixture",
};

const loss = {
    schema: IMPORT_LOSS_SCHEMA,
    sourceItemId: "item-fixture",
    category: "unsupported-field" as const,
    outcome: "lossy-normalized" as const,
    reasonCode: "UNSUPPORTED_FIELD" as const,
    note: "not migrated",
};

suite("agentic import result contracts", () => {
    test("accepts the frozen closed schemas", () => {
        const result = parseImportResult({
            schema: IMPORT_RESULT_SCHEMA,
            imported: 1,
            normalized: 1,
            skipped: 0,
            lossy: 1,
            provenance,
            losses: [loss],
            sourceIdentifiers: ["source-fixture"],
        });

        expect(result.schema).to.equal(IMPORT_RESULT_SCHEMA);
        expect(result.provenance.source).to.equal("synthetic");
        expect(result.losses).to.have.length(1);
        expect(result.sourceIdentifiers).to.deep.equal(["source-fixture"]);
    });

    test("rejects unknown top-level and nested keys", () => {
        expect(() => parseImportResult({ ...validResult(), extra: true })).to.throw();
        expect(() =>
            parseImportResult({
                ...validResult(),
                provenance: { ...provenance, extra: true },
            })
        ).to.throw();
        expect(() =>
            parseImportResult({
                ...validResult(),
                losses: [{ ...loss, extra: true }],
            })
        ).to.throw();
    });

    test("rejects wrong cardinality and invalid scalar counts", () => {
        expect(() => parseImportResult({ ...validResult(), provenance: [provenance] })).to.throw();
        expect(() => parseImportResult({ ...validResult(), losses: loss })).to.throw();
        expect(() => parseImportResult({ ...validResult(), sourceIdentifiers: "source-fixture" })).to.throw();
        expect(() => parseImportResult({ ...validResult(), imported: 1.5 })).to.throw();
        expect(() => parseImportResult({ ...validResult(), skipped: -1 })).to.throw();
        expect(() => parseImportProvenance({ ...provenance, sourceItemId: 7 })).to.throw();
        expect(() => parseImportLossEntry({ ...loss, note: 7 })).to.throw();
    });
});

function validResult() {
    return {
        schema: IMPORT_RESULT_SCHEMA,
        imported: 1,
        normalized: 1,
        skipped: 0,
        lossy: 1,
        provenance,
        losses: [loss],
        sourceIdentifiers: ["source-fixture"],
    };
}
