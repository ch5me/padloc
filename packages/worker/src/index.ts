import { Request as PlRequest, Response as PlResponse } from "@padloc/core/src/transport";
import { marshal, unmarshal } from "@padloc/core/src/encoding";
import { Err, ErrorCode } from "@padloc/core/src/error";
import { Env } from "./env";
import { createServer } from "./server-factory";

const MAX_BODY_SIZE = 25 * 1024 * 1024;

function corsHeaders(allowOrigin?: string) {
    return {
        "Access-Control-Allow-Origin": allowOrigin || "*",
        "Access-Control-Allow-Methods": "OPTIONS, POST",
        "Access-Control-Allow-Headers": "Content-Type",
    };
}

interface HealthcheckStatus {
    status: "ok" | "degraded";
    version: string;
    d1: "ok" | "unavailable";
    r2: "ok" | "unavailable";
    resend: "ok" | "unavailable";
}

export default {
    async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
        const url = new URL(request.url);

        // OPTIONS → CORS preflight
        if (request.method === "OPTIONS") {
            return new Response(null, {
                status: 204,
                headers: corsHeaders(env.ALLOW_ORIGIN),
            });
        }

        // GET /healthcheck → 200 JSON
        if (request.method === "GET" && url.pathname === "/healthcheck") {
            const health: HealthcheckStatus = {
                status: "ok",
                version: env.VERSION || "0.0.0",
                d1: "unavailable",
                r2: "unavailable",
                resend: "unavailable",
            };

            // Ping D1
            if (env.DB) {
                try {
                    await env.DB.prepare("SELECT 1").first();
                    health.d1 = "ok";
                } catch {
                    health.d1 = "unavailable";
                }
            }

            // Ping R2
            if (env.ATTACHMENTS) {
                try {
                    await env.ATTACHMENTS.list({ limit: 0 });
                    health.r2 = "ok";
                } catch {
                    health.r2 = "unavailable";
                }
            }

            // Check RESEND_API_KEY secret presence
            if (env.RESEND_API_KEY) {
                health.resend = "ok";
            }

            if (health.d1 !== "ok" || health.r2 !== "ok" || health.resend !== "ok") {
                health.status = "degraded";
            }

            return new Response(JSON.stringify(health), {
                status: 200,
                headers: {
                    "Content-Type": "application/json; charset=utf-8",
                    ...corsHeaders(env.ALLOW_ORIGIN),
                },
            });
        }

        // POST / → unmarshal → Server.handle → marshal → 200 JSON
        if (request.method === "POST" && url.pathname === "/") {
            const bodyText = await request.text();

            if (bodyText.length > MAX_BODY_SIZE) {
                const err = new Err(
                    ErrorCode.MAX_REQUEST_SIZE_EXCEEDED,
                    `Request body exceeds maximum size of ${MAX_BODY_SIZE} bytes`,
                );
                return new Response(JSON.stringify({ error: err.toRaw() }), {
                    status: 400,
                    headers: {
                        "Content-Type": "application/json; charset=utf-8",
                        ...corsHeaders(env.ALLOW_ORIGIN),
                    },
                });
            }

            let req: PlRequest;
            try {
                const raw = unmarshal(bodyText);
                req = new PlRequest().fromRaw(raw);
            } catch (e) {
                const err = new Err(ErrorCode.INVALID_REQUEST, "Failed to parse request body");
                return new Response(JSON.stringify({ error: { code: err.code, message: err.message } }), {
                    status: 400,
                    headers: {
                        "Content-Type": "application/json; charset=utf-8",
                        ...corsHeaders(env.ALLOW_ORIGIN),
                    },
                });
            }

            const server = createServer();

            let res: PlResponse;
            try {
                res = await server.handle(req);
            } catch (e) {
                if (e instanceof Err) {
                    return new Response(JSON.stringify({ error: { code: e.code, message: e.message } }), {
                        status: 400,
                        headers: {
                            "Content-Type": "application/json; charset=utf-8",
                            ...corsHeaders(env.ALLOW_ORIGIN),
                        },
                    });
                }
                throw e;
            }

            const clientVersion = (req as any).device?.appVersion;
            const resBody = marshal((res as any).toRaw(clientVersion));

            return new Response(resBody, {
                status: 200,
                headers: {
                    "Content-Type": "application/json; charset=utf-8",
                    ...corsHeaders(env.ALLOW_ORIGIN),
                },
            });
        }

        // Any other path/method → 405
        return new Response(JSON.stringify({ error: { code: "method_not_allowed", message: "Not allowed" } }), {
            status: 405,
            headers: {
                "Content-Type": "application/json; charset=utf-8",
                ...corsHeaders(env.ALLOW_ORIGIN),
            },
        });
    },
};
