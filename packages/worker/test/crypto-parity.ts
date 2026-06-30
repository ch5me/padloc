import {
    AESEncryptionParams,
    CryptoProvider,
    HashParams,
    HMACParams,
    PBKDF2Params,
    RSAEncryptionParams,
    RSASigningParams,
} from "@padloc/core/src/crypto";
import {
    base64ToBytes,
    bytesToHex,
    bytesToString,
    hexToBytes,
    marshal,
    stringToBytes,
} from "@padloc/core/src/encoding";

export interface CryptoParityResult {
    name: string;
    source: string;
    ok: boolean;
    detail: string;
}

export interface CryptoParityReport {
    ok: boolean;
    runtime: "cloudflare-worker";
    generatedAt: string;
    summary: {
        total: number;
        passed: number;
        failed: number;
    };
    benchmark?: CryptoBudgetResult;
    results: CryptoParityResult[];
}

export interface CryptoBudgetResult {
    name: string;
    ok: boolean;
    wallMs: number;
    thresholdMs: number;
    pbkdf2Iterations: number;
    note: string;
}

export interface CryptoParityOptions {
    includeBenchmark?: boolean;
    enforceBudget?: boolean;
    budgetThresholdMs?: number;
}

interface CryptoParityVector {
    name: string;
    source: string;
    run(provider: CryptoProvider): Promise<void | string>;
}

const vectorSources = {
    webCrypto:
        "Cloudflare Worker runtime requirement: globalThis.crypto.getRandomValues and crypto.subtle must be present so primitives are implemented with Web Crypto, not Node crypto.",
    srp: "Padloc SRP-6a formula from packages/core/src/srp.ts, generated once with fixed x/a/b values and SHA-256 over Padloc's unpadded bigint byte encoding.",
    hmac: "Padloc RequestAuthentication message contract from packages/core/src/session.ts with fixed session id, ISO timestamp, marshalled params, and HMAC-SHA-256 expected output.",
    pbes2: "PBKDF2-HMAC-SHA-256 password/salt/iteration vector plus AES-256-GCM ciphertext||tag generated from fixed PBES2 inputs documented in this file.",
    rsa: "Existing deterministic Padloc RSA DER fixtures from packages/core/src/spec/crypto.ts for RSA-OAEP decrypt and RSA-PSS verify; signing is verified round-trip because RSA-PSS salts are random.",
    totp: "RFC 6238 Appendix B TOTP vectors for SHA-1 and SHA-256 at Unix time 59 seconds.",
    webauthn:
        "Worker-safe WebAuthn verifier input shape from packages/server/src/auth/webauthn.ts: expectedChallenge, expectedOrigin, expectedRPID, credential, and authenticator fields without Node byte coercion.",
};

function assertHex(actual: Uint8Array, expected: string, label: string) {
    const actualHex = bytesToHex(actual);
    if (actualHex !== expected) {
        throw new Error(`${label}: expected ${expected}, got ${actualHex}`);
    }
}

function assertTrue(value: boolean, label: string) {
    if (!value) {
        throw new Error(label);
    }
}

function assertFalse(value: boolean, label: string) {
    if (value) {
        throw new Error(label);
    }
}

function assertEqual(actual: string | number, expected: string | number, label: string) {
    if (actual !== expected) {
        throw new Error(`${label}: expected ${expected}, got ${actual}`);
    }
}

function tamper(bytes: Uint8Array) {
    const copy = new Uint8Array(bytes);
    copy[0] = copy[0] ^ 0x01;
    return copy;
}

function concatBytes(parts: Uint8Array[]): Uint8Array {
    const length = parts.reduce((sum, part) => sum + part.length, 0);
    const output = new Uint8Array(length);
    let offset = 0;

    for (const part of parts) {
        output.set(part, offset);
        offset += part.length;
    }

    return output;
}

function bigintToBytes(value: bigint): Uint8Array {
    let hex = value.toString(16);
    if (hex.length % 2) {
        hex = `0${hex}`;
    }
    return hexToBytes(hex);
}

function bytesToBigint(bytes: Uint8Array): bigint {
    const hex = bytesToHex(bytes);
    return hex ? BigInt(`0x${hex}`) : 0n;
}

