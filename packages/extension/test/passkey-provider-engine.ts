import { expect } from "chai";
import { base64ToBytes, bytesToBase64, bytesToString } from "@padloc/core/src/encoding";
import { PasskeyCredential } from "@padloc/core/src/passkey";
import { derEcdsaSignatureToWebCrypto } from "@padloc/core/src/webauthn-authenticator";
import {
    describePasskeyOperation,
    executePasskeyOperation,
    PasskeyCredentialRepository,
    PasskeyProviderError,
} from "../src/passkey-provider-engine";
import { serializeWebAuthnValue } from "../src/passkey-protocol";
import { approvePasskeyRpSuffix } from "../src/passkey-rp-policy";

const origin = "https://login.example.test";
const rpIdSuffixValidator = (rpId: string, host: string) =>
    rpId === "login.example.test" && (host === rpId || host.endsWith(`.${rpId}`));

function serializedOptions(value: Record<string, unknown>): Record<string, unknown> {
    return serializeWebAuthnValue(value) as Record<string, unknown>;
}

function createOptions(overrides: Record<string, unknown> = {}): Record<string, unknown> {
    return {
        challenge: new Uint8Array([1, 2, 3, 4]),
        rp: { id: "login.example.test", name: "Example Login" },
        user: {
            id: new Uint8Array([9, 8, 7, 6]),
            name: "person@example.test",
            displayName: "Example Person",
        },
        pubKeyCredParams: [
            { type: "public-key", alg: -257 },
            { type: "public-key", alg: -7 },
        ],
        authenticatorSelection: { residentKey: "required", userVerification: "required" },
        extensions: { credProps: true },
        ...overrides,
    };
}

class MemoryRepository implements PasskeyCredentialRepository {
    credentials: PasskeyCredential[] = [];
    created: PasskeyCredential[] = [];
    updated: PasskeyCredential[] = [];

    async listCredentials(rpId: string) {
        return this.credentials.filter((credential) => credential.rpId === rpId);
    }

    async createCredential(credential: PasskeyCredential) {
        this.credentials.push(credential);
        this.created.push(credential);
    }

    async updateCredential(credential: PasskeyCredential) {
        const index = this.credentials.findIndex(
            (candidate) => candidate.credentialId.toString() === credential.credentialId.toString()
        );
        if (index < 0) throw new Error("missing credential");
        this.credentials[index] = credential;
        this.updated.push(credential);
    }

    async deleteCredential(credential: PasskeyCredential) {
        const index = this.credentials.findIndex(
            (candidate) => candidate.credentialId.toString() === credential.credentialId.toString()
        );
        if (index < 0) throw new Error("missing credential");
        this.credentials.splice(index, 1);
    }
}

function expectProviderError(error: unknown, name: string): void {
    expect(error).to.be.instanceOf(PasskeyProviderError);
    expect((error as Error).name).to.equal(name);
}

