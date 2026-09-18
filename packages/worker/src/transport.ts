import { Receiver, Request, Sender, Response as CoreResponse } from "@padloc/core/src/transport";
import { marshal, unmarshal } from "@padloc/core/src/encoding";
import { Err, ErrorCode } from "@padloc/core/src/error";
import { IdempotencyStore, hashRequestBody } from "./idempotency";
import { sanitizeError } from "./error";
import { RateLimiter } from "./rate-limiter";
import { CorsConfig, responseHeaders } from "./observability/security-headers";
import { captureHqException } from "./hq-instrumentation";
import { incrementMetric, renderMetrics } from "./metrics";

const DEFAULT_MAX_REQUEST_SIZE = 25 * 1024 * 1024;
const DEFAULT_MAX_REQUEST_AGE_MS = 5 * 60 * 1000;
const DEFAULT_CLOCK_SKEW_TOLERANCE_MS = 30 * 1000;

function errorResponse(err: Err, corsConfig: CorsConfig): Response {
    return new Response(JSON.stringify({ error: { code: err.code, message: err.message } }), {
        status: statusForError(err),
        headers: responseHeaders(corsConfig, undefined, {
            "Content-Type": "application/json; charset=utf-8",
        }),
    });
}

function statusForError(err: Err): number {
    switch (err.code) {
        case ErrorCode.INVALID_REQUEST:
        case ErrorCode.BAD_REQUEST:
        case ErrorCode.MAX_REQUEST_SIZE_EXCEEDED:
        case ErrorCode.MAX_REQUEST_AGE_EXCEEDED:
            return 400;
        case ErrorCode.INVALID_SESSION:
        case ErrorCode.SESSION_EXPIRED:
        case ErrorCode.INVALID_CREDENTIALS:
        case ErrorCode.AUTHENTICATION_REQUIRED:
        case ErrorCode.AUTHENTICATION_FAILED:
            return 401;
        case ErrorCode.INSUFFICIENT_PERMISSIONS:
        case ErrorCode.MISSING_ACCESS:
            return 403;
        case ErrorCode.NOT_FOUND:
            return 404;
        default:
            return 500;
    }
}

export class WorkerReceiverConfig {
    allowOrigin: string = "*";
    allowedOrigins?: string[];
    maxRequestSize: number = DEFAULT_MAX_REQUEST_SIZE;
    maxRequestAgeMs: number = DEFAULT_MAX_REQUEST_AGE_MS;
    clockSkewToleranceMs: number = DEFAULT_CLOCK_SKEW_TOLERANCE_MS;
    healthCheckPath: string = "/healthcheck";
    metricsPath: string = "/metrics";
    idempotencyStore?: IdempotencyStore;
    rateLimiter?: RateLimiter;
}

export class WorkerReceiver implements Receiver {
    constructor(public readonly config: WorkerReceiverConfig = new WorkerReceiverConfig()) {}

    listen(_handler: (req: Request) => Promise<CoreResponse>): void {
        // Workers are per-request; use handleFetch instead.
    }

    async handleFetch(
        request: globalThis.Request,
        handler: (req: Request) => Promise<CoreResponse>,
        _env: unknown,
        _ctx: unknown
    ): Promise<Response> {
        return this._route(request, handler);
    }

    private async _route(
        request: globalThis.Request,
        handler: (req: Request) => Promise<CoreResponse>
    ): Promise<Response> {
        const url = new URL(request.url);
        const corsConfig = this.corsConfig(request);

        if (request.method === "OPTIONS") {
            return new Response(null, {
                status: 204,
                headers: responseHeaders(corsConfig),
            });
        }

        if (request.method === "GET" && url.pathname === this.config.healthCheckPath) {
            return new Response(null, {
                status: 200,
                headers: responseHeaders(corsConfig),
            });
        }

        if (request.method === "GET" && url.pathname === this.config.metricsPath) {
            return new Response(renderMetrics(), {
                status: 200,
                headers: responseHeaders(corsConfig, undefined, {
                    "Content-Type": "text/plain; version=0.0.4; charset=utf-8",
                }),
            });
        }

        if (request.method === "POST" && url.pathname === "/") {
            return this._handlePost(request, handler);
        }

        return new Response(JSON.stringify({ error: { code: ErrorCode.BAD_REQUEST, message: "Method not allowed" } }), {
            status: 405,
            headers: responseHeaders(corsConfig, undefined, {
                "Content-Type": "application/json; charset=utf-8",
            }),
        });
    }

