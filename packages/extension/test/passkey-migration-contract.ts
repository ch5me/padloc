import { expect } from "chai";
import { readFileSync } from "fs";
import { resolve } from "path";
import { PasskeyCredential, PasskeyCeremonyBinding } from "@padloc/core/src/passkey";
import {
    executePasskeyOperation,
    PasskeyCredentialRepository,
    PasskeyProviderError,
} from "../src/passkey-provider-engine";
import {
    bindPasskeyRequest,
    consumePasskeyRequestBinding,
    passkeyRequestBindingCeremony,
} from "../src/passkey-request-binding";
import { serializeWebAuthnValue } from "../src/passkey-protocol";

const ORIGIN = "https://synthetic.ch5.me";
const RP_ID = "synthetic.ch5.me";

class MemoryPasskeyRepository implements PasskeyCredentialRepository {
    credentials: PasskeyCredential[] = [];

    async listCredentials(rpId: string) {
        return this.credentials.filter((credential) => credential.rpId === rpId);
    }

    async createCredential(credential: PasskeyCredential) {
        this.credentials.push(credential);
    }

    async updateCredential(credential: PasskeyCredential) {
        const index = this.credentials.findIndex(
            (candidate) =>
                candidate.rpId === credential.rpId &&
                candidate.credentialId.toString() === credential.credentialId.toString()
        );
        if (index < 0) throw new Error("credential not found");
        this.credentials[index] = credential;
    }

    async deleteCredential(credential: PasskeyCredential) {
        const index = this.credentials.indexOf(credential);
        if (index >= 0) this.credentials.splice(index, 1);
    }
}

function ceremony(now: number, overrides: Partial<PasskeyCeremonyBinding> = {}): PasskeyCeremonyBinding {
    return {
        flowId: "synthetic-flow-1",
        nonce: "synthetic-nonce-1",
        ttlMs: 30_000,
        expiresAt: now + 30_000,
        topOrigin: ORIGIN,
        rpId: RP_ID,
        target: {
            tabId: 7,
            frameId: 0,
            origin: ORIGIN,
            topOrigin: ORIGIN,
            documentId: "synthetic-document-1",
        },
        userVerification: { verifiedAt: now, expiresAt: now + 60_000 },
        ...overrides,
    };
}

function createOptions(challenge: number[], account: string) {
    return serializeWebAuthnValue({
        challenge: new Uint8Array(challenge),
        rp: { id: RP_ID, name: "Synthetic RP" },
        user: {
            id: new Uint8Array([1, 2, 3, 4]),
            name: account,
            displayName: "Synthetic Account",
        },
        pubKeyCredParams: [{ type: "public-key", alg: -7 }],
        authenticatorSelection: { residentKey: "required", userVerification: "required" },
    }) as Record<string, unknown>;
}

function expectProviderError(error: unknown, name: string): void {
    expect(error).to.be.instanceOf(PasskeyProviderError);
    expect((error as Error).name).to.equal(name);
}

