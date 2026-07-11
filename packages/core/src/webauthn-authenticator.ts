import { base64ToBytes, bytesToBase64, stringToBytes } from "./encoding";
import {
    PasskeyCounterPolicy,
    PasskeyCredential,
    PasskeyEs256KeyMaterial,
    PasskeyEs256PrivateJwk,
    PasskeyEs256PublicJwk,
} from "./passkey";

const ES256_ALGORITHM = { name: "ECDSA", namedCurve: "P-256", hash: "SHA-256" };
const CREDENTIAL_ID_LENGTH = 32;
const AAGUID = new Uint8Array(16);

export interface PasskeyCredentialOptions {
    rpId: string;
    rpName: string;
    userHandle: Uint8Array;
    userName: string;
    userDisplayName: string;
    credentialId?: Uint8Array;
    discoverable?: boolean;
    backupEligible?: boolean;
    backupState?: boolean;
    counterPolicy?: PasskeyCounterPolicy;
}

export interface PasskeyCeremonyRequest {
    challenge: Uint8Array;
    origin: string;
    rpId: string;
    /** Trusted result from the provider's local approval step, not the RP's requested policy. */
    userVerified?: boolean;
    /** Required for parent-domain RP IDs; the provider must back this with a Public Suffix List policy. */
    rpIdSuffixValidator?: (rpId: string, originHost: string) => boolean;
}

export interface PasskeyRegistrationResponseComponents {
    id: string;
    rawId: Uint8Array;
    clientDataJSON: Uint8Array;
    attestationObject: Uint8Array;
    authenticatorData: Uint8Array;
    publicKeyCose: Uint8Array;
}

export interface PasskeyAssertionResponseComponents {
    id: string;
    rawId: Uint8Array;
    clientDataJSON: Uint8Array;
    authenticatorData: Uint8Array;
    signature: Uint8Array;
    userHandle: Uint8Array;
    nextCounter: number;
}

/** Generate an exportable ES256 credential for encrypted vault persistence. */
export async function generatePasskeyCredential(
    options: PasskeyCredentialOptions,
    cryptoProvider: Crypto = getCrypto()
): Promise<PasskeyCredential> {
    const rpId = normalizeRpId(options.rpId);
    requireBytes(options.userHandle, "userHandle");

    if (!options.userName) {
        throw new Error("Passkey userName is required");
    }
    if (options.backupState && !options.backupEligible) {
        throw new Error("A backed-up passkey must be backup eligible");
    }

    const generated = (await cryptoProvider.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, [
        "sign",
        "verify",
    ])) as { publicKey: CryptoKey; privateKey: CryptoKey };
    const publicKeyJwk = normalizePublicJwk(
        (await cryptoProvider.subtle.exportKey("jwk", generated.publicKey)) as PasskeyEs256PublicJwk
    );
    const privateKeyJwk = normalizePrivateJwk(
        (await cryptoProvider.subtle.exportKey("jwk", generated.privateKey)) as PasskeyEs256PrivateJwk
    );
    const credentialId = options.credentialId
        ? copyBytes(options.credentialId)
        : cryptoProvider.getRandomValues(new Uint8Array(CREDENTIAL_ID_LENGTH));
    requireBytes(credentialId, "credentialId");

    return new PasskeyCredential({
        rpId,
        rpName: options.rpName,
        credentialId,
        userHandle: copyBytes(options.userHandle),
        userName: options.userName,
        userDisplayName: options.userDisplayName,
        keyMaterial: new PasskeyEs256KeyMaterial({ publicKeyJwk, privateKeyJwk }),
        discoverable: options.discoverable !== false,
        backupEligible: options.backupEligible === true,
        backupState: options.backupState === true,
        counterPolicy: options.counterPolicy || PasskeyCounterPolicy.None,
        counter: 0,
    });
}

