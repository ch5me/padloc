import {
    Field,
    FieldType,
    PasskeyAuditDecision,
    PasskeyAuditEntry,
    PasskeyCredential,
    PasskeyCredentialPolicy,
    PasskeyRateLimitPolicy,
    PasskeyTimeWindowPolicy,
    VaultItem,
    VaultItemKind,
    isPasskeyCredentialItem,
} from "../../core/src/item";
import { base64ToBytes, bytesToBase64, stringToBytes } from "../../core/src/encoding";
import {
    AUTOFILL_BROKER_PROTOCOL_VERSION,
    AutofillBrokerRequest,
    AutofillBrokerResponse,
    BrokerAudit,
    PasskeyAssertionPayload,
    PasskeyAssertionRequest,
    PasskeyEnrollmentRequest,
    PasskeyRateLimitState,
    PasskeyRegistrationPayload,
} from "./autofill-broker-protocol";

export type PasskeyAssertionReason =
    | "credential_not_found"
    | "binding_expired"
    | "binding_rp_id_mismatch"
    | "binding_top_origin_mismatch"
    | "binding_flow_id_mismatch"
    | "flow_binding_required"
    | "nonce_required"
    | "reused_nonce"
    | "emergency_lockout"
    | "rp_id_not_allowed"
    | "top_origin_not_allowed"
    | "vendor_flow_not_allowed"
    | "approval_required"
    | "time_window_denied"
    | "rate_limit_day_exceeded"
    | "rate_limit_week_exceeded"
    | "challenge_required";

interface PasskeyCredentialMatch {
    item: VaultItem & { passkeyCredential: PasskeyCredential };
    credential: PasskeyCredential;
}

export interface EnrollPasskeyResult {
    itemName: string;
    icon: string;
    fields: Field[];
    itemKind: VaultItemKind.PasskeyCredential;
    passkeyCredential: PasskeyCredential;
    response: AutofillBrokerResponse;
}

export interface RequestAssertionResult {
    updatedItem?: VaultItem & { passkeyCredential: PasskeyCredential };
    response: AutofillBrokerResponse;
}

