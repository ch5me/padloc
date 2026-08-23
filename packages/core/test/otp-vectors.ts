import { expect } from "chai";
import { createHmac, timingSafeEqual } from "crypto";
import { suite, test } from "mocha";
import { stringToBytes } from "../src/encoding";
import { getCounter, generateURL, hotp, parseURL, totp, validateHotp } from "../src/otp";
import { getPlatform } from "../src/platform";

const rfc4226Secret = stringToBytes("12345678901234567890");

// OTP uses the platform crypto abstraction. Keep these vectors independent of
// browser globals by supplying only the two operations exercised by otp.ts.
getPlatform().crypto = {
    async sign(key: Uint8Array, data: Uint8Array, params: { hash: string }) {
        return new Uint8Array(createHmac(params.hash.toLowerCase().replace("-", ""), key).update(data).digest());
    },
    async timingSafeEqual(left: Uint8Array, right: Uint8Array) {
        return left.length === right.length && timingSafeEqual(left, right);
    },
} as any;

suite("deterministic HOTP and TOTP vectors", () => {
    test("matches all RFC 4226 HOTP values, including counter zero", async () => {
        const expected = [
            "755224",
            "287082",
            "359152",
            "969429",
            "338314",
            "254676",
            "287922",
            "162583",
            "399871",
            "520489",
        ];

        for (const [counter, token] of expected.entries()) {
            expect(await hotp(rfc4226Secret, counter)).to.equal(token);
        }
    });

    test("preserves leading zeroes and honors the requested digit count", async () => {
        expect(await hotp(rfc4226Secret, 30)).to.equal("026920");
        expect(await hotp(rfc4226Secret, 0, { digits: 8, hash: "SHA-1" })).to.equal("84755224");
    });

    test("matches RFC 6238 SHA-1 and SHA-256 TOTP vectors", async () => {
        const times = [59, 1_111_111_109, 1_111_111_111, 1_234_567_890, 2_000_000_000, 20_000_000_000];
        const sha1 = ["94287082", "07081804", "14050471", "89005924", "69279037", "65353130"];
        const sha256 = ["46119246", "68084774", "67062674", "91819424", "90698825", "77737706"];
        const sha256Secret = stringToBytes("12345678901234567890123456789012");

        for (let index = 0; index < times.length; index++) {
            const options = { interval: 30, digits: 8, hash: "SHA-1" as const };
            expect(await totp(rfc4226Secret, times[index] * 1000, options)).to.equal(sha1[index]);
            expect(await totp(sha256Secret, times[index] * 1000, { ...options, hash: "SHA-256" })).to.equal(
                sha256[index]
            );
        }
    });

    test("rounds interval boundaries down and supports non-default intervals", () => {
        expect(getCounter(29_999)).to.equal(0);
        expect(getCounter(30_000)).to.equal(1);
        expect(getCounter(89_999, { interval: 45 })).to.equal(1);
        expect(getCounter(90_000, { interval: 45 })).to.equal(2);
    });

    test("accepts only counters inside the configured validation window", async () => {
        const token = await hotp(rfc4226Secret, 4);
        const options = { interval: 30, digits: 6, hash: "SHA-1" as const, window: 1 };

        expect(await validateHotp(rfc4226Secret, token, 3.9, options)).to.equal(true);
        expect(await validateHotp(rfc4226Secret, token, 5, options)).to.equal(true);
        expect(await validateHotp(rfc4226Secret, token, 6, options)).to.equal(false);
        expect(await validateHotp(rfc4226Secret, token.slice(1), 4, options)).to.equal(false);
    });

    test("generates deterministic escaped otpauth URLs for both OTP types", () => {
        expect(
            generateURL({
                secret: "JBSWY3DPEHPK3PXP",
                account: "alice+otp@example.com",
                issuer: "CH5 Auth / QA",
                type: "totp",
                interval: 45,
                digits: 8,
                hash: "SHA-256",
            })
        ).to.equal(
            "otpauth://totp/CH5%20Auth%20%2F%20QA:alice%2Botp%40example.com?secret=JBSWY3DPEHPK3PXP&issuer=CH5+Auth+%2F+QA&digits=8&algorithm=SHA256&period=45"
        );
        expect(generateURL({ secret: "GEZDGNBVGY3TQOJQ", account: "counter", type: "hotp" })).to.match(
            /^otpauth:\/\/hotp\//
        );
    });

    test("parses valid secrets and rejects absent, empty, truncated, or malformed secrets", () => {
        expect(parseURL("otpauth://totp/Example?secret=jbswy3dpehpk3pxp")).to.deep.equal({
            secret: "jbswy3dpehpk3pxp",
        });

        for (const url of [
            "otpauth://totp/Example",
            "otpauth://totp/Example?secret=",
            "otpauth://totp/Example?secret=A",
            "otpauth://totp/Example?secret=JBSW!3DP",
        ]) {
            expect(() => parseURL(url)).to.throw();
        }
    });
});
