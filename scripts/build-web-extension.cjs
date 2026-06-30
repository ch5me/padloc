const path = require("path");
const { spawnSync } = require("child_process");

const needsLegacyOpenSslProvider = Number(process.versions.node.split(".")[0]) >= 17;

if (
    needsLegacyOpenSslProvider &&
    !(process.env.NODE_OPTIONS || "").split(/\s+/).includes("--openssl-legacy-provider")
) {
    const env = {
        ...process.env,
        NODE_OPTIONS: [process.env.NODE_OPTIONS, "--openssl-legacy-provider"].filter(Boolean).join(" "),
    };
    const result = spawnSync(process.execPath, [__filename, ...process.argv.slice(2)], {
        env,
        stdio: "inherit",
    });
    process.exit(result.status === null ? 1 : result.status);
}

const targets = require("../config/environment-targets.json");

const extensionDir = path.resolve(__dirname, "../packages/extension");
const webpack = require(path.join(extensionDir, "node_modules/webpack"));

const defaultServerUrl = targets.targets.local.apiBaseUrl;
process.env.PL_SERVER_URL = process.env.PL_SERVER_URL || defaultServerUrl;

const sourcePreflight = spawnSync(process.execPath, [path.resolve(__dirname, "preflight-web-extension-source.cjs")], {
    stdio: "inherit",
    env: process.env,
});
if (sourcePreflight.status !== 0) {
    process.exit(sourcePreflight.status === null ? 1 : sourcePreflight.status);
}

const config = require(path.join(extensionDir, "webpack.config.js"));
config.context = extensionDir;
config.resolveLoader = {
    ...(config.resolveLoader || {}),
    modules: [
        path.join(extensionDir, "node_modules"),
        path.resolve(__dirname, "../node_modules"),
        "node_modules",
    ],
};

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
        return;
    }

    const preflight = spawnSync(process.execPath, [path.resolve(__dirname, "preflight-web-extension-dist.cjs")], {
        stdio: "inherit",
        env: process.env,
    });
    if (preflight.status !== 0) {
        process.exitCode = preflight.status === null ? 1 : preflight.status;
    }
});
