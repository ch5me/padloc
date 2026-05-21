import { defineConfig, devices } from "@playwright/test";
import path from "path";

const EXTENSION_DIST = path.resolve(__dirname, "..");

export default defineConfig({
    testDir: __dirname,
    workers: 1,
    timeout: 60_000,
    retries: process.env.CI ? 1 : 0,
    reporter: [
        ["list"],
        ["html", { outputFolder: path.resolve(__dirname, ".playwright-html"), open: "never" }],
        ["json", { outputFile: path.resolve(__dirname, ".playwright-results.json") }],
    ],
    use: {
        baseURL: process.env.PL_SERVER_URL || "https://api-pad-staging.ch5.me",
    },
    projects: [
        {
            name: "chromium-extension",
            use: {
                browserName: "chromium",
                launchOptions: {
                    args: [
                        `--disable-extensions-except=${EXTENSION_DIST}`,
                        `--load-extension=${EXTENSION_DIST}`,
                        "--disable-backgrounding-occluded-windows",
                        "--disable-renderer-backgrounding",
                    ],
                },
                ...devices["Desktop Chrome"],
            },
        },
    ],
    globalSetup: async () => {
        const fs = await import("fs");
        const manifestPath = path.join(EXTENSION_DIST, "manifest.json");
        if (!fs.existsSync(manifestPath)) {
            throw new Error(
                `Extension manifest not found at ${manifestPath}. ` +
                    "Run 'npm run web-extension:build' before 'npm run test:extension'."
            );
        }
    },
});
