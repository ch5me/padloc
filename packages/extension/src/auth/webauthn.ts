import { AuthClient, AuthType } from "@padloc/core/src/auth";
import {
    startAuthentication,
    startRegistration,
    browserSupportsWebauthn,
    platformAuthenticatorIsAvailable,
} from "@simplewebauthn/browser";
import {
    PublicKeyCredentialCreationOptionsJSON,
    PublicKeyCredentialRequestOptionsJSON,
} from "@simplewebauthn/typescript-types";

/**
 * WebAuthn client for the Chrome extension.
 *
 * IMPORTANT: This client MUST be invoked from the extension popup's `window`
 * context, NOT from the MV3 service worker background script. The popup
 * provides the full browser `navigator.credentials` API that WebAuthn
 * requires; MV3 service workers may not support it.
 *
 * Mirrors `@padloc/app/src/lib/auth/webauthn.ts` so that the extension
 * does not depend on the app package at runtime.
 */
export class WebAuthnClient implements AuthClient {
    readonly ready = this._init();

    private _isWebAuthnSupported = false;
    private _isPlatformAuthenticatorAvailable = false;

    private async _init() {
        this._isWebAuthnSupported = await browserSupportsWebauthn();
        this._isPlatformAuthenticatorAvailable =
            this._isWebAuthnSupported && (await platformAuthenticatorIsAvailable());
    }

    supportsType(type: AuthType) {
        return (
            this._isWebAuthnSupported &&
            (type === AuthType.WebAuthnPortable ||
                (type === AuthType.WebAuthnPlatform && this._isPlatformAuthenticatorAvailable))
        );
    }

    async prepareRegistration(serverData: PublicKeyCredentialCreationOptionsJSON) {
        return startRegistration(serverData);
    }

    async prepareAuthentication(serverData: PublicKeyCredentialRequestOptionsJSON) {
        return startAuthentication(serverData);
    }
}

export function isWebAuthnSupported() {
    return browserSupportsWebauthn();
}

export const webAuthnClient = new WebAuthnClient();