export async function enrollPasskeyCredential(
    request: AutofillBrokerRequest,
    now = new Date()
): Promise<EnrollPasskeyResult> {
    const enrollment = requirePasskeyEnrollmentRequest(request);
    const algorithm = enrollment.algorithm || "ES256";
    if (algorithm !== "ES256") {
        throw new Error(`Unsupported passkey algorithm: ${algorithm}`);
    }

    const cryptoApi = await getWebCrypto();
    const keyPair = await cryptoApi.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, ["sign", "verify"]);
    if (!keyPair.publicKey || !keyPair.privateKey) {
        throw new Error("Passkey key generation failed");
    }
    const credentialIdBytes = await randomBytes(cryptoApi, 32);
    const userHandleBytes = enrollment.userHandle ? stringToBytes(enrollment.userHandle) : await randomBytes(cryptoApi, 16);
    const publicKeySpkiBytes = new Uint8Array(await cryptoApi.subtle.exportKey("spki", keyPair.publicKey));
    const privateKeyPkcs8Bytes = new Uint8Array(await cryptoApi.subtle.exportKey("pkcs8", keyPair.privateKey));
    const publicKeyJwk = await cryptoApi.subtle.exportKey("jwk", keyPair.publicKey);
    const cosePublicKey = encodeCoseEc2PublicKey(publicKeyJwk);
    const attestedAuthData = await buildAttestedCredentialData(enrollment.rpId, credentialIdBytes, cosePublicKey);
    const attestationObject = encodeAttestationObject(attestedAuthData);
    const createdAt = new Date(now);

    const passkeyCredential = new PasskeyCredential({
        algorithm,
        credentialId: bytesToBase64(credentialIdBytes),
        rpId: enrollment.rpId,
        privateKeyFieldIndex: 0,
        publicKeySpki: bytesToBase64(publicKeySpkiBytes),
        publicKeyJwk: normalizePublicKeyJwk(publicKeyJwk),
        signCount: 0,
        userHandle: bytesToBase64(userHandleBytes),
        createdAt,
        policy: new PasskeyCredentialPolicy(enrollment.policy),
        auditTrail: [],
    });

    const auditEntry = makeAuditEntry({
        operation: "enroll-passkey",
        decision: "allow",
        reason: "enrolled",
        request,
        credential: passkeyCredential,
        rateLimit: defaultRateLimitState(passkeyCredential.policy.rateLimit),
        now,
    });
    passkeyCredential.auditTrail = [auditEntry];

    const registration: PasskeyRegistrationPayload = {
        credentialId: passkeyCredential.credentialId,
        rpId: passkeyCredential.rpId,
        algorithm: passkeyCredential.algorithm,
        userHandle: passkeyCredential.userHandle,
        createdAt: createdAt.toISOString(),
        publicKeySpki: passkeyCredential.publicKeySpki,
        publicKeyJwk: passkeyCredential.publicKeyJwk,
        credentialPublicKeyCose: bytesToBase64(cosePublicKey),
        authenticatorData: bytesToBase64(attestedAuthData),
        attestationObject: bytesToBase64(attestationObject),
        policy: {
            approval: passkeyCredential.policy.approval,
            requireFlowBinding: passkeyCredential.policy.requireFlowBinding,
        },
    };

    const itemName = enrollment.itemName || `Passkey ${enrollment.rpId}`;
    const fields = [
        new Field({ name: "Private Key", type: FieldType.Password, value: bytesToBase64(privateKeyPkcs8Bytes) }),
        new Field({ name: "RP ID", type: FieldType.Url, value: `https://${enrollment.rpId}` }),
        new Field({ name: "Credential ID", type: FieldType.Text, value: passkeyCredential.credentialId }),
        new Field({ name: "User Handle", type: FieldType.Text, value: passkeyCredential.userHandle }),
    ];

    return {
        itemName,
        icon: "security",
        fields,
        itemKind: VaultItemKind.PasskeyCredential,
        passkeyCredential,
        response: {
            ok: true,
            protocolVersion: AUTOFILL_BROKER_PROTOCOL_VERSION,
            requestId: request.requestId,
            vaultState: "unlocked",
            reason: null,
            passkey: {
                itemName,
                rpId: passkeyCredential.rpId,
                approval: passkeyCredential.policy.approval,
                registration,
                decision: "allow",
                reasonCode: null,
                rateLimit: defaultRateLimitState(passkeyCredential.policy.rateLimit),
            },
            audit: buildAudit({
                request,
                operation: "enroll-passkey",
                decision: "allow",
                reason: "enrolled",
                rateLimit: defaultRateLimitState(passkeyCredential.policy.rateLimit),
            }),
        },
    };
}

