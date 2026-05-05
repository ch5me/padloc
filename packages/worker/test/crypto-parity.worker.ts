import { WorkerCryptoProvider } from "../src/crypto";
import { runCryptoParity } from "./crypto-parity";

export default {
    async fetch(): Promise<Response> {
        const report = await runCryptoParity(new WorkerCryptoProvider());
        return new Response(JSON.stringify(report, null, 2), {
            status: report.ok ? 200 : 500,
            headers: {
                "content-type": "application/json; charset=utf-8",
            },
        });
    },
};