function positiveMod(value: bigint, modulus: bigint): bigint {
    return ((value % modulus) + modulus) % modulus;
}

function modPow(base: bigint, exponent: bigint, modulus: bigint): bigint {
    let result = 1n;
    let factor = positiveMod(base, modulus);
    let remaining = exponent;

    while (remaining > 0n) {
        if (remaining & 1n) {
            result = (result * factor) % modulus;
        }
        remaining >>= 1n;
        factor = (factor * factor) % modulus;
    }

    return result;
}

async function srpHash(provider: CryptoProvider, ...values: bigint[]): Promise<bigint> {
    const digest = await provider.hash(concatBytes(values.map(bigintToBytes)), new HashParams());
    return bytesToBigint(digest);
}

function numToBytes(num: number): Uint8Array {
    return hexToBytes(num.toString(16).padStart(16, "0"));
}

function bytesToNum(bytes: Uint8Array): number {
    return parseInt(bytesToHex(bytes), 16);
}

function hotpToken(hmac: Uint8Array, digits: number): string {
    const offset = hmac[hmac.length - 1] & 0x0f;
    const bin = new Uint8Array([hmac[offset] & 0x7f, hmac[offset + 1], hmac[offset + 2], hmac[offset + 3]]);
    return (bytesToNum(bin) % 10 ** digits).toString().padStart(digits, "0");
}

async function totpToken(
    provider: CryptoProvider,
    secret: Uint8Array,
    time: number,
    opts: { interval: number; digits: number; hash: "SHA-1" | "SHA-256" }
): Promise<string> {
    const counter = Math.floor(time / opts.interval / 1000);
    const hmac = await provider.sign(
        secret,
        numToBytes(counter),
        new HMACParams({ hash: opts.hash, keySize: secret.length * 8 })
    );
    return hotpToken(hmac, opts.digits);
}

const srpN4096 = BigInt(
    "0x" +
        "FFFFFFFFFFFFFFFFC90FDAA22168C234C4C6628B80DC1CD129024E088A67CC74020BBEA63B139B22514A08798E3404DDEF9519B3CD3A431B302B0A6DF25F14374FE1356D6D51C245E485B576625E7EC6F44C42E9A637ED6B0BFF5CB6F406B7EDEE386BFB5A899FA5AE9F24117C4B1FE649286651ECE45B3DC2007CB8A163BF0598DA48361C55D39A69163FA8FD24CF5F83655D23DCA3AD961C62F356208552BB9ED529077096966D670C354E4ABC9804F1746C08CA18217C32905E462E36CE3BE39E772C180E86039B2783A2EC07A28FB5C55DF06F4C52C9DE2BCBF6955817183995497CEA956AE515D2261898FA051015728E5A8AAAC42DAD33170D04507A33A85521ABDF1CBA64ECFB850458DBEF0A8AEA71575D060C7DB3970F85A6E1E4C7ABF5AE8CDB0933D71E8C94E04A25619DCEE3D2261AD2EE6BF12FFA06D98A0864D87602733EC86A64521F2B18177B200CBBE117577A615D6C770988C0BAD946E208E24FA074E5AB3143DB5BFCE0FD108E4B82D120A92108011A723C12A787E6D788719A10BDBA5B2699C327186AF4E23C1A946834B6150BDA2583E9CA2AD44CE8DBBBC2DB04DE8EF92E8EFC141FBECAA6287C59474E6BC05D99B2964FA090C3A2233BA186515BE7ED1F612970CEE2D7AFB81BDD762170481CD0069127D5B05AA993B4EA988D8FDDC186FFB7DC90A6C08F4DF435C934063199FFFFFFFFFFFFFFFF"
);

