import { runAttachmentLifecycleTests } from "./attachment-lifecycle";

export default {
    async fetch(_request: Request): Promise<Response> {
        const report = await runAttachmentLifecycleTests();
        return new Response(JSON.stringify(report, null, 2), {
            status: report.ok ? 200 : 500,
            headers: { "content-type": "application/json; charset=utf-8" },
        });
    },
};
