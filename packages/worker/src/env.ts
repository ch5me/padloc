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
}
