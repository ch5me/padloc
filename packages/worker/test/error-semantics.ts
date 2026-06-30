import { sanitizeError, errorResponse } from "../src/error";
import { Err, ErrorCode } from "@padloc/core/src/error";
import { IdempotencyStore, hashRequestBody } from "../src/idempotency";
import { WorkerReceiver, WorkerReceiverConfig } from "../src/transport";
import { Request as PlRequest, Response as PlResponse } from "@padloc/core/src/transport";
import { marshal } from "@padloc/core/src/encoding";

interface ErrorResponseBody {
    error: {
        code: string;
        message: string;
        stack?: unknown;
    };
}

export interface ErrorSemanticsResult {
    name: string;
    ok: boolean;
    detail: string;
}

export interface ErrorSemanticsReport {
    ok: boolean;
    runtime: "node-js";
    generatedAt: string;
    summary: {
        total: number;
        passed: number;
        failed: number;
    };
    results: ErrorSemanticsResult[];
}

class InMemoryKV {
    private store = new Map<string, { value: string; expiration?: number }>();

    async get<T>(key: string, type?: "json"): Promise<T | null> {
        const entry = this.store.get(key);
        if (!entry) return null;
        if (entry.expiration && Date.now() > entry.expiration * 1000) {
            this.store.delete(key);
            return null;
        }
        if (type === "json") return JSON.parse(entry.value) as T;
        return entry.value as unknown as T;
    }

    async put(key: string, value: string, opts?: { expirationTtl?: number }): Promise<void> {
        const entry: { value: string; expiration?: number } = { value };
        if (opts?.expirationTtl) {
            entry.expiration = Math.floor(Date.now() / 1000) + opts.expirationTtl;
        }
        this.store.set(key, entry);
    }
}

function assertTrue(value: boolean, label: string) {
    if (!value) throw new Error(label);
}

function assertEqual<T>(actual: T, expected: T, label: string) {
    if (actual !== expected) throw new Error(`${label}: expected ${expected}, got ${actual}`);
}

