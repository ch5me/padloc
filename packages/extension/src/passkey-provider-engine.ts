import { bytesToBase64 } from "@padloc/core/src/encoding";
import { PasskeyCounterPolicy, PasskeyCredential, PasskeyEs256KeyMaterial } from "@padloc/core/src/passkey";
import {
    buildPasskeyAssertionResponse,
    buildPasskeyRegistrationResponse,
    generatePasskeyCredential,
    validateRpIdForOrigin,
} from "@padloc/core/src/webauthn-authenticator";
import {
    deserializeWebAuthnValue,
    PagePasskeyRequest,
    SerializedBuffer,
    SerializedPublicKeyCredential,
} from "./passkey-protocol";

const ES256_COSE_ALGORITHM = -7;
const MAX_USER_HANDLE_LENGTH = 64;
const MAX_CREDENTIAL_ID_LENGTH = 1023;

type RecordValue = Record<string, unknown>;

interface CredentialDescriptor {
    id: Uint8Array;
}

export interface PasskeyCredentialRepository {
    listCredentials(rpId: string): Promise<readonly PasskeyCredential[]>;
    createCredential(credential: PasskeyCredential): Promise<void>;
    updateCredential(credential: PasskeyCredential): Promise<void>;
    deleteCredential(credential: PasskeyCredential): Promise<void>;
}

export interface PasskeySelectionCandidate {
    /** Invocation-local opaque value; it is not a credential ID. */
    selectionId: string;
    userName: string;
    userDisplayName: string;
}

export interface ExecutePasskeyOperationOptions {
    request: Pick<PagePasskeyRequest, "operation" | "options">;
    /** Origin derived by the isolated extension bridge, never supplied by the page request. */
    origin: string;
    repository: PasskeyCredentialRepository;
    /** Trusted result of the provider's approval/unlock step. */
    userVerified: boolean;
    /** Trusted Public Suffix List policy used to approve the requested RP ID for the origin host. */
    rpIdSuffixValidator: (rpId: string, originHost: string) => boolean;
    cryptoProvider?: Crypto;
    now?: () => Date;
    /** Revalidates ceremony lifetime, port liveness, and browser tab/origin binding. */
    assertActive?: () => Promise<void> | void;
    /** Required when multiple credentials are eligible; receives labels only, never key material or credential IDs. */
    selectCredential?: (
        credentials: readonly PasskeySelectionCandidate[]
    ) => Promise<string | undefined> | string | undefined;
}

export interface DescribePasskeyOperationOptions {
    request: Pick<PagePasskeyRequest, "operation" | "options">;
    origin: string;
    rpIdSuffixValidator: (rpId: string, originHost: string) => boolean;
}

export interface PasskeyOperationDescription {
    operation: "create" | "get";
    rpId: string;
    rpName: string;
    userName?: string;
    userDisplayName?: string;
}

/** Error with a WebAuthn/DOMException-compatible name for the page bridge. */
export class PasskeyProviderError extends Error {
    constructor(name: string, message: string) {
        super(message);
        this.name = name;
    }
}

/**
 * Produce the deliberately redacted labels needed by an approval surface.
 * Challenge bytes, credential IDs, user handles, and key material never leave this preflight boundary.
 */
export function describePasskeyOperation(description: DescribePasskeyOperationOptions): PasskeyOperationDescription {
    const options = deserializeOptions(description.request.options);
    if (description.request.operation === "create") {
        const rp = requireRecord(options.rp, "rp");
        const user = requireRecord(options.user, "user");
        const rpId = resolveRpId(optionalString(rp.id, "rp.id"), description.origin);
        validateRpBinding(rpId, description.origin, description.rpIdSuffixValidator);
        const rpName = requireNonEmptyString(rp.name, "rp.name");
        requireBytes(options.challenge, "challenge");
        requireBytes(user.id, "user.id", MAX_USER_HANDLE_LENGTH);
        const userName = requireNonEmptyString(user.name, "user.name");
        const userDisplayName = requireNonEmptyString(user.displayName, "user.displayName");
        requireEs256(options.pubKeyCredParams);
        parseCredentialDescriptors(options.excludeCredentials, "excludeCredentials");
        return { operation: "create", rpId, rpName, userName, userDisplayName };
    }
    if (description.request.operation === "get") {
        const rpId = resolveRpId(optionalString(options.rpId, "rpId"), description.origin);
        validateRpBinding(rpId, description.origin, description.rpIdSuffixValidator);
        requireBytes(options.challenge, "challenge");
        parseCredentialDescriptors(options.allowCredentials, "allowCredentials");
        return { operation: "get", rpId, rpName: rpId };
    }
    throw providerError("NotSupportedError", "Unsupported passkey operation");
}

