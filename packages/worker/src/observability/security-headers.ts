/**
 * Security headers and CORS policy for Padloc Worker.
 *
 * Implements:
 * - Strict CORS restrictions (configurable allowlist)
 * - Security headers (HSTS, CSP, etc.)
 * - Request ID tracking for audit trails
 */

/**
 * CORS configuration.
 */
export interface CorsConfig {
    allowOrigin: string;
    allowedOrigins?: string[];
    requestOrigin?: string | null;
    allowMethods?: string[];
    allowHeaders?: string[];
    maxAge?: number; // Preflight cache duration in seconds
}

/**
 * Security headers configuration.
 */
export interface SecurityHeadersConfig {
    hstsMaxAge?: number; // HSTS max-age in seconds (default: 1 year)
    includeSubDomains?: boolean;
    preload?: boolean;
    cspDirectives?: Record<string, string[]>;
}

/**
 * Default CORS configuration.
 * In production, ALLOW_ORIGIN should be set to a specific domain.
 */
export const DEFAULT_CORS: CorsConfig = {
    allowOrigin: "*",
    allowMethods: ["OPTIONS", "POST"],
    allowHeaders: ["Content-Type"],
    maxAge: 86400, // 24 hours
};

/**
 * Parse the comma-separated origin form used by Worker environment values.
 */
export function parseAllowedOrigins(value?: string | string[]): string[] {
    if (Array.isArray(value)) {
        return value.map((origin) => origin.trim()).filter(Boolean);
    }
    return (value || "")
        .split(",")
        .map((origin) => origin.trim())
        .filter(Boolean);
}

function requestedAllowOrigin(config: CorsConfig): string | undefined {
    const allowedOrigins = parseAllowedOrigins(config.allowedOrigins ?? config.allowOrigin);
    const requestOrigin = config.requestOrigin?.trim() || null;

    if (allowedOrigins.includes("*")) {
        return "*";
    }
    if (requestOrigin !== null) {
        return allowedOrigins.includes(requestOrigin) ? requestOrigin : undefined;
    }
    return allowedOrigins.length === 1 ? allowedOrigins[0] : undefined;
}

/**
 * Default security headers.
 * These are conservative defaults suitable for a password manager.
 */
export const DEFAULT_SECURITY_HEADERS: Record<string, string> = {
    // Prevent MIME type sniffing
    "X-Content-Type-Options": "nosniff",

    // Prevent clickjacking
    "X-Frame-Options": "DENY",

    // XSS protection (legacy but still useful for older browsers)
    "X-XSS-Protection": "1; mode=block",

    // Referrer policy for privacy
    "Referrer-Policy": "strict-origin-when-cross-origin",

    // Permissions policy (restrict features)
    "Permissions-Policy": "geolocation=(), microphone=(), camera=(), payment=()",

    // Content Security Policy
    // Note: CSP should be tuned to the specific deployment
    "Content-Security-Policy": [
        "default-src 'self'",
        "script-src 'self'",
        "style-src 'self' 'unsafe-inline'", // 'unsafe-inline' needed for some CSS-in-JS
        "img-src 'self' data:",
        "connect-src 'self'",
        "frame-ancestors 'none'",
        "base-uri 'self'",
        "form-action 'self'",
    ].join("; "),

    // Strict Transport Security (only over HTTPS)
    // Note: Workers always use HTTPS, but this header signals to browsers
    "Strict-Transport-Security": "max-age=31536000; includeSubDomains",

    // Cache control for sensitive content
    "Cache-Control": "no-store, no-cache, must-revalidate, private",
    Pragma: "no-cache",
};

/**
 * Generate CORS headers.
 */
export function corsHeaders(config: CorsConfig): Record<string, string> {
    const headers: Record<string, string> = {
        "Access-Control-Allow-Methods": (config.allowMethods ?? DEFAULT_CORS.allowMethods!).join(", "),
        "Access-Control-Allow-Headers": (config.allowHeaders ?? DEFAULT_CORS.allowHeaders!).join(", "),
        Vary: "Origin",
    };

    const allowOrigin = requestedAllowOrigin(config);
    if (allowOrigin !== undefined) {
        headers["Access-Control-Allow-Origin"] = allowOrigin;
    }

    if (config.maxAge !== undefined) {
        headers["Access-Control-Max-Age"] = String(config.maxAge);
    }

    return headers;
}

/**
 * Generate security headers.
 */
export function securityHeaders(config?: SecurityHeadersConfig): Record<string, string> {
    const headers: Record<string, string> = { ...DEFAULT_SECURITY_HEADERS };

    // Override HSTS if custom config provided
    if (config?.hstsMaxAge !== undefined) {
        const directives = [`max-age=${config.hstsMaxAge}`];
        if (config.includeSubDomains) directives.push("includeSubDomains");
        if (config.preload) directives.push("preload");
        headers["Strict-Transport-Security"] = directives.join("; ");
    }

    // Override CSP if custom directives provided
    if (config?.cspDirectives) {
        const cspParts: string[] = [];
        for (const [directive, values] of Object.entries(config.cspDirectives)) {
            cspParts.push(`${directive} ${values.join(" ")}`);
        }
        headers["Content-Security-Policy"] = cspParts.join("; ");
    }

    return headers;
}

/**
 * Combine all response headers.
 * Order: CORS → Security → Content-Type
 */
export function responseHeaders(
    corsConfig: CorsConfig,
    securityConfig?: SecurityHeadersConfig,
    extraHeaders?: Record<string, string>
): Record<string, string> {
    return {
        ...corsHeaders(corsConfig),
        ...securityHeaders(securityConfig),
        ...extraHeaders,
    };
}

/**
 * Generate a unique request ID.
 * Format: timestamp-random (no UUID dependency)
 */
export function generateRequestId(): string {
    return `${Date.now()}-${Math.random().toString(36).substring(2, 11)}`;
}
