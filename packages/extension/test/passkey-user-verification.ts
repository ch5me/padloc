import { expect } from "chai";
import { verifyPasskeyUserPresence } from "../src/passkey-user-verification";

suite("Passkey user verification", () => {
    test("accepts a recent password verification without invoking biometric auth", async () => {
        let biometricCalls = 0;
        let passwordCalls = 0;
        const result = await verifyPasskeyUserPresence({
            recentlyVerified: true,
            async verifyBiometric() {
                biometricCalls++;
                return "unavailable";
            },
            async requirePassword() {
                passwordCalls++;
            },
        });

        expect(result).to.equal("verified");
        expect(biometricCalls).to.equal(0);
        expect(passwordCalls).to.equal(0);
    });

    test("routes an old unlocked password-only session through password re-verification", async () => {
        let passwordCalls = 0;
        const firstAttempt = await verifyPasskeyUserPresence({
            recentlyVerified: false,
            async verifyBiometric() {
                return "unavailable";
            },
            async requirePassword() {
                passwordCalls++;
            },
        });
        const afterPasswordUnlock = await verifyPasskeyUserPresence({
            recentlyVerified: true,
            async verifyBiometric() {
                throw new Error("biometric verification should not run after password unlock");
            },
            async requirePassword() {
                throw new Error("password verification should already be fresh");
            },
        });

        expect(firstAttempt).to.equal("password-required");
        expect(passwordCalls).to.equal(1);
        expect(afterPasswordUnlock).to.equal("verified");
    });

    test("keeps the approval pending when biometric verification is cancelled", async () => {
        let passwordCalls = 0;
        const result = await verifyPasskeyUserPresence({
            recentlyVerified: false,
            async verifyBiometric() {
                return "cancelled";
            },
            async requirePassword() {
                passwordCalls++;
            },
        });

        expect(result).to.equal("cancelled");
        expect(passwordCalls).to.equal(0);
    });
});
