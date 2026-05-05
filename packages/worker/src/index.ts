import { Request as PlRequest, Response as PlResponse } from "@padloc/core/src/transport";
import { WorkerReceiver, WorkerReceiverConfig } from "./transport";
import { IdempotencyStore } from "./idempotency";
import { Env } from "./env";
import { createServer } from "./server-factory";
import { AccountLockDO } from "./locks/account-lock";

interface HealthcheckStatus {
    status: "ok" | "degraded";
    version: string;
    d1: "ok" | "unavailable";
    r2: "ok" | "unavailable";
    resend: "ok" | "unavailable";
}

async function healthcheck(env: Env): Promise<HealthcheckStatus> {
    const health: HealthcheckStatus = {
        status: "ok",
        version: env.VERSION || "0.0.0",
        d1: "unavailable",
        r2: "unavailable",
        resend: "unavailable",
    };

    if (env.DB) {
        try {
            await env.DB.prepare("SELECT 1").first();
            health.d1 = "ok";
        } catch {
            health.d1 = "unavailable";
        }
    }

    if (env.ATTACHMENTS) {
        try {
            await env.ATTACHMENTS.list({ limit: 0 });
            health.r2 = "ok";
        } catch {
            health.r2 = "unavailable";
        }
    }

    if (env.RESEND_API_KEY) health.resend = "ok";

    if (health.d1 !== "ok" || health.r2 !== "ok" || health.resend !== "ok") {
        health.status = "degraded";
    }

    return health;
}

export { AccountLockDO };

export default {
    async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
        const allowOrigin = env.ALLOW_ORIGIN || "*";
        const config = new WorkerReceiverConfig();
        config.allowOrigin = allowOrigin;
        config.idempotencyStore = new IdempotencyStore(env.HINTS);
        const receiver = new WorkerReceiver(config);

        const url = new URL(request.url);
        if (request.method === "GET" && url.pathname === config.healthCheckPath) {
            const health = await healthcheck(env);
            return new Response(JSON.stringify(health), {
                status: 200,
                headers: {
                    "Content-Type": "application/json; charset=utf-8",
                    "Access-Control-Allow-Origin": allowOrigin,
                    "Access-Control-Allow-Methods": "OPTIONS, POST",
                    "Access-Control-Allow-Headers": "Content-Type",
                },
            });
        }

        return receiver.handleFetch(
            request,
            async (req: PlRequest): Promise<PlResponse> => {
                const server = createServer(env);
                return server.handle(req);
            },
            env,
            ctx,
        );
    },
};
