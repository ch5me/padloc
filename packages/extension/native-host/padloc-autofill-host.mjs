#!/usr/bin/env node

import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

const PROTOCOL_VERSION = 1;
const STATE_DIR = process.env.PADLOC_AGENTIC_AUTOFILL_STATE_DIR || join(homedir(), ".local", "share", "ch5-autofill", "padloc-bridge");
const LATEST_RESPONSE_PATH = join(STATE_DIR, "latest-redacted-response.json");

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
    if (type === "cache-redacted-response") {
        return cacheRedactedResponse(request);
    }
    if (type === "latest-redacted-response") {
        return latestRedactedResponse(request);
    }
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

function cacheRedactedResponse(request) {
    const response = request && typeof request.response === "object" ? request.response : null;
    if (!response) {
        return statusResponse(false, "cache-redacted-response requires response");
    }
    const unsafe = findRawBundleValue(response);
    if (unsafe) {
        return statusResponse(false, "refused non-redacted bundle value");
    }
    mkdirSync(dirname(LATEST_RESPONSE_PATH), { recursive: true, mode: 0o700 });
    writeFileSync(LATEST_RESPONSE_PATH, `${JSON.stringify({
        cachedAt: new Date().toISOString(),
        response,
    }, null, 2)}\n`, { mode: 0o600 });
    return statusResponse(true, null, { cached: true });
}

function latestRedactedResponse(request) {
    try {
        const cached = JSON.parse(readFileSync(LATEST_RESPONSE_PATH, "utf8"));
        const unsafe = findRawBundleValue(cached);
        if (unsafe) {
            return statusResponse(false, "cached response contains non-redacted bundle value");
        }
        return statusResponse(true, null, { cached });
    } catch {
        return statusResponse(false, "no cached redacted response");
    }
}

function statusResponse(ok, reason, extra = {}) {
    return {
        ok,
        protocolVersion: PROTOCOL_VERSION,
        vaultState: "locked",
        reason,
        ...extra,
        audit: {
            operation: "status",
            sessionId: null,
            origin: null,
            fieldCount: 0,
            valuePolicy: "redacted audit only; no raw autofill values",
        },
    };
}

function findRawBundleValue(response) {
    if (!response || typeof response !== "object") return false;
    if (Array.isArray(response)) return response.some((entry) => findRawBundleValue(entry));
    for (const [key, value] of Object.entries(response)) {
        if (key === "value" && hasRawValue(value)) {
            return true;
        }
        if (findRawBundleValue(value)) {
            return true;
        }
    }
    return false;
}

function hasRawValue(value) {
    return value !== undefined && value !== null && value !== "";
}
