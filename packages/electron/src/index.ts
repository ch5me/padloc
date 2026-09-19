import { setPlatform } from "@elf-vault/core/src/platform";
import { ElectronPlatform } from "./platform";

(async () => {
    setPlatform(new ElectronPlatform());

    await import("@elf-vault/app/src/elements/app");

    // @ts-ignore
    window.router.basePath = window.location.pathname.replace(/index.html$/, "");

    window.onload = () => {
        const app = document.createElement("pl-app");
        document.body.appendChild(app);
    };
})();
