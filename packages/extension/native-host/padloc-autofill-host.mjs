#!/usr/bin/env node

const PROTOCOL_VERSION = 1;

const input = await readAllStdin();
const request = parseNativeMessage(input);
const response = handleRequest(request);
process.stdout.write(encodeNativeMessage(response));

async function readAllStdin() {
    const chunks = [];
    for await (const chunk of process.stdin) chunks.push(chunk);
    return Buffer.concat(chunks);
}

function parseNativeMessage(buffer) {
    if (buffer.length < 4) {
        return { type: "status", protocolVersion: PROTOCOL_VERSION };
    }
    const length = buffer.readUInt32LE(0);
    const payload = buffer.subarray(4, 4 + length).toString("utf8");
    return JSON.parse(payload);
}

function encodeNativeMessage(payload) {
    const body = Buffer.from(JSON.stringify(payload), "utf8");
    const header = Buffer.alloc(4);
    header.writeUInt32LE(body.length, 0);
    return Buffer.concat([header, body]);
}

function handleRequest(request) {
    const type = typeof request.type === "string" ? request.type : "status";
    const binding = request && typeof request.binding === "object" ? request.binding : null;
    const fields = Array.isArray(request.fields) ? request.fields : [];
    return {
        ok: type === "status",
        protocolVersion: PROTOCOL_VERSION,
        requestId: typeof request.requestId === "string" ? request.requestId : undefined,
        vaultState: "locked",
        reason: type === "status" ? null : "Padloc vault locked or approval UI unavailable",
        audit: {
            operation: type,
            sessionId: binding && typeof binding.sessionId === "string" ? binding.sessionId : null,
            origin: binding && typeof binding.origin === "string" ? binding.origin : null,
            fieldCount: fields.length,
            valuePolicy: "redacted audit only; no raw autofill values",
        },
    };
}
