#!/usr/bin/env node

import { existsSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { once } from "node:events";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

const PROTOCOL_VERSION = 1;
const STATE_DIR =
    process.env.PADLOC_AGENTIC_AUTOFILL_STATE_DIR ||
    join(homedir(), ".local", "share", "ch5-autofill", "padloc-bridge");
const LATEST_RESPONSE_PATH = join(STATE_DIR, "latest-redacted-response.json");
const PENDING_REQUEST_PATH = join(STATE_DIR, "pending-broker-request.json");
const AUDIT_LOG_PATH = join(STATE_DIR, "broker-audit.jsonl");
const MAX_MESSAGE_BYTES = 1024 * 1024;
const MAX_OUTPUT_BYTES = 1024 * 1024;

for await (const request of readNativeMessages(process.stdin)) {
    await writeNativeMessage(handleRequest(request));
}

async function* readNativeMessages(stream) {
    let buffered = Buffer.alloc(0);
    for await (const chunk of stream) {
        buffered = buffered.length ? Buffer.concat([buffered, chunk]) : Buffer.from(chunk);
        while (buffered.length >= 4) {
            const length = buffered.readUInt32LE(0);
            if (length > MAX_MESSAGE_BYTES) throw new Error("native message exceeds 1 MiB");
            if (buffered.length < 4 + length) break;
            yield JSON.parse(buffered.subarray(4, 4 + length).toString("utf8"));
            buffered = buffered.subarray(4 + length);
        }
    }
}

function encodeNativeMessage(payload) {
    let body = Buffer.from(JSON.stringify(payload), "utf8");
    if (body.length > MAX_OUTPUT_BYTES) {
        body = Buffer.from(JSON.stringify(statusResponse(false, "native response exceeds 1 MiB")), "utf8");
    }
    const header = Buffer.alloc(4);
    header.writeUInt32LE(body.length, 0);
    return Buffer.concat([header, body]);
}

async function writeNativeMessage(payload) {
    if (!process.stdout.write(encodeNativeMessage(payload))) {
        await once(process.stdout, "drain");
    }
}

function handleRequest(request) {
    const type = typeof request.type === "string" ? request.type : "status";
    if (type === "cache-redacted-response") {
        return cacheRedactedResponse(request);
    }
    if (type === "latest-redacted-response") {
        return latestRedactedResponse(request);
    }
    if (type === "broker-request") {
        return enqueueBrokerRequest(request);
    }
    if (type === "claim-broker-request") {
        return claimBrokerRequest();
    }
    if (type === "broker-response") {
        return brokerResponse(request);
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
            valuePolicy: "redacted audit only; no raw autofill values or passkey secrets",
        },
    };
}

function enqueueBrokerRequest(request) {
    const brokerRequest = request && typeof request.request === "object" ? request.request : null;
    if (!brokerRequest) {
        return statusResponse(false, "broker-request requires request");
    }
    const unsafe = findRawBundleValue(brokerRequest);
    if (unsafe) {
        return statusResponse(false, "refused broker request containing sensitive payload");
    }
    const requestId =
        typeof brokerRequest.requestId === "string" && brokerRequest.requestId
            ? brokerRequest.requestId
            : `native-${Date.now()}`;
    const queued = {
        requestId,
        queuedAt: new Date().toISOString(),
        request: {
            ...brokerRequest,
            requestId,
        },
    };
    mkdirSync(dirname(PENDING_REQUEST_PATH), { recursive: true, mode: 0o700 });
    writeFileSync(PENDING_REQUEST_PATH, `${JSON.stringify(queued, null, 2)}\n`, { mode: 0o600 });
    return statusResponse(true, null, {
        requestId,
        pending: true,
        reason: "broker request queued for Padloc extension native-messaging pickup",
    });
}

function claimBrokerRequest() {
    if (!existsSync(PENDING_REQUEST_PATH)) {
        return statusResponse(true, null, { pending: null });
    }
    try {
        const pending = JSON.parse(readFileSync(PENDING_REQUEST_PATH, "utf8"));
        const unsafe = findRawBundleValue(pending);
        if (unsafe) {
            unlinkSync(PENDING_REQUEST_PATH);
            return statusResponse(false, "pending request contains sensitive payload");
        }
        unlinkSync(PENDING_REQUEST_PATH);
        return statusResponse(true, null, { pending });
    } catch {
        return statusResponse(false, "pending broker request unreadable");
    }
}

