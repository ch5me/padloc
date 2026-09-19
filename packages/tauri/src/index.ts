import { setPlatform } from "@elf-vault/core/src/platform";
import { TauriPlatform } from "./platform";

function createApp() {
    const app = document.createElement("pl-app");
    document.body.appendChild(app);
}

(async () => {
    setPlatform(new TauriPlatform());

    await import("@elf-vault/app/src/elements/app");

    if (document.readyState === "loading") {
        document.addEventListener("DOMContentLoaded", createApp);
    } else {
        createApp();
    }
})();
