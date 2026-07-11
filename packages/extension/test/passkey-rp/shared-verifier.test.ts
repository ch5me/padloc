import { expect } from "chai";
import { PasskeyCounterPolicy } from "@padloc/core/src/passkey";
import {
    buildPasskeyAssertionResponse,
    buildPasskeyRegistrationResponse,
    generatePasskeyCredential,
} from "@padloc/core/src/webauthn-authenticator";
import { verifyAssertion, verifyRegistration } from "./shared-verifier";
import { ChallengeStore } from "./challenge-store";

suite("shared passkey RP verifier", () => {
    test("issues random single-use expiring challenges", () => {
        let now = 1_000;
        const store = new ChallengeStore(10, () => now);
        const first = store.issue("registration");
        const second = store.issue("registration");
        expect(Buffer.from(first.challenge).equals(Buffer.from(second.challenge))).to.equal(false);
        expect(store.consume(first.id, "registration")).to.equal(first);
        expect(() => store.consume(first.id, "registration")).to.throw("replayed");
        expect(() => store.consume(store.issue("assertion").id, "registration")).to.throw("type mismatch");
        const stale = store.issue("registration"); now = stale.expiresAt;
        expect(() => store.consume(stale.id, "registration")).to.throw("expired");
    });
    test("accepts extension registration/assertion and rejects challenge, RP, signature, counter, and UV faults", async () => {
        const rpID = "localhost";
        const origin = "http://localhost";
        const challenge = new Uint8Array([1, 2, 3, 4, 5]);
        const credential = await generatePasskeyCredential({
            rpId: rpID,
            rpName: "CH5 RP Contract",
            userHandle: new Uint8Array([6, 7, 8]),
            userName: "contract-user",
            userDisplayName: "Contract User",
            backupEligible: true,
            backupState: true,
            counterPolicy: PasskeyCounterPolicy.None,
        });
        const registration = await buildPasskeyRegistrationResponse(credential, {
            challenge, origin, rpId: rpID, userVerified: true,
        });
        const stored = verifyRegistration({
            clientDataJSON: registration.clientDataJSON,
            attestationObject: registration.attestationObject,
            credentialID: registration.rawId,
            expectedChallenge: challenge,
            expectedOrigin: origin,
            expectedRpID: rpID,
            requireUV: true,
            requireBackupEligible: true,
            requireBackupState: true,
        });
        const assertion = await buildPasskeyAssertionResponse(credential, {
            challenge, origin, rpId: rpID, userVerified: true,
        });
        expect(verifyAssertion({
            clientDataJSON: assertion.clientDataJSON,
            authenticatorData: assertion.authenticatorData,
            signature: assertion.signature,
            credentialID: assertion.rawId,
            expectedCredentialID: registration.rawId,
            publicKeyJwk: stored.publicKeyJwk,
            expectedChallenge: challenge,
            expectedOrigin: origin,
            expectedRpID: rpID,
            requireUV: true,
            requireBackupEligible: true,
            requireBackupState: true,
        })).to.include({ counter: 0 });

        const wrong = (overrides: Record<string, unknown>) => () => verifyAssertion({
            clientDataJSON: assertion.clientDataJSON,
            authenticatorData: assertion.authenticatorData,
            signature: assertion.signature,
            credentialID: assertion.rawId,
            expectedCredentialID: registration.rawId,
            publicKeyJwk: stored.publicKeyJwk,
            expectedChallenge: challenge,
            expectedOrigin: origin,
            expectedRpID: rpID,
            requireUV: true,
            requireBackupEligible: true,
            requireBackupState: true,
            ...overrides,
        } as any);
        expect(wrong({ expectedChallenge: new Uint8Array([9]) })).to.throw("challenge mismatch");
        expect(wrong({ expectedRpID: "wrong.invalid" })).to.throw("RP ID hash mismatch");
        const badSignature = assertion.signature.slice(); badSignature[badSignature.length - 1] ^= 1;
        expect(wrong({ signature: badSignature })).to.throw("invalid assertion signature");
        const badCounter = assertion.authenticatorData.slice(); badCounter[36] = 1;
        expect(wrong({ authenticatorData: badCounter })).to.throw("counter must be zero");
        const noUV = assertion.authenticatorData.slice(); noUV[32] &= ~0x04;
        expect(wrong({ authenticatorData: noUV })).to.throw("user verification missing");
        const noBackup = assertion.authenticatorData.slice(); noBackup[32] &= ~0x18;
        expect(wrong({ authenticatorData: noBackup })).to.throw("backup eligibility missing");
        const reserved = assertion.authenticatorData.slice(); reserved[32] |= 0x02;
        expect(wrong({ authenticatorData: reserved })).to.throw("reserved authenticator flags set");
        const attested = assertion.authenticatorData.slice(); attested[32] |= 0x40;
        expect(wrong({ authenticatorData: attested })).to.throw("assertion contains attested or extension data");
        const extended = assertion.authenticatorData.slice(); extended[32] |= 0x80;
        expect(wrong({ authenticatorData: extended })).to.throw("assertion contains attested or extension data");
        const trailing = new Uint8Array(assertion.authenticatorData.length + 1);
        trailing.set(assertion.authenticatorData);
        expect(wrong({ authenticatorData: trailing })).to.throw("must be exactly 37 bytes");
    });
});
