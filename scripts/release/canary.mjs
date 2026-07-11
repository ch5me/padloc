import { createHash } from "node:crypto";

const manifestUrl = process.argv[2];
if (!manifestUrl) throw new Error("usage: canary.mjs <manifest-url>");
const manifestResponse = await fetch(manifestUrl, { redirect: "follow" });
if (!manifestResponse.ok) throw new Error(`manifest HTTP ${manifestResponse.status}`);
const manifest = await manifestResponse.json();
for (const artifact of manifest.artifacts) {
    const response = await fetch(artifact.url, { redirect: "follow" });
    if (!response.ok) throw new Error(`${artifact.file} HTTP ${response.status}`);
    const bytes = Buffer.from(await response.arrayBuffer());
    const sha = createHash("sha256").update(bytes).digest("hex");
    if (bytes.length !== artifact.size || sha !== artifact.sha256)
        throw new Error(`${artifact.file} integrity mismatch`);
}
console.log(`verified ${manifest.channel} ${manifest.version} ${manifest.sourceSha}`);
