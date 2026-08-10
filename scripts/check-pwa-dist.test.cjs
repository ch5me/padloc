const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");

const { checkPwaDist } = require("./check-pwa-dist.cjs");

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
            "index.html": "<!doctype html><script src=app.js></script>",
            "assets/app.js": "console.log('production');",
            "assets/app.css": "body { margin: 0; }",
        },
        (dir) => assert.deepEqual(checkPwaDist(dir), [])
    );
});

test("PWA artifact gate rejects source map files at any depth", () => {
    withFixture(
        {
            "index.html": "<!doctype html>",
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
            "index.html": "<!doctype html>",
            "assets/app.js": "!function(){return true}();\n//# sourceMappingURL=app.js.map\n",
        },
        (dir) => {
            assert.deepEqual(checkPwaDist(dir), ["assets/app.js: sourceMappingURL is not allowed"]);
        }
    );
});


