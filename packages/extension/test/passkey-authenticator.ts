import { expect } from "chai";
import { createVaultItem, ItemHistoryEntry, VaultItem } from "@padloc/core/src/item";
import {
    PasskeyCounterPolicy,
    PasskeyCredential,
    PasskeyEs256KeyMaterial,
    PasskeyEs256PrivateJwk,
    PasskeyEs256PublicJwk,
} from "@padloc/core/src/passkey";
import {
    buildPasskeyAssertionResponse,
    buildPasskeyRegistrationResponse,
    derEcdsaSignatureToWebCrypto,
    encodeEs256CosePublicKey,
    generatePasskeyCredential,
    validateRpIdForOrigin,
    webCryptoEcdsaSignatureToDer,
} from "@padloc/core/src/webauthn-authenticator";
import { bytesToBase64, bytesToString } from "@padloc/core/src/encoding";

const publicKeyJwk: PasskeyEs256PublicJwk = {
    kty: "EC",
    crv: "P-256",
    x: "axfR8uEsQkf4vOblY6RA8ncDfYEt6zOg9KE5RdiYwpY",
    y: "T-NC4v4af5uO5-tKfA-eFivOM1drMV7Oy7ZAaDe_UfU",
    alg: "ES256",
    ext: true,
    key_ops: ["verify"],
};

const privateKeyJwk: PasskeyEs256PrivateJwk = {
    ...publicKeyJwk,
    d: "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAE",
    key_ops: ["sign"],
};

function bytes(...values: number[]) {
    return new Uint8Array(values);
}

function fixedCredential() {
    return new PasskeyCredential({
        rpId: "login.example.test",
        rpName: "Example Login",
        credentialId: bytes(1, 2, 3, 4, 5, 6),
        userHandle: bytes(10, 11, 12, 13),
        userName: "test@example.test",
        userDisplayName: "Test User",
        keyMaterial: new PasskeyEs256KeyMaterial({ publicKeyJwk, privateKeyJwk }),
        discoverable: true,
        backupEligible: false,
        backupState: false,
        counterPolicy: PasskeyCounterPolicy.Incrementing,
        counter: 41,
        created: new Date("2026-01-02T03:04:05.000Z"),
    });
}

const testRpPolicy = (rpId: string, host: string) =>
    rpId === "login.example.test" && (host === rpId || host.endsWith(`.${rpId}`));

