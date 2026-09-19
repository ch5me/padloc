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
        assertFixtureScalarAndCardinalityContract(fixture);
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

function assertFixtureScalarAndCardinalityContract(value: Record<string, any>): void {
    assertRecursiveFixtureValues(value);
    expect(value.brokerResponses).to.be.an("array").with.lengthOf(expectedKinds.length);
    expect(value.privacyTransitions).to.be.an("array").with.lengthOf(3);
    expect(value.target).to.deep.include({
        tabId: 7,
        frameId: 0,
        origin: "https://checkout.example.test",
        documentId: "document-synthetic-1",
        formRef: "form-synthetic-1",
        targetRevision: "revision-1",
        sessionId: "session-synthetic-1",
        topOrigin: "https://checkout.example.test",
        frameOrigin: "https://checkout.example.test",
    });

    for (const [index, transition] of value.privacyTransitions.entries()) {
        expect(transition.state, `privacyTransitions[${index}].state`).to.be.oneOf([
            "unknown",
            "clean",
            "potentially-private",
        ]);
        expect(transition.observationRevision, `privacyTransitions[${index}].observationRevision`)
            .to.be.a("number")
            .and.satisfy((entry: number) => Number.isInteger(entry) && entry >= 0);
        expect(transition.genericObservation, `privacyTransitions[${index}].genericObservation`).to.be
            .oneOf(["allowed", "blocked", "requires-separate-disclosure"]);
    }

    for (const [index, response] of value.brokerResponses.entries()) {
        expect(response.schema, `brokerResponses[${index}].schema`).to.equal(
            "elf.padloc-broker-response.v2",
        );
        expect(response.protocolVersion, `brokerResponses[${index}].protocolVersion`).to.equal(2);
        expect(response.requestId, `brokerResponses[${index}].requestId`).to.be.a("string").and.not
            .empty;
        expect(response.ok, `brokerResponses[${index}].ok`).to.be.a("boolean");
        expect(response.kind, `brokerResponses[${index}].kind`).to.equal(expectedKinds[index]);
        assertResponseScalarContract(response, `brokerResponses[${index}]`);
    }

    expect(value.handshake).to.be.an("object");
    assertHandshakeScalarContract(value.handshake);
    assertImportScalarContract(value.provenance, "provenance");
    assertImportScalarContract(value.importResult.provenance, "importResult.provenance");
    expect(value.importResult.losses).to.be.an("array").with.lengthOf(1);
    expect(value.importResult.sourceIdentifiers).to.be.an("array").with.lengthOf(1);
    assertEnvelopeScalarContract(value.envelope, "envelope");
}

function assertRecursiveFixtureValues(value: unknown, path = "fixture"): void {
    if (Array.isArray(value)) {
        expect(value, `${path} must be an array`).to.be.an("array");
        for (const [index, entry] of value.entries()) {
            assertRecursiveFixtureValues(entry, `${path}[${index}]`);
        }
        return;
    }
    if (value && typeof value === "object") {
        for (const [key, entry] of Object.entries(value)) {
            expect(key, `${path} key`).to.be.a("string").and.not.empty;
            assertRecursiveFixtureValues(entry, `${path}.${key}`);
        }
        return;
    }
    if (typeof value === "string") {
        expect(value, `${path} must be non-empty`).to.be.a("string").and.not.empty;
        return;
    }
    if (typeof value === "number") {
        expect(value, `${path} must be finite`).to.be.finite;
        expect(value, `${path} must be an integer`).to.satisfy(Number.isInteger);
    }
}