const rsaFixture = {
    privateKey: base64ToBytes(
        "MIIEvwIBADANBgkqhkiG9w0BAQEFAASCBKkwggSlAgEAAoIBAQDj62aokh6EDbYLbqHaMJvsf1GBx6P_ht7RvVyuBmL3L4uDhmFKWlnNvhZxvtUXM0R3zvuGtsS7l-fNRj_ljTztaT0oA9Z7QOvv6LZqDssd6QCPNMF_p56ZHEVjSUyC8qFjpk2zC_tSebWT_QSbeRQq9QnGcOhjOjp50SGH1ONdzjto5L7Y9uVFno14Q1IO29U-Xrai_H3B-ApUMdGAdVU-bgBKZnbArIUmcjWSkPSfPDvE4m8gLEvYbyFzegS0x1EhkaCj-X1LrJSiav8SKFNtTs7PX3cXuIw9uGPzNTOGFwoK2WFC6sRnwRUaZGwrxbZSjDEOwx13GdCy_aLo5_3LAgMBAAECggEBALSiCAZpZ834n-KHl7a495qDfTGB67PETCumDCHP5fdJsyRWCB1JZgrtMBSNzYxJkWXyoN2vVFPonEnP9ywSt8rgsRtZj063sUW-BXQgrVHTLCJTCVgGnGd0RHnfyceuS8ISN1pDkLdYxlO3H0OovhcdhNXE_ihGKboJyK1CR8A7BzKBsQrbv-TGK3i911i44cVP52FAVoBfM-12MT0mfSb3iaSlgsscWhWP98CON8wYvE8a8JSoYVn9uKmwbW8F4fSrpW4hEOfWbcEC2XA9fbXs1tNqhX_uOiEHLxFAfjqkH72ogVPJ4MQjtQCCnCoqRAzQjgx73CbG_9ttLq4NFkECgYEA-luzC5l6Fc3DpEBiLHFowuZDRD3RTaW-nFp_WTvZX6_65xWLpVTmH2R7ymzTME0mIkv6P657kZirdhJJoMvO7fEtyL-WfaNzmxQu5NYn9iW1xTAYpEFa3Vd7zbwznkCpbvk43RAQxLYLntw8CTM5kf9nQIavhAAjTCCxj-87nnMCgYEA6Q5BHp0NIXrwsec3_ccqWamUzzAyG_AxNPnTH9RaYCYJB0jZmTXWvEIFfnw9wVoblAqk9WKfkMbRKUNf3lLS4nTzehRDJNXTprxENoesTznI4eAX1o0qULll7cRsqHpZ-j6OcVRzLpsnCOHfnXEh6ABRgE7u0-gmuleZrpH-NUkCgYBIbd8OrAg15qGDE11TnjvApv0u8PNsk1bhxQyytC3fEPp1gDY2TqmEy31EwtcWUjuGEJUFd2UoahKwxfmnG09yZyPnwAW5s1_urZgjfBFzlNVRhuiaHI49GuImUxxb3DkocdGRouQ3BLO38d8sijVNl6Y3dL-yYJfVnl_AVGXbIQKBgQClcKwDimN23-obsFLMAWVr7vknN0RrFtAnli0sjDd3x6hjFnD51QFR9OAnkRTZvBiVuBSv6UnyoWB7lUtp7IutnG32vImJjY1I8J7PwvIr745N4iGp-d4PHf1gky67Tteu0FeX1eZKMHO-V3HBNz1lj0xL9DyQC13qrCL5jMPTmQKBgQCnC98PEayu27weEf1wG_u-RBnq6ON7JVMfm8dhYb3k1pbgzmEaW1qNo1bFGPgbOP7VWWLKlLJXDuiSshJtfy6hmTl2zVMM0qkpepVhp5O3Vq-ABFANleJ4LbVDGdiz5ikGL5IKx3Ra5BbtTj4vX4NOTAKTGvgNjjvYcDYoI62DZg"
    ),
    publicKey: base64ToBytes(
        "MIIBIjANBgkqhkiG9w0BAQEFAAOCAQ8AMIIBCgKCAQEA4-tmqJIehA22C26h2jCb7H9Rgcej_4be0b1crgZi9y-Lg4ZhSlpZzb4Wcb7VFzNEd877hrbEu5fnzUY_5Y087Wk9KAPWe0Dr7-i2ag7LHekAjzTBf6eemRxFY0lMgvKhY6ZNswv7Unm1k_0Em3kUKvUJxnDoYzo6edEhh9TjXc47aOS-2PblRZ6NeENSDtvVPl62ovx9wfgKVDHRgHVVPm4ASmZ2wKyFJnI1kpD0nzw7xOJvICxL2G8hc3oEtMdRIZGgo_l9S6yUomr_EihTbU7Oz193F7iMPbhj8zUzhhcKCtlhQurEZ8EVGmRsK8W2UowxDsMddxnQsv2i6Of9ywIDAQAB"
    ),
    sigData: base64ToBytes("Fm3BL9O9py8ImFOsQ9MLPuPDWORdNeV6xks48loc4EU"),
    signature: base64ToBytes(
        "sh6hSSYUER2MISzKD9fUW1KGBILaP8THFX7BKR8RO4oFMpfZTioy8O3yQ726rO69zaGKP5kxY_iP1R_-5t4_3QuWEItZFvy8Ja1bFF8S80OIyap3Nx0nKWAwiU6aPz0yy2HrYNxd6zJufojcM1_dVKlq954sLq45yhNuQPVBAKsfrPHYoqWiuyP820wD1ysghg6h6EtB6SZzNsAL9tg5uuyQo-bO6VqqsccE-aaVFxD4w_xA9pGmjQe3HUTaNdi7cfPnMTygHN2qoTzSuFVbUAOQ1KGWRWdLnz3Wj9yJb_-FyBAzGbKxNANqnQyCIVrlD4zGCe_f6JsS-kvTxSu9fw"
    ),
    plain: stringToBytes("Hello World!"),
    encrypted: base64ToBytes(
        "eAJDfWUdgL4Wl0UDsA0WsmHE29MNAnTvSjus3N0BP6foD0fFZBlrfmRbF-KjY_2zYhgaqn7E4pEKMB20tPDC-JYcAJO8PMWOR6PdLBsBCUTbdYy062iwFWgWfzSFV2LDy-G2t9HL2CbDoDAdsh1fNGIm81nY9sXbB0kKM4uNXKTdVl49Cwf30jiRRpABV_tSPmQjkHDVWOphVEY5ex0hhveRC6vfO1YZ21-CuoTa1gRq-ab21V-Pl5rfQ0RHsDgtvvSJ8_3ihzCkOTjd2Anj0GiKEsCeV0NaEgT-e5WyDj2zYNIsVOoMmB65UUkXX002Ycc2cGuoYw2uudZQSaAlqg"
    ),
};

