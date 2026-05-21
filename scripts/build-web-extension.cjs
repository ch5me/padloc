const path = require("path");

const targets = require("../config/environment-targets.json");

const extensionDir = path.resolve(__dirname, "../packages/extension");
const webpack = require(path.join(extensionDir, "node_modules/webpack"));

const defaultServerUrl = targets.targets.local.apiBaseUrl;
process.env.PL_SERVER_URL = process.env.PL_SERVER_URL || defaultServerUrl;

const config = require(path.join(extensionDir, "webpack.config.js"));

webpack(config, (err, stats) => {
    if (err) {
        console.error(err);
        process.exitCode = 1;
        return;
    }

    if (!stats) {
        console.error("Webpack did not return build stats.");
        process.exitCode = 1;
        return;
    }

    process.stdout.write(
        stats.toString({
            colors: false,
            preset: "minimal",
        }) + "\n"
    );

    if (stats.hasErrors()) {
        process.exitCode = 1;
    }
});
