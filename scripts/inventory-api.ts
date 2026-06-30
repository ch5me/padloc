/**
 * inventory-api.ts — Extracts API handler definitions from @padloc/core/src/api.ts
 *
 * Produces:
 *   .sisyphus/contract/api-inventory.json
 *   docs/contract/api-inventory.md
 *
 * Run: bun scripts/inventory-api.ts
 */

import { readFileSync, writeFileSync, mkdirSync } from "fs";
import { join, dirname } from "path";
import { fileURLToPath } from "url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, "..");

const API_TS = join(ROOT, "packages/core/src/api.ts");
const ERROR_TS = join(ROOT, "packages/core/src/error.ts");
const HTTP_TS = join(ROOT, "packages/server/src/transport/http.ts");

const OUTPUT_JSON = join(ROOT, ".sisyphus/contract/api-inventory.json");
const OUTPUT_MD = join(ROOT, "docs/contract/api-inventory.md");

interface HandlerRaw {
    method: string;
    inputType: string;
    outputType: string;
    line: number;
    comment?: string;
}

interface HandlerInventoryEntry extends HandlerRaw {
    disposition: "implemented" | "deferred" | "dropped";
    rationale: string;
}

function extractHandlers(source: string): HandlerRaw[] {
    const handlers: HandlerRaw[] = [];
    const lines = source.split("\n");

    for (let i = 0; i < lines.length; i++) {
        const line = lines[i];
        const match = line.match(/@Handler\(\s*(\w+)?\s*,\s*(\w+)?\s*\)/);
        if (!match) continue;

        const inputRaw = match[1] || "undefined";
        const outputRaw = match[2] || "undefined";

        let methodLine = "";
        let methodIndex = i + 1;
        const commentLines: string[] = [];

        while (methodIndex < lines.length) {
            const candidate = lines[methodIndex].trim();
            if (candidate.startsWith("/**")) {
                let j = methodIndex;
                while (j < lines.length) {
                    commentLines.push(lines[j].trim());
                    if (lines[j].trim().endsWith("*/")) {
                        methodIndex = j + 1;
                        break;
                    }
                    j++;
                }
                if (methodIndex < lines.length && lines[methodIndex].trim()) {
                    methodLine = lines[methodIndex].trim();
                    break;
                }
                continue;
            }
            if (candidate && !candidate.startsWith("@")) {
                methodLine = candidate;
                break;
            }
            methodIndex++;
        }

        if (!methodLine) continue;

        const methodMatch = methodLine.match(/^(\w+)\s*\(/);
        if (!methodMatch) continue;

        const methodName = methodMatch[1];
        const inputType = inputRaw === "String" ? "string" : inputRaw;
        const outputType = outputRaw === "String" ? "string" : outputRaw;

        const comment = commentLines
            .map((l) =>
                l
                    .replace(/^\s*\/?\*\*?\s*/, "")
                    .replace(/\*\/\s*$/, "")
                    .trim()
            )
            .filter(Boolean)
            .join(" ");

        handlers.push({
            method: methodName,
            inputType,
            outputType,
            line: i + 1,
            comment: comment || undefined,
        });
    }

    return handlers;
}

function extractErrorCodes(source: string): { code: string; value: string }[] {
    const codes: { code: string; value: string }[] = [];
    const pattern = /(\w+)\s*=\s*"([^"]+)"\s*,?/g;
    let match;

    while ((match = pattern.exec(source)) !== null) {
        const before = source.slice(Math.max(0, match.index - 10), match.index);
        if (before.includes("//")) continue;

        codes.push({ code: match[1].toLowerCase(), value: match[2] });
    }

    return codes;
}

