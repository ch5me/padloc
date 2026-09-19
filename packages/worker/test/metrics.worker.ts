import { Request as PlRequest, Response as PlResponse } from "@elf-vault/core/src/transport";
import { WorkerReceiver, WorkerReceiverConfig } from "../src/transport";
import { resetMetricsForTests } from "../src/metrics";

export default {
    async fetch(request: Request): Promise<Response> {
        const receiver = new WorkerReceiver(new WorkerReceiverConfig());
        const response = await receiver.handleFetch(
            request,
            async (req: PlRequest): Promise<PlResponse> => {
                const response = new PlResponse();
                if (req.method === "getVault") response.result = { ok: true };
                else response.error = { code: "test_error", message: "redacted" };
                return response;
            },
            {},
            {}
        );
        return response;
    },
};
