import { browser } from "webextension-polyfill-ts";
import { AuthClient, AuthType } from "@padloc/core/src/auth";
import { Err, ErrorCode } from "@padloc/core/src/error";

/**
 * OAuth client for the Chrome extension using chrome.identity.launchWebAuthFlow.
 *
 * Unlike the web OAuth flow which uses window.open + postMessage, this uses
 * Chrome's extension-native OAuth flow that works correctly in extension popup context.
 *
 * The flow:
 * 1. launchWebAuthFlow opens the provider auth URL in a browser-managed window
 * 2. User authenticates with the provider
 * 3. Provider redirects to chrome-extension://[ext-id]/... with code/state in URL params
 * 4. launchWebAuthFlow returns the final redirect URL
 * 5. We extract code and state from the URL
 * 6. Control returns to the extension popup with the auth code
 *
 * @see https://developer.chrome.com/docs/extensions/reference/api/identity
 * @see https://docs.cloud.google.com/identity-platform/docs/web/chrome-extension
 */
export class OauthClient implements AuthClient {
    supportsType(type: AuthType) {
        return type === AuthType.Oauth;
    }

    /**
     * Launch the Chrome extension-native OAuth flow.
     *
     * @param params.authUrl - The full OAuth authorization URL including redirect
     * @returns The authorization code and state extracted from the callback URL
     */
    async _getAuthorizationCode({ authUrl }: { authUrl: string }): Promise<{ code: string | null; state: string | null }> {
        // chrome.identity.launchWebAuthFlow returns the final redirect URL after the OAuth callback.
        // The redirect URL is typically https://<extension-id>.chromiumapp.org/provider_callback_path
        // with code and state as URL search params.
        return new Promise((resolve, reject) => {
            browser.identity
                .launchWebAuthFlow({ url: authUrl, interactive: true })
                .then((redirectUrl: string | undefined) => {
                    if (!redirectUrl) {
                        reject(new Err(ErrorCode.AUTHENTICATION_FAILED, "No redirect URL received from OAuth flow"));
                        return;
                    }

                    // Parse the redirect URL to extract code and state
                    const url = new URL(redirectUrl);
                    const params = url.searchParams;
                    const error = params.get("error");
                    const code = params.get("code");
                    const state = params.get("state");

                    if (error) {
                        reject(new Err(ErrorCode.AUTHENTICATION_FAILED, `OAuth error: ${error}`));
                        return;
                    }

                    if (!code) {
                        reject(new Err(ErrorCode.AUTHENTICATION_FAILED, "No authorization code received"));
                        return;
                    }

                    resolve({ code, state });
                })
                .catch((error: Error) => {
                    // User cancelled or extension lacks permissions
                    reject(new Err(ErrorCode.AUTHENTICATION_FAILED, `OAuth flow failed: ${error.message}`));
                });
        });
    }

    async prepareRegistration(params: { authUrl: string }) {
        return this._getAuthorizationCode(params);
    }

    async prepareAuthentication(params: { authUrl: string }) {
        return this._getAuthorizationCode(params);
    }
}

export const oauthClient = new OauthClient();