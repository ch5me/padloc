import { runErrorTests } from "./error-semantics";

export default {
    async fetch(_request: Request, _env: any, _ctx: ExecutionContext): Promise<Response> {
        const report = await runErrorTests();
        return new Response(JSON.stringify(report, null, 2), {
            status: report.ok ? 200 : 500,
            headers: { "Content-Type": "application/json" },
        });
    },
};
