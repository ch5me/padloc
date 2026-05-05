import { WorkerReceiver, WorkerReceiverConfig } from "../src/transport";
import { Request as PlRequest, Response as PlResponse } from "@padloc/core/src/transport";

export default {
    async fetch(request: Request, env: any, ctx: ExecutionContext): Promise<Response> {
        const config = new WorkerReceiverConfig();
        config.allowOrigin = env.ALLOW_ORIGIN || "*";
        const receiver = new WorkerReceiver(config);

        const url = new URL(request.url);

        // Healthcheck returns 200 with JSON — mimicking index.ts behavior
        if (request.method === "GET" && url.pathname === config.healthCheckPath) {
            return new Response(JSON.stringify({
                status: "ok",
                version: env.VERSION || "0.0.0",
                d1: env.DB ? "ok" : "unavailable",
                r2: "unavailable",
                resend: "unavailable",
            }), {
                status: 200,
                headers: {
                    "Content-Type": "application/json; charset=utf-8",
                    "Access-Control-Allow-Origin": config.allowOrigin,
                    "Access-Control-Allow-Methods": "OPTIONS, POST",
                    "Access-Control-Allow-Headers": "Content-Type",
                },
            });
        }

        return receiver.handleFetch(request, async (req: PlRequest): Promise<PlResponse> => {
            const res = new PlResponse();
            res.result = {
                echoed: req.method,
                paramsReceived: req.params,
                deviceId: req.device?.id || null,
            };
            return res;
        }, env, ctx);
    },
};
