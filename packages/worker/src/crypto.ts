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
import { Err, ErrorCode } from "@padloc/core/src/error";

function subtle() {
    return globalThis.crypto.subtle;
}

function bufferSource(bytes: Uint8Array): BufferSource {
    return new Uint8Array(bytes);
}

function hashAlgorithm(name: "SHA-1" | "SHA-256"): Algorithm {
    return { name };
}

function aesAlgorithm(params: AESEncryptionParams): AesGcmParams {
    return {
        name: params.algorithm,
        iv: bufferSource(params.iv),
        additionalData: bufferSource(params.additionalData),
        tagLength: params.tagSize,
    };
}

function aesKeyAlgorithm(params: AESEncryptionParams | AESKeyParams): AesKeyAlgorithm {
    return {
        name: params.algorithm === "AES" ? "AES-GCM" : params.algorithm,
        length: params.keySize,
    };
}

function hmacAlgorithm(params: HMACParams | HMACKeyParams): HmacImportParams {
    return {
        name: "HMAC",
        hash: hashAlgorithm("hash" in params ? params.hash : "SHA-256"),
        length: params.keySize,
    };
}

function rsaOaepKeyAlgorithm(params: RSAEncryptionParams): RsaHashedImportParams {
    return {
        name: params.algorithm,
        hash: hashAlgorithm(params.hash),
    };
}

function rsaOaepOperation(): RsaOaepParams {
    return { name: "RSA-OAEP" };
}

function rsaPssKeyAlgorithm(params: RSAKeyParams | RSASigningParams): RsaHashedImportParams {
    return {
        name: "RSA-PSS",
        hash: hashAlgorithm(params.hash),
    };
}

function rsaPssGenerateAlgorithm(params: RSAKeyParams): RsaHashedKeyGenParams {
    const publicExponent = new Uint8Array(params.publicExponent.length);
    publicExponent.set(params.publicExponent);

    return {
        name: "RSA-PSS",
        hash: hashAlgorithm(params.hash),
        modulusLength: params.modulusLength,
        publicExponent,
    };
}

function rsaPssSignAlgorithm(params: RSASigningParams): RsaPssParams {
    return {
        name: params.algorithm,
        saltLength: params.saltLength,
    };
}

function constantTimeEqual(a: Uint8Array, b: Uint8Array) {
    const length = Math.max(a.length, b.length);
    let diff = a.length ^ b.length;

    for (let i = 0; i < length; i++) {
        const left = i < a.length ? a[i] : 0;
        const right = i < b.length ? b[i] : 0;
        diff |= left ^ right;
    }

    return diff === 0;
}

export class WorkerCryptoProvider implements CryptoProvider {
    async randomBytes(n: number): Promise<Uint8Array> {
        return globalThis.crypto.getRandomValues(new Uint8Array(n));
    }

    async hash(input: Uint8Array, params: HashParams): Promise<Uint8Array> {
        const digest = await subtle().digest(hashAlgorithm(params.algorithm), bufferSource(input));
        return new Uint8Array(digest);
    }

    generateKey(params: AESKeyParams): Promise<AESKey>;
    generateKey(params: HMACKeyParams): Promise<HMACKey>;
    generateKey(params: RSAKeyParams): Promise<{ privateKey: RSAPrivateKey; publicKey: RSAPublicKey }>;
    async generateKey(
        params: AESKeyParams | HMACKeyParams | RSAKeyParams
    ): Promise<AESKey | HMACKey | { privateKey: RSAPrivateKey; publicKey: RSAPublicKey }> {
        switch (params.algorithm) {
            case "AES":
            case "HMAC":
                return this.randomBytes(params.keySize / 8);
            case "RSA": {
                const keyPair = await subtle().generateKey(rsaPssGenerateAlgorithm(params), true, ["sign", "verify"]);

                if (!("privateKey" in keyPair) || !("publicKey" in keyPair)) {
                    throw new Err(ErrorCode.NOT_SUPPORTED, "RSA key generation did not return a key pair.");
                }

                const privateKey = await subtle().exportKey("pkcs8", keyPair.privateKey);
                const publicKey = await subtle().exportKey("spki", keyPair.publicKey);

                return {
                    privateKey: new Uint8Array(privateKey),
                    publicKey: new Uint8Array(publicKey),
                };
            }
        }
    }

