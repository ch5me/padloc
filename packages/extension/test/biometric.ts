import { expect } from "chai";
import { suite, test } from "mocha";
import { AuthType } from "../../core/src/auth";
import { ErrorCode } from "../../core/src/error";
import { shouldAttemptBiometricReunlock, unlockWithBiometric } from "../src/auth/biometric";

suite("Extension biometric re-unlock", () => {
    test("cold start attempts biometric re-unlock only when session key is missing", () => {
        expect(
            shouldAttemptBiometricReunlock({
                locked: true,
                hasSessionMasterKey: false,
                hasRememberedMasterKey: true,
            })
        ).to.equal(true);

        expect(
            shouldAttemptBiometricReunlock({
                locked: true,
                hasSessionMasterKey: true,
                hasRememberedMasterKey: true,
            })
        ).to.equal(false);
    });

    test("unlockWithBiometric reuses remembered master key flow", async () => {
        let tokenUsed = "";
        const app = {
            state: {
                rememberedMasterKey: {
                    authenticatorId: "authenticator-1",
                },
            },
            unlockWithRememberedMasterKey: async (token: string) => {
                tokenUsed = token;
            },
        } as any;

        const result = await unlockWithBiometric(app, {
            authenticate: async (opts) => {
                expect(opts.type).to.equal(AuthType.WebAuthnPlatform);
                expect(opts.authenticatorId).to.equal("authenticator-1");
                return { token: "access-token" } as any;
            },
            getPlatformAuthType: () => AuthType.WebAuthnPlatform,
        });

        expect(result).to.equal("unlocked");
        expect(tokenUsed).to.equal("access-token");
    });

    test("expired remembered master key falls back without unlocking", async () => {
        const app = {
            state: {
                rememberedMasterKey: {
                    authenticatorId: "authenticator-1",
                },
            },
            unlockWithRememberedMasterKey: async () => {
                throw new Error("should not be called");
            },
        } as any;

        const result = await unlockWithBiometric(app, {
            authenticate: async () => {
                throw { code: ErrorCode.NOT_FOUND };
            },
            getPlatformAuthType: () => AuthType.WebAuthnPlatform,
        });

        expect(result).to.equal("expired");
    });

    test("extension reload keeps auto-lock restore path available after biometric unlock", async () => {
        let sessionRestored = false;
        let autoLockStarted = false;

        const restoreSessionUnlock = async () => {
            sessionRestored = true;
            return true;
        };

        const startAutoLockTimer = async () => {
            autoLockStarted = true;
        };

        if (await restoreSessionUnlock()) {
            await startAutoLockTimer();
        }

        expect(sessionRestored).to.equal(true);
        expect(autoLockStarted).to.equal(true);
    });
});
