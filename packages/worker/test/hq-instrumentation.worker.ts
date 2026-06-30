import { runHqInstrumentationTests } from "./hq-instrumentation";

export default {
    async fetch(request: Request): Promise<Response> {
        const report = await runHqInstrumentationTests();
        return new Response(JSON.stringify(report, null, 2), {
            status: report.ok ? 200 : 500,
            headers: { "Content-Type": "application/json" },
        });
    },
};