    async deriveKey(password: Uint8Array, params: PBKDF2Params): Promise<SymmetricKey> {
        const baseKey = await subtle().importKey("raw", bufferSource(password), params.algorithm, false, [
            "deriveBits",
        ]);
        const key = await subtle().deriveBits(
            {
                name: params.algorithm,
                salt: bufferSource(params.salt),
                iterations: params.iterations,
                hash: hashAlgorithm(params.hash),
            },
            baseKey,
            params.keySize
        );

        return new Uint8Array(key);
    }

    encrypt(key: AESKey, data: Uint8Array, params: AESEncryptionParams): Promise<Uint8Array>;
    encrypt(publicKey: RSAPublicKey, data: Uint8Array, params: RSAEncryptionParams): Promise<Uint8Array>;
    async encrypt(
        key: AESKey | RSAPublicKey,
        data: Uint8Array,
        params: AESEncryptionParams | RSAEncryptionParams
    ): Promise<Uint8Array> {
        switch (params.algorithm) {
            case "AES-GCM":
                return this._encryptAES(key, data, params);
            case "AES-CCM":
                throw new Err(ErrorCode.NOT_SUPPORTED, "AES-CCM is not supported by Worker Web Crypto v1.");
            case "RSA-OAEP":
                return this._encryptRSA(key, data, params);
            default:
                throw new Err(ErrorCode.INVALID_ENCRYPTION_PARAMS);
        }
    }

    decrypt(key: AESKey, data: Uint8Array, params: AESEncryptionParams): Promise<Uint8Array>;
    decrypt(privateKey: RSAPrivateKey, data: Uint8Array, params: RSAEncryptionParams): Promise<Uint8Array>;
    async decrypt(
        key: AESKey | RSAPrivateKey,
        data: Uint8Array,
        params: AESEncryptionParams | RSAEncryptionParams
    ): Promise<Uint8Array> {
        switch (params.algorithm) {
            case "AES-GCM":
                return this._decryptAES(key, data, params);
            case "AES-CCM":
                throw new Err(ErrorCode.NOT_SUPPORTED, "AES-CCM is not supported by Worker Web Crypto v1.");
            case "RSA-OAEP":
                return this._decryptRSA(key, data, params);
            default:
                throw new Err(ErrorCode.INVALID_ENCRYPTION_PARAMS);
        }
    }

    sign(key: HMACKey, data: Uint8Array, params: HMACParams): Promise<Uint8Array>;
    sign(key: RSAPrivateKey, data: Uint8Array, params: RSASigningParams): Promise<Uint8Array>;
    async sign(
        key: HMACKey | RSAPrivateKey,
        data: Uint8Array,
        params: HMACParams | RSASigningParams
    ): Promise<Uint8Array> {
        switch (params.algorithm) {
            case "HMAC":
                return this._signHMAC(key, data, params);
            case "RSA-PSS":
                return this._signRSA(key, data, params);
            default:
                throw new Err(ErrorCode.NOT_SUPPORTED);
        }
    }

    verify(key: HMACKey, signature: Uint8Array, data: Uint8Array, params: HMACParams): Promise<boolean>;
    verify(key: RSAPublicKey, signature: Uint8Array, data: Uint8Array, params: RSASigningParams): Promise<boolean>;
    async verify(
        key: HMACKey | RSAPublicKey,
        signature: Uint8Array,
        data: Uint8Array,
        params: HMACParams | RSASigningParams
    ): Promise<boolean> {
        switch (params.algorithm) {
            case "HMAC":
                return this._verifyHMAC(key, signature, data, params);
            case "RSA-PSS":
                return this._verifyRSA(key, signature, data, params);
            default:
                throw new Err(ErrorCode.NOT_SUPPORTED);
        }
    }

    async fingerprint(key: RSAPublicKey): Promise<Uint8Array> {
        return this.hash(key, new HashParams({ algorithm: "SHA-256" }));
    }

    async timingSafeEqual(a: Uint8Array, b: Uint8Array): Promise<boolean> {
        return constantTimeEqual(a, b);
    }

