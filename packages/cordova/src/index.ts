import { setPlatform } from "@elf-vault/core/src/platform";
import { CordovaPlatform } from "./platform";

(async () => {
    setPlatform(new CordovaPlatform());

    await import("@elf-vault/app/src/elements/app");

    window.onload = () => {
        const app = document.createElement("pl-app");
        document.body.appendChild(app);
    };
})();