/** Build a WebAuthn `fmt=none` registration response without mutating the credential. */
export async function buildPasskeyRegistrationResponse(
    credential: PasskeyCredential,
    request: PasskeyCeremonyRequest,
    cryptoProvider: Crypto = getCrypto()
): Promise<PasskeyRegistrationResponseComponents> {
    validateCeremony(credential, request);
    const clientDataJSON = createClientData("webauthn.create", request);
    const rpIdHash = await sha256(stringToBytes(credential.rpId), cryptoProvider);
    const publicKeyCose = encodeEs256CosePublicKey(credential.keyMaterial.publicKeyJwk);
    const authenticatorData = concatBytes(
        rpIdHash,
        new Uint8Array([authenticatorFlags(credential, request.userVerified === true, true)]),
        uint32Bytes(credential.counterPolicy === PasskeyCounterPolicy.Incrementing ? credential.counter : 0),
        AAGUID,
        uint16Bytes(credential.credentialId.length),
        credential.credentialId,
        publicKeyCose
    );
    const attestationObject = encodeCborMap([
        ["fmt", "none"],
        ["authData", authenticatorData],
        ["attStmt", cborMap([])],
    ]);

    return {
        id: bytesToBase64(credential.credentialId),
        rawId: copyBytes(credential.credentialId),
        clientDataJSON,
        attestationObject,
        authenticatorData,
        publicKeyCose,
    };
}

/** Build a signed WebAuthn assertion and return the counter the caller must persist. */
export async function buildPasskeyAssertionResponse(
    credential: PasskeyCredential,
    request: PasskeyCeremonyRequest,
    cryptoProvider: Crypto = getCrypto()
): Promise<PasskeyAssertionResponseComponents> {
    validateCeremony(credential, request);
    const clientDataJSON = createClientData("webauthn.get", request);
    const rpIdHash = await sha256(stringToBytes(credential.rpId), cryptoProvider);
    const nextCounter = getNextCounter(credential);
    const authenticatorData = concatBytes(
        rpIdHash,
        new Uint8Array([authenticatorFlags(credential, request.userVerified === true, false)]),
        uint32Bytes(nextCounter)
    );
    const clientDataHash = await sha256(clientDataJSON, cryptoProvider);
    const signedData = concatBytes(authenticatorData, clientDataHash);
    const privateKey = await cryptoProvider.subtle.importKey(
        "jwk",
        credential.keyMaterial.privateKeyJwk,
        { name: "ECDSA", namedCurve: "P-256" },
        false,
        ["sign"]
    );
    const webCryptoSignature = new Uint8Array(
        await cryptoProvider.subtle.sign(ES256_ALGORITHM, privateKey, signedData)
    );
    const signature = webCryptoEcdsaSignatureToDer(webCryptoSignature);

    return {
        id: bytesToBase64(credential.credentialId),
        rawId: copyBytes(credential.credentialId),
        clientDataJSON,
        authenticatorData,
        signature,
        userHandle: copyBytes(credential.userHandle),
        nextCounter,
    };
}

/** Validate basic RP ID/origin suffix binding. Public-suffix rejection belongs in the provider policy gate. */
export function validateRpIdForOrigin(
    rpIdInput: string,
    originInput: string,
    suffixValidator?: (rpId: string, originHost: string) => boolean
): void {
    const rpId = normalizeRpId(rpIdInput);
    const origin = parseSecureOrigin(originInput);
    const host = origin.hostname.toLowerCase().replace(/\.$/, "");
    const ipAddress = isIpAddress(host);
    const loopback = host === "localhost" || host === "127.0.0.1" || host === "[::1]";

    if (host !== rpId && (ipAddress || !host.endsWith(`.${rpId}`))) {
        throw new Error("RP ID is not valid for the supplied origin");
    }
    if (!loopback && !ipAddress && (!suffixValidator || !suffixValidator(rpId, host))) {
        throw new Error("RP ID requires an approved public-suffix policy");
    }
}

/** Encode a P-256 public JWK as the EC2/ES256 COSE_Key used by WebAuthn. */
export function encodeEs256CosePublicKey(jwk: PasskeyEs256PublicJwk): Uint8Array {
    const normalized = normalizePublicJwk(jwk);
    const x = base64ToBytes(normalized.x);
    const y = base64ToBytes(normalized.y);
    if (x.length !== 32 || y.length !== 32) {
        throw new Error("ES256 coordinates must be 32 bytes");
    }
    return encodeCborMap([
        [1, 2],
        [3, -7],
        [-1, 1],
        [-2, x],
        [-3, y],
    ]);
}

/** Convert a WebCrypto P-1363 ECDSA signature (`r || s`) to WebAuthn DER. */
export function webCryptoEcdsaSignatureToDer(signature: Uint8Array): Uint8Array {
    if (signature.length === 64) {
        const r = derInteger(signature.slice(0, 32));
        const s = derInteger(signature.slice(32));
        const body = concatBytes(new Uint8Array([0x02, r.length]), r, new Uint8Array([0x02, s.length]), s);
        return concatBytes(new Uint8Array([0x30, body.length]), body);
    }
    if (signature.length > 0 && signature[0] === 0x30) {
        derEcdsaSignatureToWebCrypto(signature);
        return copyBytes(signature);
    }
    throw new Error("ES256 signature must be a 64-byte P-1363 or valid DER value");
}

