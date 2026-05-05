export interface Env {
    DB?: D1Database;
    ATTACHMENTS?: R2Bucket;
    HINTS?: KVNamespace;
    ACCOUNT_LOCK?: DurableObjectNamespace;
    ALLOW_ORIGIN?: string;
    VERSION?: string;
    RESEND_API_KEY?: string;
}
