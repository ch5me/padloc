/** HQ / Node environments that must never mock mail, storage, or MFA bypass. */
export const LIVE_ENVIRONMENTS = ["staging", "production", "preview"] as const;

export type LiveEnvironment = (typeof LIVE_ENVIRONMENTS)[number];

export function isLiveEnvironment(environment?: string | null): boolean {
    const value = (environment || "").trim().toLowerCase();
    return value === "staging" || value === "production" || value === "preview";
}

/** Live if either the HQ stage or NODE_ENV names a live environment. */
export function isLiveProcessEnvironment(
    env: { HQ_ENVIRONMENT?: string | null; NODE_ENV?: string | null } = process.env
): boolean {
    return isLiveEnvironment(env.HQ_ENVIRONMENT) || isLiveEnvironment(env.NODE_ENV);
}
