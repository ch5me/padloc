import { Platform } from "@elf-vault/core/src/platform";
import { WebPlatform } from "@elf-vault/app/src/lib/platform";

export class TauriPlatform extends WebPlatform implements Platform {
    async getDeviceInfo() {
        const device = await super.getDeviceInfo();
        device.runtime = "tauri";
        device.description = `${device.platform} Device`;
        return device;
    }
}
