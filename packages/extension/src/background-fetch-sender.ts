import { marshal, unmarshal } from "@padloc/core/src/encoding";
import { Err, ErrorCode } from "@padloc/core/src/error";
import { Request, RequestProgress, Response as TransportResponse, Sender } from "@padloc/core/src/transport";

export class BackgroundFetchSender implements Sender {
    constructor(public url: string) {}

    async send(req: Request, progress?: RequestProgress): Promise<TransportResponse> {
        const body = marshal(req.toRaw());

        let res;
        try {
            res = await fetch(this.url, {
                method: "POST",
                headers: {
                    "Content-Type": "application/json",
                    Accept: "application/json",
                },
                body,
            });
        } catch (error) {
            progress && (progress.error = { code: ErrorCode.FAILED_CONNECTION, message: "Padloc API fetch failed" });
            throw new Err(ErrorCode.FAILED_CONNECTION, "Padloc API fetch failed", {
                error: error instanceof Error ? error : undefined,
            });
        }

        const text = await res.text();
        const byteLength = text.length;
        if (progress) {
            progress.uploadProgress = { loaded: body.length, total: body.length };
            progress.downloadProgress = { loaded: byteLength, total: byteLength };
            progress.complete();
        }

        try {
            return new TransportResponse().fromRaw(unmarshal(text));
        } catch {
            throw new Err(ErrorCode.SERVER_ERROR);
        }
    }
}