async function runErrorTests(): Promise<ErrorSemanticsReport> {
    const results: ErrorSemanticsResult[] = [];

    // --- 1. sanitizeError: Known Err passes through ---
    try {
        const known = new Err(ErrorCode.INVALID_SESSION, "session gone");
        const sanitized = sanitizeError(known);
        assertEqual(sanitized, known, "Same Err instance returned");
        results.push({ name: "Known Err passes through", ok: true, detail: "passed" });
    } catch (e) {
        results.push({ name: "Known Err passes through", ok: false, detail: String(e) });
    }

    // --- 2. sanitizeError: SQLite UNIQUE → DUPLICATE_OPERATION ---
    try {
        const sqliteErr = new Error("UNIQUE constraint failed: accounts.email");
        const sanitized = sanitizeError(sqliteErr);
        assertEqual(sanitized.code, ErrorCode.DUPLICATE_OPERATION, "Mapped to DUPLICATE_OPERATION");
        assertEqual(sanitized.status, 409, "HTTP 409 for duplicate");
        assertTrue(
            !sanitized.message.includes("SQLITE") && !sanitized.message.includes("constraint failed:"),
            "No internal details leaked"
        );
        results.push({ name: "SQLite UNIQUE → DUPLICATE_OPERATION", ok: true, detail: "passed" });
    } catch (e) {
        results.push({ name: "SQLite UNIQUE → DUPLICATE_OPERATION", ok: false, detail: String(e) });
    }

    // --- 3. sanitizeError: SQLite FK → BAD_REQUEST ---
    try {
        const sqliteErr = new Error("FOREIGN KEY constraint failed");
        const sanitized = sanitizeError(sqliteErr);
        assertEqual(sanitized.code, ErrorCode.BAD_REQUEST, "Mapped to BAD_REQUEST");
        results.push({ name: "SQLite FK → BAD_REQUEST", ok: true, detail: "passed" });
    } catch (e) {
        results.push({ name: "SQLite FK → BAD_REQUEST", ok: false, detail: String(e) });
    }

    // --- 4. sanitizeError: Unknown Error → SERVER_ERROR (no leak) ---
    try {
        const unknownErr = new Error(
            "TypeError: Cannot read property 'foo' of undefined\n  at /worker/src/handler.ts:42"
        );
        const sanitized = sanitizeError(unknownErr);
        assertEqual(sanitized.code, ErrorCode.SERVER_ERROR, "Mapped to SERVER_ERROR");
        assertEqual(sanitized.status, 500, "HTTP 500 for server error");
        assertTrue(sanitized.message !== unknownErr.message, "Internal message not exposed");
        assertEqual(sanitized.message, "An internal error occurred", "Generic message returned");
        results.push({ name: "Unknown Error → sanitized SERVER_ERROR", ok: true, detail: "passed" });
    } catch (e) {
        results.push({ name: "Unknown Error → sanitized SERVER_ERROR", ok: false, detail: String(e) });
    }

    // --- 5. sanitizeError: Network/Fetch error → SERVICE_UNAVAILABLE ---
    try {
        const fetchErr = new TypeError("fetch failed");
        const sanitized = sanitizeError(fetchErr);
        assertEqual(sanitized.code, ErrorCode.SERVICE_UNAVAILABLE, "Mapped to SERVICE_UNAVAILABLE");
        assertEqual(sanitized.status, 503, "HTTP 503 for service unavailable");
        results.push({ name: "Fetch error → SERVICE_UNAVAILABLE", ok: true, detail: "passed" });
    } catch (e) {
        results.push({ name: "Fetch error → SERVICE_UNAVAILABLE", ok: false, detail: String(e) });
    }

    // --- 6. sanitizeError: Plain string error ---
    try {
        const sanitized = sanitizeError("something broke");
        assertEqual(sanitized.code, ErrorCode.SERVER_ERROR, "String mapped to SERVER_ERROR");
        const msg = sanitized.message;
        assertTrue(
            msg !== "something broke" && (msg === "Unknown error" || msg === "An internal error occurred"),
            "Safe message"
        );
        results.push({ name: "Plain string error → SERVER_ERROR", ok: true, detail: "passed" });
    } catch (e) {
        results.push({ name: "Plain string error → SERVER_ERROR", ok: false, detail: String(e) });
    }

    // --- 7. errorResponse: consistent JSON shape ---
    try {
        const err = new Err(ErrorCode.BAD_REQUEST, "invalid payload");
        const resp = errorResponse(err, "*");
        assertEqual(resp.status, 400, "HTTP status matches error");
        assertTrue(resp.headers.get("Content-Type")?.includes("application/json"), "JSON content type");

        const body = (await resp.json()) as ErrorResponseBody;
        assertTrue(body.error !== undefined, "Has 'error' wrapper");
        assertEqual(body.error.code, "bad_request", "Error code in body");
        assertEqual(body.error.message, "invalid payload", "Error message in body");
        assertTrue(body.error.stack === undefined, "No stack in response body");
        results.push({ name: "errorResponse consistent JSON shape", ok: true, detail: "passed" });
    } catch (e) {
        results.push({ name: "errorResponse consistent JSON shape", ok: false, detail: String(e) });
    }

    // --- 8. Idempotency: duplicate request returns cached result ---
    try {
        const kv = new InMemoryKV() as unknown as KVNamespace;
        const store = new IdempotencyStore(kv);

        await store.store("hash-123", { code: "bad_request", message: "already done", status: 400 });
        const cached = await store.lookup("hash-123");
        assertTrue(cached !== null, "Cached result found");
        assertEqual((cached as Record<string, unknown>).code, "bad_request", "Cached code matches");

        results.push({ name: "Idempotency store/retrieve", ok: true, detail: "passed" });
    } catch (e) {
        results.push({ name: "Idempotency store/retrieve", ok: false, detail: String(e) });
    }

    // --- 9. Idempotency: miss returns null ---
    try {
        const kv = new InMemoryKV() as unknown as KVNamespace;
        const store = new IdempotencyStore(kv);
        const cached = await store.lookup("nonexistent");
        assertEqual(cached, null, "No cached result for unknown hash");
        results.push({ name: "Idempotency miss returns null", ok: true, detail: "passed" });
    } catch (e) {
        results.push({ name: "Idempotency miss returns null", ok: false, detail: String(e) });
    }

    // --- 10. transport: malformed JSON → 400 with stable shape ---
    try {
        const { resp, status } = await postToReceiver("{ invalid json");
        assertEqual(status, 400, "400 for malformed JSON");
        const body = (await resp.json()) as ErrorResponseBody;
        assertEqual(body.error.code, ErrorCode.INVALID_REQUEST, "INVALID_REQUEST code");
        assertTrue(!body.error.stack, "No stack exposed");
        results.push({ name: "Malformed JSON → 400 stable error", ok: true, detail: "passed" });
    } catch (e) {
        results.push({ name: "Malformed JSON → 400 stable error", ok: false, detail: String(e) });
    }

    // --- 11. transport: valid Err thrown by handler → correct HTTP status ---
    try {
        const {
            resp: _resp,
            status,
            body,
        } = await postWithHandler({}, () => {
            throw new Err(ErrorCode.INVALID_CREDENTIALS, "Wrong password");
        });
        assertEqual(status, 400, "400 for invalid credentials");
        const responseBody = body as unknown as ErrorResponseBody;
        assertEqual(responseBody.error.code, ErrorCode.INVALID_CREDENTIALS, "Correct code in body");
        assertEqual(responseBody.error.message, "Wrong password", "Message preserved");
        results.push({ name: "Err thrown → correct HTTP status + body", ok: true, detail: "passed" });
    } catch (e) {
        results.push({ name: "Err thrown → correct HTTP status + body", ok: false, detail: String(e) });
    }

    // --- 12. transport: unknown exception → sanitized 500 ---
    try {
        const {
            resp: _resp2,
            status,
            body,
        } = await postWithHandler({}, () => {
            throw new Error("D1 error: SQLITE_ERROR: no such table: accounts");
        });
        assertEqual(status, 500, "500 for internal error");
        const responseBody = body as unknown as ErrorResponseBody;
        assertEqual(responseBody.error.code, ErrorCode.SERVER_ERROR, "Sanitized to SERVER_ERROR");
        assertTrue(!responseBody.error.message.includes("SQLITE"), "No SQL internals exposed");
        results.push({ name: "Unknown exception → sanitized 500", ok: true, detail: "passed" });
    } catch (e) {
        results.push({ name: "Unknown exception → sanitized 500", ok: false, detail: String(e) });
    }

    // --- 13. transport: OPTIONS → 204 ---
    try {
        const config = new WorkerReceiverConfig();
        const receiver = new WorkerReceiver(config);
        const req = new Request("http://localhost/", { method: "OPTIONS" });
        const resp = await receiver.handleFetch(req, async () => new PlResponse(), {}, {});
        assertEqual(resp.status, 204, "OPTIONS returns 204");
        results.push({ name: "OPTIONS → 204", ok: true, detail: "passed" });
    } catch (e) {
        results.push({ name: "OPTIONS → 204", ok: false, detail: String(e) });
    }

    // --- 14. transport: wrong method → 405 ---
    try {
        const config = new WorkerReceiverConfig();
        const receiver = new WorkerReceiver(config);
        const req = new Request("http://localhost/api", { method: "DELETE" });
        const resp = await receiver.handleFetch(req, async () => new PlResponse(), {}, {});
        assertEqual(resp.status, 405, "Non-POST/GET/OPTIONS returns 405");
        const body = (await resp.json()) as ErrorResponseBody;
        assertEqual(body.error.code, ErrorCode.BAD_REQUEST, "BAD_REQUEST for method not allowed");
        results.push({ name: "Wrong method → 405", ok: true, detail: "passed" });
    } catch (e) {
        results.push({ name: "Wrong method → 405", ok: false, detail: String(e) });
    }

    // --- 15. transport: duplicate request → idempotent response ---
    try {
        const kv = new InMemoryKV() as unknown as KVNamespace;
        const config = new WorkerReceiverConfig();
        config.idempotencyStore = new IdempotencyStore(kv);

        const receiver = new WorkerReceiver(config);
        const body = marshal({ method: "echo", params: ["test"] });

        // First request — normal response
        const req1 = new Request("http://localhost/", { method: "POST", body });
        const resp1 = await receiver.handleFetch(req1, async () => new PlResponse(), {}, {});
        assertEqual(resp1.status, 200, "First request succeeds");
        assertTrue(!resp1.headers.get("Idempotency-Replayed"), "No replay header on first");

        // Second request — same body → replayed
        const req2 = new Request("http://localhost/", { method: "POST", body });
        const resp2 = await receiver.handleFetch(req2, async () => new PlResponse(), {}, {});
        assertEqual(resp2.status, 200, "Duplicate also 200");
        assertEqual(resp2.headers.get("Idempotency-Replayed"), "true", "Replay header present");

        results.push({ name: "Duplicate request → idempotent response", ok: true, detail: "passed" });
    } catch (e) {
        results.push({ name: "Duplicate request → idempotent response", ok: false, detail: String(e) });
    }

    // --- 16. transport: clock skew → rejected ---
    try {
        const config = new WorkerReceiverConfig();
        config.maxRequestAgeMs = 60000;
        config.clockSkewToleranceMs = 5000;
        const receiver = new WorkerReceiver(config);

        const staleTime = Date.now() - 5 * 60 * 1000;
        const body = marshal({ method: "echo", params: [], time: staleTime });

        const req = new Request("http://localhost/", { method: "POST", body });
        const resp = await receiver.handleFetch(req, async () => new PlResponse(), {}, {});
        assertEqual(resp.status, 400, "Stale request rejected");
        const respBody = (await resp.json()) as ErrorResponseBody;
        assertEqual(respBody.error.code, ErrorCode.CLOCK_SKEW, "CLOCK_SKEW code");

        results.push({ name: "Clock skew → CLOCK_SKEW rejection", ok: true, detail: "passed" });
    } catch (e) {
        results.push({ name: "Clock skew → CLOCK_SKEW rejection", ok: false, detail: String(e) });
    }

    // --- 17. request age within tolerance → accepted ---
    try {
        const config = new WorkerReceiverConfig();
        config.maxRequestAgeMs = 60000;
        config.clockSkewToleranceMs = 5000;
        const receiver = new WorkerReceiver(config);

        const freshTime = Date.now();
        const body = marshal({ method: "echo", params: [], time: freshTime });

        const req = new Request("http://localhost/", { method: "POST", body });
        const resp = await receiver.handleFetch(req, async () => new PlResponse(), {}, {});
        assertEqual(resp.status, 200, "Fresh request accepted");

        results.push({ name: "Fresh request accepted within tolerance", ok: true, detail: "passed" });
    } catch (e) {
        results.push({ name: "Fresh request accepted within tolerance", ok: false, detail: String(e) });
    }

    // --- 18. hashRequestBody is deterministic ---
    try {
        const h1 = await hashRequestBody('{"foo":"bar"}');
        const h2 = await hashRequestBody('{"foo":"bar"}');
        assertEqual(h1, h2, "Same body → same hash");
        const h3 = await hashRequestBody('{"foo":"baz"}');
        assertTrue(h1 !== h3, "Different body → different hash");
        results.push({ name: "hashRequestBody deterministic", ok: true, detail: "passed" });
    } catch (e) {
        results.push({ name: "hashRequestBody deterministic", ok: false, detail: String(e) });
    }

    // --- 19. Err.toResponse() excludes stack ---
    try {
        const err = new Err(ErrorCode.SERVER_ERROR, "oops", { error: new Error("internal") });
        const resp = err.toResponse();
        assertEqual(resp.code, ErrorCode.SERVER_ERROR, "Code present");
        assertEqual(resp.message, "oops", "Message present");
        assertEqual(
            (resp as { code: string; message: string; stack?: unknown }).stack,
            undefined,
            "No stack in toResponse"
        );
        results.push({ name: "Err.toResponse() excludes stack", ok: true, detail: "passed" });
    } catch (e) {
        results.push({ name: "Err.toResponse() excludes stack", ok: false, detail: String(e) });
    }

    // --- 20. Err.toRaw() still includes stack (for logging) ---
    try {
        const err = new Err(ErrorCode.SERVER_ERROR, "oops", { error: new Error("internal") });
        const raw = err.toRaw();
        assertTrue(raw.stack !== undefined, "Stack present in toRaw");
        results.push({ name: "Err.toRaw() includes stack for logging", ok: true, detail: "passed" });
    } catch (e) {
        results.push({ name: "Err.toRaw() includes stack for logging", ok: false, detail: String(e) });
    }

    const passed = results.filter((r) => r.ok).length;
    return {
        ok: passed === results.length,
        runtime: "node-js",
        generatedAt: new Date().toISOString(),
        summary: { total: results.length, passed, failed: results.length - passed },
        results,
    };
}

async function postToReceiver(rawBody: string): Promise<{ resp: Response; status: number }> {
    const config = new WorkerReceiverConfig();
    const receiver = new WorkerReceiver(config);
    const req = new Request("http://localhost/", { method: "POST", body: rawBody });
    const resp = await receiver.handleFetch(req, async () => new PlResponse(), {}, {});
    return { resp, status: resp.status };
}

async function postWithHandler(
    params: Record<string, unknown>,
    handler: (req: PlRequest) => Promise<PlResponse>
): Promise<{ resp: Response; status: number; body: Record<string, unknown> }> {
    const config = new WorkerReceiverConfig();
    const receiver = new WorkerReceiver(config);
    const body = marshal({ method: "echo", params: [params] });
    const req = new Request("http://localhost/", { method: "POST", body });
    const resp = await receiver.handleFetch(req, handler, {}, {});
    return { resp, status: resp.status, body: await resp.json() };
}

export { runErrorTests };
