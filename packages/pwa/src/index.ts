import { setPlatform } from "@elf-vault/core/src/platform";
import { WebPlatform } from "@elf-vault/app/src/lib/platform";

function mountApp() {
    if (document.querySelector("pl-app")) {
        return;
    }

    const app = document.createElement("pl-app");
    document.body.appendChild(app);
}

if (window.location.search !== "?spinner") {
    (async () => {
        setPlatform(new WebPlatform());

        await import("@elf-vault/app/src/elements/app");

        if (document.readyState === "loading") {
            window.addEventListener("load", mountApp, { once: true });
        } else {
            mountApp();
        }
    })();
}
