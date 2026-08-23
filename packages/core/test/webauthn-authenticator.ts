import { strict as assert } from "assert";
import { bytesToBase64, stringToBytes } from "../src/encoding";
import { PasskeyCounterPolicy, PasskeyCredential, PasskeyEs256KeyMaterial } from "../src/passkey";
import {
    buildPasskeyAssertionResponse,
    buildPasskeyRegistrationResponse,
    derEcdsaSignatureToWebCrypto,
    PADLOC_AGENTIC_VAULT_AAGUID,
} from "../src/webauthn-authenticator";

const challenge = new Uint8Array([0, 1, 2, 253, 254, 255]);
const credentialId = new Uint8Array([0xde, 0xad, 0xbe, 0xef]);
const userHandle = new Uint8Array([7, 8, 9]);
const coordinate = bytesToBase64(new Uint8Array(32).fill(1));

function credential(overrides: Partial<PasskeyCredential> = {}) {
    return new PasskeyCredential({
        rpId: "login.example.test",
        rpName: "Example",
        credentialId,
        userHandle,
        userName: "ada@example.test",
        userDisplayName: "Ada",
        keyMaterial: new PasskeyEs256KeyMaterial({
            publicKeyJwk: { kty: "EC", crv: "P-256", x: coordinate, y: coordinate, key_ops: ["verify"] },
            privateKeyJwk: {
                kty: "EC",
                crv: "P-256",
                x: coordinate,
                y: coordinate,
                d: coordinate,
                key_ops: ["sign"],
            },
        }),
        counterPolicy: PasskeyCounterPolicy.None,
        created: new Date(0),
        ...overrides,
    });
}

const digest = new Uint8Array(32).map((_, index) => index);
const p1363Signature = new Uint8Array(64).map((_, index) => index + 1);
const fakeCrypto = {
    subtle: {
        digest: async () => digest.buffer.slice(0),
        importKey: async () => ({} as CryptoKey),
        sign: async () => p1363Signature.buffer.slice(0),
    },
} as unknown as Crypto;

function request(overrides: Record<string, unknown> = {}) {
    return {
        challenge,
        origin: "https://login.example.test",
        rpId: "login.example.test",
        rpIdSuffixValidator: (rpId: string, host: string) => rpId === host,
        ...overrides,
    };
}

function clientData(bytes: Uint8Array) {
    return JSON.parse(new TextDecoder().decode(bytes));
}

function uint32(bytes: Uint8Array, offset: number) {
    return new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength).getUint32(offset);
}

type Cbor = string | number | Uint8Array | Map<Cbor, Cbor>;

function decodeCbor(bytes: Uint8Array): Cbor {
    let offset = 0;

    function readLength(additional: number): number {
        if (additional < 24) return additional;
        const widths: Record<number, number> = { 24: 1, 25: 2, 26: 4 };
        const width = widths[additional];
        if (!width || offset + width > bytes.length) throw new Error("Malformed CBOR length");
        let value = 0;
        for (let index = 0; index < width; index++) value = value * 256 + bytes[offset++];
        return value;
    }

    function read(): Cbor {
        if (offset >= bytes.length) throw new Error("Truncated CBOR value");
        const head = bytes[offset++];
        const major = head >> 5;
        const length = readLength(head & 31);
        if (major === 0) return length;
        if (major === 1) return -1 - length;
        if (major === 2 || major === 3) {
            if (offset + length > bytes.length) throw new Error("Truncated CBOR payload");
            const value = bytes.slice(offset, (offset += length));
            return major === 2 ? value : new TextDecoder().decode(value);
        }
        if (major === 5) {
            const value = new Map<Cbor, Cbor>();
            for (let index = 0; index < length; index++) value.set(read(), read());
            return value;
        }
        throw new Error("Unsupported CBOR type");
    }

    const value = read();
    if (offset !== bytes.length) throw new Error("Trailing CBOR data");
    return value;
}

