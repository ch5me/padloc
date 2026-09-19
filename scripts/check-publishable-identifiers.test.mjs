import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { scanPublishableIdentifiers } from "./check-publishable-identifiers.mjs";

async function fixture(files) {
    const root = await mkdtemp(join(tmpdir(), "elf-vault-publishable-"));
    for (const [name, contents] of Object.entries(files)) {
        const path = join(root, name);
        await mkdir(join(path, ".."), { recursive: true });
        await writeFile(path, contents);
    }
    return root;
}

test("rejects the retired product token in publishable bytes and entry names", async () => {
    const retired = "pad" + "loc";
    const root = await fixture({
        "dist/background.js": `globalThis.${retired}Bridge = true;`,
        [`dist/${retired}-extension.js`]: "clean",
    });
    try {
        assert.deepEqual(await scanPublishableIdentifiers(root, ["dist"]), [
            "dist/background.js: retired product token in publishable bytes",
            `dist/${retired}-extension.js: retired product token in artifact path`,
        ]);
    } finally {
        await rm(root, { recursive: true, force: true });
    }
});

test("preserves the separate legacy import format spelling", async () => {
    const root = await fixture({ "dist/import.js": 'const format = "Padlock Legacy";' });
    try {
        assert.deepEqual(await scanPublishableIdentifiers(root, ["dist"]), []);
    } finally {
        await rm(root, { recursive: true, force: true });
    }
});
