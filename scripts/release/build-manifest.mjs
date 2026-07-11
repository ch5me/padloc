import { createHash } from "node:crypto";
import { readFile, stat, writeFile } from "node:fs/promises";
import path from "node:path";

const required = [
    "RELEASE_CHANNEL",
    "RELEASE_VERSION",
    "RELEASE_SHA",
    "RELEASE_TAG",
    "RELEASE_ASSET",
    "RELEASE_BASE_URL",
    "RELEASE_RUN_URL",
];
for (const key of required) if (!process.env[key]) throw new Error(`${key} is required`);
if (!/^[0-9a-f]{40}$/.test(process.env.RELEASE_SHA)) throw new Error("RELEASE_SHA must be a full lowercase SHA");
if (!/^(staging|stable)$/.test(process.env.RELEASE_CHANNEL)) throw new Error("invalid release channel");
if (!/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/.test(process.env.RELEASE_VERSION))
    throw new Error("RELEASE_VERSION must be SemVer");

const file = path.resolve(process.env.RELEASE_ASSET);
const bytes = await readFile(file);
const info = await stat(file);
const assetName = path.basename(file);
const releaseUrl = `${process.env.RELEASE_BASE_URL}/releases/tag/${encodeURIComponent(process.env.RELEASE_TAG)}`;
const assetUrl = `${process.env.RELEASE_BASE_URL}/releases/download/${encodeURIComponent(
    process.env.RELEASE_TAG
)}/${encodeURIComponent(assetName)}`;
const manifest = {
    schemaVersion: 1,
    product: "ch5-auth",
    version: process.env.RELEASE_VERSION,
    channel: process.env.RELEASE_CHANNEL,
    sourceSha: process.env.RELEASE_SHA,
    publishedAt: process.env.RELEASE_PUBLISHED_AT || new Date().toISOString(),
    build: { number: process.env.RELEASE_BUILD || "0", toolchain: `node-${process.version}`, dependenciesLocked: true },
    releaseNotesUrl: `${releaseUrl}#release-notes`,
    provenance: {
        repository: process.env.RELEASE_BASE_URL,
        commitUrl: `${process.env.RELEASE_BASE_URL}/commit/${process.env.RELEASE_SHA}`,
        workflow: process.env.RELEASE_WORKFLOW || "public-release-staging.yml",
        runUrl: process.env.RELEASE_RUN_URL,
        promotionMode: process.env.RELEASE_PROMOTION_MODE || "original-artifact",
    },
    artifacts: [
        {
            platform: "web-extension",
            architecture: "browser-independent",
            file: assetName,
            url: assetUrl,
            sha256: createHash("sha256").update(bytes).digest("hex"),
            size: info.size,
            signature: "unsigned",
            notarization: "not-applicable",
            minimumOs: null,
            compatibility: "Developer installation in Chromium-family browsers; not a browser-store release.",
        },
    ],
};
await writeFile(process.env.RELEASE_MANIFEST || "manifest.json", `${JSON.stringify(manifest, null, 2)}\n`);
