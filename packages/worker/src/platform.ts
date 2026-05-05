import { DeviceInfo, StubPlatform } from "@padloc/core/src/platform";
import { WorkerCryptoProvider } from "./crypto";

export class WorkerPlatform extends StubPlatform {
    crypto = new WorkerCryptoProvider();

    readonly fetch: typeof fetch = (input, init) => globalThis.fetch(input, init);

    async getDeviceInfo() {
        return new DeviceInfo({ platform: "cloudflare-worker", runtime: "cloudflare-workers" });
    }
}
