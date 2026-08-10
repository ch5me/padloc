const fs = require("fs");
const path = require("path");

function checkPwaDist(distDir) {
    if (!fs.existsSync(distDir)) {
        return [`${distDir}: missing`];
    }
    if (!fs.existsSync(path.join(distDir, "index.html"))) {
        return ["index.html: required PWA entrypoint is missing"];
    }

    const failures = [];
    const files = [];
    function collect(dir) {
        for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
            const file = path.join(dir, entry.name);
            if (entry.isDirectory()) {
                collect(file);
            } else {
                files.push(file);
            }
        }
    }
    collect(distDir);

    for (const file of files) {
        const relative = path.relative(distDir, file);
        if (relative.endsWith(".map")) {
            failures.push(`${relative}: source map file is not allowed`);
            continue;
        }

        const source = fs.readFileSync(file, "utf8");
        if (/sourceMappingURL/i.test(source)) {
            failures.push(`${relative}: sourceMappingURL is not allowed`);
        }
    }

    return failures;
}

if (require.main === module) {
    const distDir = path.resolve(__dirname, "..", "packages/pwa/dist");
    const failures = checkPwaDist(distDir);
    if (failures.length) {
        console.error("PWA production artifact check failed:");
        for (const failure of failures) console.error(`- ${failure}`);
        process.exit(1);
    }
    console.log("PWA production artifact check passed.");
}

module.exports = { checkPwaDist };
