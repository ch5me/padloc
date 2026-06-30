// @ts-nocheck
const { expect } = require("chai");
const { afterEach, beforeEach, suite: mochaSuite, test: mochaTest } = require("mocha");
const requireModule = require;
const { base64ToBytes, bytesToBase64, stringToBytes } = requireModule("../../core/src/encoding");
const { FieldType, PasskeyCredentialPolicy, VaultItem, VaultItemKind } = requireModule("../../core/src/item");
const {
    clearPasskeySignerMemoryCacheForTests,
    configurePasskeySignerStoreForTests,
    enrollPasskeyCredential,
    PADLOC_AGENTIC_VAULT_AAGUID,
    requestPasskeyAssertion,
    verifyAssertionSignature,
} = requireModule("../src/passkey-broker");

const ORIGINAL_INDEXED_DB = globalThis.indexedDB;

const ALGORITHMS = [
    {
        label: "ES256",
        value: -7,
        generateKey: { name: "ECDSA", namedCurve: "P-256" },
    },
    {
        label: "Ed25519",
        value: -8,
        generateKey: { name: "Ed25519" },
    },
];

mochaSuite("Passkey broker", () => {
    beforeEach(() => {
        configurePasskeySignerStoreForTests({ allowMemoryOnly: true });
        clearPasskeySignerMemoryCacheForTests();
        restoreOriginalIndexedDb();
    });

    afterEach(() => {
        configurePasskeySignerStoreForTests({ allowMemoryOnly: false });
        clearPasskeySignerMemoryCacheForTests();
        restoreOriginalIndexedDb();
    });

    for (const algorithm of ALGORITHMS) {
        mochaTest(
            `${algorithm.label} generated enroll stores opaque signer handle and returns WebAuthn registration material`,
            async () => {
                const request = await enrollmentRequest({
                    algorithm: algorithm.value,
                    passkey: {
                        credentialId: undefined,
                        privateKeyPkcs8: undefined,
                    },
                });
                const result = await enrollPasskeyCredential(request, new Date("2026-06-29T18:00:00.000Z"));
                const signerHandleField = result.fields[result.passkeyCredential.privateKeyFieldIndex];

                expect(signerHandleField.name).to.equal("Signer Handle");
                expect(signerHandleField.type).to.equal(FieldType.Password);
                expect(signerHandleField.value).to.match(/^padloc-passkey-signer:/);
                expect(result.passkeyCredential.credentialId).to.be.a("string").and.not.equal("");
                expect(JSON.stringify(result.response)).not.to.contain(signerHandleField.value);
                expect(JSON.stringify(result.fields)).not.to.contain("BEGIN PRIVATE KEY");
                expect(JSON.stringify(result.fields)).not.to.contain("Private Key");
                expect(result.response.passkey.registration.attestationObject).to.be.a("string").and.not.equal("");
                expect(result.response.passkey.registration.publicKeySpki).to.be.a("string").and.not.equal("");

                const item = asStoredItem(result);
                const requestAssertion = assertionRequest(
                    item.passkeyCredential.credentialId,
                    `nonce-generated-${algorithm.value}`,
                    "flow-generated"
                );
                const assertion = await requestPasskeyAssertion(
                    requestAssertion,
                    [item],
                    new Date("2026-06-29T18:05:00.000Z")
                );
                const verified = await verifyAssertionSignature(
                    assertion.updatedItem.passkeyCredential,
                    assertion.response.passkey.assertion,
                    requestAssertion.passkey
                );

                expect(assertion.response.ok).to.equal(true);
                expect(verified).to.equal(true);
            }
        );

        mochaTest(
            `${algorithm.label} enroll-import stores opaque signer handle and never stores raw key bytes`,
            async () => {
                const request = await enrollmentRequest({ algorithm: algorithm.value });
                const result = await enrollPasskeyCredential(request, new Date("2026-06-29T18:00:00.000Z"));
                const signerHandleField = result.fields[result.passkeyCredential.privateKeyFieldIndex];

                expect(signerHandleField.name).to.equal("Signer Handle");
                expect(signerHandleField.type).to.equal(FieldType.Password);
                expect(signerHandleField.value).to.match(/^padloc-passkey-signer:/);
                expect(signerHandleField.value).not.to.equal(request.passkey.privateKeyPkcs8);
                expect(result.passkeyCredential.algorithm).to.equal(algorithm.value);
                expect(result.passkeyCredential.privateKeyFieldIndex).to.equal(0);
                expect(JSON.stringify(result)).not.to.contain(request.passkey.privateKeyPkcs8);
                expect(JSON.stringify(result.response)).not.to.contain(signerHandleField.value);
                expect(JSON.stringify(result.response)).not.to.contain("privateKey");
                expect(result.response.passkey.registration.attestationObject).to.be.a("string").and.not.equal("");
                expect(result.response.passkey.registration.algorithm).to.equal(algorithm.value);
            }
        );

        mochaTest(
            `${algorithm.label} enroll-import -> assert -> signature verifies against stored public key`,
            async () => {
                const request = await enrollmentRequest({ algorithm: algorithm.value });
                const enrolled = await enrollPasskeyCredential(request, new Date("2026-06-29T18:00:00.000Z"));
                const item = asStoredItem(enrolled);
                const requestAssertion = assertionRequest(
                    item.passkeyCredential.credentialId,
                    "nonce-allow",
                    "flow-allow"
                );
                const result = await requestPasskeyAssertion(
                    requestAssertion,
                    [item],
                    new Date("2026-06-29T18:05:00.000Z")
                );

                expect(result.response.ok).to.equal(true);
                expect(result.updatedItem.passkeyCredential.signCount).to.equal(1);
                expect(result.updatedItem.passkeyCredential.algorithm).to.equal(algorithm.value);
                expect(result.response.passkey.decision).to.equal("allow");
                expect(JSON.stringify(result.response)).not.to.contain(item.fields[0].value);
                expect(item.fields[0].value).to.match(/^padloc-passkey-signer:/);

                const verified = await verifyAssertionSignature(
                    result.updatedItem.passkeyCredential,
                    result.response.passkey.assertion,
                    requestAssertion.passkey
                );

                expect(verified).to.equal(true);
            }
        );
    }

    mochaTest("legacy private-key vault field fails loud instead of signing", async () => {
        const enrolled = await enrollPasskeyCredential(await enrollmentRequest(), new Date("2026-06-29T18:00:00.000Z"));
        const item = asStoredItem(enrolled);
        item.fields[0].value = "legacy-raw-private-key";
        const request = assertionRequest(item.passkeyCredential.credentialId, "nonce-legacy", "flow-legacy");

        try {
            await requestPasskeyAssertion(request, [item], new Date("2026-06-29T18:05:00.000Z"));
            throw new Error("expected legacy private key field to fail");
        } catch (error) {
            expect(error.message).to.contain("Legacy passkey private key field is not supported");
        }
    });

    mochaTest("generated enroll requires durable signer IndexedDB outside test mode", async () => {
        configurePasskeySignerStoreForTests({ allowMemoryOnly: false });
        Reflect.deleteProperty(globalThis, "indexedDB");

        try {
            await enrollPasskeyCredential(
                await enrollmentRequest({
                    passkey: {
                        credentialId: undefined,
                        privateKeyPkcs8: undefined,
                    },
                }),
                new Date("2026-06-29T18:00:00.000Z")
            );
            throw new Error("expected enrollment without IndexedDB to fail");
        } catch (error) {
            expect(error.message).to.contain("IndexedDB unavailable");
        }
    });

    mochaTest("assertion reloads signer key from IndexedDB after memory cache clears", async () => {
        configurePasskeySignerStoreForTests({ allowMemoryOnly: false });
        installMemoryIndexedDb();
        const enrolled = await enrollPasskeyCredential(
            await enrollmentRequest({
                passkey: {
                    credentialId: undefined,
                    privateKeyPkcs8: undefined,
                },
            }),
            new Date("2026-06-29T18:00:00.000Z")
        );
        const item = asStoredItem(enrolled);
        clearPasskeySignerMemoryCacheForTests();
        const request = assertionRequest(item.passkeyCredential.credentialId, "nonce-idb-reload", "flow-idb-reload");
        const assertion = await requestPasskeyAssertion(request, [item], new Date("2026-06-29T18:05:00.000Z"));
        const verified = await verifyAssertionSignature(
            assertion.updatedItem.passkeyCredential,
            assertion.response.passkey.assertion,
            request.passkey
        );

        expect(assertion.response.ok).to.equal(true);
        expect(verified).to.equal(true);
    });

    mochaTest("denies disallowed rpId", async () => {
        const enrolled = await enrollPasskeyCredential(await enrollmentRequest(), new Date("2026-06-29T18:00:00.000Z"));
        const item = asStoredItem(enrolled);
        const request = assertionRequest(item.passkeyCredential.credentialId, "nonce-rp", "flow-rp");
        request.passkey.rpId = "evil.example";
        request.binding.rpId = "evil.example";
        const result = await requestPasskeyAssertion(request, [item], new Date("2026-06-29T18:05:00.000Z"));

        expect(result.response.ok).to.equal(false);
        expect(result.response.reason).to.equal("rp_id_not_allowed");
    });

    mochaTest("denies disallowed top origin", async () => {
        const enrolled = await enrollPasskeyCredential(await enrollmentRequest(), new Date("2026-06-29T18:00:00.000Z"));
        const item = asStoredItem(enrolled);
        const request = assertionRequest(item.passkeyCredential.credentialId, "nonce-origin", "flow-origin");
        request.passkey.topOrigin = "https://blocked.example.test";
        request.binding.origin = "https://blocked.example.test";
        request.binding.topOrigin = "https://blocked.example.test";
        const result = await requestPasskeyAssertion(request, [item], new Date("2026-06-29T18:05:00.000Z"));

        expect(result.response.ok).to.equal(false);
        expect(result.response.reason).to.equal("top_origin_not_allowed");
    });

    mochaTest("allows HTTPS sibling origins under the passkey RP ID", async () => {
        const enrolled = await enrollPasskeyCredential(await enrollmentRequest(), new Date("2026-06-29T18:00:00.000Z"));
        const item = asStoredItem(enrolled);
        const request = assertionRequest(
            item.passkeyCredential.credentialId,
            "nonce-related-origin",
            "flow-related-origin"
        );
        request.passkey.topOrigin = "https://login.example-rp.test";
        request.binding.origin = "https://login.example-rp.test";
        request.binding.topOrigin = "https://login.example-rp.test";
        const result = await requestPasskeyAssertion(request, [item], new Date("2026-06-29T18:05:00.000Z"));

        expect(result.response.ok).to.equal(true);
        expect(result.response.passkey.assertion).to.exist;
    });

    mochaTest("denies missing flow binding when required", async () => {
        const enrolled = await enrollPasskeyCredential(await enrollmentRequest(), new Date("2026-06-29T18:00:00.000Z"));
        const item = asStoredItem(enrolled);
        const request = assertionRequest(item.passkeyCredential.credentialId, "nonce-flow", undefined);
        delete request.passkey.flowId;
        delete request.binding.flowId;
        const result = await requestPasskeyAssertion(request, [item], new Date("2026-06-29T18:05:00.000Z"));

        expect(result.response.ok).to.equal(false);
        expect(result.response.reason).to.equal("flow_binding_required");
    });

    mochaTest("denies once daily rate limit is exhausted", async () => {
        const enrolled = await enrollPasskeyCredential(
            await enrollmentRequest({ policy: { ...basePolicy(), rateLimit: { maxPerDay: 1, maxPerWeek: 3 } } }),
            new Date("2026-06-29T18:00:00.000Z")
        );
        const item = asStoredItem(enrolled);
        const allow = await requestPasskeyAssertion(
            assertionRequest(item.passkeyCredential.credentialId, "nonce-first", "flow-rate"),
            [item],
            new Date("2026-06-29T18:05:00.000Z")
        );
        const deny = await requestPasskeyAssertion(
            assertionRequest(allow.updatedItem.passkeyCredential.credentialId, "nonce-second", "flow-rate"),
            [allow.updatedItem],
            new Date("2026-06-29T18:10:00.000Z")
        );

        expect(allow.response.ok).to.equal(true);
        expect(deny.response.ok).to.equal(false);
        expect(deny.response.reason).to.equal("rate_limit_day_exceeded");
    });

    mochaTest("denies emergency lockout", async () => {
        const enrolled = await enrollPasskeyCredential(
            await enrollmentRequest({ policy: { ...basePolicy(), emergencyLockout: true } }),
            new Date("2026-06-29T18:00:00.000Z")
        );
        const item = asStoredItem(enrolled);
        const result = await requestPasskeyAssertion(
            assertionRequest(item.passkeyCredential.credentialId, "nonce-lock", "flow-lock"),
            [item],
            new Date("2026-06-29T18:05:00.000Z")
        );

        expect(result.response.ok).to.equal(false);
        expect(result.response.reason).to.equal("emergency_lockout");
    });

    mochaTest("marks WebAuthn UV bit when userVerification is required", async () => {
        const enrolled = await enrollPasskeyCredential(
            await enrollmentRequest({ passkey: { userVerification: "required" } }),
            new Date("2026-06-29T18:00:00.000Z")
        );
        const item = asStoredItem(enrolled);
        const request = assertionRequest(item.passkeyCredential.credentialId, "nonce-uv", "flow-uv");
        request.passkey.userVerification = "required";
        const assertion = await requestPasskeyAssertion(request, [item], new Date("2026-06-29T18:05:00.000Z"));

        const registrationFlags = readAuthenticatorFlags(enrolled.response.passkey.registration.authenticatorData);
        const assertionFlags = readAuthenticatorFlags(assertion.response.passkey.assertion.authenticatorData);
        expect(registrationFlags & 0x04).to.equal(0x04);
        expect(assertionFlags & 0x04).to.equal(0x04);
        expect(registrationFlags & 0x18).to.equal(0x18);
        expect(assertionFlags & 0x18).to.equal(0x18);
    });

    mochaTest("generated registration uses Padloc platform-passkey identity metadata", async () => {
        const enrolled = await enrollPasskeyCredential(
            await enrollmentRequest({ passkey: { userVerification: "required" } }),
            new Date("2026-06-29T18:00:00.000Z")
        );
        const registration = enrolled.response.passkey.registration;
        const decodedAuthData = decodeAuthenticatorData(registration.authenticatorData);
        const attestationObject = decodeCbor(base64ToBytes(registration.attestationObject));
        const decodedAttestationAuthData = decodeAuthenticatorData(bytesToBase64(attestationObject.authData));

        expect(registration.aaguid).to.equal(PADLOC_AGENTIC_VAULT_AAGUID);
        expect(decodedAuthData.aaguid).to.equal(PADLOC_AGENTIC_VAULT_AAGUID);
        expect(decodedAttestationAuthData.aaguid).to.equal(PADLOC_AGENTIC_VAULT_AAGUID);
        expect(decodedAuthData.flags & 0x01).to.equal(0x01);
        expect(decodedAuthData.flags & 0x04).to.equal(0x04);
        expect(decodedAuthData.flags & 0x40).to.equal(0x40);
        expect(decodedAuthData.flags & 0x18).to.equal(0x18);
        expect(decodedAttestationAuthData.flags).to.equal(decodedAuthData.flags);
        expect(decodedAuthData.signCount).to.equal(0);
        expect(attestationObject.fmt).to.equal("none");
        expect(registration.authenticatorAttachment).to.equal("platform");
        expect(registration.clientExtensionResults).to.deep.equal({ credProps: { rk: true } });
        expect(registration.transports).to.deep.equal(["internal"]);
    });

    mochaTest("encodes attestationObject attStmt as a CBOR map", async () => {
        const none = await enrollPasskeyCredential(await enrollmentRequest(), new Date("2026-06-29T18:00:00.000Z"));
        const googleStyle = await enrollPasskeyCredential(
            await enrollmentRequest({
                passkey: {
                    clientDataHash: bytesToBase64(new Uint8Array(32).fill(1)),
                    userVerification: "preferred",
                },
            }),
            new Date("2026-06-29T18:00:00.000Z")
        );

        const noneObject = decodeCbor(base64ToBytes(none.response.passkey.registration.attestationObject));
        const googleStyleObject = decodeCbor(
            base64ToBytes(googleStyle.response.passkey.registration.attestationObject)
        );

        expect(noneObject.fmt).to.equal("none");
        expect(noneObject.attStmt).to.deep.equal({});
        expect(noneObject.attStmt).not.to.be.instanceOf(Uint8Array);
        expect(googleStyleObject.fmt).to.equal("none");
        expect(googleStyleObject.attStmt).to.deep.equal({});
        expect(googleStyleObject.attStmt).not.to.be.instanceOf(Uint8Array);
        expect(googleStyleObject.authData).to.be.instanceOf(Uint8Array);
    });
});

