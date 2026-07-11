import { build } from "esbuild";
import { createRequire } from "node:module";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);
const testFile = resolve(dirname(fileURLToPath(import.meta.url)), "worker-logging-redaction.ts");
const [{ text: bundledTest }] = (
    await build({
        entryPoints: [testFile],
        bundle: true,
        platform: "node",
        format: "cjs",
        target: "node16",
        write: false,
    })
).outputFiles;
const testModule = { exports: {} };

new Function("require", "module", "exports", "__filename", "__dirname", bundledTest)(
    require,
    testModule,
    testModule.exports,
    testFile,
    dirname(testFile)
);

await testModule.exports.run();