suite("Passkey migration contract", () => {
    test("re-enrolls a new synthetic-RP credential without touching an existing credential", async () => {
        const repository = new MemoryPasskeyRepository();
        const now = Date.parse("2026-09-18T20:00:00.000Z");
        const first = await executePasskeyOperation({
            request: { operation: "create", options: createOptions([1, 2, 3], "existing@synthetic.test") },
            origin: ORIGIN,
            repository,
            userVerified: true,
            ceremony: ceremony(now),
            requireCeremonyBinding: true,
            rpIdSuffixValidator: (rpId, host) => rpId === RP_ID && host === ORIGIN.slice(8),
            now: () => new Date(now),
        });
        const existing = repository.credentials[0];
        const existingSnapshot = JSON.stringify(existing);

        await executePasskeyOperation({
            request: { operation: "create", options: createOptions([4, 5, 6], "reenrolled@synthetic.test") },
            origin: ORIGIN,
            repository,
            userVerified: true,
            ceremony: ceremony(now, { flowId: "synthetic-flow-2", nonce: "synthetic-nonce-2" }),
            requireCeremonyBinding: true,
            rpIdSuffixValidator: (rpId, host) => rpId === RP_ID && host === ORIGIN.slice(8),
            now: () => new Date(now),
        });

        expect(first.id).to.be.a("string");
        expect(repository.credentials).to.have.length(2);
        expect(JSON.stringify(repository.credentials[0])).to.equal(existingSnapshot);
        expect(repository.credentials[1].userName).to.equal("reenrolled@synthetic.test");
        expect(repository.credentials[1].rpId).to.equal(RP_ID);
    });

    test("requires the complete bound assertion contract and recent verification", async () => {
        const repository = new MemoryPasskeyRepository();
        const now = Date.parse("2026-09-18T20:00:00.000Z");
        const created = await executePasskeyOperation({
            request: { operation: "create", options: createOptions([7, 8, 9], "assert@synthetic.test") },
            origin: ORIGIN,
            repository,
            userVerified: true,
            ceremony: ceremony(now),
            requireCeremonyBinding: true,
            rpIdSuffixValidator: (rpId, host) => rpId === RP_ID && host === ORIGIN.slice(8),
            now: () => new Date(now),
        });
        const credential = repository.credentials[0];
        const assertionOptions = serializeWebAuthnValue({
            challenge: new Uint8Array([9, 8, 7]),
            rpId: RP_ID,
            allowCredentials: [{ type: "public-key", id: credential.credentialId }],
            userVerification: "required",
        }) as Record<string, unknown>;
        const run = (binding: PasskeyCeremonyBinding, userVerified = true) =>
            executePasskeyOperation({
                request: { operation: "get", options: assertionOptions },
                origin: ORIGIN,
                repository,
                userVerified,
                ceremony: binding,
                requireCeremonyBinding: true,
                rpIdSuffixValidator: (rpId, host) => rpId === RP_ID && host === ORIGIN.slice(8),
                now: () => new Date(now),
            });

        expect(created.id).to.be.a("string");
        for (const binding of [
            ceremony(now, { topOrigin: "https://evil.example" }),
            ceremony(now, { rpId: "evil.ch5.me" }),
            ceremony(now, { expiresAt: now - 1 }),
            ceremony(now, { nonce: "" }),
            ceremony(now, { userVerification: { verifiedAt: now - 120_000, expiresAt: now - 60_000 } }),
        ]) {
            let error: unknown;
            try {
                await run(binding);
            } catch (caught) {
                error = caught;
            }
            expect(error).to.be.instanceOf(PasskeyProviderError);
        }

        let verificationError: unknown;
        try {
            await run(ceremony(now), false);
        } catch (caught) {
            verificationError = caught;
        }
        expectProviderError(verificationError, "NotAllowedError");
    });

    test("binds and consumes a one-time request nonce to the exact synthetic target", () => {
        const now = Date.parse("2026-09-18T20:00:00.000Z");
        const binding = bindPasskeyRequest(
            ORIGIN,
            {
                url: `${ORIGIN}/login`,
                frameId: 0,
                documentId: "synthetic-document-1",
                tab: { id: 7 },
            },
            {
                flowId: "synthetic-flow",
                nonce: "synthetic-nonce",
                ttlMs: 30_000,
                topOrigin: ORIGIN,
                rpId: RP_ID,
                target: {
                    frameId: 0,
                    origin: ORIGIN,
                    topOrigin: ORIGIN,
                    documentId: "synthetic-document-1",
                },
            },
            now
        );
        expect(binding).to.not.equal(null);
        expect(passkeyRequestBindingCeremony(binding!)).to.include({ flowId: "synthetic-flow", rpId: RP_ID });
        expect(consumePasskeyRequestBinding(binding!, "wrong", now)).to.equal(false);
        expect(consumePasskeyRequestBinding(binding!, "synthetic-nonce", now)).to.equal(true);
        expect(consumePasskeyRequestBinding(binding!, "synthetic-nonce", now)).to.equal(false);
    });

    test("keeps 1PUX passkey data on the explicit loss-report path", () => {
        const importer = readFileSync(resolve(__dirname, "../../app/src/lib/import.ts"), "utf8");
        expect(importer).to.contain('lossCategoryToReason("passkey")');
        expect(importer).not.to.contain("new PasskeyCredential");
        expect(importer).not.to.contain("passkeyCredential:");
    });

    test("keeps the passkey background handoff separate from the autofill dispatch", () => {
        const background = readFileSync(resolve(__dirname, "../src/background.ts"), "utf8");
        for (const symbol of [
            "nativeRuntime.onConnect.addListener",
            "nativeRuntime.onMessage.addListener",
            "buildPasskeyFallback",
            "beginPasskeyRequest",
            "resolvePasskeyRequest",
            "requestPasskeyCredentialSelection",
            "assertPasskeyCeremonyActive",
            "createVaultPasskeyRepository",
        ]) {
            expect(background).to.contain(symbol);
        }
        expect(background.indexOf('case "agenticAutofillBroker"')).to.be.greaterThan(
            background.indexOf('case "getPasskeyApprovalPrompt"')
        );
        expect(background).to.contain("created = await application.createItem");
        expect(background).to.contain("passkeys: [credential]");
        expect(background).to.contain("name: `${credential.rpName || credential.rpId} Passkey`");
    });
});
