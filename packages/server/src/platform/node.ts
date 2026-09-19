import { Platform, StubPlatform } from "@elf-vault/core/src/platform";
import { NodeCryptoProvider } from "../crypto/node";

export class NodePlatform extends StubPlatform implements Platform {
    crypto = new NodeCryptoProvider();

    async getDeviceInfo() {
        const info = await super.getDeviceInfo();
        info.runtime = "node";
        return info;
    }
}