/**
 * Execute one vault-backed WebAuthn ceremony without depending on browser globals or UI.
 * The caller owns approval, unlocking, origin derivation, encrypted storage, and credential selection UI.
 */
export async function executePasskeyOperation(
    execution: ExecutePasskeyOperationOptions
): Promise<SerializedPublicKeyCredential> {
    if (typeof execution.userVerified !== "boolean") {
        throw providerError("TypeError", "userVerified must be a trusted boolean result");
    }
    const options = deserializeOptions(execution.request.options);
    if (execution.request.operation === "create") {
        return executeCreate(options, execution);
    }
    if (execution.request.operation === "get") {
        return executeGet(options, execution);
    }
    throw providerError("NotSupportedError", "Unsupported passkey operation");
}

async function executeCreate(
    options: RecordValue,
    execution: ExecutePasskeyOperationOptions
): Promise<SerializedPublicKeyCredential> {
    const rp = requireRecord(options.rp, "rp");
    const user = requireRecord(options.user, "user");
    const rpId = resolveRpId(optionalString(rp.id, "rp.id"), execution.origin);
    validateRpBinding(rpId, execution.origin, execution.rpIdSuffixValidator);
    const rpName = requireNonEmptyString(rp.name, "rp.name");

    const challenge = requireBytes(options.challenge, "challenge");
    const userHandle = requireBytes(user.id, "user.id", MAX_USER_HANDLE_LENGTH);
    const userName = requireNonEmptyString(user.name, "user.name");
    const userDisplayName = requireNonEmptyString(user.displayName, "user.displayName");
    requireEs256(options.pubKeyCredParams);

    const authenticatorSelection = optionalRecord(options.authenticatorSelection, "authenticatorSelection");
    const attachment = optionalString(authenticatorSelection?.authenticatorAttachment, "authenticatorAttachment");
    if (attachment && attachment !== "platform" && attachment !== "cross-platform") {
        throw providerError("TypeError", "Invalid authenticatorAttachment value");
    }
    if (attachment === "cross-platform") {
        throw providerError("NotSupportedError", "This vault passkey provider is a platform authenticator");
    }
    const userVerification = parseUserVerification(authenticatorSelection?.userVerification);
    requireRequestedUserVerification(userVerification, execution.userVerified);

    const residentKey = optionalString(authenticatorSelection?.residentKey, "residentKey");
    if (residentKey && residentKey !== "discouraged" && residentKey !== "preferred" && residentKey !== "required") {
        throw providerError("TypeError", "Invalid residentKey value");
    }
    const requireResidentKey = optionalBoolean(authenticatorSelection?.requireResidentKey, "requireResidentKey");
    if (requireResidentKey === true && residentKey === "discouraged") {
        throw providerError("TypeError", "Conflicting resident-key requirements");
    }
    const discoverable = requireResidentKey === true || residentKey === "preferred" || residentKey === "required";

    const attestation = optionalString(options.attestation, "attestation");
    if (attestation && !["none", "indirect", "direct", "enterprise"].includes(attestation)) {
        throw providerError("TypeError", "Invalid attestation preference");
    }
    if (attestation === "enterprise") {
        throw providerError("NotSupportedError", "Enterprise attestation is not supported");
    }

    const excludeCredentials = parseCredentialDescriptors(options.excludeCredentials, "excludeCredentials");
    const storedCredentials = await listAndValidateCredentials(execution.repository, rpId);
    if (
        excludeCredentials.some((descriptor) =>
            storedCredentials.some((credential) => bytesEqual(descriptor.id, credential.credentialId))
        )
    ) {
        throw providerError("InvalidStateError", "A credential already exists for an excluded credential ID");
    }
    await assertExecutionActive(execution);

    const credential = await generatePasskeyCredential(
        {
            rpId,
            rpName,
            userHandle,
            userName,
            userDisplayName,
            discoverable,
            backupEligible: true,
            backupState: true,
            counterPolicy: PasskeyCounterPolicy.None,
        },
        execution.cryptoProvider
    );
    const registration = await buildPasskeyRegistrationResponse(
        credential,
        {
            challenge,
            origin: execution.origin,
            rpId,
            userVerified: execution.userVerified,
            rpIdSuffixValidator: execution.rpIdSuffixValidator,
        },
        execution.cryptoProvider
    );
    const publicKeySpki = await exportPublicKeySpki(credential, execution.cryptoProvider);

    await assertExecutionActive(execution);
    let created = false;
    try {
        await execution.repository.createCredential(credential);
        created = true;
        await assertExecutionActive(execution);
    } catch (error) {
        if (created) await rollbackCreatedCredential(execution.repository, credential);
        throw error;
    }
    return {
        id: registration.id,
        type: "public-key",
        rawId: serializedBuffer(registration.rawId),
        authenticatorAttachment: "platform",
        response: {
            clientDataJSON: serializedBuffer(registration.clientDataJSON),
            attestationObject: serializedBuffer(registration.attestationObject),
            authenticatorData: serializedBuffer(registration.authenticatorData),
            publicKey: serializedBuffer(publicKeySpki),
            publicKeyAlgorithm: ES256_COSE_ALGORITHM,
            transports: ["internal"],
        },
        clientExtensionResults: credentialPropertiesExtension(options.extensions, discoverable),
    };
}

