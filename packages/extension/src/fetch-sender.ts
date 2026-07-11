import { marshal, unmarshal } from "@padloc/core/src/encoding";
import { Err, ErrorCode } from "@padloc/core/src/error";
import { Request, RequestProgress, Response, Sender } from "@padloc/core/src/transport";

/** HTTP transport for extension service workers. It deliberately has no DOM or Lit dependencies. */
export class FetchSender implements Sender {
    constructor(public readonly url: string) {}

    async send(request: Request, _progress?: RequestProgress): Promise<Response> {
        let response: globalThis.Response;
        try {
            response = await fetch(this.url, {
                method: "POST",
                headers: {
                    "Content-Type": "application/json",
                    Accept: "application/json",
                },
                body: marshal(request.toRaw()),
            });
        } catch (error) {
            throw new Err(ErrorCode.FAILED_CONNECTION, undefined, { error });
        }

        const body = await response.text();
        if (!response.ok) {
            throw new Err(ErrorCode.FAILED_CONNECTION, `HTTP ${response.status} ${response.statusText}`);
        }

        try {
            return new Response().fromRaw(unmarshal(body));
        } catch (error) {
            throw new Err(ErrorCode.SERVER_ERROR, undefined, { error });
        }
    }
}