function restoreOriginalIndexedDb() {
    if (typeof ORIGINAL_INDEXED_DB === "undefined") {
        Reflect.deleteProperty(globalThis, "indexedDB");
        return;
    }
    Reflect.set(globalThis, "indexedDB", ORIGINAL_INDEXED_DB);
}

function installMemoryIndexedDb() {
    const databases = new Map();
    const fakeIndexedDb = {
        open(name) {
            const request = makeIdbRequest();
            queueMicrotask(() => {
                let state = databases.get(name);
                const isNew = !state;
                if (!state) {
                    state = { stores: new Map() };
                    databases.set(name, state);
                }
                request.result = makeIdbDatabase(state);
                if (isNew && typeof request.onupgradeneeded === "function")
                    request.onupgradeneeded({ target: request });
                queueMicrotask(() => request.onsuccess && request.onsuccess({ target: request }));
            });
            return request;
        },
        deleteDatabase(name) {
            const request = makeIdbRequest();
            queueMicrotask(() => {
                databases.delete(name);
                request.onsuccess && request.onsuccess({ target: request });
            });
            return request;
        },
    };
    Reflect.set(globalThis, "indexedDB", fakeIndexedDb);
    return fakeIndexedDb;
}

function makeIdbDatabase(state) {
    return {
        objectStoreNames: {
            contains: (name) => state.stores.has(name),
        },
        createObjectStore(name) {
            if (!state.stores.has(name)) state.stores.set(name, new Map());
            return makeIdbObjectStore(state.stores.get(name));
        },
        transaction(name) {
            if (!state.stores.has(name)) throw new Error(`missing object store ${name}`);
            return {
                objectStore: (requestedName) => {
                    if (requestedName !== name) throw new Error(`unexpected object store ${requestedName}`);
                    return makeIdbObjectStore(state.stores.get(name));
                },
            };
        },
        close() {},
    };
}