function brokerResponse(request) {
    const requestId = typeof request.requestId === "string" ? request.requestId : null;
    const latest = latestRedactedResponse(request);
    if (!latest.ok || !latest.cached || !latest.cached.response) {
        return latest;
    }
    if (requestId && latest.cached.response.requestId !== requestId) {
        return statusResponse(false, "broker response not ready", { requestId, pending: true });
    }
    return latest;
}

function cacheRedactedResponse(request) {
    const response = request && typeof request.response === "object" ? request.response : null;
    if (!response) {
        return statusResponse(false, "cache-redacted-response requires response");
    }
    if (response.protocolVersion === 2 && !isClosedBrokerResponseV2(response)) {
        return statusResponse(false, "refused non-closed broker response");
    }
    const unsafe = findRawBundleValue(response);
    if (unsafe) {
        return statusResponse(false, "refused non-redacted sensitive payload");
    }
    mkdirSync(dirname(LATEST_RESPONSE_PATH), { recursive: true, mode: 0o700 });
    writeFileSync(
        LATEST_RESPONSE_PATH,
        `${JSON.stringify(
            {
                cachedAt: new Date().toISOString(),
                response,
            },
            null,
            2
        )}\n`,
        { mode: 0o600 }
    );
    appendAuditRecord(response);
    return statusResponse(true, null, { cached: true });
}

function latestRedactedResponse(request) {
    try {
        const cached = JSON.parse(readFileSync(LATEST_RESPONSE_PATH, "utf8"));
        if (cached && cached.response && cached.response.protocolVersion === 2 && !isClosedBrokerResponseV2(cached.response)) {
            return statusResponse(false, "cached response is not a closed broker response");
        }
        const unsafe = findRawBundleValue(cached);
        if (unsafe) {
            return statusResponse(false, "cached response contains non-redacted sensitive payload");
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
            valuePolicy: "redacted audit only; no raw autofill values or passkey secrets",
        },
    };
}