export async function requestPasskeyAssertion(
    request: AutofillBrokerRequest,
    items: VaultItem[],
    now = new Date()
): Promise<RequestAssertionResult> {
    const assertionRequest = requirePasskeyAssertionRequest(request);
    const match = findPasskeyCredential(items, assertionRequest.credentialId);
    if (!match) {
        return denyWithoutItem(request, "credential_not_found", null);
    }

    const { item } = match;
    const credential = cloneCredential(item.passkeyCredential);
    const rateLimitBefore = measureRateLimit(credential, now);
    const denial = evaluateAssertionPolicy(request, assertionRequest, credential, rateLimitBefore, now);
    if (denial) {
        appendAudit(credential, makeAuditEntry({
            operation: "request-assertion",
            decision: "deny",
            reason: denial,
            request,
            credential,
            rateLimit: rateLimitBefore,
            now,
        }));
        return {
            updatedItem: new VaultItem({ ...item, passkeyCredential: credential }) as VaultItem & { passkeyCredential: PasskeyCredential },
            response: denyResponse(request, credential, denial, rateLimitBefore),
        };
    }

    const cryptoApi = await getWebCrypto();
    const clientDataHash = await resolveClientDataHash(assertionRequest, cryptoApi);
    const nextSignCount = credential.signCount + 1;
    const authenticatorData = await buildAssertionAuthenticatorData(credential.rpId, nextSignCount);
    const signedPayload = concatBytes(authenticatorData, clientDataHash);
    const privateKeyPkcs8 = readStoredPrivateKey(item, credential);
    const importedPrivateKey = await cryptoApi.subtle.importKey(
        "pkcs8",
        base64ToBytes(privateKeyPkcs8),
        { name: "ECDSA", namedCurve: "P-256" },
        false,
        ["sign"]
    );
    const rawSignature = new Uint8Array(
        await cryptoApi.subtle.sign({ name: "ECDSA", hash: "SHA-256" }, importedPrivateKey, signedPayload)
    );
    const derSignature = rawEcdsaSignatureToDer(rawSignature);

    credential.signCount = nextSignCount;
    const rateLimitAfter = measureRateLimit(credential, now, true);
    appendAudit(credential, makeAuditEntry({
        operation: "request-assertion",
        decision: "allow",
        reason: "allowed",
        request,
        credential,
        rateLimit: rateLimitAfter,
        now,
    }));

    const assertion: PasskeyAssertionPayload = {
        credentialId: credential.credentialId,
        authenticatorData: bytesToBase64(authenticatorData),
        signature: bytesToBase64(derSignature),
        userHandle: credential.userHandle,
        signCount: credential.signCount,
    };

    return {
        updatedItem: new VaultItem({ ...item, passkeyCredential: credential }) as VaultItem & { passkeyCredential: PasskeyCredential },
        response: {
            ok: true,
            protocolVersion: AUTOFILL_BROKER_PROTOCOL_VERSION,
            requestId: request.requestId,
            vaultState: "unlocked",
            reason: null,
            approvalId: assertionRequest.approvalId,
            passkey: {
                itemId: item.id,
                itemName: item.name,
                rpId: credential.rpId,
                topOrigin: assertionRequest.topOrigin,
                vendor: assertionRequest.vendor || null,
                flowId: assertionRequest.flowId || null,
                nonce: assertionRequest.nonce || null,
                approval: credential.policy.approval,
                assertion,
                decision: "allow",
                reasonCode: null,
                rateLimit: rateLimitAfter,
            },
            audit: buildAudit({
                request,
                operation: "request-assertion",
                decision: "allow",
                reason: "allowed",
                approvalId: assertionRequest.approvalId || null,
                rateLimit: rateLimitAfter,
            }),
        },
    };
}

export function findPasskeyCredential(items: VaultItem[], credentialId: string): PasskeyCredentialMatch | null {
    for (const item of items) {
        if (!isPasskeyCredentialItem(item)) continue;
        if (item.passkeyCredential.credentialId === credentialId) {
            return {
                item: item as VaultItem & { passkeyCredential: PasskeyCredential },
                credential: item.passkeyCredential,
            };
        }
    }
    return null;
}

export async function verifyAssertionSignature(
    credential: PasskeyCredential,
    assertion: PasskeyAssertionPayload,
    request: PasskeyAssertionRequest
): Promise<boolean> {
    const cryptoApi = await getWebCrypto();
    const importedPublicKey = await cryptoApi.subtle.importKey(
        "spki",
        base64ToBytes(credential.publicKeySpki),
        { name: "ECDSA", namedCurve: "P-256" },
        false,
        ["verify"]
    );
    const clientDataHash = await resolveClientDataHash(request, cryptoApi);
    const signedPayload = concatBytes(base64ToBytes(assertion.authenticatorData), clientDataHash);
    const rawSignature = derEcdsaSignatureToRaw(base64ToBytes(assertion.signature), 32);
    return cryptoApi.subtle.verify({ name: "ECDSA", hash: "SHA-256" }, importedPublicKey, rawSignature, signedPayload);
}

