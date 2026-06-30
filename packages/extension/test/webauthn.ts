import { AuthType } from "../../core/src/auth";
import { expect } from "chai";
import { suite, test } from "mocha";
import { webAuthnClient } from "../src/auth/webauthn";

suite("WebAuthnClient smoke", () => {
    test("client ready promise resolves", async () => {
        await webAuthnClient.ready;
    });

    test("supportsType returns boolean for WebAuthnPlatform", async () => {
        await webAuthnClient.ready;
        const result = webAuthnClient.supportsType(AuthType.WebAuthnPlatform);
        expect(typeof result).to.equal("boolean");
    });

    test("supportsType returns boolean for WebAuthnPortable", async () => {
        await webAuthnClient.ready;
        const result = webAuthnClient.supportsType(AuthType.WebAuthnPortable);
        expect(typeof result).to.equal("boolean");
    });

    test("supportsType returns false for non-WebAuthn types", async () => {
        await webAuthnClient.ready;
        expect(webAuthnClient.supportsType(AuthType.Email)).to.be.false;
        expect(webAuthnClient.supportsType(AuthType.Totp)).to.be.false;
    });
});
