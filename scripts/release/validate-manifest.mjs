import { readFile } from "node:fs/promises";

const manifest = JSON.parse(await readFile(process.argv[2] || "manifest.json", "utf8"));
const fail = (message) => {
    throw new Error(message);
};
if (manifest.schemaVersion !== 1 || manifest.product !== "ch5-auth") fail("unexpected manifest identity");
if (!/^(staging|stable)$/.test(manifest.channel)) fail("invalid channel");
if (!/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/.test(manifest.version)) fail("invalid SemVer");
if (!/^[0-9a-f]{40}$/.test(manifest.sourceSha)) fail("invalid source SHA");
if (!Array.isArray(manifest.artifacts) || manifest.artifacts.length === 0) fail("artifacts required");
for (const artifact of manifest.artifacts) {
    if (!/^[0-9a-f]{64}$/.test(artifact.sha256) || !Number.isInteger(artifact.size) || artifact.size < 1)
        fail("invalid artifact integrity metadata");
    if (manifest.channel === "stable" && artifact.signature === "unknown")
        fail("stable signature state cannot be unknown");
}
console.log(`valid ${manifest.channel} manifest ${manifest.version} ${manifest.sourceSha}`);
