import { App } from "@padloc/core/src/app";
import { AuthPurpose } from "@padloc/core/src/auth";
import { ErrorCode } from "@padloc/core/src/error";
import { authenticate, getPlatformAuthType } from "@padloc/core/src/platform";

export type BiometricReunlockResult = "unavailable" | "unlocked" | "expired" | "cancelled" | "failed";

type BiometricDeps = {
    authenticate: typeof authenticate;
    getPlatformAuthType: typeof getPlatformAuthType;
};

export function shouldAttemptBiometricReunlock(opts: {
    locked: boolean;
    hasSessionMasterKey: boolean;
    hasRememberedMasterKey: boolean;
}) {
    return opts.locked && !opts.hasSessionMasterKey && opts.hasRememberedMasterKey;
}

function getErrorCode(error: unknown) {
    return typeof error === "object" && error && "code" in error
        ? (error as { code?: ErrorCode }).code
        : undefined;
}

export async function unlockWithBiometric(
    app: App,
    deps: BiometricDeps = { authenticate, getPlatformAuthType }
): Promise<BiometricReunlockResult> {
    const rememberedMasterKey = app.state.rememberedMasterKey;
    const type = deps.getPlatformAuthType();

    if (!rememberedMasterKey || !type) {
        return "unavailable";
    }

    try {
        const { token } = await deps.authenticate({
            purpose: AuthPurpose.AccessKeyStore,
            type,
            authenticatorId: rememberedMasterKey.authenticatorId,
        });
        await app.unlockWithRememberedMasterKey(token);
        return "unlocked";
    } catch (error) {
        switch (getErrorCode(error)) {
            case ErrorCode.NOT_FOUND:
                return "expired";
            case ErrorCode.AUTHENTICATION_FAILED:
                return "cancelled";
            default:
                return "failed";
        }
    }
}
