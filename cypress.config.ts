import { defineConfig } from "cypress";

const baseUrl = process.env.CYPRESS_BASE_URL;
if (!baseUrl) {
    throw new Error("CYPRESS_BASE_URL required; run `npm run test:e2e`");
}
const env = {
    ...(process.env.CYPRESS_SERVER_URL ? { serverUrl: process.env.CYPRESS_SERVER_URL } : {}),
    ...(process.env.CYPRESS_V3_URL ? { v3_url: process.env.CYPRESS_V3_URL } : {}),
    ...(process.env.CYPRESS_MAILDEV_URL ? { MAILDEV_URL: process.env.CYPRESS_MAILDEV_URL } : {}),
};

export default defineConfig({
    includeShadowDom: true,
    video: false,
    chromeWebSecurity: false,
    screenshotOnRunFailure: false,
    videoUploadOnPasses: false,
    waitForAnimations: true,
    env,
    e2e: {
        // We've imported your old cypress plugins here.
        // You may want to clean this up later by importing these.
        setupNodeEvents(on, config) {
            return require("./cypress/plugins/index.ts")(on, config);
        },
        baseUrl,
    },
});
