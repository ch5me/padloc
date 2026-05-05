import { Request, Response } from "@padloc/core/src/transport";
import { marshal, unmarshal } from "@padloc/core/src/encoding";

export function marshalRequest(req: Request, clientVersion?: string): string {
    return marshal(req.toRaw(clientVersion));
}

export function unmarshalRequest(body: string): Request {
    const req = new Request();
    req.fromRaw(unmarshal(body));
    return req;
}

export function marshalResponse(res: Response, clientVersion?: string): string {
    return marshal(res.toRaw(clientVersion));
}

export function unmarshalResponse(body: string): Response {
    const res = new Response();
    res.fromRaw(unmarshal(body));
    return res;
}