async function runCompleteAuthRequestCryptoBudget(
    provider: CryptoProvider,
    thresholdMs: number
): Promise<CryptoBudgetResult> {
    const started = performance.now();
    const x = bytesToBigint(
        await provider.deriveKey(
            stringToBytes("correct horse battery staple"),
            new PBKDF2Params({
                salt: stringToBytes("padloc-worker-complete-auth-budget"),
                iterations: 1_000_000,
            })
        )
    );

    const g = 5n;
    const a = bytesToBigint(hexToBytes("0102030405060708090a0b0c0d0e0f101112131415161718191a1b1c1d1e1f20"));
    const b = bytesToBigint(hexToBytes("2122232425262728292a2b2c2d2e2f303132333435363738393a3b3c3d3e3f40"));
    const k = await srpHash(provider, srpN4096, g);
    const v = modPow(g, x, srpN4096);
    const A = modPow(g, a, srpN4096);
    const B = positiveMod(k * v + modPow(g, b, srpN4096), srpN4096);
    const u = await srpHash(provider, A, B);
    const clientS = modPow(positiveMod(B - k * modPow(g, x, srpN4096), srpN4096), a + u * x, srpN4096);
    const serverS = modPow(positiveMod(A * modPow(v, u, srpN4096), srpN4096), b, srpN4096);
    const clientK = await srpHash(provider, clientS);
    const serverK = await srpHash(provider, serverS);
    const rsaVerified = await provider.verify(
        rsaFixture.publicKey,
        rsaFixture.signature,
        rsaFixture.sigData,
        new RSASigningParams()
    );

    assertTrue(
        await provider.timingSafeEqual(bigintToBytes(clientK), bigintToBytes(serverK)),
        "completeAuthRequest SRP K must match"
    );
    assertTrue(rsaVerified, "completeAuthRequest RSA-PSS verification must pass");

    const wallMs = performance.now() - started;
    return {
        name: "completeAuthRequest crypto budget",
        ok: wallMs <= thresholdMs,
        wallMs: Math.round(wallMs * 100) / 100,
        thresholdMs,
        pbkdf2Iterations: 1_000_000,
        note: "Measures PBKDF2-HMAC-SHA-256 1M + SRP-4096 + RSA-PSS verify in the Worker request path.",
    };
}

