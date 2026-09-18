import { BiometricVerificationResult } from "./auth/biometric";
import {
    isFreshPasskeyUserVerification,
    PASSKEY_USER_VERIFICATION_MAX_AGE_MS,
    PasskeyUserVerificationGrant,
} from "@padloc/core/src/passkey";

export type PasskeyUserVerificationResult = "verified" | "password-required" | "cancelled";

export { PASSKEY_USER_VERIFICATION_MAX_AGE_MS };
export type { PasskeyUserVerificationGrant };

export function issuePasskeyUserVerification(
    verifiedAt = Date.now(),
    ttlMs = PASSKEY_USER_VERIFICATION_MAX_AGE_MS
): PasskeyUserVerificationGrant {
    if (!Number.isFinite(verifiedAt) || !Number.isFinite(ttlMs) || ttlMs <= 0) {
        throw new TypeError("Passkey verification timestamps are invalid");
    }
    return Object.freeze({ verifiedAt, expiresAt: verifiedAt + Math.min(ttlMs, PASSKEY_USER_VERIFICATION_MAX_AGE_MS) });
}

export function isRecentPasskeyVerification(
    grant: PasskeyUserVerificationGrant | undefined,
    now = Date.now()
): boolean {
    return !!grant && isFreshPasskeyUserVerification(grant, now);
}

export async function verifyPasskeyUserPresence(options: {
    recentlyVerified: boolean;
    verifyBiometric(): Promise<BiometricVerificationResult>;
    requirePassword(): Promise<void>;
}): Promise<PasskeyUserVerificationResult> {
    if (options.recentlyVerified) return "verified";

    const biometricResult = await options.verifyBiometric();
    if (biometricResult === "verified") return "verified";
    if (biometricResult === "cancelled") return "cancelled";

    await options.requirePassword();
    return "password-required";
}
