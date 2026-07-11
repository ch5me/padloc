import { expect } from "chai";
import { approvePasskeyRpSuffix, isPasskeyProviderOriginEnabled } from "../src/passkey-rp-policy";

suite("Passkey RP canary policy", () => {
    test("enables secure CH5 and Google origins plus loopback development", () => {
        expect(isPasskeyProviderOriginEnabled("https://pad.ch5.me")).to.equal(true);
        expect(isPasskeyProviderOriginEnabled("https://accounts.google.com")).to.equal(true);
        expect(isPasskeyProviderOriginEnabled("http://localhost:3000")).to.equal(true);
        expect(isPasskeyProviderOriginEnabled("http://127.0.0.1:4173")).to.equal(true);
    });

    test("does not activate on lookalikes, insecure public origins, or unrelated sites", () => {
        expect(isPasskeyProviderOriginEnabled("https://attacker-google.com")).to.equal(false);
        expect(isPasskeyProviderOriginEnabled("https://google.com.attacker.example")).to.equal(false);
        expect(isPasskeyProviderOriginEnabled("http://accounts.google.com")).to.equal(false);
        expect(isPasskeyProviderOriginEnabled("https://webauthn.io")).to.equal(false);
    });

    test("approves only RP IDs at or below an allowed root and bound to the origin host", () => {
        expect(approvePasskeyRpSuffix("google.com", "accounts.google.com")).to.equal(true);
        expect(approvePasskeyRpSuffix("accounts.google.com", "accounts.google.com")).to.equal(true);
        expect(approvePasskeyRpSuffix("ch5.me", "pad.ch5.me")).to.equal(true);
        expect(approvePasskeyRpSuffix("com", "accounts.google.com")).to.equal(false);
        expect(approvePasskeyRpSuffix("google.com", "google.com.attacker.example")).to.equal(false);
        expect(approvePasskeyRpSuffix("attacker-google.com", "attacker-google.com")).to.equal(false);
    });
});