function requirePasskeyEnrollmentRequest(request: AutofillBrokerRequest): PasskeyEnrollmentRequest {
    if (request.type !== "enroll-passkey" || !request.passkey) {
        throw new Error("Passkey enrollment requires passkey payload");
    }
    const enrollment = request.passkey as PasskeyEnrollmentRequest;
    if (!enrollment.rpId || !enrollment.policy) {
        throw new Error("Passkey enrollment requires rpId and policy");
    }
    return enrollment;
}

function requirePasskeyAssertionRequest(request: AutofillBrokerRequest): PasskeyAssertionRequest {
    if (request.type !== "request-assertion" || !request.passkey) {
        throw new Error("Passkey assertion requires passkey payload");
    }
    const assertion = request.passkey as PasskeyAssertionRequest;
    if (!assertion.credentialId || !assertion.rpId || !assertion.topOrigin) {
        throw new Error("Passkey assertion requires credentialId, rpId, and topOrigin");
    }
    return assertion;
}

function evaluateAssertionPolicy(
    request: AutofillBrokerRequest,
    assertion: PasskeyAssertionRequest,
    credential: PasskeyCredential,
    rateLimit: PasskeyRateLimitState,
    now: Date
): PasskeyAssertionReason | null {
    const binding = request.binding;
    if (binding?.expiresAt && Date.parse(binding.expiresAt) <= now.getTime()) return "binding_expired";
    if (binding?.rpId && binding.rpId !== assertion.rpId) return "binding_rp_id_mismatch";
    if (binding?.topOrigin && binding.topOrigin !== assertion.topOrigin) return "binding_top_origin_mismatch";
    if (binding?.flowId && assertion.flowId !== binding.flowId) return "binding_flow_id_mismatch";
    if (credential.policy.requireFlowBinding && !assertion.flowId) return "flow_binding_required";
    const nonce = assertion.nonce || binding?.nonce || null;
    if (!nonce) return "nonce_required";
    if (credential.auditTrail.some((entry) => entry.nonce === nonce)) return "reused_nonce";
    if (credential.policy.emergencyLockout) return "emergency_lockout";
    if (!credential.policy.allowedRpIds.includes(assertion.rpId)) return "rp_id_not_allowed";
    if (!credential.policy.allowedTopOrigins.includes(assertion.topOrigin)) return "top_origin_not_allowed";
    const requestedVendorFlow = assertion.vendor || binding?.vendor || "";
    if (credential.policy.allowedVendorFlows.length && !credential.policy.allowedVendorFlows.includes(requestedVendorFlow)) {
        return "vendor_flow_not_allowed";
    }
    if (credential.policy.approval === "push_required" && !assertion.approvalId) return "approval_required";
    if (!isWithinAllowedTimeWindow(credential.policy.timeWindows, now)) return "time_window_denied";
    if (rateLimit.maxPerDay !== null && rateLimit.dayCount >= rateLimit.maxPerDay) return "rate_limit_day_exceeded";
    if (rateLimit.maxPerWeek !== null && rateLimit.weekCount >= rateLimit.maxPerWeek) return "rate_limit_week_exceeded";
    if (!assertion.clientDataHash && !assertion.challenge) return "challenge_required";
    return null;
}

function denyWithoutItem(
    request: AutofillBrokerRequest,
    reason: PasskeyAssertionReason,
    rateLimit: PasskeyRateLimitState | null
): RequestAssertionResult {
    const response = {
        ok: false,
        protocolVersion: AUTOFILL_BROKER_PROTOCOL_VERSION,
        requestId: request.requestId,
        vaultState: "unlocked",
        reason,
        passkey: {
            decision: "deny",
            reasonCode: reason,
            rateLimit: rateLimit || undefined,
        },
        audit: buildAudit({
            request,
            operation: "request-assertion",
            decision: "deny",
            reason,
            rateLimit: rateLimit || undefined,
        }),
    } as AutofillBrokerResponse;
    return {
        response,
    };
}

