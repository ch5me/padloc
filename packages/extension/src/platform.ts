import { WebPlatform } from "@padloc/app/src/lib/platform";
import { StartAuthRequestResponse, StartRegisterAuthenticatorResponse } from "@padloc/core/src/api";
import { AuthClient, AuthType } from "@padloc/core/src/auth";
import { ExtensionStorage } from "./storage";
import { oauthClient } from "./auth/oauth";
import { webAuthnClient } from "./auth/webauthn";

export class ExtensionPlatform extends WebPlatform {
    storage = new ExtensionStorage();

    get supportedAuthTypes() {
        return super.supportedAuthTypes.filter((type) =>
            [
                AuthType.Email,
                AuthType.Totp,
                AuthType.WebAuthnPlatform,
                AuthType.WebAuthnPortable,
                AuthType.Oauth,
            ].includes(type)
        );
    }

    protected async _getAuthClient(type: AuthType): Promise<AuthClient | null> {
        if (type === AuthType.Oauth) {
            return oauthClient;
        }
        if (type === AuthType.WebAuthnPlatform || type === AuthType.WebAuthnPortable) {
            return webAuthnClient;
        }
        return super._getAuthClient(type);
    }

    protected async _prepareRegisterAuthenticator({ data, type }: StartRegisterAuthenticatorResponse): Promise<any> {
        if (type === AuthType.Oauth) {
            return oauthClient.prepareRegistration(data);
        }

        return super._prepareRegisterAuthenticator(arguments[0] as StartRegisterAuthenticatorResponse);
    }

    protected async _prepareCompleteAuthRequest({ data, type }: StartAuthRequestResponse): Promise<any> {
        if (type === AuthType.Oauth) {
            return oauthClient.prepareAuthentication(data);
        }

        return super._prepareCompleteAuthRequest(arguments[0] as StartAuthRequestResponse);
    }

    async getDeviceInfo() {
        const info = await super.getDeviceInfo();
        info.description = `${info.browser} extension on ${info.platform}`;
        info.runtime = "extension";
        return info;
    }
}