function assertResponseScalarContract(response: Record<string, any>, path: string): void {
    if (response.target) assertTargetScalarContract(response.target, `${path}.target`);
    if (response.fields) {
        expect(response.fields, `${path}.fields`).to.be.an("array").with.length.greaterThan(0);
        for (const [index, field] of response.fields.entries()) {
            expect(field, `${path}.fields[${index}]`).to.be.an("object");
            for (const key of ["fieldRef", "role", "selector"].filter((entry) => entry in field)) {
                expect(field[key], `${path}.fields[${index}].${key}`).to.be.a("string").and.not.empty;
            }
            if ("sourceRef" in field) {
                expect(field.sourceRef, `${path}.fields[${index}].sourceRef`).to.be.a("string").and.not
                    .empty;
                expect(field.transactionOnly, `${path}.fields[${index}].transactionOnly`).to.be.a(
                    "boolean",
                );
                expect(field.releaseClass, `${path}.fields[${index}].releaseClass`).to.be.oneOf([
                    "low",
                    "secret",
                    "high-risk",
                ]);
            }
        }
    }
    if (response.receipt) {
        expect(response.receipt.filledFieldRefs, `${path}.receipt.filledFieldRefs`).to.be.an("array");
        expect(response.receipt.modelDisclosure, `${path}.receipt.modelDisclosure`).to.be.oneOf([
            "none",
            "approved",
        ]);
        expect(response.receipt.submittedByExecutor, `${path}.receipt.submittedByExecutor`).to.be.a(
            "boolean",
        );
    }
    if (response.error) {
        expect(response.error.schema, `${path}.error.schema`).to.equal("elf.padloc-broker-error.v1");
        expect(response.error.retryable, `${path}.error.retryable`).to.be.a("boolean");
        expect(response.error.code, `${path}.error.code`).to.be.a("string").and.not.empty;
    }
    if (response.observationRevision !== undefined) {
        expect(response.observationRevision, `${path}.observationRevision`)
            .to.be.a("number")
            .and.satisfy((entry: number) => Number.isInteger(entry) && entry >= 0);
    }
}

function assertTargetScalarContract(target: Record<string, any>, path: string): void {
    for (const key of [
        "origin",
        "documentId",
        "formRef",
        "targetRevision",
        "sessionId",
        "topOrigin",
        "frameOrigin",
    ]) {
        expect(target[key], `${path}.${key}`).to.be.a("string").and.not.empty;
    }
    expect(target.tabId, `${path}.tabId`).to.be.a("number").and.satisfy(Number.isInteger);
    expect(target.frameId, `${path}.frameId`).to.be.a("number").and.satisfy(Number.isInteger);
}

function assertImportScalarContract(value: Record<string, any>, path: string): void {
    expect(value.schema, `${path}.schema`).to.be.a("string").and.not.empty;
    expect(value.source, `${path}.source`).to.be.a("string").and.not.empty;
    expect(value.sourceId, `${path}.sourceId`).to.be.a("string").and.not.empty;
    expect(value.importedAt, `${path}.importedAt`).to.be.a("string").and.not.empty;
    expect(value.importerVersion, `${path}.importerVersion`).to.be.a("string").and.not.empty;
}

function assertEnvelopeScalarContract(value: Record<string, any>, path: string): void {
    expect(value.schema, `${path}.schema`).to.equal(
        "elf.encrypted-autofill-profile-envelope.v1",
    );
    expect(value.formatVersion, `${path}.formatVersion`).to.equal(1);
    expect(value.ciphertext, `${path}.ciphertext`).to.be.a("string").and.not.empty;
    expect(value.wrappedKey, `${path}.wrappedKey`).to.be.a("string").and.not.empty;
    expect(value.wrapAlgorithm, `${path}.wrapAlgorithm`).to.equal("padloc-import-key-v1");
    expect(value.recordCountHint, `${path}.recordCountHint`)
        .to.be.a("number")
        .and.satisfy((entry: number) => Number.isInteger(entry) && entry >= 0);
    expect(value.createdAt, `${path}.createdAt`).to.be.a("string").and.not.empty;
}

function assertHandshakeScalarContract(handshake: Record<string, any>): void {
    expect(handshake.beginRequest.operation).to.equal("import-begin");
    expect(handshake.commitRequest.operation).to.equal("import-commit");
    for (const key of ["beginRequest", "beginSuccess", "beginError", "commitRequest", "commitSuccess", "commitError"]) {
        expect(handshake[key], `handshake.${key}`).to.be.an("object");
        expect(handshake[key].requestId, `handshake.${key}.requestId`).to.be.a("string").and.not.empty;
        if ("ok" in handshake[key]) {
            expect(handshake[key].ok, `handshake.${key}.ok`).to.be.a("boolean");
        }
    }
    expect(handshake.commitRequest.envelope, "handshake.commitRequest.envelope").to.be.an("object");
    assertEnvelopeScalarContract(handshake.commitRequest.envelope, "handshake.commitRequest.envelope");
}

function assertExactTarget(actual: Record<string, unknown>, expected: Record<string, unknown>): void {
    for (const key of Object.keys(expected)) {
        if (actual[key] !== expected[key]) throw new Error(`target mismatch: ${key}`);
    }
}
