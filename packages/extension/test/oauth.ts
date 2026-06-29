import { AuthType } from "../../core/src/auth";
import { expect } from "chai";
import { setup, suite, teardown, test } from "mocha";
import sinon from "sinon";
import { browser } from "webextension-polyfill-ts";
import { ExtensionPlatform } from "../src/platform";
import { oauthClient, OauthClient } from "../src/auth/oauth";

suite("ExtensionPlatform OAuth", () => {
    let sandbox: sinon.SinonSandbox;

    setup(() => {
        sandbox = sinon.createSandbox();
    });

    teardown(() => {
        sandbox.restore();
    });

    test("supportedAuthTypes includes OAuth", () => {
        const platform = new ExtensionPlatform();
        const types = platform.supportedAuthTypes;
        expect(types).to.include(AuthType.Oauth);
    });

    test("_getAuthClient returns oauthClient for OAuth type", async () => {
        const platform = new ExtensionPlatform();
        const client = await (platform as any)._getAuthClient(AuthType.Oauth);
        expect(client).to.equal(oauthClient);
    });
});

suite("OauthClient", () => {
    let sandbox: sinon.SinonSandbox;
    let client: OauthClient;

    setup(() => {
        sandbox = sinon.createSandbox();
        client = new OauthClient();
    });

    teardown(() => {
        sandbox.restore();
    });

    test("supportsType returns true for OAuth", () => {
        expect(client.supportsType(AuthType.Oauth)).to.be.true;
    });

    test("supportsType returns false for non-OAuth types", () => {
        expect(client.supportsType(AuthType.Email)).to.be.false;
        expect(client.supportsType(AuthType.Totp)).to.be.false;
        expect(client.supportsType(AuthType.WebAuthnPlatform)).to.be.false;
        expect(client.supportsType(AuthType.WebAuthnPortable)).to.be.false;
    });

    suite("prepareAuthentication", () => {
        test("resolves with code and state on successful OAuth callback", async () => {
            const authUrl =
                "https://provider.com/oauth/authorize?redirect_uri=https%3A%2F%2Fext-id.chromiumapp.org%2Fcallback&state=test-state";

            sandbox.stub(browser.identity, "launchWebAuthFlow").resolves("https://ext-id.chromiumapp.org/callback?code=auth-code-123&state=test-state");

            const result = await client.prepareAuthentication({ authUrl });

            expect(result).to.deep.equal({ code: "auth-code-123", state: "test-state" });
            expect(browser.identity.launchWebAuthFlow).to.have.been.calledOnceWith({
                url: authUrl,
                interactive: true,
            });
        });

        test("rejects when user cancels the OAuth flow", async () => {
            const authUrl = "https://provider.com/oauth/authorize?redirect_uri=https%3A%2F%2Fext-id.chromiumapp.org%2Fcallback";

            sandbox.stub(browser.identity, "launchWebAuthFlow").rejects(new Error("User cancelled"));

            let error: any;
            try {
                await client.prepareAuthentication({ authUrl });
            } catch (e) {
                error = e;
            }

            expect(error).to.exist;
            expect(error.code).to.equal("AUTHENTICATION_FAILED");
            expect(error.message).to.include("OAuth flow failed");
        });

        test("rejects when redirect URL contains error parameter", async () => {
            const authUrl = "https://provider.com/oauth/authorize?redirect_uri=https%3A%2F%2Fext-id.chromiumapp.org%2Fcallback";

            sandbox.stub(browser.identity, "launchWebAuthFlow").resolves("https://ext-id.chromiumapp.org/callback?error=access_denied");

            let error: any;
            try {
                await client.prepareAuthentication({ authUrl });
            } catch (e) {
                error = e;
            }

            expect(error).to.exist;
            expect(error.code).to.equal("AUTHENTICATION_FAILED");
            expect(error.message).to.include("OAuth error: access_denied");
        });

        test("rejects when no redirect URL is returned", async () => {
            const authUrl = "https://provider.com/oauth/authorize?redirect_uri=https%3A%2F%2Fext-id.chromiumapp.org%2Fcallback";

            sandbox.stub(browser.identity, "launchWebAuthFlow").resolves(undefined);

            let error: any;
            try {
                await client.prepareAuthentication({ authUrl });
            } catch (e) {
                error = e;
            }

            expect(error).to.exist;
            expect(error.code).to.equal("AUTHENTICATION_FAILED");
            expect(error.message).to.include("No redirect URL received");
        });

        test("rejects when callback URL has no code parameter", async () => {
            const authUrl = "https://provider.com/oauth/authorize?redirect_uri=https%3A%2F%2Fext-id.chromiumapp.org%2Fcallback";

            sandbox.stub(browser.identity, "launchWebAuthFlow").resolves("https://ext-id.chromiumapp.org/callback?state=test-state");

            let error: any;
            try {
                await client.prepareAuthentication({ authUrl });
            } catch (e) {
                error = e;
            }

            expect(error).to.exist;
            expect(error.code).to.equal("AUTHENTICATION_FAILED");
            expect(error.message).to.include("No authorization code received");
        });
    });

    suite("prepareRegistration", () => {
        test("resolves with code and state on successful OAuth callback", async () => {
            const authUrl =
                "https://provider.com/oauth/authorize?redirect_uri=https%3A%2F%2Fext-id.chromiumapp.org%2Fcallback&state=reg-state";

            sandbox.stub(browser.identity, "launchWebAuthFlow").resolves("https://ext-id.chromiumapp.org/callback?code=reg-code-456&state=reg-state");

            const result = await client.prepareRegistration({ authUrl });

            expect(result).to.deep.equal({ code: "reg-code-456", state: "reg-state" });
        });
    });
});