suite("Passkey provider engine", () => {
    test("returns only redacted approval metadata from serialized create and get requests", () => {
        const createDescription = describePasskeyOperation({
            request: { operation: "create", options: serializedOptions(createOptions()) },
            origin,
            rpIdSuffixValidator,
        });
        const getDescription = describePasskeyOperation({
            request: {
                operation: "get",
                options: serializedOptions({
                    challenge: new Uint8Array([4, 3, 2, 1]),
                    rpId: "login.example.test",
                    allowCredentials: [{ type: "public-key", id: new Uint8Array([99]) }],
                }),
            },
            origin,
            rpIdSuffixValidator,
        });

        expect(createDescription).to.deep.equal({
            operation: "create",
            rpId: "login.example.test",
            rpName: "Example Login",
            userName: "person@example.test",
            userDisplayName: "Example Person",
        });
        expect(getDescription).to.deep.equal({
            operation: "get",
            rpId: "login.example.test",
            rpName: "login.example.test",
        });
        expect(JSON.stringify(createDescription)).not.to.contain("challenge");
        expect(JSON.stringify(getDescription)).not.to.contain("credential");
    });

    test("creates and then signs with a vault-held ES256 credential for a controlled RP", async () => {
        const repository = new MemoryRepository();
        const registration = await executePasskeyOperation({
            request: { operation: "create", options: serializedOptions(createOptions()) },
            origin,
            repository,
            userVerified: true,
            rpIdSuffixValidator,
        });

        expect(registration).to.include({ type: "public-key", authenticatorAttachment: "platform" });
        expect(registration.response).to.have.keys(
            "clientDataJSON",
            "attestationObject",
            "authenticatorData",
            "publicKey",
            "publicKeyAlgorithm",
            "transports"
        );
        expect(registration.clientExtensionResults).to.deep.equal({ credProps: { rk: true } });
        const spki = base64ToBytes((registration.response.publicKey as any).base64url);
        expect(spki[0]).to.equal(0x30);
        expect(spki[1]).not.to.equal(0x00);
        expect(
            (await crypto.subtle.importKey("spki", spki, { name: "ECDSA", namedCurve: "P-256" }, false, ["verify"]))
                .type
        ).to.equal("public");
        expect(repository.created).to.have.length(1);
        expect(repository.created[0].keyMaterial.privateKeyJwk.d).to.be.a("string").and.not.empty;
        expect(repository.created[0]).to.include({
            backupEligible: true,
            backupState: true,
            counterPolicy: "none",
        });
        expect(repository.created[0].counter).to.equal(0);

        const lastUsed = new Date("2026-07-10T19:30:00.000Z");
        const assertion = await executePasskeyOperation({
            request: {
                operation: "get",
                options: serializedOptions({
                    challenge: new Uint8Array([5, 6, 7, 8]),
                    rpId: "login.example.test",
                    allowCredentials: [{ type: "public-key", id: new Uint8Array(repository.created[0].credentialId) }],
                    userVerification: "required",
                }),
            },
            origin,
            repository,
            userVerified: true,
            rpIdSuffixValidator,
            now: () => lastUsed,
        });

        expect(assertion.id).to.equal(registration.id);
        expect(assertion.response).to.have.keys("clientDataJSON", "authenticatorData", "signature", "userHandle");
        expect(repository.updated).to.have.length(1);
        expect(repository.updated[0].counter).to.equal(0);
        expect(repository.updated[0].lastUsed?.toISOString()).to.equal(lastUsed.toISOString());
        expect(repository.created[0].counter).to.equal(0);

        const clientDataJSON = (assertion.response.clientDataJSON as any).base64url;
        expect(JSON.parse(bytesToString(base64ToBytes(clientDataJSON)))).to.deep.equal({
            type: "webauthn.get",
            challenge: "BQYHCA",
            origin,
            crossOrigin: false,
        });
        const clientDataBytes = base64ToBytes(clientDataJSON);
        const authenticatorData = base64ToBytes((assertion.response.authenticatorData as any).base64url);
        const signature = base64ToBytes((assertion.response.signature as any).base64url);
        const clientDataHash = new Uint8Array(await crypto.subtle.digest("SHA-256", clientDataBytes));
        const signedData = new Uint8Array(authenticatorData.length + clientDataHash.length);
        signedData.set(authenticatorData);
        signedData.set(clientDataHash, authenticatorData.length);
        const publicKey = await crypto.subtle.importKey(
            "jwk",
            repository.updated[0].keyMaterial.publicKeyJwk,
            { name: "ECDSA", namedCurve: "P-256" },
            false,
            ["verify"]
        );
        expect(
            await crypto.subtle.verify(
                { name: "ECDSA", hash: "SHA-256" },
                publicKey,
                derEcdsaSignatureToWebCrypto(signature),
                signedData
            )
        ).to.equal(true);
    });

    test("emits the Google canary's discoverable multi-device credential shape", async () => {
        const googleOrigin = "https://accounts.google.com";
        const repository = new MemoryRepository();
        const registration = await executePasskeyOperation({
            request: {
                operation: "create",
                options: serializedOptions(
                    createOptions({
                        rp: { id: "google.com", name: "Google" },
                        user: {
                            id: new Uint8Array([7, 6, 5, 4]),
                            name: "google-canary@example.test",
                            displayName: "Google Canary",
                        },
                    })
                ),
            },
            origin: googleOrigin,
            repository,
            userVerified: true,
            rpIdSuffixValidator: approvePasskeyRpSuffix,
        });

        expect(registration).to.include({ type: "public-key", authenticatorAttachment: "platform" });
        expect(registration.response.transports).to.deep.equal(["internal"]);
        expect(registration.clientExtensionResults).to.deep.equal({ credProps: { rk: true } });
        expect(repository.created[0]).to.include({
            rpId: "google.com",
            backupEligible: true,
            backupState: true,
            counterPolicy: "none",
            counter: 0,
        });
        const registrationAuthData = base64ToBytes((registration.response.authenticatorData as any).base64url);
        expect(registrationAuthData[32] & 0x5d).to.equal(0x5d);
        expect(Array.from(registrationAuthData.slice(33, 37))).to.deep.equal([0, 0, 0, 0]);
        expect(Array.from(registrationAuthData.slice(37, 53))).to.deep.equal(new Array(16).fill(0));

        const assertion = await executePasskeyOperation({
            request: {
                operation: "get",
                options: serializedOptions({
                    challenge: new Uint8Array([8, 7, 6, 5]),
                    rpId: "google.com",
                    allowCredentials: [
                        { type: "public-key", id: new Uint8Array(repository.created[0].credentialId) },
                    ],
                    userVerification: "required",
                }),
            },
            origin: googleOrigin,
            repository,
            userVerified: true,
            rpIdSuffixValidator: approvePasskeyRpSuffix,
        });

        const assertionClientData = JSON.parse(
            bytesToString(base64ToBytes((assertion.response.clientDataJSON as any).base64url))
        );
        expect(assertionClientData).to.deep.equal({
            type: "webauthn.get",
            challenge: "CAcGBQ",
            origin: googleOrigin,
            crossOrigin: false,
        });
        const assertionAuthData = base64ToBytes((assertion.response.authenticatorData as any).base64url);
        expect(assertionAuthData[32] & 0x1d).to.equal(0x1d);
        expect(Array.from(assertionAuthData.slice(33, 37))).to.deep.equal([0, 0, 0, 0]);
        expect(repository.updated[0].counter).to.equal(0);
        expect(assertion.id).to.equal(registration.id);
    });

    test("rejects registration when the relying party does not offer ES256", async () => {
        const repository = new MemoryRepository();
        let error: unknown;
        try {
            await executePasskeyOperation({
                request: {
                    operation: "create",
                    options: serializedOptions(
                        createOptions({ pubKeyCredParams: [{ type: "public-key", alg: -257 }] })
                    ),
                },
                origin,
                repository,
                userVerified: true,
                rpIdSuffixValidator,
            });
        } catch (caught) {
            error = caught;
        }
        expectProviderError(error, "NotSupportedError");
        expect(repository.created).to.have.length(0);
    });

    test("rejects an RP ID that the trusted suffix policy does not approve", async () => {
        const repository = new MemoryRepository();
        let error: unknown;
        try {
            await executePasskeyOperation({
                request: { operation: "create", options: serializedOptions(createOptions()) },
                origin,
                repository,
                userVerified: true,
                rpIdSuffixValidator: () => false,
            });
        } catch (caught) {
            error = caught;
        }
        expectProviderError(error, "SecurityError");
    });

    test("rejects an explicitly empty RP ID rather than treating it as omitted", async () => {
        const repository = new MemoryRepository();
        let error: unknown;
        try {
            await executePasskeyOperation({
                request: {
                    operation: "create",
                    options: serializedOptions(createOptions({ rp: { id: "", name: "Must Not Default To Origin" } })),
                },
                origin,
                repository,
                userVerified: true,
                rpIdSuffixValidator,
            });
        } catch (caught) {
            error = caught;
        }
        expectProviderError(error, "SecurityError");
        expect(repository.created).to.have.length(0);
    });

    test("honors excludeCredentials before creating another credential", async () => {
        const repository = new MemoryRepository();
        await executePasskeyOperation({
            request: { operation: "create", options: serializedOptions(createOptions()) },
            origin,
            repository,
            userVerified: true,
            rpIdSuffixValidator,
        });
        let error: unknown;
        try {
            await executePasskeyOperation({
                request: {
                    operation: "create",
                    options: serializedOptions(
                        createOptions({
                            excludeCredentials: [
                                { type: "public-key", id: new Uint8Array(repository.credentials[0].credentialId) },
                            ],
                        })
                    ),
                },
                origin,
                repository,
                userVerified: true,
                rpIdSuffixValidator,
            });
        } catch (caught) {
            error = caught;
        }
        expectProviderError(error, "InvalidStateError");
        expect(repository.created).to.have.length(1);
    });

    test("honors allowCredentials and does not persist an assertion for a non-match", async () => {
        const repository = new MemoryRepository();
        await executePasskeyOperation({
            request: { operation: "create", options: serializedOptions(createOptions()) },
            origin,
            repository,
            userVerified: true,
            rpIdSuffixValidator,
        });
        let error: unknown;
        try {
            await executePasskeyOperation({
                request: {
                    operation: "get",
                    options: serializedOptions({
                        challenge: new Uint8Array([1]),
                        rpId: "login.example.test",
                        allowCredentials: [{ type: "public-key", id: new Uint8Array([99, 98, 97]) }],
                    }),
                },
                origin,
                repository,
                userVerified: true,
                rpIdSuffixValidator,
            });
        } catch (caught) {
            error = caught;
        }
        expectProviderError(error, "NotAllowedError");
        expect(repository.updated).to.have.length(0);
    });

    test("exposes only labels and invocation-local tokens when multiple credentials need selection", async () => {
        const repository = new MemoryRepository();
        for (const [id, name] of [
            [1, "first@example.test"],
            [2, "second@example.test"],
            [3, "third@example.test"],
            [4, "fourth@example.test"],
            [5, "fifth@example.test"],
        ] as const) {
            await executePasskeyOperation({
                request: {
                    operation: "create",
                    options: serializedOptions(
                        createOptions({
                            user: {
                                id: new Uint8Array([id]),
                                name,
                                displayName: name,
                            },
                        })
                    ),
                },
                origin,
                repository,
                userVerified: true,
                rpIdSuffixValidator,
            });
        }

        let displayedCandidates: unknown;
        const assertion = await executePasskeyOperation({
            request: {
                operation: "get",
                options: serializedOptions({
                    challenge: new Uint8Array([7, 7, 7]),
                    rpId: "login.example.test",
                }),
            },
            origin,
            repository,
            userVerified: true,
            rpIdSuffixValidator,
            selectCredential(candidates) {
                displayedCandidates = candidates;
                return "3";
            },
        });

        expect(displayedCandidates).to.deep.equal([
            { selectionId: "0", userName: "first@example.test", userDisplayName: "first@example.test" },
            { selectionId: "1", userName: "second@example.test", userDisplayName: "second@example.test" },
            { selectionId: "2", userName: "third@example.test", userDisplayName: "third@example.test" },
            { selectionId: "3", userName: "fourth@example.test", userDisplayName: "fourth@example.test" },
            { selectionId: "4", userName: "fifth@example.test", userDisplayName: "fifth@example.test" },
        ]);
        expect(JSON.stringify(displayedCandidates)).not.to.contain("privateKey");
        expect(JSON.stringify(displayedCandidates)).not.to.contain("credentialId");
        expect(assertion.id).to.equal(bytesToBase64(repository.credentials[3].credentialId));
    });

    test("does not mutate a credential when selection is cancelled or invalid", async () => {
        const repository = new MemoryRepository();
        for (const id of [1, 2]) {
            await executePasskeyOperation({
                request: {
                    operation: "create",
                    options: serializedOptions(
                        createOptions({
                            user: {
                                id: new Uint8Array([id]),
                                name: `person-${id}@example.test`,
                                displayName: `Person ${id}`,
                            },
                        })
                    ),
                },
                origin,
                repository,
                userVerified: true,
                rpIdSuffixValidator,
            });
        }

        for (const selection of [undefined, "missing"] as const) {
            let error: unknown;
            try {
                await executePasskeyOperation({
                    request: {
                        operation: "get",
                        options: serializedOptions({
                            challenge: new Uint8Array([7, 7, 7]),
                            rpId: "login.example.test",
                        }),
                    },
                    origin,
                    repository,
                    userVerified: true,
                    rpIdSuffixValidator,
                    selectCredential: () => selection,
                });
            } catch (caught) {
                error = caught;
            }
            expectProviderError(error, "NotAllowedError");
        }

        expect(repository.updated).to.have.length(0);
        expect(repository.credentials.map((credential) => credential.counter)).to.deep.equal([0, 0]);
    });

    test("fails closed when the selected credential is deleted before counter persistence", async () => {
        const repository = new MemoryRepository();
        for (const id of [1, 2]) {
            await executePasskeyOperation({
                request: {
                    operation: "create",
                    options: serializedOptions(
                        createOptions({
                            user: {
                                id: new Uint8Array([id]),
                                name: `person-${id}@example.test`,
                                displayName: `Person ${id}`,
                            },
                        })
                    ),
                },
                origin,
                repository,
                userVerified: true,
                rpIdSuffixValidator,
            });
        }

        let error: unknown;
        try {
            await executePasskeyOperation({
                request: {
                    operation: "get",
                    options: serializedOptions({
                        challenge: new Uint8Array([8, 8, 8]),
                        rpId: "login.example.test",
                    }),
                },
                origin,
                repository,
                userVerified: true,
                rpIdSuffixValidator,
                selectCredential() {
                    repository.credentials = [];
                    return "1";
                },
            });
        } catch (caught) {
            error = caught;
        }

        expect(error).to.be.instanceOf(Error);
        expect((error as Error).message).to.equal("missing credential");
        expect(repository.updated).to.have.length(0);
    });

    test("rolls back registration and assertion mutations when the ceremony expires during persistence", async () => {
        const registrationRepository = new MemoryRepository();
        let registrationCheck = 0;
        let registrationError: unknown;
        try {
            await executePasskeyOperation({
                request: { operation: "create", options: serializedOptions(createOptions()) },
                origin,
                repository: registrationRepository,
                userVerified: true,
                rpIdSuffixValidator,
                assertActive() {
                    registrationCheck += 1;
                    if (registrationCheck >= 3) throw new PasskeyProviderError("NotAllowedError", "expired");
                },
            });
        } catch (caught) {
            registrationError = caught;
        }
        expectProviderError(registrationError, "NotAllowedError");
        expect(registrationRepository.credentials).to.have.length(0);

        const assertionRepository = new MemoryRepository();
        await executePasskeyOperation({
            request: { operation: "create", options: serializedOptions(createOptions()) },
            origin,
            repository: assertionRepository,
            userVerified: true,
            rpIdSuffixValidator,
        });
        let assertionCheck = 0;
        let assertionError: unknown;
        try {
            await executePasskeyOperation({
                request: {
                    operation: "get",
                    options: serializedOptions({
                        challenge: new Uint8Array([9, 9, 9]),
                        rpId: "login.example.test",
                    }),
                },
                origin,
                repository: assertionRepository,
                userVerified: true,
                rpIdSuffixValidator,
                assertActive() {
                    assertionCheck += 1;
                    if (assertionCheck >= 3) throw new PasskeyProviderError("NotAllowedError", "expired");
                },
            });
        } catch (caught) {
            assertionError = caught;
        }
        expectProviderError(assertionError, "NotAllowedError");
        expect(assertionRepository.credentials).to.have.length(1);
        expect(assertionRepository.credentials[0].counter).to.equal(0);
        expect(assertionRepository.credentials[0].lastUsed).to.equal(undefined);
    });

    test("restores assertion metadata when a repository mutates locally and then rejects", async () => {
        class MutatingRejectRepository extends MemoryRepository {
            rejectNextUpdate = true;

            async updateCredential(credential: PasskeyCredential) {
                await super.updateCredential(credential);
                if (this.rejectNextUpdate) {
                    this.rejectNextUpdate = false;
                    throw new Error("strict sync failed after local mutation");
                }
            }
        }

        const repository = new MutatingRejectRepository();
        await executePasskeyOperation({
            request: { operation: "create", options: serializedOptions(createOptions()) },
            origin,
            repository,
            userVerified: true,
            rpIdSuffixValidator,
        });

        let error: unknown;
        try {
            await executePasskeyOperation({
                request: {
                    operation: "get",
                    options: serializedOptions({
                        challenge: new Uint8Array([10, 10, 10]),
                        rpId: "login.example.test",
                    }),
                },
                origin,
                repository,
                userVerified: true,
                rpIdSuffixValidator,
            });
        } catch (caught) {
            error = caught;
        }

        expect(error).to.be.instanceOf(Error);
        expect((error as Error).message).to.equal("strict sync failed after local mutation");
        expect(repository.credentials).to.have.length(1);
        expect(repository.credentials[0].counter).to.equal(0);
        expect(repository.credentials[0].lastUsed).to.equal(undefined);
        expect(repository.updated).to.have.length(2);
    });

    test("requires a trusted verification result when the RP requires user verification", async () => {
        const repository = new MemoryRepository();
        let error: unknown;
        try {
            await executePasskeyOperation({
                request: { operation: "create", options: serializedOptions(createOptions()) },
                origin,
                repository,
                userVerified: false,
                rpIdSuffixValidator,
            });
        } catch (caught) {
            error = caught;
        }
        expectProviderError(error, "NotAllowedError");
        expect(repository.created).to.have.length(0);
    });
});
