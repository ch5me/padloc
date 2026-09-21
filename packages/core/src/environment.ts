/** HQ / Node environments that must never mock mail, storage, or MFA bypass. */
export const LIVE_ENVIRONMENTS = ["staging", "production", "preview"] as const;

export type LiveEnvironment = (typeof LIVE_ENVIRONMENTS)[number];

export function isLiveEnvironment(environment?: string | null): boolean {
    const value = (environment || "").trim().toLowerCase();
    return value === "staging" || value === "production" || value === "preview";
}

type ProcessStageEnv = {
    HQ_ENVIRONMENT?: string | null;
    NODE_ENV?: string | null;
};

function readProcessStage(
    env: ProcessStageEnv | undefined,
    key: "HQ_ENVIRONMENT" | "NODE_ENV"
): string | null | undefined {
    if (env) return env[key];
    const value = process.env[key];
    return typeof value === "string" ? value : undefined;
}

/** Live if either the HQ stage or NODE_ENV names a live environment. */
export function isLiveProcessEnvironment(env?: ProcessStageEnv): boolean {
    return (
        isLiveEnvironment(readProcessStage(env, "HQ_ENVIRONMENT")) ||
        isLiveEnvironment(readProcessStage(env, "NODE_ENV"))
    );
}
