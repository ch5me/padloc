import assert from "node:assert/strict";
import { createHash, generateKeyPairSync } from "node:crypto";
import { chmod, mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { spawn } from "node:child_process";
import { test } from "node:test";

const script = new URL("./package-chrome-extension-distribution.mjs", import.meta.url);
test("packages Elf Vault CRX, ZIP, and self-hosted update XML with stable identity", async () => {
    const root = await mkdtemp(join("/tmp", "padloc-package-extension-"));
    const extensionDir = join(root, "extension");
    const chrome = join(root, "fake-chrome.mjs");
    const key = join(root, "signing-key.pem");
    const crx = join(root, "elf-vault.crx");
    const zip = join(root, "elf-vault.zip");
    const updates = join(root, "updates.xml");
    const { privateKey, publicKey } = generateKeyPairSync("rsa", {
        modulusLength: 2048,
        privateKeyEncoding: { type: "pkcs1", format: "pem" },
        publicKeyEncoding: { type: "spki", format: "der" },
    });
    const manifestKey = publicKey.toString("base64");
    const expectedId = extensionIdFromManifestKey(manifestKey);
    await mkdir(extensionDir, { recursive: true });
    await writeFile(
        join(extensionDir, "manifest.json"),
        JSON.stringify({
            manifest_version: 3,
            key: manifestKey,
            version: "4.3.0.0",
            background: { service_worker: "background.js" },
        })
    );
    await writeFile(join(extensionDir, "background.js"), "");
    await writeFile(key, privateKey);
    await writeFile(
        chrome,
        `#!/usr/bin/env node
import { basename, dirname, join } from "node:path";
import { writeFileSync } from "node:fs";
const extension = process.argv.find((arg) => arg.startsWith("--pack-extension=")).split("=")[1];
writeFileSync(join(dirname(extension), basename(extension) + ".crx"), "fake-crx");
`
    );
    await chmod(chrome, 0o755);

    const result = await runPackage({
        PADLOC_EXTENSION_DIST: extensionDir,
        PADLOC_EXTENSION_KEY: key,
        PADLOC_EXTENSION_CRX: crx,
        PADLOC_EXTENSION_ZIP: zip,
        PADLOC_EXTENSION_CHROME_BIN: chrome,
        PADLOC_EXTENSION_UPDATE_URL: "https://mb-extensions.ch5.me/elf-vault/elf-vault.crx?x=1&y=2",
        PADLOC_EXTENSION_UPDATE_MANIFEST: updates,
    });
    assert.match(result, new RegExp(`"extensionId": "${expectedId}"`));
    assert.equal(await readFile(crx, "utf8"), "fake-crx");
    await stat(zip);
    const xml = await readFile(updates, "utf8");
    assert.match(xml, new RegExp(`appid="${expectedId}"`));
    assert.match(xml, /version="4\.3\.0\.0"/);
    assert.match(xml, /x=1&amp;y=2/);
    await rm(root, { recursive: true, force: true });
});

test("rejects incomplete signed distribution configuration", async () => {
    const root = await mkdtemp(join("/tmp", "padloc-package-extension-"));
    const extensionDir = join(root, "extension");
    const { publicKey } = generateKeyPairSync("rsa", {
        modulusLength: 2048,
        publicKeyEncoding: { type: "spki", format: "der" },
    });
    const manifestKey = publicKey.toString("base64");
    await mkdir(extensionDir, { recursive: true });
    await writeFile(
        join(extensionDir, "manifest.json"),
        JSON.stringify({
            manifest_version: 3,
            key: manifestKey,
            version: "4.3.0.0",
            background: { service_worker: "background.js" },
        })
    );
    await writeFile(join(extensionDir, "background.js"), "");
    const stderr = await runPackage(
        {
            PADLOC_EXTENSION_DIST: extensionDir,
            PADLOC_EXTENSION_CRX: join(root, "elf-vault.crx"),
        },
        true
    );
    assert.match(stderr, /requires PADLOC_EXTENSION_KEY or PADLOC_EXTENSION_SIGNING_KEY/);
    await rm(root, { recursive: true, force: true });
});

async function runPackage(extra, expectFailure = false) {
    const env = { ...process.env, ...extra };
    return await new Promise((resolveRun, reject) => {
        const child = spawn(process.execPath, [script.pathname], {
            env,
            stdio: ["ignore", "pipe", "pipe"],
        });
        let stdout = "";
        let stderr = "";
        child.stdout.on("data", (chunk) => (stdout += chunk));
        child.stderr.on("data", (chunk) => (stderr += chunk));
        child.once("error", reject);
        child.once("exit", (code) => {
            if (expectFailure) {
                if (code === 0) reject(new Error("expected package command to fail"));
                else resolveRun(stderr);
            } else if (code === 0) {
                resolveRun(stdout);
            } else {
                reject(new Error(stderr || `package command exited ${code}`));
            }
        });
    });
}

function extensionIdFromManifestKey(manifestKey) {
    const digest = createHash("sha256").update(Buffer.from(manifestKey, "base64")).digest().subarray(0, 16);
    return [...digest]
        .map((byte) => byte.toString(16).padStart(2, "0"))
        .join("")
        .replace(/[0-9a-f]/g, (nibble) => String.fromCharCode(97 + Number.parseInt(nibble, 16)));
}