function makeIdbObjectStore(store) {
    return {
        put(record) {
            const request = makeIdbRequest();
            queueMicrotask(() => {
                store.set(record.handle, record);
                request.result = record;
                request.onsuccess && request.onsuccess({ target: request });
            });
            return request;
        },
        get(handle) {
            const request = makeIdbRequest();
            queueMicrotask(() => {
                request.result = store.get(handle);
                request.onsuccess && request.onsuccess({ target: request });
            });
            return request;
        },
        count() {
            const request = makeIdbRequest();
            queueMicrotask(() => {
                request.result = store.size;
                request.onsuccess && request.onsuccess({ target: request });
            });
            return request;
        },
    };
}

function makeIdbRequest() {
    return {
        error: null,
        result: undefined,
        onblocked: null,
        onerror: null,
        onsuccess: null,
        onupgradeneeded: null,
    };
}

function asStoredItem(enrolled: { itemName: string; fields: unknown[]; passkeyCredential: Record<string, unknown> }) {
    return new VaultItem({
        id: "passkey-item-1",
        name: enrolled.itemName,
        itemKind: VaultItemKind.PasskeyCredential,
        fields: enrolled.fields,
        passkeyCredential: enrolled.passkeyCredential,
    });
}

async function enrollmentRequest(
    overrides: {
        algorithm?: number;
        fixtureSeed?: string;
        policy?: Record<string, unknown>;
        passkey?: Record<string, unknown>;
    } = {}
) {
    const fixture = await makeImportedCredentialFixture(overrides.algorithm || -7, overrides.fixtureSeed || "default");
    const policy = new PasskeyCredentialPolicy({
        ...basePolicy(),
        ...(overrides.policy || {}),
    });
    return {
        type: "enroll-passkey",
        protocolVersion: 1,
        requestId: "enroll-1",
        binding: {
            sessionId: "session-enroll",
            origin: "https://accounts.example-rp.test",
            topOrigin: "https://accounts.example-rp.test",
            vendor: "throwaway-test-rp",
            profileId: "profile-1",
            accountId: "account-1",
        },
        passkey: {
            itemName: "Example RP Passkey",
            rpId: "example-rp.test",
            credentialId: fixture.credentialId,
            privateKeyPkcs8: fixture.privateKeyPkcs8,
            userHandle: fixture.userHandle,
            signCount: fixture.signCount,
            algorithm: fixture.algorithm,
            vendor: "throwaway-test-rp",
            policy,
            ...(overrides.passkey || {}),
        },
    };
}