async function executeGet(
    options: RecordValue,
    execution: ExecutePasskeyOperationOptions
): Promise<SerializedPublicKeyCredential> {
    const rpId = resolveRpId(optionalString(options.rpId, "rpId"), execution.origin);
    validateRpBinding(rpId, execution.origin, execution.rpIdSuffixValidator);
    const challenge = requireBytes(options.challenge, "challenge");
    const userVerification = parseUserVerification(options.userVerification);
    requireRequestedUserVerification(userVerification, execution.userVerified);
    rejectUnsupportedAssertionExtensions(options.extensions);

    const allowCredentialsPresent = typeof options.allowCredentials !== "undefined";
    const allowCredentials = parseCredentialDescriptors(options.allowCredentials, "allowCredentials");
    const storedCredentials = await listAndValidateCredentials(execution.repository, rpId);
    const eligible = storedCredentials.filter((credential) => {
        if (allowCredentials.length > 0) {
            return allowCredentials.some((descriptor) => bytesEqual(descriptor.id, credential.credentialId));
        }
        return !allowCredentialsPresent || allowCredentials.length === 0 ? credential.discoverable : false;
    });
    if (eligible.length === 0) {
        throw providerError("NotAllowedError", "No eligible passkey was found for this relying party");
    }

    const credential = await selectCredential(eligible, execution.selectCredential);
    await assertExecutionActive(execution);
    const credentialBeforeAssertion = cloneCredential(credential);
    const credentialToPersist = cloneCredential(credential);
    const assertion = await buildPasskeyAssertionResponse(
        credentialToPersist,
        {
            challenge,
            origin: execution.origin,
            rpId,
            userVerified: execution.userVerified,
            rpIdSuffixValidator: execution.rpIdSuffixValidator,
        },
        execution.cryptoProvider
    );
    credentialToPersist.counter = assertion.nextCounter;
    credentialToPersist.lastUsed = currentDate(execution.now);
    await assertExecutionActive(execution);
    try {
        await execution.repository.updateCredential(credentialToPersist);
        await assertExecutionActive(execution);
    } catch (error) {
        try {
            await rollbackUpdatedCredential(execution.repository, credentialBeforeAssertion);
        } catch (_rollbackError) {
            // Preserve the original repository/ceremony failure. The rollback is
            // best-effort because the credential may have been removed entirely.
        }
        throw error;
    }

    return {
        id: assertion.id,
        type: "public-key",
        rawId: serializedBuffer(assertion.rawId),
        authenticatorAttachment: "platform",
        response: {
            clientDataJSON: serializedBuffer(assertion.clientDataJSON),
            authenticatorData: serializedBuffer(assertion.authenticatorData),
            signature: serializedBuffer(assertion.signature),
            userHandle: serializedBuffer(assertion.userHandle),
        },
        clientExtensionResults: {},
    };
}

function deserializeOptions(options: Record<string, unknown>): RecordValue {
    let deserialized: unknown;
    try {
        deserialized = deserializeWebAuthnValue(options);
    } catch (_error) {
        throw providerError("DataError", "Passkey options contain invalid serialized binary data");
    }
    return requireRecord(deserialized, "publicKey options");
}

function resolveRpId(requestedRpId: string | undefined, origin: string): string {
    if (typeof requestedRpId !== "undefined") return requestedRpId.toLowerCase().replace(/\.$/, "");
    try {
        return new URL(origin).hostname.toLowerCase().replace(/\.$/, "");
    } catch (_error) {
        throw providerError("SecurityError", "Invalid trusted WebAuthn origin");
    }
}

function validateRpBinding(
    rpId: string,
    origin: string,
    rpIdSuffixValidator: (rpId: string, originHost: string) => boolean
): void {
    try {
        validateRpIdForOrigin(rpId, origin, rpIdSuffixValidator);
    } catch (error) {
        throw providerError("SecurityError", errorMessage(error, "Invalid RP ID or origin"));
    }
}

