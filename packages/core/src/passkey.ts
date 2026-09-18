import { AsBytes, AsDate, AsSerializable, Serializable } from "./encoding";

export const PASSKEY_CEREMONY_MIN_TTL_MS = 1_000;
export const PASSKEY_CEREMONY_MAX_TTL_MS = 120_000;
export const PASSKEY_USER_VERIFICATION_MAX_AGE_MS = 60_000;

export enum PasskeyCounterPolicy {
    None = "none",
    Incrementing = "incrementing",
}

export interface PasskeyCeremonyTarget {
    tabId: number;
    frameId: 0;
    origin: string;
    topOrigin: string;
    documentId: string;
}

export interface PasskeyUserVerificationGrant {
    verifiedAt: number;
    expiresAt: number;
}

/**
 * Request metadata that binds a passkey operation to one browser ceremony.
 * The binding contains no credential or private-key material.
 */
export interface PasskeyCeremonyBinding {
    flowId: string;
    nonce: string;
    ttlMs: number;
    expiresAt: number;
    topOrigin: string;
    rpId: string;
    target: PasskeyCeremonyTarget;
    userVerification?: PasskeyUserVerificationGrant;
}

export function validatePasskeyCeremonyBinding(
    binding: PasskeyCeremonyBinding,
    now = Date.now(),
    requireUserVerification = false
): void {
    if (!Number.isFinite(now)) throw new TypeError("Passkey ceremony clock is invalid");
    if (!isBoundedToken(binding.flowId) || !isBoundedToken(binding.nonce)) {
        throw new TypeError("Passkey ceremony flow and nonce are required");
    }
    if (
        !Number.isInteger(binding.ttlMs) ||
        binding.ttlMs < PASSKEY_CEREMONY_MIN_TTL_MS ||
        binding.ttlMs > PASSKEY_CEREMONY_MAX_TTL_MS
    ) {
        throw new TypeError("Passkey ceremony TTL is outside the supported range");
    }
    if (!Number.isFinite(binding.expiresAt) || binding.expiresAt <= now || binding.expiresAt - now > binding.ttlMs) {
        throw new Error("Passkey ceremony expired or has an invalid deadline");
    }
    const topOrigin = exactOrigin(binding.topOrigin, "Passkey ceremony top origin");
    const targetOrigin = exactOrigin(binding.target.origin, "Passkey ceremony target origin");
    if (topOrigin !== targetOrigin || binding.target.topOrigin !== topOrigin) {
        throw new Error("Passkey ceremony target origin mismatch");
    }
    if (
        !Number.isInteger(binding.target.tabId) ||
        binding.target.tabId < 0 ||
        binding.target.frameId !== 0 ||
        !isBoundedToken(binding.target.documentId)
    ) {
        throw new TypeError("Passkey ceremony target is invalid");
    }
    if (!isValidRpId(binding.rpId)) throw new TypeError("Passkey ceremony RP ID is invalid");
    if (
        requireUserVerification &&
        (!binding.userVerification || !isFreshPasskeyUserVerification(binding.userVerification, now))
    ) {
        throw new Error("Passkey ceremony requires recent user verification");
    }
}

export function isFreshPasskeyUserVerification(grant: PasskeyUserVerificationGrant, now = Date.now()): boolean {
    if (!Number.isFinite(now)) return false;
    if (!Number.isFinite(grant.verifiedAt) || !Number.isFinite(grant.expiresAt)) return false;
    if (grant.verifiedAt > now || grant.expiresAt <= now) return false;
    if (grant.expiresAt - grant.verifiedAt > PASSKEY_USER_VERIFICATION_MAX_AGE_MS) return false;
    return now - grant.verifiedAt <= PASSKEY_USER_VERIFICATION_MAX_AGE_MS;
}

function isBoundedToken(value: unknown): value is string {
    return typeof value === "string" && value.length > 0 && value.length <= 256 && !/[\u0000-\u001f\u007f]/.test(value);
}

function exactOrigin(value: unknown, label: string): string {
    if (typeof value !== "string") throw new TypeError(`${label} is invalid`);
    let parsed: URL;
    try {
        parsed = new URL(value);
    } catch {
        throw new TypeError(`${label} is invalid`);
    }
    const host = parsed.hostname.toLowerCase().replace(/\.$/, "");
    const loopback = host === "localhost" || host === "127.0.0.1" || host === "[::1]";
    if (parsed.origin !== value || (parsed.protocol !== "https:" && !(parsed.protocol === "http:" && loopback))) {
        throw new TypeError(`${label} is invalid`);
    }
    return parsed.origin;
}