function denyResponse(
    request: AutofillBrokerRequest,
    credential: PasskeyCredential,
    reason: PasskeyAssertionReason,
    rateLimit: PasskeyRateLimitState
): AutofillBrokerResponse {
    return {
        ok: false,
        protocolVersion: AUTOFILL_BROKER_PROTOCOL_VERSION,
        requestId: request.requestId,
        vaultState: "unlocked",
        reason,
        approvalId: (request.passkey as PasskeyAssertionRequest).approvalId,
        passkey: {
            rpId: credential.rpId,
            topOrigin: (request.passkey as PasskeyAssertionRequest).topOrigin,
            vendor: (request.passkey as PasskeyAssertionRequest).vendor || null,
            flowId: (request.passkey as PasskeyAssertionRequest).flowId || null,
            nonce: (request.passkey as PasskeyAssertionRequest).nonce || request.binding?.nonce || null,
            approval: credential.policy.approval,
            decision: "deny",
            reasonCode: reason,
            rateLimit,
        },
        audit: buildAudit({
            request,
            operation: "request-assertion",
            decision: "deny",
            reason,
            approvalId: (request.passkey as PasskeyAssertionRequest).approvalId || null,
            rateLimit,
        }),
    };
}

function buildAudit({
    request,
    operation,
    decision,
    reason,
    approvalId = null,
    rateLimit,
}: {
    request: AutofillBrokerRequest;
    operation: BrokerAudit["operation"];
    decision: PasskeyAuditDecision;
    reason: string;
    approvalId?: string | null;
    rateLimit?: PasskeyRateLimitState;
}): BrokerAudit {
    const passkey = (request.passkey || {}) as Partial<PasskeyEnrollmentRequest & PasskeyAssertionRequest>;
    return {
        operation,
        sessionId: request.binding?.sessionId || null,
        origin: request.binding?.origin || passkey.topOrigin || null,
        fieldCount: request.fields?.length || 0,
        valuePolicy: "redacted audit only; no raw autofill values or passkey secrets",
        actor: request.binding?.sessionId || passkey.accountId || null,
        profileId: request.binding?.profileId || passkey.profileId || null,
        vendor: request.binding?.vendor || passkey.vendor || null,
        rpId: request.binding?.rpId || passkey.rpId || null,
        topOrigin: request.binding?.topOrigin || passkey.topOrigin || null,
        decision,
        reason,
        approvalId,
        flowId: request.binding?.flowId || passkey.flowId || null,
        nonce: request.binding?.nonce || passkey.nonce || null,
        rateLimit,
    };
}

function makeAuditEntry({
    operation,
    decision,
    reason,
    request,
    credential,
    rateLimit,
    now,
}: {
    operation: "enroll-passkey" | "request-assertion";
    decision: PasskeyAuditDecision;
    reason: string;
    request: AutofillBrokerRequest;
    credential: PasskeyCredential;
    rateLimit: PasskeyRateLimitState;
    now: Date;
}): PasskeyAuditEntry {
    const passkey = (request.passkey || {}) as Partial<PasskeyEnrollmentRequest & PasskeyAssertionRequest>;
    return new PasskeyAuditEntry({
        operation,
        decision,
        reason,
        actor: request.binding?.sessionId || passkey.accountId || null,
        profileId: request.binding?.profileId || passkey.profileId || null,
        vendor: request.binding?.vendor || passkey.vendor || null,
        rpId: credential.rpId || passkey.rpId || null,
        topOrigin: request.binding?.topOrigin || passkey.topOrigin || null,
        flowId: request.binding?.flowId || passkey.flowId || null,
        nonce: request.binding?.nonce || passkey.nonce || null,
        approvalId: passkey.approvalId || null,
        rateLimitDayCount: rateLimit.dayCount,
        rateLimitWeekCount: rateLimit.weekCount,
        createdAt: new Date(now),
    });
}