function classifyHandlers(handlers: HandlerRaw[]): HandlerInventoryEntry[] {
    const serverSource = readFileSync(join(ROOT, "packages/core/src/server.ts"), "utf-8");

    return handlers.map((h) => {
        const methodPattern = new RegExp(`async ${h.method}\\s*\\(|${h.method}\\s*\\(`);
        const isImplemented = methodPattern.test(serverSource);

        let disposition: "implemented" | "deferred" | "dropped" = "implemented";
        let rationale = "";

        if (!isImplemented) {
            disposition = "deferred";
            rationale = "Not yet implemented in Controller; stub in API only";
        }

        switch (h.method) {
            case "getLegacyData":
                rationale = "V3 migration helper — retrieves legacy PBES2Container for account migration";
                break;
            case "deleteLegacyAccount":
                rationale = "V3 migration helper — deletes v3 account after migration to v4";
                break;
            case "listAccounts":
                rationale = "Admin/debug endpoint — lists all accounts with pagination";
                break;
            case "listOrgs":
                rationale = "Admin/debug endpoint — lists all organizations with pagination";
                break;
            case "listChangeLogEntries":
                rationale = "Admin/audit endpoint — retrieves change log with pagination";
                break;
            case "listRequestLogEntries":
                rationale = "Admin/audit endpoint — retrieves request log with pagination";
                break;
            case "acceptInvite":
                rationale = "Used during org onboarding flow";
                break;
            case "createAttachment":
                rationale = "Creates attachment metadata; returns attachment ID for blob upload";
                break;
            case "removeTrustedDevice":
                rationale = "Removes a trusted device from auth.mfaOrder/trustedDevices list";
                break;
            case "startRegisterAuthenticator":
            case "completeRegisterAuthenticator":
            case "deleteAuthenticator":
                rationale = "MFA authenticator registration lifecycle";
                break;
            default:
                if (!rationale) {
                    rationale = "Implemented in server.ts:Controller";
                }
        }

        return {
            method: h.method,
            inputType: h.inputType,
            outputType: h.outputType,
            disposition,
            rationale,
            sourceLine: h.line,
            comment: h.comment,
        };
    });
}

const AUTH_FLOW = {
    flow: "Authentication & Session Establishment",
    steps: [
        {
            step: 1,
            handler: "startAuthRequest",
            description:
                "Client initiates authentication with email, auth type, and purpose (Login/Signup/Recover). " +
                "Server creates an AuthRequest, checks device trust, returns request ID and token.",
        },
        {
            step: 2,
            handler: "completeAuthRequest",
            description:
                "Client submits authenticator response (e.g., email code, TOTP). " +
                "Server verifies via AuthServer, marks request as Verified. " +
                "Returns accountStatus, deviceTrusted, provisioning, and legacyData.",
        },
        {
            step: 3,
            handler: "startCreateSession",
            description:
                "Client requests SRP session init. Requires authToken from step 2 unless device is trusted. " +
                "Server creates SRPSession, returns accountId, keyParams, SRP B value, and srpId.",
        },
        {
            step: 4,
            handler: "completeCreateSession",
            description:
                "Client submits SRP A, M values for verification. " +
                "Server validates SRP proof, creates Session object, stores session key. " +
                "Returns Session (with key stripped). Optionally adds device to trusted devices.",
        },
    ],
};

const apiSource = readFileSync(API_TS, "utf-8");
const extractedHandlers = extractHandlers(apiSource);

const errorSource = readFileSync(ERROR_TS, "utf-8");
const errorCodes = extractErrorCodes(errorSource);

const inventory = classifyHandlers(extractedHandlers);

const inventoryJson = {
    generated: new Date().toISOString(),
    source: "packages/core/src/api.ts",
    totalHandlers: inventory.length,
    errorCodes,
    authFlow: AUTH_FLOW,
    httpErrorShape: {
        source: "packages/server/src/transport/http.ts",
        success: {
            status: 200,
            headers: {
                "Content-Type": "application/json; charset=utf-8",
            },
            body: "Response.toRaw(clientVersion) — { result: any, error?: { code: string, message: string }, auth?: {...} }",
        },
        clientError: {
            status: 400,
            body: "Generic JSON parse/marshal failures; specific error in Response.error field",
        },
        methodNotAllowed: {
            status: 405,
            description: "Returned for unsupported HTTP methods (non-POST/non-OPTIONS/non-healthcheck-GET)",
        },
        maxRequestSize: {
            status: "stream destroyed",
            code: "MAX_REQUEST_SIZE_EXCEEDED",
            note: "Request is destroyed mid-stream when size exceeds config.maxRequestSize",
        },
    },
    handlers: inventory,
};

mkdirSync(dirname(OUTPUT_JSON), { recursive: true });
mkdirSync(dirname(OUTPUT_MD), { recursive: true });

