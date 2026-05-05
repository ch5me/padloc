/**
 * Log redaction for sensitive fields.
 *
 * Implements structured field-level redaction for a password manager:
 * - Passwords, verifiers, auth proofs (SRP/M1/M2/K)
 * - Vault data (encrypted or plaintext)
 * - Private keys, signing keys, HMAC keys
 * - Session keys
 *
 * Design principles:
 * - Redacts at the field level, preserving structure for debugging
 * - Uses [REDACTED] sentinel for redacted values
 * - Recursive traversal of objects/arrays
 * - Safe to call on any data, including null/undefined
 */

const SENSITIVE_FIELD_PATTERNS = [
    // Core secret material
    /^password$/i,
    /^passphrase$/i,
    /^masterpassword$/i,
    /^secret$/i,

    // Auth/Crypto material
    /^verifier$/i,
    /^srp[xy]?$/i,
    /^srp[a-z]*$/i,
    /^x$/i, // SRP x value (derived from password)
    /^a$/i, // SRP client public
    /^b$/i, // SRP server public
    /^A$/i, // SRP client public
    /^B$/i, // SRP server public
    /^K$/i, // SRP session key
    /^M[12]?$/i, // SRP proofs
    /^salt$/i,

    // Keys
    /^private[key]?$/i,
    /^public[key]?$/i,
    /^signing[key]?$/i,
    /^hmac[key]?$/i,
    /^encryption[key]?$/i,
    /^session[key]?$/i,
    /^key$/i,
    /^aes[key]?$/i,
    /^rsa[key]?$/i,
    /^iv$/i, // Initialization vector
    /^nonce$/i,

    // Vault data
    /^vault[data]?$/i,
    /^vault$/i,
    /^encrypted[data]?$/i,
    /^ciphertext$/i,
    /^encrypted$/i,

    // Auth proofs
    /^auth[_-]?proof$/i,
    /^auth$/i,
    /^authrequest$/i,
    /^session$/i,
    /^srpsession$/i,

    // Attachments
    /^attachment[data]?$/i,
    /^file[data]?$/i,
];

/**
 * Check if a field name matches sensitive patterns.
 */
export function isSensitiveField(fieldName: string): boolean {
    return SENSITIVE_FIELD_PATTERNS.some((pattern) => pattern.test(fieldName));
}

/**
 * Deep clone with redaction of sensitive fields.
 * Returns a new object with sensitive fields replaced by [REDACTED].
 */
export function redact<T>(data: T, options?: { depth?: number; currentDepth?: number }): T {
    const depth = options?.depth ?? Infinity;
    const currentDepth = options?.currentDepth ?? 0;

    if (currentDepth >= depth) {
        return Array.isArray(data) ? ([...data] as T) : (data as T);
    }

    if (data === null || data === undefined) {
        return data;
    }

    if (typeof data === "string") {
        return data;
    }

    if (typeof data === "number" || typeof data === "boolean") {
        return data;
    }

    if (Array.isArray(data)) {
        return data.map((item) => redact(item, { depth, currentDepth: currentDepth + 1 })) as T;
    }

    if (typeof data === "object") {
        const redacted: Record<string, unknown> = {};
        for (const [key, value] of Object.entries(data)) {
            if (isSensitiveField(key)) {
                redacted[key] = "[REDACTED]";
            } else if (typeof value === "object" && value !== null) {
                redacted[key] = redact(value, { depth, currentDepth: currentDepth + 1 });
            } else {
                redacted[key] = value;
            }
        }
        return redacted as T;
    }

    return data;
}

/**
 * Redaction sentinel value.
 */
export const REDACTED = "[REDACTED]";

/**
 * Create a structured log entry with automatic redaction.
 *
 * Usage:
 *   structuredLog("request_received", { method, url, body: redact(body) })
 *   structuredLog("auth_failure", { email: "user@example.com", reason: "invalid_credentials" })
 *
 * Sensitive fields (passwords, keys, vault data) are automatically redacted.
 */
export function structuredLog(
    type: string,
    data: Record<string, unknown>,
    context?: {
        requestId?: string;
        accountId?: string;
        sessionId?: string;
        ipAddress?: string;
    },
): { type: string; data: Record<string, unknown>; context?: typeof context; timestamp: string } {
    return {
        type,
        data: redact(data),
        context: context
            ? {
                  requestId: context.requestId,
                  accountId: context.accountId,
                  sessionId: context.sessionId,
                  ipAddress: context.ipAddress,
              }
            : undefined,
        timestamp: new Date().toISOString(),
    };
}

/**
 * Redact a request body for logging.
 * Preserves method, params, and non-sensitive fields.
 */
export function redactRequest<T extends Record<string, unknown>>(request: T): T {
    return redact(request);
}

/**
 * Redact an error for logging while preserving structure.
 */
export function redactError(error: Error): Record<string, unknown> {
    return {
        name: error.name,
        message: "[REDACTED]", // Never log error messages that may contain sensitive input
        stack: typeof process !== "undefined" && process.env?.NODE_ENV === "development" ? error.stack : undefined,
    };
}