function assertionRequest(credentialId: string, nonce: string, flowId?: string) {
    const challenge = bytesToBase64(stringToBytes("challenge-for-passkey"));
    return {
        type: "request-assertion",
        protocolVersion: 1,
        requestId: `assert-${nonce}`,
        binding: {
            sessionId: "session-assert",
            origin: "https://accounts.example-rp.test",
            topOrigin: "https://accounts.example-rp.test",
            rpId: "example-rp.test",
            flowId,
            nonce,
            expiresAt: "2026-06-29T18:20:00.000Z",
            vendor: "throwaway-test-rp",
            profileId: "profile-1",
            accountId: "account-1",
        },
        passkey: {
            credentialId,
            rpId: "example-rp.test",
            topOrigin: "https://accounts.example-rp.test",
            challenge,
            flowId,
            nonce,
            vendor: "throwaway-test-rp",
        },
    };
}

function basePolicy() {
    return {
        allowedRpIds: ["example-rp.test"],
        allowedTopOrigins: ["https://accounts.example-rp.test"],
        allowedVendorFlows: ["throwaway-test-rp"],
        approval: "none",
        rateLimit: {
            maxPerDay: 5,
            maxPerWeek: 10,
        },
        timeWindows: [],
        requireFlowBinding: true,
        emergencyLockout: false,
    };
}