function findRawBundleValue(response) {
    if (!response || typeof response !== "object") return false;
    if (Array.isArray(response)) return response.some((entry) => findRawBundleValue(entry));
    for (const [key, value] of Object.entries(response)) {
        if (isSensitiveKey(key) && hasRawValue(value)) {
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

function isSensitiveKey(key) {
    return /(^value$|secret|private[_-]?key)/i.test(key);
}

function appendAuditRecord(response) {
    const audit = response && typeof response === "object" ? response.audit : null;
    if (!audit || typeof audit !== "object") return;
    const operation = typeof audit.operation === "string" ? audit.operation : "";
    if (!operation) return;
    mkdirSync(dirname(AUDIT_LOG_PATH), { recursive: true, mode: 0o700 });
    const record = {
        loggedAt: new Date().toISOString(),
        requestId: typeof response.requestId === "string" ? response.requestId : null,
        operation,
        sessionId: typeof audit.sessionId === "string" ? audit.sessionId : null,
        origin: typeof audit.origin === "string" ? audit.origin : null,
        actor: typeof audit.actor === "string" ? audit.actor : null,
        profileId: typeof audit.profileId === "string" ? audit.profileId : null,
        vendor: typeof audit.vendor === "string" ? audit.vendor : null,
        rpId: typeof audit.rpId === "string" ? audit.rpId : null,
        topOrigin: typeof audit.topOrigin === "string" ? audit.topOrigin : null,
        decision: typeof audit.decision === "string" ? audit.decision : null,
        reason: typeof audit.reason === "string" ? audit.reason : null,
        approvalId: typeof audit.approvalId === "string" ? audit.approvalId : null,
        flowId: typeof audit.flowId === "string" ? audit.flowId : null,
        nonce: typeof audit.nonce === "string" ? audit.nonce : null,
        rateLimit: audit.rateLimit && typeof audit.rateLimit === "object" ? audit.rateLimit : null,
        valuePolicy: typeof audit.valuePolicy === "string" ? audit.valuePolicy : null,
    };
    writeFileSync(AUDIT_LOG_PATH, `${JSON.stringify(record)}\n`, { flag: "a", mode: 0o600 });
}

function isClosedBrokerResponseV2(response) {
    if (!isObject(response)) return false;
    const shared = ["schema", "kind", "protocolVersion", "requestId", "ok"];
    if (
        !hasExactlyKeys(response, shared.concat(["target", "vaultState"])) &&
        !hasExactlyKeys(response, shared.concat(["vaultState"])) &&
        !hasExactlyKeys(response, shared.concat(["target", "fields"])) &&
        !hasExactlyKeys(response, shared.concat(["target", "planId", "fields", "expiresAt"])) &&
        !hasExactlyKeys(response, shared.concat(["target", "planId", "reasonCode", "mode"])) &&
        !hasExactlyKeys(response, shared.concat(["target", "grantId", "planId", "expiresAt", "maxUses"])) &&
        !hasExactlyKeys(response, shared.concat(["target", "grantId", "receipt"])) &&
        !hasExactlyKeys(response, shared.concat(["target", "grantId", "status"])) &&
        !hasExactlyKeys(response, shared.concat(["target", "state", "observationRevision", "genericObservation"])) &&
        !hasExactlyKeys(response, shared.concat(["result", "target"])) &&
        !hasExactlyKeys(response, shared.concat(["result"])) &&
        !hasExactlyKeys(response, shared.concat(["error", "target"])) &&
        !hasExactlyKeys(response, shared.concat(["error"]))
    ) {
        return false;
    }
    if (
        response.schema !== "elf.padloc-broker-response.v2" ||
        response.protocolVersion !== 2 ||
        typeof response.requestId !== "string" ||
        typeof response.ok !== "boolean" ||
        typeof response.kind !== "string"
    ) {
        return false;
    }
    if (response.target !== undefined && !isExactTarget(response.target)) return false;
    if (response.kind === "status") return ["locked", "unlocked", "unknown"].includes(response.vaultState);
    if (response.kind === "classified") {
        return (
            Array.isArray(response.fields) &&
            response.fields.every(
                (field) => isObject(field) && hasExactlyKeys(field, ["selector", "role", "fieldRef"]) &&
                    [field.selector, field.role, field.fieldRef].every((value) => typeof value === "string" && value)
            )
        );
    }
    if (response.kind === "plan") {
        return (
            typeof response.planId === "string" &&
            typeof response.expiresAt === "string" &&
            Array.isArray(response.fields) &&
            response.fields.every(
                (field) =>
                    isObject(field) &&
                    hasExactlyKeys(field, ["fieldRef", "role", "sourceRef", "transactionOnly", "releaseClass"]) &&
                    typeof field.fieldRef === "string" &&
                    typeof field.role === "string" &&
                    typeof field.sourceRef === "string" &&
                    typeof field.transactionOnly === "boolean" &&
                    ["low", "secret", "high-risk"].includes(field.releaseClass)
            )
        );
    }
    if (response.kind === "approval-required") {
        return (
            typeof response.planId === "string" &&
            typeof response.reasonCode === "string" &&
            ["plan", "manual", "auto", "dontAsk"].includes(response.mode)
        );
    }
    if (response.kind === "granted") {
        return (
            typeof response.grantId === "string" &&
            typeof response.planId === "string" &&
            typeof response.expiresAt === "string" &&
            Number.isInteger(response.maxUses) &&
            response.maxUses >= 0
        );
    }
    if (response.kind === "applied") {
        return typeof response.grantId === "string" && isReceipt(response.receipt);
    }
    if (response.kind === "revoked") {
        return typeof response.grantId === "string" && response.status === "revoked";
    }
    if (response.kind === "privacy-status") {
        return (
            ["unknown", "clean", "potentially-private"].includes(response.state) &&
            Number.isInteger(response.observationRevision) &&
            response.observationRevision >= 0 &&
            ["allowed", "blocked", "requires-separate-disclosure"].includes(response.genericObservation)
        );
    }
    if (response.kind === "import-result") {
        return isImportResult(response.result);
    }
    if (response.kind === "error") {
        return isError(response.error);
    }
    return false;
}

function isExactTarget(target) {
    return (
        isObject(target) &&
        hasExactlyKeys(target, [
            "tabId",
            "frameId",
            "origin",
            "documentId",
            "formRef",
            "targetRevision",
            "sessionId",
            "topOrigin",
            "frameOrigin",
        ]) &&
        Number.isInteger(target.tabId) &&
        target.tabId >= 0 &&
        Number.isInteger(target.frameId) &&
        target.frameId >= 0 &&
        [target.origin, target.documentId, target.formRef, target.targetRevision, target.sessionId, target.topOrigin, target.frameOrigin].every(
            (value) => typeof value === "string" && value
        )
    );
}

function isReceipt(receipt) {
    return (
        isObject(receipt) &&
        hasExactlyKeys(receipt, ["receiptId", "status", "filledFieldRefs", "modelDisclosure", "submittedByExecutor"]) &&
        typeof receipt.receiptId === "string" &&
        ["completed", "partial", "revoked", "outcome-unknown"].includes(receipt.status) &&
        Array.isArray(receipt.filledFieldRefs) &&
        receipt.filledFieldRefs.every((value) => typeof value === "string" && value) &&
        ["none", "approved"].includes(receipt.modelDisclosure) &&
        typeof receipt.submittedByExecutor === "boolean"
    );
}

function isError(error) {
    return (
        isObject(error) &&
        (hasExactlyKeys(error, ["schema", "code", "retryable"]) ||
            hasExactlyKeys(error, ["schema", "code", "retryable", "safeMessage"])) &&
        error.schema === "elf.padloc-broker-error.v1" &&
        [
            "LOCKED",
            "DENIED",
            "ASK_REQUIRED",
            "TARGET_MISMATCH",
            "STALE",
            "UNKNOWN_PRIVACY",
            "POTENTIALLY_PRIVATE",
            "INVALID_REQUEST",
            "UNKNOWN_KEY",
            "UNSUPPORTED",
            "EXPIRED",
            "REVOKED",
        ].includes(error.code) &&
        typeof error.retryable === "boolean" &&
        (error.safeMessage === undefined || (typeof error.safeMessage === "string" && error.safeMessage))
    );
}

function isImportResult(result) {
    if (
        !isObject(result) ||
        !hasExactlyKeys(result, [
            "schema",
            "imported",
            "normalized",
            "skipped",
            "lossy",
            "provenance",
            "losses",
            "sourceIdentifiers",
        ]) ||
        result.schema !== "elf.import-result.v1" ||
        ![result.imported, result.normalized, result.skipped, result.lossy].every(
            (value) => Number.isInteger(value) && value >= 0
        ) ||
        !isImportProvenance(result.provenance) ||
        !Array.isArray(result.losses) ||
        !result.losses.every(isImportLoss) ||
        !Array.isArray(result.sourceIdentifiers) ||
        !result.sourceIdentifiers.every((value) => typeof value === "string" && value)
    ) {
        return false;
    }
    return true;
}

function isImportProvenance(value) {
    if (!isObject(value)) return false;
    const keys = ["schema", "source", "sourceId", "importedAt", "importerVersion"];
    const optionalKeys = keys.concat(["sourceItemId"]);
    if (!Object.keys(value).every((key) => optionalKeys.includes(key))) return false;
    return (
        value.schema === "elf.import-provenance.v1" &&
        ["1pux", "compatibility-envelope", "create-item", "synthetic"].includes(value.source) &&
        typeof value.sourceId === "string" &&
        value.sourceId &&
        typeof value.importedAt === "string" &&
        value.importedAt &&
        typeof value.importerVersion === "string" &&
        value.importerVersion &&
        (value.sourceItemId === undefined || value.sourceItemId === null || (typeof value.sourceItemId === "string" && value.sourceItemId))
    );
}

function isImportLoss(value) {
    if (!isObject(value)) return false;
    const keys = ["schema", "sourceItemId", "category", "outcome", "reasonCode"];
    const optionalKeys = keys.concat(["note"]);
    if (!Object.keys(value).every((key) => optionalKeys.includes(key))) return false;
    return (
        value.schema === "elf.import-loss.v1" &&
        typeof value.sourceItemId === "string" &&
        value.sourceItemId &&
        ["passkey", "attachment", "document", "history", "sharing", "totp-parameters", "unsupported-field", "trashed", "unknown-kind"].includes(
            value.category
        ) &&
        ["skipped", "lossy-normalized"].includes(value.outcome) &&
        [
            "UNSUPPORTED_PASSKEY",
            "UNSUPPORTED_ATTACHMENT",
            "UNSUPPORTED_DOCUMENT",
            "UNSUPPORTED_HISTORY",
            "UNSUPPORTED_SHARING",
            "NONEXACT_TOTP_PARAMETERS",
            "UNSUPPORTED_FIELD",
            "TRASHED_ITEM",
            "UNKNOWN_KIND",
        ].includes(value.reasonCode) &&
        (value.note === undefined || value.note === null || (typeof value.note === "string" && value.note))
    );
}

function hasExactlyKeys(value, keys) {
    const actual = Object.keys(value);
    return actual.length === keys.length && actual.every((key) => keys.includes(key));
}

function isObject(value) {
    return Boolean(value && typeof value === "object" && !Array.isArray(value));
}
