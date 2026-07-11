const path = require("path");

process.env.TS_NODE_PROJECT = path.resolve(__dirname, "../../tsconfig.json");
require("ts-node/register");
require("tsconfig-paths/register");
require("../setup.ts");

const Mocha = require("mocha");
const fs = require("fs");
const mocha = new Mocha({ ui: "tdd", color: true });
const roots = process.argv.slice(2);
if (!roots.length) {
    for (const child of fs.readdirSync(__dirname).filter((name) => name.endsWith(".test.ts")).sort()) {
        mocha.addFile(path.join(__dirname, child));
    }
} else {
    const addTests = (entry) => {
        const resolved = path.resolve(entry);
        if (fs.statSync(resolved).isDirectory()) {
            for (const child of fs.readdirSync(resolved)) addTests(path.join(resolved, child));
        } else if (resolved.endsWith(".ts") && !path.basename(resolved).startsWith("setup")) {
            mocha.addFile(resolved);
        }
    };
    roots.forEach(addTests);
}
mocha.run((failures) => {
    process.exitCode = failures ? 1 : 0;
});