async function listAndValidateCredentials(
    repository: PasskeyCredentialRepository,
    rpId: string
): Promise<readonly PasskeyCredential[]> {
    const credentials = await repository.listCredentials(rpId);
    if (!Array.isArray(credentials)) {
        throw providerError("DataError", "Passkey repository returned an invalid credential list");
    }
    const ids = new Set<string>();
    for (const credential of credentials) {
        if (!(credential instanceof PasskeyCredential) || !credential.validate() || credential.rpId !== rpId) {
            throw providerError("DataError", "Passkey repository returned an invalid credential");
        }
        const id = bytesToBase64(credential.credentialId);
        if (ids.has(id)) {
            throw providerError("DataError", "Passkey repository returned duplicate credential IDs");
        }
        ids.add(id);
    }
    return credentials;
}

async function selectCredential(
    eligible: readonly PasskeyCredential[],
    selector: ExecutePasskeyOperationOptions["selectCredential"]
): Promise<PasskeyCredential> {
    if (eligible.length === 1) return eligible[0];
    if (!selector) {
        throw providerError("NotAllowedError", "Credential selection is required for this passkey request");
    }
    const candidates = eligible.map((credential, index) => ({
        selectionId: String(index),
        userName: credential.userName,
        userDisplayName: credential.userDisplayName,
    }));
    const selected = await selector(candidates);
    const selectedIndex = typeof selected === "string" && /^\d+$/.test(selected) ? Number(selected) : -1;
    const canonical = Number.isSafeInteger(selectedIndex) ? eligible[selectedIndex] : undefined;
    if (!canonical) {
        throw providerError("NotAllowedError", "No eligible passkey was selected");
    }
    return canonical;
}

async function exportPublicKeySpki(
    credential: PasskeyCredential,
    cryptoProvider: Crypto | undefined
): Promise<Uint8Array> {
    const provider = cryptoProvider || globalThis.crypto;
    if (!provider) throw providerError("OperationError", "WebCrypto is not available");
    const publicKey = await provider.subtle.importKey(
        "jwk",
        credential.keyMaterial.publicKeyJwk,
        { name: "ECDSA", namedCurve: "P-256" },
        true,
        ["verify"]
    );
    return new Uint8Array(await provider.subtle.exportKey("spki", publicKey));
}

function cloneCredential(credential: PasskeyCredential): PasskeyCredential {
    return new PasskeyCredential({
        schemaVersion: credential.schemaVersion,
        rpId: credential.rpId,
        rpName: credential.rpName,
        credentialId: new Uint8Array(credential.credentialId),
        userHandle: new Uint8Array(credential.userHandle),
        userName: credential.userName,
        userDisplayName: credential.userDisplayName,
        keyMaterial: new PasskeyEs256KeyMaterial({
            publicKeyJwk: { ...credential.keyMaterial.publicKeyJwk },
            privateKeyJwk: { ...credential.keyMaterial.privateKeyJwk },
        }),
        discoverable: credential.discoverable,
        backupEligible: credential.backupEligible,
        backupState: credential.backupState,
        counterPolicy: credential.counterPolicy,
        counter: credential.counter,
        created: new Date(credential.created),
        lastUsed: credential.lastUsed && new Date(credential.lastUsed),
    });
}

function requireEs256(value: unknown): void {
    if (!Array.isArray(value) || value.length === 0) {
        throw providerError("TypeError", "pubKeyCredParams must be a non-empty array");
    }
    let supportsEs256 = false;
    for (const parameter of value) {
        const record = requireRecord(parameter, "pubKeyCredParams entry");
        if (record.type !== "public-key" || !Number.isInteger(record.alg)) {
            throw providerError("TypeError", "Invalid public-key credential parameter");
        }
        if (record.alg === ES256_COSE_ALGORITHM) supportsEs256 = true;
    }
    if (!supportsEs256) {
        throw providerError("NotSupportedError", "The relying party did not offer ES256 (-7)");
    }
}

function parseCredentialDescriptors(value: unknown, name: string): CredentialDescriptor[] {
    if (typeof value === "undefined") return [];
    if (!Array.isArray(value)) throw providerError("TypeError", `${name} must be an array`);
    return value.map((entry, index) => {
        const descriptor = requireRecord(entry, `${name}[${index}]`);
        if (descriptor.type !== "public-key") {
            throw providerError("TypeError", `${name}[${index}] must have type public-key`);
        }
        return { id: requireBytes(descriptor.id, `${name}[${index}].id`, MAX_CREDENTIAL_ID_LENGTH) };
    });
}