function appendAudit(credential: PasskeyCredential, auditEntry: PasskeyAuditEntry): void {
    credential.auditTrail = [...credential.auditTrail, auditEntry];
}

function measureRateLimit(credential: PasskeyCredential, now: Date, includeCurrent = false): PasskeyRateLimitState {
    const counts = countAllowedAssertions(credential.auditTrail, now);
    return {
        dayCount: counts.dayCount + (includeCurrent ? 1 : 0),
        weekCount: counts.weekCount + (includeCurrent ? 1 : 0),
        maxPerDay: credential.policy.rateLimit.maxPerDay ?? null,
        maxPerWeek: credential.policy.rateLimit.maxPerWeek ?? null,
    };
}

function countAllowedAssertions(auditTrail: PasskeyAuditEntry[], now: Date): { dayCount: number; weekCount: number } {
    const nowMs = now.getTime();
    const dayAgo = nowMs - 24 * 60 * 60 * 1000;
    const weekAgo = nowMs - 7 * 24 * 60 * 60 * 1000;
    let dayCount = 0;
    let weekCount = 0;
    for (const entry of auditTrail) {
        if (entry.operation !== "request-assertion" || entry.decision !== "allow") continue;
        const createdAtMs = entry.createdAt.getTime();
        if (createdAtMs >= dayAgo) dayCount += 1;
        if (createdAtMs >= weekAgo) weekCount += 1;
    }
    return { dayCount, weekCount };
}

function defaultRateLimitState(policy: PasskeyRateLimitPolicy): PasskeyRateLimitState {
    return {
        dayCount: 0,
        weekCount: 0,
        maxPerDay: policy.maxPerDay ?? null,
        maxPerWeek: policy.maxPerWeek ?? null,
    };
}

function isWithinAllowedTimeWindow(timeWindows: PasskeyTimeWindowPolicy[], now: Date): boolean {
    if (!timeWindows.length) return true;
    return timeWindows.some((window) => matchesTimeWindow(window, now));
}

function matchesTimeWindow(window: PasskeyTimeWindowPolicy, now: Date): boolean {
    const locale = "en-US";
    const timeZone = window.timezone || "UTC";
    const formatter = new Intl.DateTimeFormat(locale, {
        timeZone,
        hour12: false,
        weekday: "short",
        hour: "2-digit",
        minute: "2-digit",
    });
    const parts = formatter.formatToParts(now);
    const weekday = parts.find((part) => part.type === "weekday")?.value || "Sun";
    const hour = Number(parts.find((part) => part.type === "hour")?.value || "0");
    const minute = Number(parts.find((part) => part.type === "minute")?.value || "0");
    const minuteOfDay = hour * 60 + minute;
    const weekdayIndex = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"].indexOf(weekday);
    if (window.daysOfWeek?.length && !window.daysOfWeek.includes(weekdayIndex)) return false;
    if (window.startMinute <= window.endMinute) {
        return minuteOfDay >= window.startMinute && minuteOfDay <= window.endMinute;
    }
    return minuteOfDay >= window.startMinute || minuteOfDay <= window.endMinute;
}

async function resolveClientDataHash(
    request: PasskeyAssertionRequest,
    cryptoApi: Crypto
): Promise<Uint8Array> {
    if (request.clientDataHash) {
        return base64ToBytes(request.clientDataHash);
    }
    const clientDataJson = JSON.stringify({
        type: "webauthn.get",
        challenge: request.challenge,
        origin: request.topOrigin,
        crossOrigin: false,
    });
    return new Uint8Array(await cryptoApi.subtle.digest("SHA-256", stringToBytes(clientDataJson)));
}

