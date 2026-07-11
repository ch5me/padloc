import { AsBytes, AsDate, AsSerializable, Serializable } from "./encoding";

export enum PasskeyCounterPolicy {
    None = "none",
    Incrementing = "incrementing",
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