/** Convert a WebAuthn DER ECDSA signature to WebCrypto's 64-byte P-1363 form. */
export function derEcdsaSignatureToWebCrypto(signature: Uint8Array): Uint8Array {
    if (signature.length < 8 || signature[0] !== 0x30 || signature[1] !== signature.length - 2) {
        throw new Error("Invalid ES256 DER signature sequence");
    }
    let offset = 2;
    const r = readDerInteger(signature, offset);
    offset = r.nextOffset;
    const s = readDerInteger(signature, offset);
    if (s.nextOffset !== signature.length) {
        throw new Error("Unexpected data after ES256 DER signature");
    }
    return concatBytes(leftPad32(r.value), leftPad32(s.value));
}

function validateCeremony(credential: PasskeyCredential, request: PasskeyCeremonyRequest) {
    if (!credential.validate()) {
        throw new Error("Invalid passkey credential");
    }
    requireBytes(request.challenge, "challenge");
    const rpId = normalizeRpId(request.rpId);
    if (rpId !== credential.rpId) {
        throw new Error("Credential RP ID does not match the ceremony RP ID");
    }
    validateRpIdForOrigin(rpId, request.origin, request.rpIdSuffixValidator);
}

function createClientData(type: "webauthn.create" | "webauthn.get", request: PasskeyCeremonyRequest) {
    parseSecureOrigin(request.origin);
    return stringToBytes(
        JSON.stringify({
            type,
            challenge: bytesToBase64(request.challenge),
            origin: request.origin,
            crossOrigin: false,
        })
    );
}

function parseSecureOrigin(originInput: string): URL {
    let origin: URL;
    try {
        origin = new URL(originInput);
    } catch (_error) {
        throw new Error("Invalid WebAuthn origin");
    }
    if (origin.origin !== originInput || origin.username || origin.password) {
        throw new Error("WebAuthn origin must not include a path, query, credentials, or fragment");
    }
    const host = origin.hostname.toLowerCase();
    const local = host === "localhost" || host === "127.0.0.1" || host === "[::1]";
    if (origin.protocol !== "https:" && !(origin.protocol === "http:" && local)) {
        throw new Error("WebAuthn origin must use HTTPS (except loopback development origins)");
    }
    return origin;
}

function normalizeRpId(rpId: string): string {
    const normalized = rpId.toLowerCase().replace(/\.$/, "");
    if (!normalized || normalized.includes(":") || normalized.includes("/") || /\s/.test(normalized)) {
        throw new Error("Invalid RP ID");
    }
    return normalized;
}

function isIpAddress(host: string) {
    return /^\d{1,3}(?:\.\d{1,3}){3}$/.test(host) || host.startsWith("[");
}

function authenticatorFlags(credential: PasskeyCredential, userVerified: boolean, attested: boolean) {
    let flags = 0x01;
    if (userVerified) flags |= 0x04;
    if (credential.backupEligible) flags |= 0x08;
    if (credential.backupState) flags |= 0x10;
    if (attested) flags |= 0x40;
    return flags;
}

function getNextCounter(credential: PasskeyCredential) {
    if (credential.counterPolicy === PasskeyCounterPolicy.None) {
        return 0;
    }
    if (credential.counter >= 0xffffffff) {
        throw new Error("Passkey signature counter is exhausted");
    }
    return credential.counter + 1;
}

function normalizePublicJwk(jwk: PasskeyEs256PublicJwk): PasskeyEs256PublicJwk {
    if (jwk.kty !== "EC" || jwk.crv !== "P-256" || !jwk.x || !jwk.y) {
        throw new Error("Expected an ES256 public JWK");
    }
    return { kty: "EC", crv: "P-256", x: jwk.x, y: jwk.y, alg: "ES256", ext: true, key_ops: ["verify"] };
}

function normalizePrivateJwk(jwk: PasskeyEs256PrivateJwk): PasskeyEs256PrivateJwk {
    if (!jwk.d) {
        throw new Error("Expected an ES256 private JWK");
    }
    return { ...normalizePublicJwk(jwk), d: jwk.d, key_ops: ["sign"] };
}

