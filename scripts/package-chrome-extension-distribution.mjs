#!/usr/bin/env node

import { createHash, createPublicKey } from "node:crypto";
import { mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, resolve } from "node:path";
import { spawn } from "node:child_process";

const rootDir = resolve(new URL("..", import.meta.url).pathname);
const extensionDir = resolve(process.env.PADLOC_EXTENSION_DIST ?? "packages/extension/dist");
const zipOutput = resolve(process.env.PADLOC_EXTENSION_ZIP ?? ".ch5/artifacts/elf-vault-extension.zip");
const crxOutput = process.env.PADLOC_EXTENSION_CRX ? resolve(process.env.PADLOC_EXTENSION_CRX) : null;
const keyPath = process.env.PADLOC_EXTENSION_KEY ? resolve(process.env.PADLOC_EXTENSION_KEY) : null;
const keyPem = process.env.PADLOC_EXTENSION_SIGNING_KEY ?? "";
const chromeBinary = process.env.PADLOC_EXTENSION_CHROME_BIN || process.env.CHROME_BIN || "";
const updateUrl = process.env.PADLOC_EXTENSION_UPDATE_URL?.trim() || null;
const updateManifestOutput = process.env.PADLOC_EXTENSION_UPDATE_MANIFEST
    ? resolve(process.env.PADLOC_EXTENSION_UPDATE_MANIFEST)
    : null;

if (crxOutput && !keyPath && !keyPem) {
    throw new Error(
        "PADLOC_EXTENSION_CRX requires PADLOC_EXTENSION_KEY or PADLOC_EXTENSION_SIGNING_KEY; refusing to create an unsigned CRX"
    );
}
if (updateManifestOutput && !updateUrl) {
    throw new Error(
        "PADLOC_EXTENSION_UPDATE_MANIFEST requires PADLOC_EXTENSION_UPDATE_URL; refusing to emit an unusable update manifest"
    );
}
if (updateManifestOutput && !crxOutput) {
    throw new Error(
        "PADLOC_EXTENSION_UPDATE_MANIFEST requires PADLOC_EXTENSION_CRX so the update entry names a packaged artifact"
    );
}

const manifestPath = resolve(extensionDir, "manifest.json");
const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
if (manifest.manifest_version !== 3 || typeof manifest.background?.service_worker !== "string") {
    throw new Error(`invalid extension build: ${manifestPath}`);
}
if (typeof manifest.key !== "string" || !manifest.key.trim()) {
    throw new Error("extension build must contain a stable manifest key before CRX packaging");
}
if (!/^\d+(?:\.\d+){0,3}$/.test(String(manifest.version))) {
    throw new Error(`manifest version is not Chrome-compatible: ${manifest.version}`);
}

const entries = await readdir(extensionDir);
if (entries.length < 2) {
    throw new Error(`extension build is incomplete: ${extensionDir}`);
}
await stat(extensionDir);
await mkdir(dirname(zipOutput), { recursive: true });
await rm(zipOutput, { force: true });
await run("zip", ["-qr", "-X", zipOutput, "."], { cwd: extensionDir });

const extensionId = extensionIdFromManifestKey(manifest.key);
let temporaryKeyDir = null;
try {
    if (crxOutput) {
        let signingKeyPath = keyPath;
        if (!signingKeyPath && keyPem) {
            temporaryKeyDir = await mkdtemp(resolve(tmpdir(), "padloc-extension-signing-"));
            signingKeyPath = resolve(temporaryKeyDir, "signing-key.pem");
            await writeFile(signingKeyPath, keyPem, { mode: 0o600 });
        }
        const privateKey = await readFile(signingKeyPath, "utf8");
        const derivedPublicKey = createPublicKey(privateKey).export({ type: "spki", format: "der" });
        if (Buffer.from(manifest.key, "base64").compare(derivedPublicKey) !== 0) {
            throw new Error("signing key does not match the stable public key in manifest.json");
        }

        await mkdir(dirname(crxOutput), { recursive: true });
        await rm(crxOutput, { force: true });
        await run(
            resolve(rootDir, "scripts/package-chrome-crx.sh"),
            ["--extension-dir", extensionDir, "--crx-file", crxOutput, "--private-key-file", signingKeyPath],
            {
                env: {
                    ...process.env,
                    ...(chromeBinary ? { CHROME_BIN: chromeBinary } : {}),
                },
            }
        );
    }

    if (updateManifestOutput) {
        await mkdir(dirname(updateManifestOutput), { recursive: true });
        await writeFile(
            updateManifestOutput,
            [
                '<?xml version="1.0" encoding="UTF-8"?>',
                '<gupdate xmlns="http://www.google.com/update2/response" protocol="2.0">',
                `  <app appid="${extensionId}">`,
                `    <updatecheck codebase="${escapeXml(updateUrl)}" version="${escapeXml(manifest.version)}" />`,
                "  </app>",
                "</gupdate>",
                "",
            ].join("\n"),
            "utf8"
        );
    }
} finally {
    if (temporaryKeyDir) {
        await rm(temporaryKeyDir, { recursive: true, force: true });
    }
}

console.log(
    JSON.stringify(
        {
            extensionDir,
            extensionId,
            manifestVersion: manifest.version,
            zipOutput,
            ...(crxOutput ? { crxOutput } : {}),
            ...(updateManifestOutput ? { updateManifestOutput, updateUrl } : {}),
        },
        null,
        2
    )
);

function extensionIdFromManifestKey(manifestKey) {
    const publicKey = Buffer.from(manifestKey, "base64");
    createPublicKey({ key: publicKey, format: "der", type: "spki" });
    const digest = createHash("sha256").update(publicKey).digest().subarray(0, 16);
    return [...digest]
        .map((byte) => byte.toString(16).padStart(2, "0"))
        .join("")
        .replace(/[0-9a-f]/g, (nibble) => String.fromCharCode(97 + Number.parseInt(nibble, 16)));
}

function escapeXml(value) {
    return String(value).replace(
        /[<>&'"]/g,
        (character) =>
            ({
                "<": "&lt;",
                ">": "&gt;",
                "&": "&amp;",
                "'": "&apos;",
                '"': "&quot;",
            }[character])
    );
}

async function run(command, args, options = {}) {
    await new Promise((resolveRun, reject) => {
        const child = spawn(command, args, { stdio: "inherit", ...options });
        child.once("error", reject);
        child.once("exit", (code) => {
            code === 0 ? resolveRun() : reject(new Error(`${command} exited with ${code}`));
        });
    });
}
