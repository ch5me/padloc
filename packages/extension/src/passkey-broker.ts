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

interface PasskeySignerKeyMaterial {
    credentialId: string;
    signerHandle: string;
    privateKey: CryptoKey;
    publicKeySpki: string;
    publicKeyJwk: NonNullable<PasskeyCredential["publicKeyJwk"]>;
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

const PASSKEY_ALGORITHM_ES256 = -7;
const PASSKEY_ALGORITHM_ED25519 = -8;
const PASSKEY_SIGNER_HANDLE_PREFIX = "padloc-passkey-signer:";
const PASSKEY_SIGNER_DB_NAME = "padloc-agentic-passkey-signers";
const PASSKEY_SIGNER_DB_VERSION = 1;
const PASSKEY_SIGNER_STORE_NAME = "keys";
const memoryPasskeySignerKeys = new Map<string, CryptoKey>();
let allowMemoryOnlyPasskeySignerStoreForTests = false;

export function configurePasskeySignerStoreForTests(options: { allowMemoryOnly?: boolean } = {}): void {
    allowMemoryOnlyPasskeySignerStoreForTests = Boolean(options.allowMemoryOnly);
}

export function clearPasskeySignerMemoryCacheForTests(): void {
    memoryPasskeySignerKeys.clear();
}

export async function enrollPasskeyCredential(
    request: AutofillBrokerRequest,
    now = new Date()
): Promise<EnrollPasskeyResult> {
    const enrollment = requirePasskeyEnrollmentRequest(request);
    const algorithm = normalizePasskeyAlgorithm(enrollment.algorithm);
    const cryptoApi = await getWebCrypto();
    const keyMaterial = await resolveEnrollmentKeyMaterial(cryptoApi, algorithm, enrollment);
    const credentialIdBytes = base64ToBytes(keyMaterial.credentialId);
    const userHandle = enrollment.userHandle || bytesToBase64(await randomBytes(cryptoApi, 16));
    const publicKeyJwk = keyMaterial.publicKeyJwk;
    const cosePublicKey = encodeCosePublicKey(publicKeyJwk, algorithm);
    const signCount = normalizeSignCount(enrollment.signCount ?? 0);
    const attestedAuthData = await buildAttestedCredentialData(
        enrollment.rpId,
        credentialIdBytes,
        cosePublicKey,
        shouldSetUserVerification(enrollment.userVerification)
    );
    const attestationObject = encodeAttestationObject(attestedAuthData);
    const createdAt = new Date(now);

    const passkeyCredential = new PasskeyCredential({
        algorithm,
        credentialId: keyMaterial.credentialId,
        rpId: enrollment.rpId,
        privateKeyFieldIndex: 0,
        publicKeySpki: keyMaterial.publicKeySpki,
        publicKeyJwk: publicKeyJwk,
        signCount,
        userHandle,
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
        new Field({ name: "Signer Handle", type: FieldType.Password, value: keyMaterial.signerHandle }),
        new Field({ name: "RP ID", type: FieldType.Url, value: `https://${enrollment.rpId}` }),
        new Field({ name: "Credential ID", type: FieldType.Text, value: passkeyCredential.credentialId }),
        new Field({ name: "User Handle", type: FieldType.Text, value: passkeyCredential.userHandle }),
    ];

    await storePasskeySignerKey(keyMaterial.signerHandle, keyMaterial.privateKey);

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
    const authenticatorData = await buildAssertionAuthenticatorData(
        credential.rpId,
        nextSignCount,
        shouldSetUserVerification(assertionRequest.userVerification)
    );
    const signedPayload = concatBytes(authenticatorData, clientDataHash);
    const signerHandle = readStoredSignerHandle(item, credential);
    const algorithm = normalizePasskeyAlgorithm(credential.algorithm);
    const signerKey = await loadPasskeySignerKey(signerHandle);
    if (!signerKey) {
        throw new Error("Padloc passkey signer key missing; re-enroll passkey");
    }
    const signature = await signAssertionPayload(cryptoApi, algorithm, signerKey, signedPayload);

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
        signature: bytesToBase64(signature),
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
    const algorithm = normalizePasskeyAlgorithm(credential.algorithm);
    const importedPublicKey = await importPublicKeyForAlgorithm(cryptoApi, algorithm, base64ToBytes(credential.publicKeySpki));
    const clientDataHash = await resolveClientDataHash(request, cryptoApi);
    const signedPayload = concatBytes(base64ToBytes(assertion.authenticatorData), clientDataHash);
    return verifyAssertionPayload(cryptoApi, algorithm, importedPublicKey, base64ToBytes(assertion.signature), signedPayload);
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

async function resolveEnrollmentKeyMaterial(
    cryptoApi: Crypto,
    algorithm: number,
    enrollment: PasskeyEnrollmentRequest
): Promise<PasskeySignerKeyMaterial> {
    if (enrollment.credentialId && enrollment.privateKeyPkcs8) {
        const privateKeyPkcs8 = base64ToBytes(enrollment.privateKeyPkcs8);
        const privateKey = await importPrivateKeyForAlgorithm(cryptoApi, algorithm, privateKeyPkcs8, false);
        const publicKeyJwk = await derivePublicJwkFromPrivateKeyPkcs8(cryptoApi, algorithm, privateKeyPkcs8);
        const publicKeySpki = await exportPublicKeySpki(cryptoApi, algorithm, publicKeyJwk);
        return {
            credentialId: enrollment.credentialId,
            signerHandle: await makePasskeySignerHandle(cryptoApi),
            privateKey,
            publicKeySpki,
            publicKeyJwk,
        };
    }
    if (enrollment.credentialId || enrollment.privateKeyPkcs8) {
        throw new Error("Passkey enrollment requires both credentialId and privateKeyPkcs8 when importing");
    }
    const keyPair = await generateKeyPairForAlgorithm(cryptoApi, algorithm);
    if (!("privateKey" in keyPair) || !keyPair.privateKey || !keyPair.publicKey) {
        throw new Error("Passkey key generation failed");
    }
    const publicKeyJwk = normalizePublicKeyJwk(await cryptoApi.subtle.exportKey("jwk", keyPair.publicKey));
    const publicKeySpki = bytesToBase64(new Uint8Array(await cryptoApi.subtle.exportKey("spki", keyPair.publicKey)));
    const credentialId = bytesToBase64(await randomBytes(cryptoApi, 32)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
    return {
        credentialId,
        signerHandle: await makePasskeySignerHandle(cryptoApi),
        privateKey: keyPair.privateKey,
        publicKeySpki,
        publicKeyJwk,
    };
}

async function generateKeyPairForAlgorithm(cryptoApi: Crypto, algorithm: number): Promise<CryptoKeyPair> {
    if (algorithm === PASSKEY_ALGORITHM_ES256) {
        return cryptoApi.subtle.generateKey(
            { name: "ECDSA", namedCurve: "P-256" },
            false,
            ["sign", "verify"]
        );
    }
    if (algorithm === PASSKEY_ALGORITHM_ED25519) {
        return cryptoApi.subtle.generateKey({ name: "Ed25519" }, false, ["sign", "verify"]) as Promise<CryptoKeyPair>;
    }
    throw new Error(`Unsupported passkey algorithm: ${algorithm}`);
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
    credentialPublicKey: Uint8Array,
    userVerified = false
): Promise<Uint8Array> {
    const rpIdHash = await sha256(stringToBytes(rpId));
    const flags = new Uint8Array([0x41 | (userVerified ? 0x04 : 0x00)]);
    const signCount = new Uint8Array([0x00, 0x00, 0x00, 0x00]);
    const aaguid = new Uint8Array(16);
    const credentialLength = new Uint8Array([(credentialId.length >> 8) & 0xff, credentialId.length & 0xff]);
    return concatBytes(rpIdHash, flags, signCount, aaguid, credentialLength, credentialId, credentialPublicKey);
}

async function buildAssertionAuthenticatorData(
    rpId: string,
    signCount: number,
    userVerified = false
): Promise<Uint8Array> {
    const rpIdHash = await sha256(stringToBytes(rpId));
    const flags = new Uint8Array([0x01 | (userVerified ? 0x04 : 0x00)]);
    const count = new Uint8Array([
        (signCount >>> 24) & 0xff,
        (signCount >>> 16) & 0xff,
        (signCount >>> 8) & 0xff,
        signCount & 0xff,
    ]);
    return concatBytes(rpIdHash, flags, count);
}

function shouldSetUserVerification(userVerification: UserVerificationRequirement | undefined): boolean {
    return userVerification === "required" || userVerification === "preferred";
}

function encodeAttestationObject(authData: Uint8Array): Uint8Array {
    return encodeCborMap([
        ["fmt", "none"],
        ["attStmt", encodeCborMap([])],
        ["authData", authData],
    ]);
}

function encodeCosePublicKey(publicKeyJwk: JsonWebKey, algorithm: number): Uint8Array {
    if (algorithm === PASSKEY_ALGORITHM_ES256) {
        const x = publicKeyJwk.x;
        const y = publicKeyJwk.y;
        if (!x || !y || publicKeyJwk.kty !== "EC" || publicKeyJwk.crv !== "P-256") {
            throw new Error("Expected exported ES256 public JWK");
        }
        return encodeCborMap([
            [1, 2],
            [3, PASSKEY_ALGORITHM_ES256],
            [-1, 1],
            [-2, base64ToBytes(x)],
            [-3, base64ToBytes(y)],
        ]);
    }
    if (algorithm === PASSKEY_ALGORITHM_ED25519) {
        const x = publicKeyJwk.x;
        if (!x || publicKeyJwk.kty !== "OKP" || publicKeyJwk.crv !== "Ed25519") {
            throw new Error("Expected exported Ed25519 public JWK");
        }
        return encodeCborMap([
            [1, 1],
            [3, PASSKEY_ALGORITHM_ED25519],
            [-1, 6],
            [-2, base64ToBytes(x)],
        ]);
    }
    throw new Error(`Unsupported passkey algorithm: ${algorithm}`);
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

async function importPrivateKeyForAlgorithm(
    cryptoApi: Crypto,
    algorithm: number,
    privateKeyPkcs8: Uint8Array,
    extractable = true
): Promise<CryptoKey> {
    if (algorithm === PASSKEY_ALGORITHM_ES256) {
        return cryptoApi.subtle.importKey(
            "pkcs8",
            privateKeyPkcs8,
            { name: "ECDSA", namedCurve: "P-256" },
            extractable,
            ["sign"]
        );
    }
    if (algorithm === PASSKEY_ALGORITHM_ED25519) {
        return cryptoApi.subtle.importKey("pkcs8", privateKeyPkcs8, { name: "Ed25519" }, extractable, ["sign"]);
    }
    throw new Error(`Unsupported passkey algorithm: ${algorithm}`);
}

async function derivePublicJwkFromPrivateKeyPkcs8(
    cryptoApi: Crypto,
    algorithm: number,
    privateKeyPkcs8: Uint8Array
): Promise<NonNullable<PasskeyCredential["publicKeyJwk"]>> {
    const extractablePrivateKey = await importPrivateKeyForAlgorithm(cryptoApi, algorithm, privateKeyPkcs8);
    const exportedPrivateKeyJwk = await cryptoApi.subtle.exportKey("jwk", extractablePrivateKey);
    return normalizePublicKeyJwk(toPublicJwk(exportedPrivateKeyJwk, algorithm));
}

async function exportPublicKeySpki(
    cryptoApi: Crypto,
    algorithm: number,
    publicKeyJwk: NonNullable<PasskeyCredential["publicKeyJwk"]>
): Promise<string> {
    const publicKey = await importPublicKeyFromJwk(cryptoApi, algorithm, publicKeyJwk);
    return bytesToBase64(new Uint8Array(await cryptoApi.subtle.exportKey("spki", publicKey)));
}

async function importPublicKeyForAlgorithm(
    cryptoApi: Crypto,
    algorithm: number,
    publicKeySpki: Uint8Array
): Promise<CryptoKey> {
    if (algorithm === PASSKEY_ALGORITHM_ES256) {
        return cryptoApi.subtle.importKey(
            "spki",
            publicKeySpki,
            { name: "ECDSA", namedCurve: "P-256" },
            false,
            ["verify"]
        );
    }
    if (algorithm === PASSKEY_ALGORITHM_ED25519) {
        return cryptoApi.subtle.importKey("spki", publicKeySpki, { name: "Ed25519" }, false, ["verify"]);
    }
    throw new Error(`Unsupported passkey algorithm: ${algorithm}`);
}

async function importPublicKeyFromJwk(
    cryptoApi: Crypto,
    algorithm: number,
    publicKeyJwk: JsonWebKey
): Promise<CryptoKey> {
    if (algorithm === PASSKEY_ALGORITHM_ES256) {
        return cryptoApi.subtle.importKey(
            "jwk",
            publicKeyJwk,
            { name: "ECDSA", namedCurve: "P-256" },
            true,
            ["verify"]
        );
    }
    if (algorithm === PASSKEY_ALGORITHM_ED25519) {
        return cryptoApi.subtle.importKey("jwk", publicKeyJwk, { name: "Ed25519" }, true, ["verify"]);
    }
    throw new Error(`Unsupported passkey algorithm: ${algorithm}`);
}

async function signAssertionPayload(
    cryptoApi: Crypto,
    algorithm: number,
    privateKey: CryptoKey,
    signedPayload: Uint8Array
): Promise<Uint8Array> {
    if (algorithm === PASSKEY_ALGORITHM_ES256) {
        const rawSignature = new Uint8Array(
            await cryptoApi.subtle.sign({ name: "ECDSA", hash: "SHA-256" }, privateKey, signedPayload)
        );
        return rawEcdsaSignatureToDer(rawSignature);
    }
    if (algorithm === PASSKEY_ALGORITHM_ED25519) {
        return new Uint8Array(await cryptoApi.subtle.sign("Ed25519", privateKey, signedPayload));
    }
    throw new Error(`Unsupported passkey algorithm: ${algorithm}`);
}

async function verifyAssertionPayload(
    cryptoApi: Crypto,
    algorithm: number,
    publicKey: CryptoKey,
    signature: Uint8Array,
    signedPayload: Uint8Array
): Promise<boolean> {
    if (algorithm === PASSKEY_ALGORITHM_ES256) {
        const rawSignature = derEcdsaSignatureToRaw(signature, 32);
        return cryptoApi.subtle.verify({ name: "ECDSA", hash: "SHA-256" }, publicKey, rawSignature, signedPayload);
    }
    if (algorithm === PASSKEY_ALGORITHM_ED25519) {
        return cryptoApi.subtle.verify("Ed25519", publicKey, signature, signedPayload);
    }
    throw new Error(`Unsupported passkey algorithm: ${algorithm}`);
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

function readStoredSignerHandle(item: VaultItem, credential: PasskeyCredential): string {
    const field = item.fields[credential.privateKeyFieldIndex];
    if (!field?.value) {
        throw new Error("Passkey signer handle field missing");
    }
    if (!field.value.startsWith(PASSKEY_SIGNER_HANDLE_PREFIX)) {
        throw new Error("Legacy passkey private key field is not supported; re-enroll passkey");
    }
    return field.value;
}

async function makePasskeySignerHandle(cryptoApi: Crypto): Promise<string> {
    return `${PASSKEY_SIGNER_HANDLE_PREFIX}${bytesToBase64(await randomBytes(cryptoApi, 32))
        .replace(/\+/g, "-")
        .replace(/\//g, "_")
        .replace(/=+$/g, "")}`;
}

async function storePasskeySignerKey(handle: string, privateKey: CryptoKey): Promise<void> {
    const indexedDb = getIndexedDb();
    if (!indexedDb) {
        if (allowMemoryOnlyPasskeySignerStoreForTests) {
            memoryPasskeySignerKeys.set(handle, privateKey);
            return;
        }
        throw new Error("Padloc passkey signer IndexedDB unavailable; refusing volatile passkey enrollment");
    }
    const db = await openPasskeySignerDb(indexedDb);
    try {
        await idbRequestToPromise(
            db.transaction(PASSKEY_SIGNER_STORE_NAME, "readwrite")
                .objectStore(PASSKEY_SIGNER_STORE_NAME)
                .put({ handle, privateKey, createdAt: new Date().toISOString() })
        );
    } finally {
        db.close();
    }
    memoryPasskeySignerKeys.set(handle, privateKey);
}

async function loadPasskeySignerKey(handle: string): Promise<CryptoKey | null> {
    const memoryKey = memoryPasskeySignerKeys.get(handle);
    if (memoryKey) return memoryKey;
    const indexedDb = getIndexedDb();
    if (!indexedDb) {
        if (allowMemoryOnlyPasskeySignerStoreForTests) return null;
        throw new Error("Padloc passkey signer IndexedDB unavailable; cannot load durable passkey signer");
    }
    const db = await openPasskeySignerDb(indexedDb);
    try {
        const record = await idbRequestToPromise<{ privateKey?: CryptoKey } | undefined>(
            db.transaction(PASSKEY_SIGNER_STORE_NAME, "readonly")
                .objectStore(PASSKEY_SIGNER_STORE_NAME)
                .get(handle)
        );
        if (!record?.privateKey) return null;
        memoryPasskeySignerKeys.set(handle, record.privateKey);
        return record.privateKey;
    } finally {
        db.close();
    }
}

function getIndexedDb(): IDBFactory | null {
    return typeof indexedDB === "undefined" ? null : indexedDB;
}

function openPasskeySignerDb(indexedDb: IDBFactory): Promise<IDBDatabase> {
    return new Promise((resolve, reject) => {
        const request = indexedDb.open(PASSKEY_SIGNER_DB_NAME, PASSKEY_SIGNER_DB_VERSION);
        request.onupgradeneeded = () => {
            const db = request.result;
            if (!db.objectStoreNames.contains(PASSKEY_SIGNER_STORE_NAME)) {
                db.createObjectStore(PASSKEY_SIGNER_STORE_NAME, { keyPath: "handle" });
            }
        };
        request.onsuccess = () => resolve(request.result);
        request.onerror = () => reject(request.error || new Error("Failed to open Padloc passkey signer store"));
    });
}

function idbRequestToPromise<T>(request: IDBRequest<T>): Promise<T> {
    return new Promise((resolve, reject) => {
        request.onsuccess = () => resolve(request.result);
        request.onerror = () => reject(request.error || new Error("Padloc passkey signer store request failed"));
    });
}

function normalizePasskeyAlgorithm(value: unknown): number {
    if (value === undefined || value === null || value === "" || value === "ES256") return PASSKEY_ALGORITHM_ES256;
    if (value === PASSKEY_ALGORITHM_ES256) return PASSKEY_ALGORITHM_ES256;
    if (value === PASSKEY_ALGORITHM_ED25519) return PASSKEY_ALGORITHM_ED25519;
    if (value === "Ed25519") return PASSKEY_ALGORITHM_ED25519;
    throw new Error(`Unsupported passkey algorithm: ${String(value)}`);
}

function normalizeSignCount(value: number): number {
    if (!Number.isInteger(value) || value < 0) {
        throw new Error("Passkey signCount must be a non-negative integer");
    }
    return value;
}

function toPublicJwk(privateKeyJwk: JsonWebKey, algorithm: number): JsonWebKey {
    if (algorithm === PASSKEY_ALGORITHM_ES256) {
        if (!privateKeyJwk.x || !privateKeyJwk.y || privateKeyJwk.kty !== "EC" || privateKeyJwk.crv !== "P-256") {
            throw new Error("Expected exported ES256 private JWK");
        }
        return {
            kty: privateKeyJwk.kty,
            crv: privateKeyJwk.crv,
            x: privateKeyJwk.x,
            y: privateKeyJwk.y,
            ext: privateKeyJwk.ext,
            key_ops: ["verify"],
        };
    }
    if (algorithm === PASSKEY_ALGORITHM_ED25519) {
        if (!privateKeyJwk.x || privateKeyJwk.kty !== "OKP" || privateKeyJwk.crv !== "Ed25519") {
            throw new Error("Expected exported Ed25519 private JWK");
        }
        return {
            kty: privateKeyJwk.kty,
            crv: privateKeyJwk.crv,
            x: privateKeyJwk.x,
            alg: privateKeyJwk.alg,
            ext: privateKeyJwk.ext,
            key_ops: ["verify"],
        };
    }
    throw new Error(`Unsupported passkey algorithm: ${algorithm}`);
}

function normalizePublicKeyJwk(publicKeyJwk: JsonWebKey): NonNullable<PasskeyCredential["publicKeyJwk"]> {
    if (!publicKeyJwk.kty || !publicKeyJwk.crv || !publicKeyJwk.x) {
        throw new Error("Expected exported passkey public JWK");
    }
    return {
        kty: publicKeyJwk.kty,
        crv: publicKeyJwk.crv,
        x: publicKeyJwk.x,
        ...(publicKeyJwk.y ? { y: publicKeyJwk.y } : {}),
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
