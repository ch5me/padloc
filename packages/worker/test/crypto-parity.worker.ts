import { WorkerCryptoProvider } from "../src/crypto";
import { runCryptoParity } from "./crypto-parity";

export default {
    async fetch(request: Request): Promise<Response> {
        const url = new URL(request.url);
        const report = await runCryptoParity(new WorkerCryptoProvider(), {
            includeBenchmark: url.searchParams.get("benchmark") === "1",
            enforceBudget: url.searchParams.get("enforceBudget") === "1",
        });
        return new Response(JSON.stringify(report, null, 2), {
            status: report.ok ? 200 : 500,
            headers: {
                "content-type": "application/json; charset=utf-8",
            },
        });
    },
};