    private async _encryptAES(key: AESKey, data: Uint8Array, params: AESEncryptionParams): Promise<Uint8Array> {
        const cryptoKey = await subtle().importKey("raw", bufferSource(key), aesKeyAlgorithm(params), false, [
            "encrypt",
        ]);

        try {
            const encrypted = await subtle().encrypt(aesAlgorithm(params), cryptoKey, bufferSource(data));
            return new Uint8Array(encrypted);
        } catch (error) {
            throw new Err(ErrorCode.ENCRYPTION_FAILED, undefined, {
                error: error instanceof Error ? error : undefined,
            });
        }
    }

    private async _decryptAES(key: AESKey, data: Uint8Array, params: AESEncryptionParams): Promise<Uint8Array> {
        const cryptoKey = await subtle().importKey("raw", bufferSource(key), aesKeyAlgorithm(params), false, [
            "decrypt",
        ]);

        try {
            const decrypted = await subtle().decrypt(aesAlgorithm(params), cryptoKey, bufferSource(data));
            return new Uint8Array(decrypted);
        } catch (error) {
            throw new Err(ErrorCode.DECRYPTION_FAILED, undefined, {
                error: error instanceof Error ? error : undefined,
            });
        }
    }

    private async _encryptRSA(
        publicKey: RSAPublicKey,
        data: Uint8Array,
        params: RSAEncryptionParams
    ): Promise<Uint8Array> {
        const cryptoKey = await subtle().importKey(
            "spki",
            bufferSource(publicKey),
            rsaOaepKeyAlgorithm(params),
            false,
            ["encrypt"]
        );

        try {
            const encrypted = await subtle().encrypt(rsaOaepOperation(), cryptoKey, bufferSource(data));
            return new Uint8Array(encrypted);
        } catch (error) {
            throw new Err(ErrorCode.ENCRYPTION_FAILED, undefined, {
                error: error instanceof Error ? error : undefined,
            });
        }
    }

    private async _decryptRSA(
        privateKey: RSAPrivateKey,
        data: Uint8Array,
        params: RSAEncryptionParams
    ): Promise<Uint8Array> {
        const cryptoKey = await subtle().importKey(
            "pkcs8",
            bufferSource(privateKey),
            rsaOaepKeyAlgorithm(params),
            false,
            ["decrypt"]
        );

        try {
            const decrypted = await subtle().decrypt(rsaOaepOperation(), cryptoKey, bufferSource(data));
            return new Uint8Array(decrypted);
        } catch (error) {
            throw new Err(ErrorCode.DECRYPTION_FAILED, undefined, {
                error: error instanceof Error ? error : undefined,
            });
        }
    }

    private async _signHMAC(key: HMACKey, data: Uint8Array, params: HMACParams): Promise<Uint8Array> {
        const algorithm = hmacAlgorithm(params);
        // Web Crypto rejects HMAC keys longer than the hash output. Hash them down first.
        const effectiveKey = key.length > 32 ? await this.hash(key, new HashParams({ algorithm: "SHA-256" })) : key;
        const cryptoKey = await subtle().importKey("raw", bufferSource(effectiveKey), algorithm, false, ["sign"]);
        const signature = await subtle().sign(algorithm, cryptoKey, bufferSource(data));
        return new Uint8Array(signature);
    }

    private async _verifyHMAC(
        key: HMACKey,
        signature: Uint8Array,
        data: Uint8Array,
        params: HMACParams
    ): Promise<boolean> {
        const expected = await this._signHMAC(key, data, params);
        return this.timingSafeEqual(expected, signature);
    }

    private async _signRSA(key: RSAPrivateKey, data: Uint8Array, params: RSASigningParams): Promise<Uint8Array> {
        const cryptoKey = await subtle().importKey("pkcs8", bufferSource(key), rsaPssKeyAlgorithm(params), false, [
            "sign",
        ]);
        const signature = await subtle().sign(rsaPssSignAlgorithm(params), cryptoKey, bufferSource(data));
        return new Uint8Array(signature);
    }

    private async _verifyRSA(
        key: RSAPublicKey,
        signature: Uint8Array,
        data: Uint8Array,
        params: RSASigningParams
    ): Promise<boolean> {
        const cryptoKey = await subtle().importKey("spki", bufferSource(key), rsaPssKeyAlgorithm(params), false, [
            "verify",
        ]);
        return subtle().verify(rsaPssSignAlgorithm(params), cryptoKey, bufferSource(signature), bufferSource(data));
    }
}
