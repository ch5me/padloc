import { createHash, createPublicKey, verify as verifySignature } from "crypto";

export interface RegistrationInput {
    clientDataJSON: Uint8Array;
    attestationObject: Uint8Array;
    credentialID: Uint8Array;
    expectedChallenge: Uint8Array;
    expectedOrigin: string;
    expectedRpID: string;
    requireUV?: boolean;
    requireBackupEligible?: boolean;
    requireBackupState?: boolean;
}

export interface AssertionInput {
    clientDataJSON: Uint8Array;
    authenticatorData: Uint8Array;
    signature: Uint8Array;
    credentialID: Uint8Array;
    expectedCredentialID: Uint8Array;
    publicKeyJwk: Record<string, unknown>;
    expectedChallenge: Uint8Array;
    expectedOrigin: string;
    expectedRpID: string;
    requireUV?: boolean;
    requireBackupEligible?: boolean;
    requireBackupState?: boolean;
}

export interface VerifiedRegistration {
    publicKeyJwk: Record<string, unknown>;
    flags: number;
    counter: number;
}

const b64url = (value: Uint8Array) => Buffer.from(value).toString("base64url");

export function verifyRegistration(input: RegistrationInput): VerifiedRegistration {
    verifyClientData(input.clientDataJSON, "webauthn.create", input);
    const decoded = decodeCbor(input.attestationObject);
    if (!(decoded instanceof Map) || decoded.get("fmt") !== "none") throw new Error("unsupported attestation format");
    const statement = decoded.get("attStmt");
    if (!(statement instanceof Map) || statement.size !== 0) throw new Error("fmt=none attStmt must be empty");
    const authData = requireBytes(decoded.get("authData"), "authData");
    const header = verifyAuthenticatorData(authData, input.expectedRpID, input, true);
    let offset = 53;
    const idLength = authData.readUInt16BE(offset);
    offset += 2;
    const credentialID = authData.subarray(offset, offset + idLength);
    if (!credentialID.equals(Buffer.from(input.credentialID))) throw new Error("credential ID mismatch");
    offset += idLength;
    const cose = decodeCbor(authData.subarray(offset));
    if (!(cose instanceof Map) || cose.get(1) !== 2 || cose.get(3) !== -7 || cose.get(-1) !== 1) {
        throw new Error("unsupported COSE key");
    }
    const x = requireBytes(cose.get(-2), "COSE x");
    const y = requireBytes(cose.get(-3), "COSE y");
    if (x.length !== 32 || y.length !== 32) throw new Error("invalid ES256 coordinates");
    return { publicKeyJwk: { kty: "EC", crv: "P-256", x: b64url(x), y: b64url(y) }, ...header };
}

export function verifyAssertion(input: AssertionInput): { flags: number; counter: number } {
    verifyClientData(input.clientDataJSON, "webauthn.get", input);
    if (!Buffer.from(input.credentialID).equals(Buffer.from(input.expectedCredentialID))) {
        throw new Error("credential ID mismatch");
    }
    const header = verifyAuthenticatorData(input.authenticatorData, input.expectedRpID, input, false);
    const clientHash = createHash("sha256").update(input.clientDataJSON).digest();
    const signed = Buffer.concat([Buffer.from(input.authenticatorData), clientHash]);
    const key = createPublicKey({ key: input.publicKeyJwk as any, format: "jwk" });
    if (!verifySignature("sha256", signed, key, Buffer.from(input.signature))) throw new Error("invalid assertion signature");
    return header;
}

function verifyClientData(
    bytes: Uint8Array,
    type: string,
    input: { expectedChallenge: Uint8Array; expectedOrigin: string }
) {
    let client: any;
    try {
        client = JSON.parse(Buffer.from(bytes).toString("utf8"));
    } catch {
        throw new Error("malformed client data");
    }
    if (client.type !== type) throw new Error("client-data type mismatch");
    if (client.challenge !== b64url(input.expectedChallenge)) throw new Error("challenge mismatch");
    if (client.origin !== input.expectedOrigin || client.crossOrigin === true) throw new Error("origin mismatch");
}

function verifyAuthenticatorData(
    data: Uint8Array,
    rpID: string,
    policy: { requireUV?: boolean; requireBackupEligible?: boolean; requireBackupState?: boolean },
    attested: boolean
) {
    const bytes = Buffer.from(data);
    if (bytes.length < (attested ? 55 : 37)) throw new Error("authenticator data truncated");
    if (!attested && bytes.length !== 37) throw new Error("assertion authenticator data must be exactly 37 bytes");
    const expectedHash = createHash("sha256").update(rpID, "utf8").digest();
    if (!bytes.subarray(0, 32).equals(expectedHash)) throw new Error("RP ID hash mismatch");
    const flags = bytes[32];
    if ((flags & 0x22) !== 0) throw new Error("reserved authenticator flags set");
    if (!attested && (flags & 0xc0) !== 0) throw new Error("assertion contains attested or extension data");
    if (attested && (flags & 0x80) !== 0) throw new Error("registration extension data unsupported");
    if ((flags & 0x01) === 0) throw new Error("user presence missing");
    if (policy.requireUV && (flags & 0x04) === 0) throw new Error("user verification missing");
    if (policy.requireBackupEligible && (flags & 0x08) === 0) throw new Error("backup eligibility missing");
    if (policy.requireBackupState && (flags & 0x10) === 0) throw new Error("backup state missing");
    if ((flags & 0x10) !== 0 && (flags & 0x08) === 0) throw new Error("backup state requires eligibility");
    if (attested && (flags & 0x40) === 0) throw new Error("attested data missing");
    const counter = bytes.readUInt32BE(33);
    if (counter !== 0) throw new Error("synchronized credential counter must be zero");
    return { flags, counter };
}

function requireBytes(value: unknown, label: string): Buffer {
    if (!(value instanceof Uint8Array)) throw new Error(`${label} must be bytes`);
    return Buffer.from(value);
}

function decodeCbor(input: Uint8Array): unknown {
    const bytes = Buffer.from(input);
    const read = (offset: number): [unknown, number] => {
        if (offset >= bytes.length) throw new Error("truncated CBOR");
        const initial = bytes[offset++];
        const major = initial >> 5;
        const additional = initial & 31;
        let length: number;
        if (additional < 24) length = additional;
        else if (additional === 24) length = bytes[offset++];
        else if (additional === 25) { length = bytes.readUInt16BE(offset); offset += 2; }
        else if (additional === 26) { length = bytes.readUInt32BE(offset); offset += 4; }
        else throw new Error("unsupported CBOR length");
        if (major === 0) return [length, offset];
        if (major === 1) return [-1 - length, offset];
        if (major === 2 || major === 3) {
            if (offset + length > bytes.length) throw new Error("truncated CBOR value");
            const value = bytes.subarray(offset, offset + length);
            return [major === 2 ? Buffer.from(value) : value.toString("utf8"), offset + length];
        }
        if (major === 5) {
            const map = new Map<unknown, unknown>();
            for (let index = 0; index < length; index++) {
                const [key, afterKey] = read(offset);
                const [value, afterValue] = read(afterKey);
                map.set(key, value);
                offset = afterValue;
            }
            return [map, offset];
        }
        throw new Error("unsupported CBOR type");
    };
    const [value, offset] = read(0);
    if (offset !== bytes.length) throw new Error("trailing CBOR data");
    return value;
}