suite("Passkey authenticator foundation", () => {
    test("serializes private credential material only in the live encrypted item payload", () => {
        const item = new VaultItem({ id: "item-1", name: "Example", passkeys: [fixedCredential()] });
        item.history = [new ItemHistoryEntry(item)];

        const raw = item.toRaw();
        const restored = new VaultItem().fromRaw(raw);

        expect(restored.passkeys[0]).to.be.instanceOf(PasskeyCredential);
        expect(restored.passkeys[0].keyMaterial).to.be.instanceOf(PasskeyEs256KeyMaterial);
        expect(restored.passkeys[0].keyMaterial.privateKeyJwk.d).to.equal(privateKeyJwk.d);
        expect(raw.history[0]).not.to.have.property("passkeys");
        expect(restored.history[0]).not.to.have.property("passkeys");
        expect(raw.passkeys[0].credentialId).to.equal("AQIDBAUG");
    });

    test("preserves passkeys when creating a vault item through the shared factory", async () => {
        const credential = fixedCredential();
        const item = await createVaultItem({ name: "Example", passkeys: [credential] });

        expect(item.passkeys).to.deep.equal([credential]);
    });

    test("generates an exportable ES256 credential with caller-controlled deterministic identifiers", async () => {
        const credential = await generatePasskeyCredential({
            rpId: "LOGIN.EXAMPLE.TEST",
            rpName: "Example Login",
            credentialId: bytes(20, 21, 22),
            userHandle: bytes(30, 31, 32),
            userName: "test@example.test",
            userDisplayName: "Test User",
        });

        expect(credential.rpId).to.equal("login.example.test");
        expect(Array.from(credential.credentialId)).to.deep.equal([20, 21, 22]);
        expect(credential.keyMaterial.publicKeyJwk.crv).to.equal("P-256");
        expect(credential.keyMaterial.privateKeyJwk.d).to.be.a("string").and.not.empty;
        const imported = await crypto.subtle.importKey(
            "jwk",
            credential.keyMaterial.privateKeyJwk,
            { name: "ECDSA", namedCurve: "P-256" },
            false,
            ["sign"]
        );
        expect(imported.type).to.equal("private");
    });

    test("rejects mismatched public and private key coordinates", () => {
        const credential = fixedCredential();
        credential.keyMaterial.privateKeyJwk = { ...privateKeyJwk, x: bytesToBase64(new Uint8Array(32)) };

        expect(credential.validate()).to.equal(false);
    });

    test("never logs private JWK material when serialized passkey validation fails", () => {
        const raw = JSON.parse(JSON.stringify(fixedCredential().toRaw()));
        raw.keyMaterial.privateKeyJwk.d = "PRIVATE-JWK-SENTINEL";
        raw.keyMaterial.privateKeyJwk.x = "mismatch";
        const warnings: unknown[][] = [];
        const originalWarn = console.warn;
        console.warn = (...args: unknown[]) => warnings.push(args);
        try {
            expect(() => new PasskeyCredential().fromRaw(raw)).to.throw();
        } finally {
            console.warn = originalWarn;
        }
        expect(JSON.stringify(warnings)).not.to.contain("PRIVATE-JWK-SENTINEL");
    });

    test("builds deterministic fmt=none registration components with valid RP binding and COSE", async () => {
        const credential = fixedCredential();
        const challenge = bytes(100, 101, 102, 103);
        const result = await buildPasskeyRegistrationResponse(credential, {
            challenge,
            origin: "https://login.example.test",
            rpId: "login.example.test",
            userVerified: true,
            rpIdSuffixValidator: testRpPolicy,
        });
        const expectedRpHash = new Uint8Array(
            await crypto.subtle.digest("SHA-256", new TextEncoder().encode(credential.rpId))
        );
        const clientData = JSON.parse(bytesToString(result.clientDataJSON));

        expect(result.id).to.equal(bytesToBase64(credential.credentialId));
        expect(Array.from(result.authenticatorData.slice(0, 32))).to.deep.equal(Array.from(expectedRpHash));
        expect(result.authenticatorData[32]).to.equal(0x45);
        expect(result.authenticatorData.slice(37, 53)).to.deep.equal(new Uint8Array(16));
        expect(result.publicKeyCose[0]).to.equal(0xa5);
        expect(result.attestationObject[0]).to.equal(0xa3);
        expect(Array.from(result.publicKeyCose)).to.deep.equal(Array.from(encodeEs256CosePublicKey(publicKeyJwk)));
        expect(clientData).to.deep.equal({
            type: "webauthn.create",
            challenge: bytesToBase64(challenge),
            origin: "https://login.example.test",
            crossOrigin: false,
        });
    });

    test("signs a verifiable assertion and returns the counter to persist without mutating the credential", async () => {
        const credential = fixedCredential();
        const result = await buildPasskeyAssertionResponse(credential, {
            challenge: bytes(90, 91, 92, 93),
            origin: "https://login.example.test",
            rpId: "login.example.test",
            userVerified: true,
            rpIdSuffixValidator: testRpPolicy,
        });
        const clientDataHash = new Uint8Array(await crypto.subtle.digest("SHA-256", result.clientDataJSON));
        const signedData = new Uint8Array(result.authenticatorData.length + clientDataHash.length);
        signedData.set(result.authenticatorData);
        signedData.set(clientDataHash, result.authenticatorData.length);
        const publicKey = await crypto.subtle.importKey(
            "jwk",
            publicKeyJwk,
            { name: "ECDSA", namedCurve: "P-256" },
            false,
            ["verify"]
        );
        const verified = await crypto.subtle.verify(
            { name: "ECDSA", hash: "SHA-256" },
            publicKey,
            derEcdsaSignatureToWebCrypto(result.signature),
            signedData
        );

        expect(verified).to.equal(true);
        expect(result.authenticatorData[32]).to.equal(0x05);
        expect(new DataView(result.authenticatorData.buffer).getUint32(33)).to.equal(42);
        expect(result.nextCounter).to.equal(42);
        expect(credential.counter).to.equal(41);
    });

    test("round-trips fixed-width WebCrypto signatures through strict DER encoding", () => {
        const raw = new Uint8Array(64);
        raw[0] = 0x80;
        raw[31] = 0x01;
        raw[62] = 0x7f;
        raw[63] = 0xff;

        const der = webCryptoEcdsaSignatureToDer(raw);

        expect(der[0]).to.equal(0x30);
        expect(Array.from(derEcdsaSignatureToWebCrypto(der))).to.deep.equal(Array.from(raw));
    });

    test("treats a 64-byte signature beginning with a DER tag as P-1363", () => {
        const raw = new Uint8Array(64);
        raw[0] = 0x30;
        raw[31] = 0x01;
        raw[63] = 0x02;

        expect(Array.from(derEcdsaSignatureToWebCrypto(webCryptoEcdsaSignatureToDer(raw)))).to.deep.equal(
            Array.from(raw)
        );
    });

    test("rejects cross-RP and insecure-origin ceremonies before signing", async () => {
        expect(() => validateRpIdForOrigin("example.test", "https://example.test.evil.test", () => true)).to.throw(
            "RP ID is not valid"
        );
        expect(() => validateRpIdForOrigin("example.test", "http://example.test")).to.throw("must use HTTPS");
        expect(() => validateRpIdForOrigin("com", "https://accounts.google.com")).to.throw("public-suffix policy");
        expect(() => validateRpIdForOrigin("co.uk", "https://co.uk")).to.throw("public-suffix policy");

        let error: Error | undefined;
        try {
            await buildPasskeyAssertionResponse(fixedCredential(), {
                challenge: bytes(1),
                origin: "https://login.example.test",
                rpId: "other.example.test",
                rpIdSuffixValidator: testRpPolicy,
            });
        } catch (caught) {
            error = caught as Error;
        }
        expect(error?.message).to.contain("does not match");
    });
});