async function buildAttestedCredentialData(
    rpId: string,
    credentialId: Uint8Array,
    credentialPublicKey: Uint8Array
): Promise<Uint8Array> {
    const rpIdHash = await sha256(stringToBytes(rpId));
    const flags = new Uint8Array([0x41]);
    const signCount = new Uint8Array([0x00, 0x00, 0x00, 0x00]);
    const aaguid = new Uint8Array(16);
    const credentialLength = new Uint8Array([(credentialId.length >> 8) & 0xff, credentialId.length & 0xff]);
    return concatBytes(rpIdHash, flags, signCount, aaguid, credentialLength, credentialId, credentialPublicKey);
}

async function buildAssertionAuthenticatorData(rpId: string, signCount: number): Promise<Uint8Array> {
    const rpIdHash = await sha256(stringToBytes(rpId));
    const flags = new Uint8Array([0x01]);
    const count = new Uint8Array([
        (signCount >>> 24) & 0xff,
        (signCount >>> 16) & 0xff,
        (signCount >>> 8) & 0xff,
        signCount & 0xff,
    ]);
    return concatBytes(rpIdHash, flags, count);
}

function encodeAttestationObject(authData: Uint8Array): Uint8Array {
    return encodeCborMap([
        ["fmt", "none"],
        ["attStmt", encodeCborMap([])],
        ["authData", authData],
    ]);
}

function encodeCoseEc2PublicKey(publicKeyJwk: JsonWebKey): Uint8Array {
    const x = publicKeyJwk.x;
    const y = publicKeyJwk.y;
    if (!x || !y || publicKeyJwk.kty !== "EC" || publicKeyJwk.crv !== "P-256") {
        throw new Error("Expected exported ES256 public JWK");
    }
    return encodeCborMap([
        [1, 2],
        [3, -7],
        [-1, 1],
        [-2, base64ToBytes(x)],
        [-3, base64ToBytes(y)],
    ]);
}

function encodeCborMap(entries: Array<[string | number, string | number | Uint8Array]>): Uint8Array {
    const encodedEntries = entries.map(([key, value]) => concatBytes(encodeCborValue(key), encodeCborValue(value)));
    return concatBytes(encodeCborHead(5, entries.length), ...encodedEntries);
}

function encodeCborValue(value: string | number | Uint8Array): Uint8Array {
    if (typeof value === "number") return encodeCborNumber(value);
    if (typeof value === "string") return concatBytes(encodeCborHead(3, value.length), stringToBytes(value));
    return concatBytes(encodeCborHead(2, value.length), value);
}

function encodeCborNumber(value: number): Uint8Array {
    if (value >= 0) return encodeCborHead(0, value);
    return encodeCborHead(1, -1 - value);
}

function encodeCborHead(majorType: number, value: number): Uint8Array {
    if (value < 24) return new Uint8Array([(majorType << 5) | value]);
    if (value < 256) return new Uint8Array([(majorType << 5) | 24, value]);
    if (value < 65536) return new Uint8Array([(majorType << 5) | 25, (value >> 8) & 0xff, value & 0xff]);
    throw new Error("CBOR value too large for minimal encoder");
}

function rawEcdsaSignatureToDer(rawSignature: Uint8Array): Uint8Array {
    if (rawSignature.length % 2 !== 0) {
        throw new Error("Unexpected raw ECDSA signature length");
    }
    const half = rawSignature.length / 2;
    const r = trimInteger(rawSignature.slice(0, half));
    const s = trimInteger(rawSignature.slice(half));
    const sequence = concatBytes(encodeDerInteger(r), encodeDerInteger(s));
    return concatBytes(new Uint8Array([0x30]), encodeDerLength(sequence.length), sequence);
}

function derEcdsaSignatureToRaw(derSignature: Uint8Array, width: number): Uint8Array {
    if (derSignature[0] !== 0x30) throw new Error("Expected DER sequence");
    let offset = 2;
    if (derSignature[1] & 0x80) {
        const lengthBytes = derSignature[1] & 0x7f;
        offset = 2 + lengthBytes;
    }
    const r = decodeDerInteger(derSignature, offset);
    offset += r.totalLength;
    const s = decodeDerInteger(derSignature, offset);
    return concatBytes(leftPad(r.value, width), leftPad(s.value, width));
}

