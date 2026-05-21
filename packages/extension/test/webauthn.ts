/// <reference path="../../node_modules/@types/mocha/index.d.ts" />
import { AuthType } from "@padloc/core/src/auth";
import { expect } from "chai";
import { ExtensionPlatform } from "../src/platform";
import { webAuthnClient } from "../src/auth/webauthn";

suite("ExtensionPlatform WebAuthn", () => {
    test("supportedAuthTypes includes WebAuthnPlatform and WebAuthnPortable", () => {
        const platform = new ExtensionPlatform();
        const types = platform.supportedAuthTypes;
        expect(types).to.include(AuthType.WebAuthnPlatform);
        expect(types).to.include(AuthType.WebAuthnPortable);
        expect(types).to.include(AuthType.Email);
        expect(types).to.include(AuthType.Totp);
    });

    test("_getAuthClient returns webAuthnClient for WebAuthnPlatform", async () => {
        const platform = new ExtensionPlatform();
        const client = await (platform as any)._getAuthClient(AuthType.WebAuthnPlatform);
        expect(client).to.equal(webAuthnClient);
    });

    test("_getAuthClient returns webAuthnClient for WebAuthnPortable", async () => {
        const platform = new ExtensionPlatform();
        const client = await (platform as any)._getAuthClient(AuthType.WebAuthnPortable);
        expect(client).to.equal(webAuthnClient);
    });

    test("_getAuthClient delegates non-WebAuthn types to WebPlatform", async () => {
        const platform = new ExtensionPlatform();
        const emailClient = await (platform as any)._getAuthClient(AuthType.Email);
        expect(emailClient).to.not.be.null;
    });
});

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
