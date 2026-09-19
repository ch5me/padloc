const { resolve, join } = require("path");
const { readFileSync, writeFileSync } = require("fs");
const { EnvironmentPlugin } = require("webpack");
const { InjectManifest } = require("workbox-webpack-plugin");
const HtmlWebpackPlugin = require("html-webpack-plugin");
const { CleanWebpackPlugin } = require("clean-webpack-plugin");
const WebpackPwaManifest = require("webpack-pwa-manifest");
const sharp = require("sharp");
const { version } = require("../../package.json");

function removeTrailingSlash(url) {
    return url.replace(/(\/*)$/, "");
}

const out = process.env.PL_PWA_DIR || resolve(__dirname, "dist");
const buildEnvironment = process.env.PL_BUILD_ENV || process.env.NODE_ENV || "development";
const isProductionBuild = buildEnvironment === "production";
const workerPort = process.env.PL_WORKER_PORT;
const pwaPort = process.env.PL_PWA_PORT || process.env.PORT;
if (!process.env.PL_SERVER_URL && !workerPort) {
    throw new Error("PL_SERVER_URL or PL_WORKER_PORT required");
}
if (!process.env.PL_PWA_URL && !pwaPort) {
    throw new Error("PL_PWA_URL or PL_PWA_PORT required");
}
const serverUrl = removeTrailingSlash(
    process.env.PL_SERVER_URL || `http://127.0.0.1:${workerPort}`
);
const pwaUrl = removeTrailingSlash(process.env.PL_PWA_URL || `http://localhost:${pwaPort}`);
const pwaHost = new URL(pwaUrl).hostname;
const rootDir = resolve(__dirname, "../..");
const assetsDir = resolve(rootDir, process.env.PL_ASSETS_DIR || "assets");
const disableCsp = process.env.PL_PWA_DISABLE_CSP === "true";

const { name, terms_of_service } = require(join(assetsDir, "manifest.json"));

const isBuildingLocally = (() => {
    try {
        const hostname = new URL(pwaUrl).hostname;
        return hostname === "localhost" || hostname === "127.0.0.1" || hostname.endsWith(".localhost");
    } catch {
        return pwaUrl.includes(".localhost") || pwaUrl.startsWith("http://localhost") || pwaUrl.startsWith("http://127.0.0.1");
    }
})();
const pwaWebSocket = new URL(pwaUrl);
if (!pwaWebSocket.port && pwaPort) pwaWebSocket.port = String(pwaPort);
const pwaWebSocketUrl = pwaWebSocket.toString().replace(/^http/, "ws").replace(/\/$/, "");
const allowedHosts = [pwaHost];
if (isBuildingLocally) {
    // ch5-svc routes through per-tree localhost and company dev hostnames.
    allowedHosts.push(".localhost", ".dev.ch5.me");
}

const htmlMetaTags = disableCsp
    ? {}
    : {
          "Content-Security-Policy": {
              "http-equiv": "Content-Security-Policy",
                content: `default-src 'none'; base-uri 'none'; script-src blob: [REPLACE_SCRIPT]; connect-src ${serverUrl} https://api.pwnedpasswords.com [REPLACE_CONNECT]; style-src 'unsafe-inline'; font-src [REPLACE_FONT]; object-src blob:; frame-src blob:; img-src [REPLACE_IMG] blob: data: https://icons.duckduckgo.com; manifest-src [REPLACE_MANIFEST]; worker-src 'self';`,
          },
      };

module.exports = {
    entry: resolve(__dirname, "src/index.ts"),
    output: {
        path: out,
        filename: "[name].js",
        chunkFilename: "[name].chunk.js",
        publicPath: "/",
        hashFunction: "sha256",
    },
    mode: isProductionBuild ? "production" : "development",
    devtool: isProductionBuild ? false : "source-map",
    stats: "minimal",
    resolve: {
        extensions: [".ts", ".js", ".css", ".svg", ".png", ".jpg"],
        alias: {
            assets: assetsDir,
            "@elf-vault/core": resolve(rootDir, "packages/core"),
            "@elf-vault/app": resolve(rootDir, "packages/app"),
            "@elf-vault/locale": resolve(rootDir, "packages/locale"),
        },
    },
    module: {
        rules: [
            {
                test: /\.ts$/,
                loader: "ts-loader",
            },
            {
                test: /\.css$/,
                use: ["style-loader", "css-loader"],
            },
            {
                test: /\.(woff|woff2|eot|ttf|otf|svg)$/,
                loader: "file-loader",
                options: {
                    name: "[name].[ext]",
                },
            },
            {
                test: /\.txt|md$/i,
                use: "raw-loader",
            },
        ],
    },
    plugins: [
        new EnvironmentPlugin({
            PL_APP_NAME: name,
            PL_PWA_URL: pwaUrl,
            PL_SERVER_URL: serverUrl,
            PL_BILLING_ENABLED: null,
            PL_BILLING_DISABLE_PAYMENT: null,
            PL_BILLING_STRIPE_PUBLIC_KEY: null,
            PL_SUPPORT_EMAIL: "support@ch5.me",
            PL_VERSION: version,
            PL_VENDOR_VERSION: version,
            PL_DISABLE_SW: false,
            PL_CLIENT_SUPPORTED_AUTH_TYPES: "email",
            PL_TERMS_OF_SERVICE: terms_of_service,
        }),
        new CleanWebpackPlugin(),
        {
            apply(compiler) {
                if (disableCsp) {
                    return;
                }

                compiler.hooks.compilation.tap("Update CSP - dev", (compilation) => {
                    HtmlWebpackPlugin.getHooks(compilation).beforeEmit.tapAsync(
                        "Update CSP - dev",
                        (data, callback) => {
                            if (!isBuildingLocally) {
                                callback(null, data);
                                return;
                            }

                            const builtFilesForCsp = new Map([
                                ["script-src", [""]],
                                ["font-src", [""]],
                                ["img-src", [""]],
                                ["manifest-src", [""]],
                            ]);

                            // Manually add the root for the CSP meta tag
                            for (const cspRule of builtFilesForCsp.keys()) {
                                const files = builtFilesForCsp.get(cspRule);

                                data.html = data.html.replace(
                                    `[REPLACE_${cspRule.replace("-src", "").toUpperCase()}]`,
                                    `${files.map((file) => `${pwaUrl}/${file}`).join(" ")}`
                                );
                            }

                            // Add the websocket URL + PWA URL of webpack-dev-server to connect-src when building locally, or nothing otherwise
                            const connectReplacement = `${pwaWebSocketUrl}/ws ${pwaUrl}`;
                            data.html = data.html.replace("[REPLACE_CONNECT]", connectReplacement);

                            callback(null, data);
                        }
                    );

                    return true;
                });
            },
        },
        {
            apply(compiler) {
                if (!isProductionBuild) return;

                compiler.hooks.emit.tap("Secure production PWA artifact", (compilation) => {
                    compilation.assets["_worker.js"] = {
                        source: () => `export default { async fetch(request, env) {\n    if (new URL(request.url).pathname.endsWith(".map")) return new Response("Not Found", { status: 404 });\n    return env.ASSETS.fetch(request);\n} };\n`,
                        size: () => 224,
                    };
                    compilation.assets["_redirects"] = {
                        source: () => "/*.map /404 404\n",
                        size: () => 18,
                    };
                    for (const [name, asset] of Object.entries(compilation.assets)) {
                        if (!name.endsWith(".js")) continue;
                        const source = asset.source().toString();
                        const sanitized = source.replace(/sourceMappingURL/g, "source-map");
                        if (sanitized !== source) {
                            compilation.assets[name] = {
                                source: () => sanitized,
                                size: () => Buffer.byteLength(sanitized),
                            };
                        }
                    }
                });
            },
        },
        new HtmlWebpackPlugin({
            title: name,
            template: resolve(__dirname, "src/index.html"),
            meta: htmlMetaTags,
        }),
        new WebpackPwaManifest({
            filename: "manifest.json",
            name: name,
            short_name: name,
            icons: [
                {
                    src: resolve(__dirname, assetsDir, "app-icon.png"),
                    sizes: [96, 128, 192, 256, 384, 512],
                },
            ],
        }),
        new InjectManifest({
            swSrc: resolve(__dirname, "../app/src/sw.ts"),
            swDest: "sw.js",
            exclude: [/favicon\.png$/, /\.map$/],
        }),
        {
            apply(compiler) {
                compiler.hooks.emit.tapPromise("Generate Favicon", async (compilation) => {
                    const icon = await sharp(resolve(__dirname, assetsDir, "app-icon.png"))
                        .resize({
                            width: 256,
                            height: 256,
                        })
                        .toBuffer();

                    compilation.assets["favicon.png"] = {
                        source: () => icon,
                        size: () => Buffer.byteLength(icon),
                    };

                    return true;
                });
            },
        },
        {
            apply(compiler) {
                if (disableCsp) {
                    return;
                }

                compiler.hooks.afterEmit.tapPromise("Store Built Files for CSP - non-dev", async (compilation) => {
                    if (isBuildingLocally) {
                        // Skip
                        return true;
                    }

                    const fileExtensionsToCspRule = new Map([
                        ["js", "script-src"],
                        ["map", "script-src"],
                        ["woff2", "font-src"],
                        ["svg", "img-src"],
                        ["png", "img-src"],
                        ["json", "manifest-src"],
                    ]);
                    const builtFilesForCsp = new Map([
                        ["script-src", []],
                        ["font-src", []],
                        ["img-src", []],
                        ["manifest-src", []],
                    ]);

                    const assets = compilation.getAssets();

                    const htmlFilePath = resolve(out, "index.html");
                    let htmlFileContents = readFileSync(htmlFilePath, "utf-8");

                    for (const asset of assets) {
                        // Skip the file we're writing to!
                        if (asset.name === "index.html") {
                            continue;
                        }

                        const fileExtension = asset.name.split(".").pop();

                        if (!fileExtensionsToCspRule.has(fileExtension)) {
                            // NOTE: Throwing an error in this hook is silently ignored, so we need to just log it and keep going
                            console.error(`No CSP rule found for ".${fileExtension}"! (${asset.name})`);
                            continue;
                        }

                        const cspRule = fileExtensionsToCspRule.get(fileExtension);

                        if (!builtFilesForCsp.has(cspRule)) {
                            // NOTE: Throwing an error in this hook is silently ignored, so we need to just log it and keep going
                            console.error(`No CSP rule found for "${cspRule}"! (${fileExtension})`);
                            continue;
                        }

                        builtFilesForCsp.get(cspRule).push(asset.name);
                    }

                    // Use origin-relative sources so the same artifact works on
                    // the canonical app origin and the retained legacy origin.
                    for (const cspRule of builtFilesForCsp.keys()) {
                        htmlFileContents = htmlFileContents.replace(
                            `[REPLACE_${cspRule.replace("-src", "").toUpperCase()}]`,
                            "'self'"
                        );
                    }

                    // Nothing more to connect to, in non-dev
                    htmlFileContents = htmlFileContents.replace("[REPLACE_CONNECT]", "");

                    writeFileSync(htmlFilePath, htmlFileContents, "utf-8");

                    return true;
                });
            },
        },
    ],
    devServer: {
        historyApiFallback: true,
        host: "0.0.0.0",
        allowedHosts,
        ...(pwaPort ? { port: pwaPort } : {}),
        // hot: false,
        // liveReload: false,
        client: { overlay: false },
    },
};
