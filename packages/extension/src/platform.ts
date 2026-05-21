import { WebPlatform } from "@padloc/app/src/lib/platform";
import { AuthType } from "@padloc/core/src/auth";
import { ExtensionStorage } from "./storage";
import { oauthClient } from "./auth/oauth";

export class ExtensionPlatform extends WebPlatform {
    storage = new ExtensionStorage();

    get supportedAuthTypes() {
        return super.supportedAuthTypes.filter((type) =>
            [AuthType.Email, AuthType.Totp, AuthType.WebAuthnPlatform, AuthType.WebAuthnPortable, AuthType.Oauth].includes(type)
        );
    }

    protected async _getAuthClient(type: AuthType) {
        if (type === AuthType.Oauth) {
            return oauthClient;
        }
        return super._getAuthClient(type);
    }

    async getDeviceInfo() {
        const info = await super.getDeviceInfo();
        info.description = `${info.browser} extension on ${info.platform}`;
        info.runtime = "extension";
        return info;
    }
}