async function makeImportedCredentialFixture(algorithm: number, seed: string) {
    const subtle = globalThis.crypto.subtle;
    const generateKey = ALGORITHMS.find((entry) => entry.value === algorithm)?.generateKey;
    if (!generateKey) {
        throw new Error(`Unsupported fixture algorithm ${algorithm}`);
    }
    const keyPair = await subtle.generateKey(generateKey, true, ["sign", "verify"]);
    if (!("privateKey" in keyPair) || !keyPair.privateKey) {
        throw new Error(`Fixture key generation failed for algorithm ${algorithm}`);
    }
    return {
        algorithm,
        credentialId: bytesToBase64(stringToBytes(`credential-${seed}-${algorithm}`)),
        privateKeyPkcs8: bytesToBase64(new Uint8Array(await subtle.exportKey("pkcs8", keyPair.privateKey))),
        userHandle: bytesToBase64(stringToBytes(`user-${seed}-${algorithm}`)),
        signCount: 0,
    };
}

function readAuthenticatorFlags(authenticatorData: string) {
    return base64ToBytes(authenticatorData)[32];
}

function decodeAuthenticatorData(authenticatorData: string) {
    const bytes = base64ToBytes(authenticatorData);
    return {
        flags: bytes[32],
        signCount: (bytes[33] << 24) | (bytes[34] << 16) | (bytes[35] << 8) | bytes[36],
        aaguid: formatUuid(bytes.slice(37, 53)),
    };
}