function isValidRpId(value: unknown): value is string {
    return (
        typeof value === "string" &&
        value.length > 0 &&
        value.length <= 253 &&
        !/[\s/:\\]/.test(value) &&
        value === value.toLowerCase()
    );
}

export interface PasskeyEs256PublicJwk {
    kty: "EC";
    crv: "P-256";
    x: string;
    y: string;
    alg?: "ES256";
    ext?: boolean;
    key_ops?: string[];
}

export interface PasskeyEs256PrivateJwk extends PasskeyEs256PublicJwk {
    d: string;
}

export class PasskeyEs256KeyMaterial extends Serializable {
    constructor(vals: Partial<PasskeyEs256KeyMaterial> = {}) {
        super();
        Object.assign(this, vals);
    }

    publicKeyJwk: PasskeyEs256PublicJwk = {
        kty: "EC",
        crv: "P-256",
        x: "",
        y: "",
    };

    privateKeyJwk: PasskeyEs256PrivateJwk = {
        kty: "EC",
        crv: "P-256",
        x: "",
        y: "",
        d: "",
    };

    validate() {
        return (
            isEs256PublicJwk(this.publicKeyJwk, "verify") &&
            isEs256PrivateJwk(this.privateKeyJwk) &&
            this.publicKeyJwk.x === this.privateKeyJwk.x &&
            this.publicKeyJwk.y === this.privateKeyJwk.y
        );
    }
}

/**
 * A discoverable WebAuthn credential stored inside the encrypted vault item
 * payload. Private key material must never be logged or copied outside an
 * unlocked vault/provider boundary.
 */
export class PasskeyCredential extends Serializable {
    constructor(vals: Partial<PasskeyCredential> = {}) {
        super();
        Object.assign(this, vals);
    }

    schemaVersion: 1 = 1;

    rpId: string = "";

    rpName: string = "";

    @AsBytes()
    credentialId: Uint8Array = new Uint8Array();

    @AsBytes()
    userHandle: Uint8Array = new Uint8Array();

    userName: string = "";

    userDisplayName: string = "";

    @AsSerializable(PasskeyEs256KeyMaterial)
    keyMaterial: PasskeyEs256KeyMaterial = new PasskeyEs256KeyMaterial();

    discoverable: boolean = true;

    backupEligible: boolean = false;

    backupState: boolean = false;

    counterPolicy: PasskeyCounterPolicy = PasskeyCounterPolicy.None;

    counter: number = 0;

    @AsDate()
    created: Date = new Date();

    @AsDate()
    lastUsed?: Date = undefined;

    validate() {
        return (
            this.schemaVersion === 1 &&
            typeof this.rpId === "string" &&
            this.rpId.length > 0 &&
            typeof this.rpName === "string" &&
            this.credentialId instanceof Uint8Array &&
            this.credentialId.length > 0 &&
            this.userHandle instanceof Uint8Array &&
            this.userHandle.length > 0 &&
            typeof this.userName === "string" &&
            this.userName.length > 0 &&
            typeof this.userDisplayName === "string" &&
            this.keyMaterial instanceof PasskeyEs256KeyMaterial &&
            this.keyMaterial.validate() &&
            typeof this.discoverable === "boolean" &&
            typeof this.backupEligible === "boolean" &&
            typeof this.backupState === "boolean" &&
            (!this.backupState || this.backupEligible) &&
            Object.values(PasskeyCounterPolicy).includes(this.counterPolicy) &&
            Number.isInteger(this.counter) &&
            this.counter >= 0 &&
            this.counter <= 0xffffffff &&
            this.created instanceof Date &&
            (typeof this.lastUsed === "undefined" || this.lastUsed instanceof Date)
        );
    }
}

function isEs256PublicJwk(value: any, operation: "sign" | "verify"): value is PasskeyEs256PublicJwk {
    return (
        value &&
        value.kty === "EC" &&
        value.crv === "P-256" &&
        (typeof value.alg === "undefined" || value.alg === "ES256") &&
        (typeof value.ext === "undefined" || value.ext === true) &&
        (typeof value.key_ops === "undefined" ||
            (Array.isArray(value.key_ops) &&
                value.key_ops.includes(operation) &&
                !value.key_ops.includes(operation === "sign" ? "verify" : "sign"))) &&
        typeof value.x === "string" &&
        value.x.length > 0 &&
        typeof value.y === "string" &&
        value.y.length > 0
    );
}

function isEs256PrivateJwk(value: any): value is PasskeyEs256PrivateJwk {
    return isEs256PublicJwk(value, "sign") && typeof (value as any).d === "string" && (value as any).d.length > 0;
}