suite("WebAuthn authenticator responses", () => {
    test("builds a deterministic, RP-bound registration with IDs and flags", async () => {
        const result = await buildPasskeyRegistrationResponse(
            credential({ backupEligible: true, backupState: true }),
            request({ userVerified: true }),
            fakeCrypto
        );

        assert.equal(result.id, bytesToBase64(credentialId));
        assert.deepEqual(result.rawId, credentialId);
        assert.notEqual(result.rawId, credentialId);
        assert.deepEqual(clientData(result.clientDataJSON), {
            type: "webauthn.create",
            challenge: bytesToBase64(challenge),
            origin: "https://login.example.test",
            crossOrigin: false,
        });
        assert.deepEqual(result.authenticatorData.slice(0, 32), digest);
        assert.equal(result.authenticatorData[32], 0x5d, "UP, UV, BE, BS and AT flags");
        assert.equal(uint32(result.authenticatorData, 33), 0);
        assert.equal(
            [...result.authenticatorData.slice(37, 53)]
                .map((byte) => byte.toString(16).padStart(2, "0"))
                .join("")
                .replace(/(.{8})(.{4})(.{4})(.{4})(.{12})/, "$1-$2-$3-$4-$5"),
            PADLOC_AGENTIC_VAULT_AAGUID
        );
        assert.equal(new DataView(result.authenticatorData.buffer).getUint16(53), credentialId.length);
        assert.deepEqual(result.authenticatorData.slice(55, 59), credentialId);

        const attestation = decodeCbor(result.attestationObject) as Map<Cbor, Cbor>;
        assert.equal(attestation.get("fmt"), "none");
        assert.deepEqual(attestation.get("authData"), result.authenticatorData);
        assert.deepEqual(attestation.get("attStmt"), new Map());
    });

    test("rejects challenge, credential RP, and origin mismatches", async () => {
        await assert.rejects(
            buildPasskeyRegistrationResponse(credential(), request({ challenge: new Uint8Array() }), fakeCrypto),
            /challenge must not be empty/
        );
        await assert.rejects(
            buildPasskeyRegistrationResponse(credential(), request({ rpId: "other.example.test" }), fakeCrypto),
            /Credential RP ID does not match/
        );
        await assert.rejects(
            buildPasskeyRegistrationResponse(
                credential(),
                request({ origin: "https://other.example.test" }),
                fakeCrypto
            ),
            /RP ID is not valid/
        );
        await assert.rejects(
            buildPasskeyRegistrationResponse(
                credential(),
                request({ origin: "https://login.example.test/path" }),
                fakeCrypto
            ),
            /must not include a path/
        );
        await assert.rejects(
            buildPasskeyRegistrationResponse(credential(), request({ rpIdSuffixValidator: () => false }), fakeCrypto),
            /approved public-suffix policy/
        );
    });

    test("sets assertion flags and advances an incrementing counter without mutation", async () => {
        const source = credential({
            backupEligible: true,
            counterPolicy: PasskeyCounterPolicy.Incrementing,
            counter: 41,
        });
        const result = await buildPasskeyAssertionResponse(source, request({ userVerified: true }), fakeCrypto);

        assert.equal(result.id, bytesToBase64(credentialId));
        assert.deepEqual(result.rawId, credentialId);
        assert.deepEqual(result.userHandle, userHandle);
        assert.equal(result.authenticatorData[32], 0x0d, "UP, UV and BE flags");
        assert.equal(uint32(result.authenticatorData, 33), 42);
        assert.equal(result.nextCounter, 42);
        assert.equal(source.counter, 41);
        assert.deepEqual(derEcdsaSignatureToWebCrypto(result.signature), p1363Signature);
        assert.equal(clientData(result.clientDataJSON).type, "webauthn.get");
    });

    test("keeps a zero counter for the none policy and rejects counter exhaustion", async () => {
        const none = await buildPasskeyAssertionResponse(
            credential({ counter: 123, counterPolicy: PasskeyCounterPolicy.None }),
            request(),
            fakeCrypto
        );
        assert.equal(none.nextCounter, 0);
        assert.equal(uint32(none.authenticatorData, 33), 0);

        await assert.rejects(
            buildPasskeyAssertionResponse(
                credential({ counter: 0xffffffff, counterPolicy: PasskeyCounterPolicy.Incrementing }),
                request(),
                fakeCrypto
            ),
            /counter is exhausted/
        );
    });

    test("rejects malformed credential key data and malformed CBOR", async () => {
        const malformed = credential();
        malformed.keyMaterial.publicKeyJwk.x = bytesToBase64(new Uint8Array(31));
        malformed.keyMaterial.privateKeyJwk.x = malformed.keyMaterial.publicKeyJwk.x;
        await assert.rejects(
            buildPasskeyRegistrationResponse(malformed, request(), fakeCrypto),
            /ES256 coordinates must be 32 bytes/
        );

        const valid = await buildPasskeyRegistrationResponse(credential(), request(), fakeCrypto);
        assert.throws(() => decodeCbor(valid.attestationObject.slice(0, -1)), /Truncated CBOR/);
        assert.throws(() => decodeCbor(new Uint8Array([...valid.attestationObject, 0])), /Trailing CBOR data/);
    });

    test("copies caller-owned identifiers and challenges", async () => {
        const suppliedChallenge = stringToBytes("fixed challenge");
        const suppliedId = new Uint8Array([1, 2, 3]);
        const source = credential({ credentialId: suppliedId });
        const result = await buildPasskeyAssertionResponse(
            source,
            request({ challenge: suppliedChallenge }),
            fakeCrypto
        );

        suppliedChallenge.fill(0);
        suppliedId.fill(0);
        assert.equal(clientData(result.clientDataJSON).challenge, bytesToBase64(stringToBytes("fixed challenge")));
        assert.deepEqual(result.rawId, new Uint8Array([1, 2, 3]));
    });
});