function encodeDerInteger(value: Uint8Array): Uint8Array {
    return concatBytes(new Uint8Array([0x02]), encodeDerLength(value.length), value);
}

function encodeDerLength(length: number): Uint8Array {
    if (length < 128) return new Uint8Array([length]);
    return new Uint8Array([0x81, length]);
}

function decodeDerInteger(signature: Uint8Array, offset: number): { value: Uint8Array; totalLength: number } {
    if (signature[offset] !== 0x02) throw new Error("Expected DER integer");
    const length = signature[offset + 1];
    const start = offset + 2;
    const value = signature.slice(start, start + length);
    return { value: value[0] === 0x00 ? value.slice(1) : value, totalLength: 2 + length };
}

function leftPad(value: Uint8Array, width: number): Uint8Array {
    if (value.length >= width) return value.slice(value.length - width);
    const output = new Uint8Array(width);
    output.set(value, width - value.length);
    return output;
}

function trimInteger(value: Uint8Array): Uint8Array {
    let index = 0;
    while (index < value.length - 1 && value[index] === 0) index += 1;
    let trimmed = value.slice(index);
    if (trimmed[0] & 0x80) {
        const prefixed = new Uint8Array(trimmed.length + 1);
        prefixed.set(trimmed, 1);
        trimmed = prefixed;
    }
    return trimmed;
}

async function sha256(data: Uint8Array): Promise<Uint8Array> {
    const cryptoApi = await getWebCrypto();
    return new Uint8Array(await cryptoApi.subtle.digest("SHA-256", data));
}

async function randomBytes(cryptoApi: Crypto, length: number): Promise<Uint8Array> {
    const bytes = new Uint8Array(length);
    cryptoApi.getRandomValues(bytes);
    return bytes;
}

async function getWebCrypto(): Promise<Crypto> {
    if (globalThis.crypto?.subtle) return globalThis.crypto;
    const nodeCrypto = getNodeWebCrypto();
    if (nodeCrypto?.subtle) return nodeCrypto;
    throw new Error("WebCrypto unavailable");
}

function cloneCredential(credential: PasskeyCredential): PasskeyCredential {
    return new PasskeyCredential().fromRaw(credential.toRaw()) as PasskeyCredential;
}

function readStoredPrivateKey(item: VaultItem, credential: PasskeyCredential): string {
    const field = item.fields[credential.privateKeyFieldIndex];
    if (!field?.value) {
        throw new Error("Passkey private key field missing");
    }
    return field.value;
}

function normalizePublicKeyJwk(publicKeyJwk: JsonWebKey): PasskeyCredential["publicKeyJwk"] {
    if (!publicKeyJwk.kty || !publicKeyJwk.crv || !publicKeyJwk.x || !publicKeyJwk.y) {
        throw new Error("Expected exported ES256 public JWK");
    }
    return {
        kty: publicKeyJwk.kty,
        crv: publicKeyJwk.crv,
        x: publicKeyJwk.x,
        y: publicKeyJwk.y,
        alg: publicKeyJwk.alg,
        ext: publicKeyJwk.ext,
        key_ops: publicKeyJwk.key_ops,
    };
}

function getNodeWebCrypto(): Crypto | null {
    try {
        const nodeRequire = Function("return typeof require !== 'undefined' ? require : null;")() as
            | ((id: string) => { webcrypto?: Crypto })
            | null;
        if (!nodeRequire) return null;
        const nodeCrypto = nodeRequire("crypto");
        return nodeCrypto.webcrypto || null;
    } catch {
        return null;
    }
}

function concatBytes(...chunks: Uint8Array[]): Uint8Array {
    const length = chunks.reduce((sum, chunk) => sum + chunk.length, 0);
    const output = new Uint8Array(length);
    let offset = 0;
    for (const chunk of chunks) {
        output.set(chunk, offset);
        offset += chunk.length;
    }
    return output;
}
