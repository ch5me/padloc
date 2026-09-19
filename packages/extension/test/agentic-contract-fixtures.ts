import { readFileSync } from "fs";
import { join } from "path";
import { suite, test } from "mocha";
import { expect } from "chai";

const protocol = require("../src/autofill-broker-protocol");
const migration = require("../src/autofill-compatibility-migration");
const importContracts = require("../../core/src/import-result");

const fixturePath = join(__dirname, "fixtures/agentic-autofill/contract.v1.json");
const fixture = JSON.parse(readFileSync(fixturePath, "utf8")) as Record<string, any>;

const expectedKinds = [
    "status",
    "classified",
    "plan",
    "approval-required",
    "granted",
    "applied",
    "revoked",
    "privacy-status",
    "import-result",
    "error",
];

suite("Agentic autofill contract fixtures", () => {
    test("parses every canonical v2 variant and handshake round-trip", () => {
        const responses = fixture.brokerResponses as unknown[];
        expect(responses.map((response: any) => response.kind)).to.deep.equal(expectedKinds);
        for (const response of responses) {
            expect(() => protocol.assertAutofillBrokerResponseV2(response)).not.to.throw();
        }

        expect(() => migration.parseImportBeginRequest(fixture.handshake.beginRequest)).not.to.throw();
        expect(() => migration.parseImportBeginResult(fixture.handshake.beginSuccess)).not.to.throw();
        expect(() => migration.parseImportCommitRequest(fixture.handshake.commitRequest)).not.to.throw();
        expect(() => migration.parseImportCommitResult(fixture.handshake.commitSuccess)).not.to.throw();
        expect(() => protocol.assertAutofillBrokerResponseV2(fixture.handshake.beginError)).not.to.throw();
        expect(() => protocol.assertAutofillBrokerResponseV2(fixture.handshake.commitError)).not.to.throw();
    });

    test("keeps exact target identity and privacy state transitions", () => {
        const privacy = fixture.brokerResponses.find((response: any) => response.kind === "privacy-status");
        expect(privacy.target).to.deep.equal(fixture.target);
        expect(fixture.privacyTransitions.map((entry: any) => entry.state)).to.deep.equal([
            "unknown",
            "clean",
            "potentially-private",
        ]);
        expect(fixture.privacyTransitions.map((entry: any) => entry.observationRevision)).to.deep.equal([0, 1, 2]);
        expect(privacy.state).to.equal(fixture.privacyTransitions[1].state);
        expect(privacy.observationRevision).to.equal(fixture.privacyTransitions[1].observationRevision);
        expect(privacy.genericObservation).to.equal(fixture.privacyTransitions[1].genericObservation);

        const substituted = { ...privacy, target: { ...privacy.target, documentId: "other-document" } };
        expect(substituted.target).not.to.deep.equal(fixture.target);
        expect(() => protocol.assertAutofillBrokerResponseV2(substituted)).not.to.throw();
        expect(() => assertExactTarget(substituted.target, fixture.target)).to.throw();
    });

    test("parses import provenance, result, and encrypted envelope", () => {
        expect(() => migration.parseEncryptedAutofillProfileEnvelope(fixture.envelope)).not.to.throw();
        const result = importContracts.parseImportResult(fixture.importResult);
        expect(result.provenance).to.deep.equal(fixture.provenance);
        expect(result.losses).to.have.length(1);
        expect(result.sourceIdentifiers).to.deep.equal(["fixture-source-item-1"]);
    });

    test("rejects arbitrary nested keys and malformed protocol-v1 payloads", () => {
        const classified = fixture.brokerResponses.find((response: any) => response.kind === "classified");
        const nestedUnknown = {
            ...classified,
            target: { ...classified.target, unexpected: "reject" },
        };
        expect(() => protocol.assertAutofillBrokerResponseV2(nestedUnknown)).to.throw();

        const nestedFieldUnknown = {
            ...classified,
            fields: [{ ...classified.fields[0], unexpected: "reject" }],
        };
        expect(() => protocol.assertAutofillBrokerResponseV2(nestedFieldUnknown)).to.throw();

        const nestedResultUnknown = {
            ...fixture.brokerResponses.find((response: any) => response.kind === "import-result"),
            result: {
                ...fixture.importResult,
                provenance: { ...fixture.importResult.provenance, unexpected: "reject" },
            },
        };
        expect(() => protocol.assertAutofillBrokerResponseV2(nestedResultUnknown)).to.throw();
        const nestedEnvelopeUnknown = {
            ...fixture.handshake.commitRequest,
            envelope: {
                ...fixture.handshake.commitRequest.envelope,
                sourceProvenance: {
                    ...fixture.handshake.commitRequest.envelope.sourceProvenance,
                    unexpected: "reject",
                },
            },
        };
        expect(() => migration.parseImportCommitRequest(nestedEnvelopeUnknown)).to.throw();
        expect(() => protocol.parseAutofillBrokerResponse(fixture.malformedProtocolV1)).to.throw();
    });

    test("keeps protocol-v1 compatibility reads explicitly non-authorizing", () => {
        const legacy = protocol.parseAutofillBrokerResponse(fixture.legacyProtocolV1);
        expect(protocol.isProtocolV1NonAuthorizing(legacy)).to.equal(true);
        expect((legacy as any).authorizing).to.equal(false);
    });

    test("keeps broker outputs metadata-only", () => {
        for (const response of fixture.brokerResponses) {
            const serialized = JSON.stringify(response);
            expect(serialized).not.to.match(/sentinel|password|plaintext|rawKey|privateKey|ciphertext|wrappedKey/i);
            expect(protocol.hasSensitivePayloadValue(response)).to.equal(false);
        }

        const classified = fixture.brokerResponses.find((response: any) => response.kind === "classified");
        expect(
            protocol.hasSensitivePayloadValue({
                ...classified,
                fields: [{ ...classified.fields[0], value: "forbidden" }],
            }),
        ).to.equal(true);
    });
});

function assertExactTarget(actual: Record<string, unknown>, expected: Record<string, unknown>): void {
    for (const key of Object.keys(expected)) {
        if (actual[key] !== expected[key]) throw new Error(`target mismatch: ${key}`);
    }
}
