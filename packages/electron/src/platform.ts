import { Platform } from "@elf-vault/core/src/platform";
import { WebPlatform } from "@elf-vault/app/src/lib/platform";

export class ElectronPlatform extends WebPlatform implements Platform {
    async getDeviceInfo() {
        const device = await super.getDeviceInfo();
        device.runtime = "electron";
        return device;
    }
}