function parseUserVerification(value: unknown): "required" | "preferred" | "discouraged" {
    if (typeof value === "undefined") return "preferred";
    if (value !== "required" && value !== "preferred" && value !== "discouraged") {
        throw providerError("TypeError", "Invalid userVerification value");
    }
    return value;
}

function requireRequestedUserVerification(requirement: string, userVerified: boolean): void {
    if (requirement === "required" && !userVerified) {
        throw providerError("NotAllowedError", "The relying party requires user verification");
    }
}

function rejectUnsupportedAssertionExtensions(value: unknown): void {
    const extensions = optionalRecord(value, "extensions");
    if (extensions && extensions.appid === true) {
        throw providerError("NotSupportedError", "The legacy AppID extension is not supported");
    }
}

function credentialPropertiesExtension(value: unknown, discoverable: boolean): Record<string, unknown> {
    const extensions = optionalRecord(value, "extensions");
    return extensions?.credProps === true ? { credProps: { rk: discoverable } } : {};
}

function currentDate(clock: (() => Date) | undefined): Date {
    const date = clock ? clock() : new Date();
    if (!(date instanceof Date) || Number.isNaN(date.getTime())) {
        throw providerError("OperationError", "Passkey provider clock returned an invalid date");
    }
    return new Date(date);
}

function requireRecord(value: unknown, name: string): RecordValue {
    if (!value || typeof value !== "object" || Array.isArray(value)) {
        throw providerError("TypeError", `${name} must be an object`);
    }
    const prototype = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) {
        throw providerError("TypeError", `${name} must be a plain object`);
    }
    return value as RecordValue;
}

function optionalRecord(value: unknown, name: string): RecordValue | undefined {
    return typeof value === "undefined" ? undefined : requireRecord(value, name);
}

function requireNonEmptyString(value: unknown, name: string): string {
    if (typeof value !== "string" || value.length === 0) {
        throw providerError("TypeError", `${name} must be a non-empty string`);
    }
    return value;
}

function optionalString(value: unknown, name: string): string | undefined {
    if (typeof value === "undefined") return undefined;
    if (typeof value !== "string") throw providerError("TypeError", `${name} must be a string`);
    return value;
}

function optionalBoolean(value: unknown, name: string): boolean | undefined {
    if (typeof value === "undefined") return undefined;
    if (typeof value !== "boolean") throw providerError("TypeError", `${name} must be a boolean`);
    return value;
}

function requireBytes(value: unknown, name: string, maximumLength?: number): Uint8Array {
    let bytes: Uint8Array;
    if (value instanceof ArrayBuffer) {
        bytes = new Uint8Array(value);
    } else if (ArrayBuffer.isView(value)) {
        bytes = new Uint8Array(value.buffer, value.byteOffset, value.byteLength);
    } else {
        throw providerError("TypeError", `${name} must be binary data`);
    }
    if (bytes.length === 0 || (maximumLength !== undefined && bytes.length > maximumLength)) {
        throw providerError("TypeError", `${name} has an invalid length`);
    }
    return new Uint8Array(bytes);
}

function serializedBuffer(bytes: Uint8Array): SerializedBuffer {
    return { __padlocWebAuthnType: "buffer", base64url: bytesToBase64(bytes) };
}

function bytesEqual(left: Uint8Array, right: Uint8Array): boolean {
    if (left.length !== right.length) return false;
    let difference = 0;
    for (let index = 0; index < left.length; index++) difference |= left[index] ^ right[index];
    return difference === 0;
}

function providerError(name: string, message: string): PasskeyProviderError {
    return new PasskeyProviderError(name, message);
}

async function assertExecutionActive(execution: ExecutePasskeyOperationOptions): Promise<void> {
    await execution.assertActive?.();
}

async function rollbackCreatedCredential(
    repository: PasskeyCredentialRepository,
    credential: PasskeyCredential
): Promise<void> {
    try {
        await repository.deleteCredential(credential);
    } catch (_error) {
        throw providerError("OperationError", "Padloc could not roll back a cancelled passkey registration");
    }
}

async function rollbackUpdatedCredential(
    repository: PasskeyCredentialRepository,
    credential: PasskeyCredential
): Promise<void> {
    try {
        await repository.updateCredential(credential);
    } catch (_error) {
        throw providerError("OperationError", "Padloc could not roll back a cancelled passkey assertion");
    }
}

function errorMessage(error: unknown, fallback: string): string {
    return error instanceof Error ? error.message : fallback;
}