function formatUuid(bytes) {
    const hex = Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
    return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

function decodeCbor(bytes) {
    const decoded = decodeCborValue(bytes, 0);
    expect(decoded.offset).to.equal(bytes.length);
    return decoded.value;
}

function decodeCborValue(bytes, offset) {
    const first = bytes[offset++];
    const major = first >> 5;
    const additional = first & 0x1f;
    const length = readCborLength(bytes, offset, additional);
    offset = length.offset;
    if (major === 0) return { value: length.value, offset };
    if (major === 1) return { value: -1 - length.value, offset };
    if (major === 2) {
        return { value: bytes.slice(offset, offset + length.value), offset: offset + length.value };
    }
    if (major === 3) {
        const textBytes = bytes.slice(offset, offset + length.value);
        return { value: new TextDecoder().decode(textBytes), offset: offset + length.value };
    }
    if (major === 5) {
        const result = {};
        for (let index = 0; index < length.value; index += 1) {
            const key = decodeCborValue(bytes, offset);
            const value = decodeCborValue(bytes, key.offset);
            result[key.value] = value.value;
            offset = value.offset;
        }
        return { value: result, offset };
    }
    throw new Error(`Unsupported CBOR major type ${major}`);
}

function readCborLength(bytes, offset, additional) {
    if (additional < 24) return { value: additional, offset };
    if (additional === 24) return { value: bytes[offset], offset: offset + 1 };
    if (additional === 25) return { value: (bytes[offset] << 8) | bytes[offset + 1], offset: offset + 2 };
    throw new Error(`Unsupported CBOR additional info ${additional}`);
}
