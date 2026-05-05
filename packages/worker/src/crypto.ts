import {
    AESEncryptionParams,
    AESKey,
    AESKeyParams,
    CryptoProvider,
    HashParams,
    HMACKey,
    HMACKeyParams,
    HMACParams,
    PBKDF2Params,
    RSAEncryptionParams,
    RSAKeyParams,
    RSAPrivateKey,
    RSAPublicKey,
    RSASigningParams,
    SymmetricKey,
} from "@padloc/core/src/crypto";

const notImplementedMessage = "WorkerCryptoProvider is not implemented yet; T13 must satisfy crypto parity vectors.";

export class WorkerCryptoProvider implements CryptoProvider {
    async randomBytes(_n: number): Promise<Uint8Array> {
        throw new Error(notImplementedMessage);
    }

    async hash(_input: Uint8Array, _params: HashParams): Promise<Uint8Array> {
        throw new Error(notImplementedMessage);
    }

    generateKey(params: AESKeyParams): Promise<AESKey>;
    generateKey(params: HMACKeyParams): Promise<HMACKey>;
    generateKey(params: RSAKeyParams): Promise<{ privateKey: RSAPrivateKey; publicKey: RSAPublicKey }>;
    async generateKey(
        _params: AESKeyParams | HMACKeyParams | RSAKeyParams,
    ): Promise<AESKey | HMACKey | { privateKey: RSAPrivateKey; publicKey: RSAPublicKey }> {
        throw new Error(notImplementedMessage);
    }

    async deriveKey(_password: Uint8Array, _params: PBKDF2Params): Promise<SymmetricKey> {
        throw new Error(notImplementedMessage);
    }

    encrypt(key: AESKey, data: Uint8Array, params: AESEncryptionParams): Promise<Uint8Array>;
    encrypt(publicKey: RSAPublicKey, data: Uint8Array, params: RSAEncryptionParams): Promise<Uint8Array>;
    async encrypt(
        _key: AESKey | RSAPublicKey,
        _data: Uint8Array,
        _params: AESEncryptionParams | RSAEncryptionParams,
    ): Promise<Uint8Array> {
        throw new Error(notImplementedMessage);
    }

    decrypt(key: AESKey, data: Uint8Array, params: AESEncryptionParams): Promise<Uint8Array>;
    decrypt(privateKey: RSAPrivateKey, data: Uint8Array, params: RSAEncryptionParams): Promise<Uint8Array>;
    async decrypt(
        _key: AESKey | RSAPrivateKey,
        _data: Uint8Array,
        _params: AESEncryptionParams | RSAEncryptionParams,
    ): Promise<Uint8Array> {
        throw new Error(notImplementedMessage);
    }

    sign(key: HMACKey, data: Uint8Array, params: HMACParams): Promise<Uint8Array>;
    sign(key: RSAPrivateKey, data: Uint8Array, params: RSASigningParams): Promise<Uint8Array>;
    async sign(
        _key: HMACKey | RSAPrivateKey,
        _data: Uint8Array,
        _params: HMACParams | RSASigningParams,
    ): Promise<Uint8Array> {
        throw new Error(notImplementedMessage);
    }

    verify(key: HMACKey, signature: Uint8Array, data: Uint8Array, params: HMACParams): Promise<boolean>;
    verify(key: RSAPublicKey, signature: Uint8Array, data: Uint8Array, params: RSASigningParams): Promise<boolean>;
    async verify(
        _key: HMACKey | RSAPublicKey,
        _signature: Uint8Array,
        _data: Uint8Array,
        _params: HMACParams | RSASigningParams,
    ): Promise<boolean> {
        throw new Error(notImplementedMessage);
    }

    async fingerprint(_key: RSAPublicKey): Promise<Uint8Array> {
        throw new Error(notImplementedMessage);
    }

    async timingSafeEqual(_a: Uint8Array, _b: Uint8Array): Promise<boolean> {
        throw new Error(notImplementedMessage);
    }
}
