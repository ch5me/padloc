import { setPlatform } from "@padloc/core/src/platform";
import { WebPlatform } from "@padloc/app/src/lib/platform";

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

        await import("@padloc/app/src/elements/app");

        if (document.readyState === "loading") {
            window.addEventListener("load", mountApp, { once: true });
        } else {
            mountApp();
        }
    })();
}
