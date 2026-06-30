import { AuthType } from "@padloc/core/src/auth";
import { DeviceInfo, StubPlatform } from "@padloc/core/src/platform";
import { WebCryptoProvider } from "@padloc/app/src/lib/crypto";
import { ExtensionStorage } from "./storage";

export class BackgroundExtensionPlatform extends StubPlatform {
    crypto = new WebCryptoProvider();
    storage = new ExtensionStorage();

    get supportedAuthTypes() {
        return [AuthType.Email, AuthType.Totp, AuthType.WebAuthnPlatform, AuthType.WebAuthnPortable, AuthType.Oauth];
    }

    async getDeviceInfo() {
        return new DeviceInfo({
            platform: "ChromeExtension",
            appVersion: process.env.PL_VERSION || "",
            vendorVersion: process.env.PL_VENDOR_VERSION || "",
            userAgent: navigator.userAgent,
            locale: navigator.language || "en",
            browser: "Chrome",
            description: "Chrome extension service worker",
            runtime: "extension",
        });
    }
}