function encodeCborMap(entries: ReadonlyArray<readonly [string | number, CborValue]>): Uint8Array {
    return encodeCbor(cborMap(entries));
}

interface CborMap {
    entries: ReadonlyArray<readonly [string | number, CborValue]>;
}

type CborValue = string | number | Uint8Array | CborMap;

function cborMap(entries: ReadonlyArray<readonly [string | number, CborValue]>): CborMap {
    return { entries };
}

function encodeCbor(value: CborValue): Uint8Array {
    if (typeof value === "number") {
        if (!Number.isInteger(value)) throw new Error("CBOR only supports integer values here");
        return value >= 0 ? cborHead(0, value) : cborHead(1, -1 - value);
    }
    if (typeof value === "string") {
        const bytes = stringToBytes(value);
        return concatBytes(cborHead(3, bytes.length), bytes);
    }
    if (value instanceof Uint8Array) {
        return concatBytes(cborHead(2, value.length), value);
    }
    const encodedEntries = value.entries.map(([key, child]) => concatBytes(encodeCbor(key), encodeCbor(child)));
    return concatBytes(cborHead(5, value.entries.length), ...encodedEntries);
}

function cborHead(majorType: number, value: number): Uint8Array {
    if (value < 24) return new Uint8Array([(majorType << 5) | value]);
    if (value <= 0xff) return new Uint8Array([(majorType << 5) | 24, value]);
    if (value <= 0xffff) return concatBytes(new Uint8Array([(majorType << 5) | 25]), uint16Bytes(value));
    if (value <= 0xffffffff) return concatBytes(new Uint8Array([(majorType << 5) | 26]), uint32Bytes(value));
    throw new Error("CBOR integer exceeds uint32 range");
}

function derInteger(bytes: Uint8Array) {
    let start = 0;
    while (start < bytes.length - 1 && bytes[start] === 0) start++;
    const value = bytes.slice(start);
    return value[0] & 0x80 ? concatBytes(new Uint8Array([0]), value) : value;
}

function readDerInteger(signature: Uint8Array, offset: number) {
    if (signature[offset] !== 0x02) throw new Error("Invalid ES256 DER integer");
    const length = signature[offset + 1];
    const start = offset + 2;
    const end = start + length;
    if (!length || end > signature.length) throw new Error("Invalid ES256 DER integer length");
    const encoded = signature.slice(start, end);
    if (encoded.length > 33 || (encoded.length === 33 && encoded[0] !== 0)) {
        throw new Error("ES256 DER integer exceeds 32 bytes");
    }
    return { value: encoded[0] === 0 ? encoded.slice(1) : encoded, nextOffset: end };
}

function leftPad32(value: Uint8Array) {
    if (value.length > 32) throw new Error("ES256 integer exceeds 32 bytes");
    const padded = new Uint8Array(32);
    padded.set(value, 32 - value.length);
    return padded;
}

async function sha256(bytes: Uint8Array, cryptoProvider: Crypto) {
    return new Uint8Array(await cryptoProvider.subtle.digest("SHA-256", bytes));
}

function uint16Bytes(value: number) {
    if (!Number.isInteger(value) || value < 0 || value > 0xffff) throw new Error("Value exceeds uint16 range");
    const bytes = new Uint8Array(2);
    new DataView(bytes.buffer).setUint16(0, value);
    return bytes;
}

function uint32Bytes(value: number) {
    if (!Number.isInteger(value) || value < 0 || value > 0xffffffff) throw new Error("Value exceeds uint32 range");
    const bytes = new Uint8Array(4);
    new DataView(bytes.buffer).setUint32(0, value);
    return bytes;
}

function concatBytes(...parts: Uint8Array[]) {
    const result = new Uint8Array(parts.reduce((length, part) => length + part.length, 0));
    let offset = 0;
    for (const part of parts) {
        result.set(part, offset);
        offset += part.length;
    }
    return result;
}

function copyBytes(bytes: Uint8Array) {
    return new Uint8Array(bytes);
}

function requireBytes(value: Uint8Array, name: string) {
    if (!(value instanceof Uint8Array) || value.length === 0) {
        throw new Error(`Passkey ${name} must not be empty`);
    }
}

function getCrypto(): Crypto {
    if (typeof globalThis.crypto === "undefined") {
        throw new Error("WebCrypto is not available");
    }
    return globalThis.crypto;
}
