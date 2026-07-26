export interface Env {
    DB?: D1Database;
    ATTACHMENTS?: R2Bucket;
    HINTS?: KVNamespace;
    ACCOUNT_LOCK?: DurableObjectNamespace;
    ALLOW_ORIGIN?: string;
    CLIENT_URL?: string;
    VERSION?: string;
    RESEND_API_KEY?: string;
    EMAIL_BACKEND?: string;
    EMAIL_KV?: KVNamespace;
    EMAIL_FROM_ADDRESS?: string;
    EMAIL_VERIFY_ON_SIGNUP?: string;
    RATE_LIMIT_MAX_REQUESTS?: string;
    RATE_LIMIT_WINDOW_MS?: string;
    HQ_SENTRY_DSN?: string;
    HQ_OTLP_ENDPOINT?: string;
    HQ_ENVIRONMENT?: string;
    HQ_RELEASE?: string;
    HQ_SERVICE_NAME?: string;
    HQ_ALLOW_LOCAL_ENDPOINTS?: string;
    /** Firefly SSO verification — see src/firefly-sso.ts. All three required to enable the route. */
    FIREFLY_JWKS_URL?: string;
    FIREFLY_ISSUER?: string;
    FIREFLY_AUDIENCE?: string;
    /** Firefly seat-sync admin route — see src/firefly-seat-sync.ts. G020. */
    FIREFLY_SEAT_SYNC_SECRET?: string;
}
