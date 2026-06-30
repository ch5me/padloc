import fs from "fs";
import path from "path";

const EXTENSION_DIST = path.resolve(__dirname, "../dist");

async function globalSetup() {
    const manifestPath = path.join(EXTENSION_DIST, "manifest.json");
    if (!fs.existsSync(manifestPath)) {
        throw new Error(
            `Extension manifest not found at ${manifestPath}. ` +
                "Run 'npm run web-extension:build' before 'npm run test:extension'."
        );
    }
}

export default globalSetup;
