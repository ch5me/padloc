import { BiometricVerificationResult } from "./auth/biometric";

export type PasskeyUserVerificationResult = "verified" | "password-required" | "cancelled";

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
