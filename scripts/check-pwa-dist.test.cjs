const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");

const { checkPwaDist } = require("./check-pwa-dist.cjs");

const originSafeCsp =
    "default-src 'none'; script-src 'self' blob:; connect-src https://api.vault.elf.dance; " +
    "style-src 'unsafe-inline'; font-src 'self'; img-src 'self' blob: data: https://icons.duckduckgo.com; " +
    "manifest-src 'self'; worker-src 'self';";

function withFixture(files, run) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "padloc-pwa-dist-"));
    try {
        for (const [relativePath, contents] of Object.entries(files)) {
            const file = path.join(dir, relativePath);
            fs.mkdirSync(path.dirname(file), { recursive: true });
            fs.writeFileSync(file, contents);
        }
        return run(dir);
    } finally {
        fs.rmSync(dir, { recursive: true, force: true });
    }
}


test("PWA artifact gate rejects missing entrypoint", () => {
    withFixture({ "app.js": "console.log('broken');" }, (dir) => {
        assert.deepEqual(checkPwaDist(dir), ["index.html: required PWA entrypoint is missing"]);
    });
});

test("PWA artifact gate accepts a clean nested production fixture", () => {
    withFixture(
        {
            "index.html":
                `<!doctype html><title>Elf Vault</title><meta http-equiv="Content-Security-Policy" content="${originSafeCsp}">`,
            "manifest.json": JSON.stringify({ name: "Elf Vault", short_name: "Elf Vault" }),
            "favicon.png": "png",
            "sw.js": "self.addEventListener('fetch', () => {});",
            "assets/app.js": "console.log('production');",
            "assets/app.css": "body { margin: 0; }",
        },
        (dir) => assert.deepEqual(checkPwaDist(dir), [])
    );
});

test("PWA artifact gate rejects source map files at any depth", () => {
    withFixture(
        {
            "index.html":
                `<!doctype html><title>Elf Vault</title><meta http-equiv="Content-Security-Policy" content="${originSafeCsp}">`,
            "manifest.json": JSON.stringify({ name: "Elf Vault", short_name: "Elf Vault" }),
            "favicon.png": "png",
            "sw.js": "self.addEventListener('fetch', () => {});",
            "assets/chunks/app.js.map": "{\"version\":3}",
        },
        (dir) => {
            assert.deepEqual(checkPwaDist(dir), ["assets/chunks/app.js.map: source map file is not allowed"]);
        }
    );
});
test("PWA artifact gate rejects sourceMappingURL markers in JavaScript", () => {
    withFixture(
        {
            "index.html":
                `<!doctype html><title>Elf Vault</title><meta http-equiv="Content-Security-Policy" content="${originSafeCsp}">`,
            "manifest.json": JSON.stringify({ name: "Elf Vault", short_name: "Elf Vault" }),
            "favicon.png": "png",
            "sw.js": "self.addEventListener('fetch', () => {});",
            "assets/app.js": "!function(){return true}();\n//# sourceMappingURL=app.js.map\n",
        },
        (dir) => {
            assert.deepEqual(checkPwaDist(dir), ["assets/app.js: sourceMappingURL is not allowed"]);
        }
    );
});

test("PWA artifact gate rejects CSP sources pinned to the canonical app origin", () => {
    withFixture(
        {
            "index.html":
                '<!doctype html><title>Elf Vault</title><meta http-equiv="Content-Security-Policy" content="' +
                originSafeCsp.replace("'self'", "https://vault.elf.dance/main.js") +
                '">',
            "manifest.json": JSON.stringify({ name: "Elf Vault", short_name: "Elf Vault" }),
            "favicon.png": "png",
            "sw.js": "self.addEventListener('fetch', () => {});",
            "main.js": "console.log('production');",
        },
        (dir) => {
            assert.deepEqual(checkPwaDist(dir), [
                "index.html: script-src must include origin-safe source 'self'",
                "index.html: script-src must not pin application asset origins (https://vault.elf.dance/main.js)",
            ]);
        }
    );
});
