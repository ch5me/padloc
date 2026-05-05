import { Platform, DeviceInfo } from "@padloc/core/src/platform";
import { WorkerCryptoProvider } from "./crypto";

export class WorkerPlatform implements Platform {
    crypto = new WorkerCryptoProvider();
    storage = { get: async () => null, set: async () => {}, remove: async () => {}, clear: async () => {} } as any;
    biometricKeyStore = {
        isSupported: async () => false,
        getKey: async () => {
            throw new Error("not supported");
        },
        storeKey: async () => {
            throw new Error("not supported");
        },
    };

    get supportedAuthTypes() {
        return [] as const;
    }

    async setClipboard(_val: string) {
        throw new Error("not supported");
    }
    async getClipboard() {
        return "";
    }
    async getDeviceInfo() {
        return new DeviceInfo();
    }
    async scanQR() {
        throw new Error("not supported");
        return "";
    }
    async stopScanQR() {}
    async composeEmail(_addr: string, _subject: string, _message: string) {}
    openExternalUrl(_url: string) {}
    async saveFile(_name: string, _type: string, _contents: Uint8Array) {}
    async registerAuthenticator(_opts: any) {
        throw new Error("not supported");
        return "";
    }
    async startAuthRequest(_opts: any) {
        throw new Error("not supported");
        return { token: "", authRequestId: "", email: "", secret: "", codeLength: 0, codeExpires: 0 };
    }
    async completeAuthRequest(_req: any, _data?: any) {
        throw new Error("not supported");
        return { email: "", token: "", accountStatus: 0 as any, deviceTrusted: false, provisioning: null as any };
    }
    readonly platformAuthType: null = null;
    async supportsPlatformAuthenticator() {
        return false;
    }
    async registerPlatformAuthenticator(_purposes: any[]) {
        throw new Error("not supported");
        return "";
    }
    async getPlatformAuthToken(_purpose: any[]) {
        throw new Error("not supported");
        return "";
    }
}