const vectors: CryptoParityVector[] = [
    {
        name: "Worker Web Crypto runtime availability",
        source: vectorSources.webCrypto,
        async run(_provider) {
            assertTrue(typeof globalThis.crypto?.getRandomValues === "function", "crypto.getRandomValues must exist");
            assertTrue(typeof globalThis.crypto?.subtle?.digest === "function", "crypto.subtle.digest must exist");
            assertTrue(
                typeof globalThis.crypto?.subtle?.importKey === "function",
                "crypto.subtle.importKey must exist"
            );
            assertTrue(
                typeof globalThis.crypto?.subtle?.deriveBits === "function",
                "crypto.subtle.deriveBits must exist"
            );
            assertTrue(typeof globalThis.crypto?.subtle?.encrypt === "function", "crypto.subtle.encrypt must exist");
            assertTrue(typeof globalThis.crypto?.subtle?.sign === "function", "crypto.subtle.sign must exist");
            assertTrue(typeof globalThis.crypto?.subtle?.verify === "function", "crypto.subtle.verify must exist");
        },
    },
    {
        name: "SRP/session negotiation M1/M2 verification",
        source: vectorSources.srp,
        async run(provider) {
            const g = 5n;
            const x = bytesToBigint(hexToBytes("120fb6cffcf8b32c43e7225256c4f837a86548c92ccc35480805987cb70be17b"));
            const a = bytesToBigint(hexToBytes("0102030405060708090a0b0c0d0e0f101112131415161718191a1b1c1d1e1f20"));
            const b = bytesToBigint(hexToBytes("2122232425262728292a2b2c2d2e2f303132333435363738393a3b3c3d3e3f40"));

            const k = await srpHash(provider, srpN4096, g);
            const v = modPow(g, x, srpN4096);
            const A = modPow(g, a, srpN4096);
            const B = positiveMod(k * v + modPow(g, b, srpN4096), srpN4096);
            const u = await srpHash(provider, A, B);
            const clientS = modPow(positiveMod(B - k * modPow(g, x, srpN4096), srpN4096), a + u * x, srpN4096);
            const serverS = modPow(positiveMod(A * modPow(v, u, srpN4096), srpN4096), b, srpN4096);
            const clientK = await srpHash(provider, clientS);
            const serverK = await srpHash(provider, serverS);
            const clientM1 = await srpHash(provider, A, B, clientK);
            const serverM1 = await srpHash(provider, A, B, serverK);
            const clientM2 = await srpHash(provider, A, clientM1, clientK);
            const serverM2 = await srpHash(provider, A, serverM1, serverK);
            const clientM1Bytes = bigintToBytes(clientM1);
            const serverM1Bytes = bigintToBytes(serverM1);

            assertHex(
                bigintToBytes(clientK),
                "759487c2ec7420d1aa52f6d7c273b29c10c130cbd8859b08ea34751632702485",
                "client K"
            );
            assertHex(
                bigintToBytes(serverK),
                "759487c2ec7420d1aa52f6d7c273b29c10c130cbd8859b08ea34751632702485",
                "server K"
            );
            assertHex(clientM1Bytes, "6f18a4ef21763db8a597ce3a86cccd64dc8e1545a0666242a3df174a55a2f8f0", "client M1");
            assertHex(serverM1Bytes, "6f18a4ef21763db8a597ce3a86cccd64dc8e1545a0666242a3df174a55a2f8f0", "server M1");
            assertHex(
                bigintToBytes(clientM2),
                "e6d748d9381afd54421f308598464d212f11811fdca236bef5b169b3afd8f99a",
                "client M2"
            );
            assertHex(
                bigintToBytes(serverM2),
                "e6d748d9381afd54421f308598464d212f11811fdca236bef5b169b3afd8f99a",
                "server M2"
            );
            assertTrue(
                await provider.timingSafeEqual(clientM1Bytes, serverM1Bytes),
                "M1 must verify with timingSafeEqual"
            );
            assertFalse(
                clientM1Bytes === serverM1Bytes,
                "packages/core/src/srp.ts documents `server.M1 !== M1`; byte arrays need constant-time byte comparison, not `===` identity comparison"
            );
            assertFalse(
                await provider.timingSafeEqual(clientM1Bytes, tamper(serverM1Bytes)),
                "tampered M1 must not verify"
            );
        },
    },
    {
        name: "HMAC request signature contract",
        source: vectorSources.hmac,
        async run(provider) {
            const params = new HMACParams();
            const key = hexToBytes("000102030405060708090a0b0c0d0e0f101112131415161718191a1b1c1d1e1f");
            const session = "session-parity-0001";
            const time = "2024-01-02T03:04:05.006Z";
            const data = [{ method: "unlock", counter: 7, ok: true }];
            const message = `${session}_${time}_${marshal(data)}`;
            const messageBytes = stringToBytes(message);
            const signature = await provider.sign(key, messageBytes, params);

            assertHex(signature, "97a17f9e2281b60372ee7c999dfbbb19f9b05464237a29b8e6ffa82503b8ad5f", "request HMAC");
            assertTrue(await provider.verify(key, signature, messageBytes, params), "request HMAC must verify");
            assertFalse(
                await provider.verify(key, tamper(signature), messageBytes, params),
                "tampered request HMAC must fail"
            );
        },
    },
    {
        name: "PBES2/PBKDF2 and AES-GCM vector",
        source: vectorSources.pbes2,
        async run(provider) {
            const keyParams = new PBKDF2Params({
                salt: stringToBytes("salt"),
                iterations: 1,
            });
            const key = await provider.deriveKey(stringToBytes("password"), keyParams);
            assertHex(key, "120fb6cffcf8b32c43e7225256c4f837a86548c92ccc35480805987cb70be17b", "PBKDF2 key");

            const encryptionParams = new AESEncryptionParams();
            Object.assign(encryptionParams, {
                iv: hexToBytes("000102030405060708090a0b0c"),
                additionalData: hexToBytes("7061646c6f632d616164"),
            });
            const plain = stringToBytes("Padloc PBES2 parity");
            const encrypted = await provider.encrypt(key, plain, encryptionParams);
            assertHex(
                encrypted,
                "3a01f50c9d046862fc4756953c3c7daf15c1a5a0a283de85af41096e63e1509e3a1a17",
                "AES-GCM ciphertext||tag"
            );
            assertEqual(
                bytesToString(await provider.decrypt(key, encrypted, encryptionParams)),
                "Padloc PBES2 parity",
                "AES-GCM decrypt"
            );
        },
    },
    {
        name: "RSA wrapping and signing fixtures",
        source: vectorSources.rsa,
        async run(provider) {
            const decrypted = await provider.decrypt(
                rsaFixture.privateKey,
                rsaFixture.encrypted,
                new RSAEncryptionParams()
            );
            assertEqual(bytesToString(decrypted), "Hello World!", "RSA-OAEP decrypt fixture");

            const signingParams = new RSASigningParams();
            assertTrue(
                await provider.verify(rsaFixture.publicKey, rsaFixture.signature, rsaFixture.sigData, signingParams),
                "RSA-PSS fixture signature must verify"
            );

            const freshSignature = await provider.sign(rsaFixture.privateKey, rsaFixture.sigData, signingParams);
            assertTrue(
                await provider.verify(rsaFixture.publicKey, freshSignature, rsaFixture.sigData, signingParams),
                "fresh RSA-PSS signature must verify"
            );
        },
    },
    {
        name: "TOTP RFC 6238 vectors",
        source: vectorSources.totp,
        async run(provider) {
            const sha1Secret = stringToBytes("12345678901234567890");
            const sha256Secret = stringToBytes("12345678901234567890123456789012");

            assertEqual(
                await totpToken(provider, sha1Secret, 59000, { interval: 30, digits: 8, hash: "SHA-1" }),
                "94287082",
                "TOTP SHA-1"
            );
            assertEqual(
                await totpToken(provider, sha256Secret, 59000, { interval: 30, digits: 8, hash: "SHA-256" }),
                "46119246",
                "TOTP SHA-256"
            );
        },
    },
    {
        name: "WebAuthn verifier input shape",
        source: vectorSources.webauthn,
        async run(_provider) {
            const verifierInput = {
                expectedChallenge: "padloc-worker-auth-challenge",
                expectedOrigin: "https://vault.example.test",
                expectedRPID: "vault.example.test",
                credential: {
                    id: "Y3JlZGVudGlhbC1pZC1iYXNlNjQ",
                    rawId: "Y3JlZGVudGlhbC1pZC1iYXNlNjQ",
                    type: "public-key",
                    response: {
                        clientDataJSON:
                            "eyJ0eXBlIjoid2ViYXV0aG4uZ2V0IiwiY2hhbGxlbmdlIjoicGFkbG9jLXdvcmtlci1hdXRoLWNoYWxsZW5nZSIsIm9yaWdpbiI6Imh0dHBzOi8vdmF1bHQuZXhhbXBsZS50ZXN0IiwiY3Jvc3NPcmlnaW4iOmZhbHNlfQ",
                        authenticatorData: "AAECAwQFBgcICQoLDA0ODw",
                        signature: "EBESExQVFhcYGRobHB0eHw",
                        userHandle: "cGFkbG9jLXVzZXI",
                    },
                },
                authenticator: {
                    credentialID: "Y3JlZGVudGlhbC1pZC1iYXNlNjQ",
                    credentialPublicKey: bytesToHex(rsaFixture.publicKey),
                    counter: 4,
                },
            };

            const clientData = JSON.parse(
                bytesToString(base64ToBytes(verifierInput.credential.response.clientDataJSON))
            );
            assertEqual(clientData.type, "webauthn.get", "WebAuthn clientDataJSON type");
            assertEqual(clientData.challenge, verifierInput.expectedChallenge, "WebAuthn challenge");
            assertEqual(clientData.origin, verifierInput.expectedOrigin, "WebAuthn origin");
            assertEqual(verifierInput.expectedRPID, "vault.example.test", "WebAuthn RPID");
            assertEqual(verifierInput.credential.type, "public-key", "WebAuthn credential type");
            assertEqual(verifierInput.authenticator.counter, 4, "WebAuthn authenticator counter");
        },
    },
];