writeFileSync(OUTPUT_JSON, JSON.stringify(inventoryJson, null, 2));

function mdTable(headers: string[], rows: string[][]): string {
    const headerRow = `| ${headers.join(" | ")} |`;
    const separator = `| ${headers.map(() => "---").join(" | ")} |`;
    const dataRows = rows.map((r) => `| ${r.join(" | ")} |`);
    return [headerRow, separator, ...dataRows].join("\n");
}

const mdLines: string[] = [];

mdLines.push("# Padloc API Contract Inventory");
mdLines.push("");
mdLines.push(`> Generated: ${new Date().toISOString()}`);
mdLines.push(`> Source: \`packages/core/src/api.ts\``);
mdLines.push(`> Total handlers: ${inventory.length}`);
mdLines.push("");

mdLines.push("## Auth Flow");
mdLines.push("");
mdLines.push(`The authentication & session establishment flow consists of ${AUTH_FLOW.steps.length} steps:`);
mdLines.push("");
for (const step of AUTH_FLOW.steps) {
    mdLines.push(`**Step ${step.step}: \`${step.handler}\`**`);
    mdLines.push(step.description);
    mdLines.push("");
}

mdLines.push("## Error Codes");
mdLines.push("");
mdLines.push("From `packages/core/src/error.ts`:");
mdLines.push("");
mdLines.push(
    mdTable(
        ["Code", "Value"],
        errorCodes.map((e) => [e.code, `\`${e.value}\``])
    )
);
mdLines.push("");

mdLines.push("## HTTP Error Shape");
mdLines.push("");
mdLines.push("From `packages/server/src/transport/http.ts` (lines 78-106):");
mdLines.push("");
mdLines.push(
    "- **Success (200)**: `Content-Type: application/json; charset=utf-8`. Body is `marshal(Response.toRaw())`."
);
mdLines.push(
    "- **Bad Request (400)**: Returned on any exception during request processing, including parse/decode failures."
);
mdLines.push("- **Method Not Allowed (405)**: For unsupported HTTP methods.");
mdLines.push("- **Max Request Size**: Stream destroyed mid-read when exceeding `config.maxRequestSize` (default 1GB).");
mdLines.push("- **Error envelope**: `{ code: string, message: string, stack?: string }` — via `Err.toRaw()`.");
mdLines.push("");

mdLines.push("## API Handlers");
mdLines.push("");
mdLines.push(
    mdTable(
        ["#", "Method", "ParamType", "ReturnType", "Disposition", "Rationale", "Line"],
        inventory.map((h, i) => [
            `${i + 1}`,
            `\`${h.method}\``,
            `\`${h.inputType}\``,
            `\`${h.outputType}\``,
            h.disposition,
            h.rationale,
            `L${h.sourceLine}`,
        ])
    )
);
mdLines.push("");

mdLines.push("## Notes");
mdLines.push("");
mdLines.push(
    "- `String` param type maps to `string` in inventory; decorator converts `String` → `undefined` in handlerDefinitions."
);
mdLines.push("- Handlers with `undefined` param type use no input (e.g., `getAuthInfo()`).");
mdLines.push("- Handlers with `undefined` return type return `void` (no serialized output).");
mdLines.push("- The `@Handler` decorator populates `API.handlerDefinitions[]` at decoration time for reflection.");
mdLines.push("");

writeFileSync(OUTPUT_MD, mdLines.join("\n"));

const evidenceLines: string[] = [];
evidenceLines.push("# Task 1 Evidence — API Contract Inventory");
evidenceLines.push("");
evidenceLines.push(`Run date: ${new Date().toISOString()}`);
evidenceLines.push(`Script: scripts/inventory-api.ts`);
evidenceLines.push(`Source: ${API_TS}`);
evidenceLines.push(`Total handlers extracted: ${inventory.length}`);
evidenceLines.push(`Expected range: 39-45`);
evidenceLines.push(`Status: ${inventory.length >= 39 && inventory.length <= 45 ? "PASS" : "FAIL"}`);
evidenceLines.push("");
evidenceLines.push("All handler methods:");
evidenceLines.push(inventory.map((h, i) => `  ${i + 1}. ${h.method}`).join("\n"));
evidenceLines.push("");
evidenceLines.push("Error codes extracted:");
evidenceLines.push(errorCodes.map((e) => `  - ${e.code}: "${e.value}"`).join("\n"));
evidenceLines.push("");
evidenceLines.push(
    "Auth flow documented: startAuthRequest → completeAuthRequest → startCreateSession → completeCreateSession"
);
evidenceLines.push("");
evidenceLines.push(
    "HTTP error shape captured from packages/server/src/transport/http.ts:38-50 (config) + 78-106 (POST handler)."
);
evidenceLines.push("");