    private async _handlePost(
        request: globalThis.Request,
        handler: (req: Request) => Promise<CoreResponse>
    ): Promise<Response> {
        const corsConfig = this.corsConfig(request);
        const identity =
            request.headers.get("cf-connecting-ip") || request.headers.get("x-forwarded-for") || "anonymous";

        if (this.config.rateLimiter) {
            const rateResult = await this.config.rateLimiter.check(identity);
            if (!rateResult.allowed) {
                incrementMetric("padloc_rpc_total", { method: "unknown" });
                incrementMetric("padloc_rpc_error_total", { method: "unknown", code: String(ErrorCode.BAD_REQUEST) });
                return new Response(
                    JSON.stringify({
                        error: { code: ErrorCode.BAD_REQUEST, message: "Too many requests. Please try again later." },
                    }),
                    {
                        status: 429,
                        headers: responseHeaders(corsConfig, undefined, {
                            "Content-Type": "application/json; charset=utf-8",
                            "Retry-After": String(Math.ceil((rateResult.retryAfterMs || 0) / 1000)),
                        }),
                    }
                );
            }
        }

        const bodyText = await request.text();
        if (new TextEncoder().encode(bodyText).byteLength > this.config.maxRequestSize) {
            incrementMetric("padloc_rpc_total", { method: "unknown" });
            return metricErrorResponse(
                new Err(
                    ErrorCode.MAX_REQUEST_SIZE_EXCEEDED,
                    `Request body exceeds maximum size of ${this.config.maxRequestSize} bytes`
                ),
                corsConfig,
                "unknown"
            );
        }

        let req: Request;
        let rawRequest: Record<string, unknown>;
        try {
            rawRequest = unmarshal(bodyText);
            req = new Request().fromRaw(rawRequest);
        } catch {
            incrementMetric("padloc_rpc_total", { method: "unknown" });
            return metricErrorResponse(
                new Err(ErrorCode.INVALID_REQUEST, "Failed to parse request body"),
                corsConfig,
                "unknown"
            );
        }

        const method = req.method || "unknown";
        incrementMetric("padloc_rpc_total", { method });
        req.ipAddress = request.headers.get("cf-connecting-ip") || request.headers.get("x-forwarded-for") || undefined;

        if (!validateRequestAge(rawRequest, this.config)) {
            return metricErrorResponse(
                new Err(ErrorCode.MAX_REQUEST_AGE_EXCEEDED, "Request timestamp outside acceptable window"),
                corsConfig,
                method
            );
        }

        const idempotencyKey = request.headers.get("idempotency-key");
        const requestHash = idempotencyKey ? await hashRequestBody(`${idempotencyKey}\n${bodyText}`) : null;
        const existing = requestHash ? await this.config.idempotencyStore?.lookup(requestHash) : null;
        if (existing) {
            if (existing.error) incrementMetric("padloc_rpc_error_total", { method, code: String(existing.error) });
            return new Response(JSON.stringify(existing), {
                status: 200,
                headers: {
                    "Content-Type": "application/json; charset=utf-8",
                    "Idempotency-Replayed": "true",
                    ...responseHeaders(corsConfig),
                },
            });
        }

        let res: CoreResponse;
        try {
            res = await handler(req);
        } catch (unknown) {
            if (unknown instanceof Err) {
                if (unknown.report) {
                    captureHqException(unknown.originalError || unknown, {
                        "padloc.error.code": unknown.code,
                        "padloc.error.report": true,
                    });
                }
                return metricErrorResponse(unknown, corsConfig, method);
            }
            const sanitized = sanitizeError(unknown);
            if (sanitized.report) {
                captureHqException(sanitized.originalError || unknown, {
                    "padloc.error.code": sanitized.code,
                    "padloc.error.report": true,
                });
            }
            return metricErrorResponse(sanitized, corsConfig, method);
        }

        const raw = res.toRaw(req.device?.appVersion);
        if (raw.error !== undefined && raw.error !== null) {
            incrementMetric("padloc_rpc_error_total", { method, code: String(raw.error) });
        } else if (method === "getVault" || method === "updateVault") {
            incrementMetric("padloc_vault_sync_success_total");
        }

        if (requestHash) {
            await this.config.idempotencyStore?.store(requestHash, raw);
        }

        const resBody = marshal(raw);
        return new Response(resBody, {
            status: 200,
            headers: responseHeaders(corsConfig, undefined, {
                "Content-Type": "application/json; charset=utf-8",
                "Content-Length": String(new TextEncoder().encode(resBody).byteLength),
            }),
        });
    }

    private corsConfig(request: globalThis.Request): CorsConfig {
        return {
            allowOrigin: this.config.allowOrigin || "*",
            allowedOrigins: this.config.allowedOrigins,
            requestOrigin: request.headers.get("Origin"),
        };
    }
}

function metricErrorResponse(err: Err, corsConfig: CorsConfig, method: string): Response {
    incrementMetric("padloc_rpc_error_total", { method, code: String(err.code) });
    return errorResponse(err, corsConfig);
}

function validateRequestAge(rawRequest: Record<string, unknown>, config: WorkerReceiverConfig): boolean {
    const requestTime = rawRequest.time as number | undefined;
    if (!requestTime) return true;

    const now = Date.now();
    const age = Math.abs(now - requestTime);
    const maxAge = config.maxRequestAgeMs + config.clockSkewToleranceMs;

    return age <= maxAge;
}

export class WorkerSender implements Sender {
    constructor(public url: string) {}

    async send(req: Request): Promise<CoreResponse> {
        const body = marshal(req.toRaw());

        const res = await fetch(this.url, {
            method: "POST",
            headers: {
                "Content-Type": "application/json",
                Accept: "application/json",
            },
            body,
        });

        const resBody = await res.text();

        if (!res.ok) {
            throw new Err(ErrorCode.FAILED_CONNECTION, `HTTP ${res.status} - ${res.statusText}: ${resBody}`);
        }

        return new CoreResponse().fromRaw(unmarshal(resBody));
    }
}

export function marshalRequest(req: Request, clientVersion?: string): string {
    return marshal(req.toRaw(clientVersion));
}

export function unmarshalRequest(body: string): Request {
    const r = new Request();
    r.fromRaw(unmarshal(body));
    return r;
}

export function marshalResponse(res: CoreResponse, clientVersion?: string): string {
    return marshal(res.toRaw(clientVersion));
}

export function unmarshalResponse(body: string): CoreResponse {
    const r = new CoreResponse();
    r.fromRaw(unmarshal(body));
    return r;
}