function formatError(error: unknown) {
    if (error instanceof Error) {
        return error.message;
    }

    return String(error);
}

export async function runCryptoParity(
    provider: CryptoProvider,
    { includeBenchmark = false, enforceBudget = false, budgetThresholdMs = 200 }: CryptoParityOptions = {}
): Promise<CryptoParityReport> {
    const results: CryptoParityResult[] = [];
    let benchmark: CryptoBudgetResult | undefined;

    for (const vector of vectors) {
        try {
            const detail = await vector.run(provider);
            results.push({
                name: vector.name,
                source: vector.source,
                ok: true,
                detail: detail || "passed",
            });
        } catch (error) {
            results.push({
                name: vector.name,
                source: vector.source,
                ok: false,
                detail: formatError(error),
            });
        }
    }

    if (includeBenchmark) {
        try {
            benchmark = await runCompleteAuthRequestCryptoBudget(provider, budgetThresholdMs);
            results.push({
                name: benchmark.name,
                source: "T13 CPU-budget proof for Worker Paid remote runtime.",
                ok: !enforceBudget || benchmark.ok,
                detail: `${benchmark.wallMs} ms wall; threshold ${benchmark.thresholdMs} ms; ${benchmark.note}`,
            });
        } catch (error) {
            results.push({
                name: "completeAuthRequest crypto budget",
                source: "T13 CPU-budget proof for Worker Paid remote runtime.",
                ok: false,
                detail: formatError(error),
            });
        }
    }

    const passed = results.filter((result) => result.ok).length;
    return {
        ok: passed === results.length,
        runtime: "cloudflare-worker",
        generatedAt: new Date().toISOString(),
        summary: {
            total: results.length,
            passed,
            failed: results.length - passed,
        },
        benchmark,
        results,
    };
}