const evidencePath = join(ROOT, ".sisyphus/evidence/task-1-contract-inventory.txt");
writeFileSync(evidencePath, evidenceLines.join("\n"));

const learningsPath = join(ROOT, ".sisyphus/notepads/padloc-cloudflare-native-backend/learnings.md");

const learningsMd = [
    "# Padloc Cloudflare Native Backend — Learnings",
    "",
    "> Appended by Task 1 (API Contract Inventory)",
    "",
    "## Patterns Discovered",
    "",
    "### 1. Decorator-Driven API Definition",
    "",
    "- API handlers are defined via `@Handler(ParamType, ResponseType)` decorator on methods of the `API` class.",
    "- The decorator populates `API.handlerDefinitions[]` at decoration time — a reflection table used by the transport layer.",
    "- `String` constructor is mapped to `undefined` in handlerDefinitions (line 433: `input: input === String ? undefined : ...`).",
    "- Param types that are `Serializable` subclasses get auto-deserialized via `def.input().fromRaw(param)` in `Controller.process()`.",
    "",
    "### 2. Transport Protocol",
    "",
    "- Single HTTP POST endpoint serves all API methods.",
    "- Request envelope: `{ method: string, params?: any[], auth?: RequestAuthentication, device?: DeviceInfo }`",
    "- Response envelope: `{ result: any, error?: { code: string, message: string }, auth?: RequestAuthentication }`",
    "- Request/response serialization via `marshal/unmarshal` in `@padloc/core/src/encoding`.",
    "- Authentication via session-based signature verification (not HTTP headers/cookies).",
    "- All errors returned in `Response.error` field with HTTP 200, except transport-level errors (400/405).",
    "",
    "### 3. Error Handling Shape",
    "",
    "- `Err.toRaw()` returns `{ code: string, message: string, stack?: string }`.",
    '- Error codes are snake_case strings (e.g., `"invalid_session"`).',
    "- Quota errors are commented out in error.ts — org/vault/member limits defined but not active.",
    "- Provisioning errors exist: `PROVISIONING_QUOTA_EXCEEDED`, `PROVISIONING_NOT_ALLOWED`.",
    '- MFA errors use email-specific naming: `"email_verification_required"`, `"email_verification_failed"`, `"email_verification_tries_exceeded"`.',
    "",
    "### 4. Auth Flow",
    "",
    "- Four-step SRP-based authentication with email verification:",
    "  1. `startAuthRequest` → initiate with email, get request ID",
    "  2. `completeAuthRequest` → submit code/proof, get verified token",
    "  3. `startCreateSession` → get SRP params (B, srpId, keyParams)",
    "  4. `completeCreateSession` → submit SRP proof (A, M), get Session",
    "- Device trust model: trusted devices can skip email verification.",
    "- `updateAuth` between auth and session steps allows password change.",
    "- Admin login uses `asAdmin` flag in `startCreateSession`.",
    "",
    "### 5. Handler Count",
    "",
    `- Total: ${inventory.length} handlers`,
    "- Account-related: ~10",
    "- Org-related: ~4",
    "- Vault-related: ~4",
    "- Auth-related: ~9",
    "- Admin/List: ~4",
    "- Legacy/Migration: ~2",
    "- Attachment: ~3",
    "- KeyStore: ~3",
    "",
].join("\n");

writeFileSync(learningsPath, learningsMd);

console.log(`\n${inventory.length} handlers extracted from ${API_TS}`);
console.log(`Output: ${OUTPUT_JSON}`);
console.log(`Output: ${OUTPUT_MD}`);
console.log(`Evidence: ${evidencePath}`);
console.log(`Learnings: ${learningsPath}`);
console.log("Done.");
