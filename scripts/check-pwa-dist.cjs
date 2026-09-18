const fs = require("fs");
const path = require("path");

function checkPwaDist(distDir) {
    if (!fs.existsSync(distDir)) {
        return [`${distDir}: missing`];
    }
    const indexPath = path.join(distDir, "index.html");
    if (!fs.existsSync(indexPath)) {
        return ["index.html: required PWA entrypoint is missing"];
    }

    const failures = [];
    const indexHtml = fs.readFileSync(indexPath, "utf8");
    const requiredAssets = ["manifest.json", "favicon.png", "sw.js"];
    for (const asset of requiredAssets) {
        if (!fs.existsSync(path.join(distDir, asset))) {
            failures.push(`${asset}: required branded PWA asset is missing`);
        }
    }

    if (!indexHtml.includes("Elf Vault")) {
        failures.push("index.html: Elf Vault title is missing");
    }
    for (const pattern of [/\bCH5 Auth\b/i, /\bPadloc\b/i, /padloc\.app/i, /\b(?:api-)?pad(?:-staging)?\.ch5\.me\b/i]) {
        if (pattern.test(indexHtml)) {
            failures.push(`index.html: current-product compatibility marker ${pattern} is not allowed`);
        }
    }
    if (!/worker-src\s+'self'(?:\s|;|["'])/i.test(indexHtml)) {
        failures.push("index.html: service worker CSP must use origin-safe worker-src 'self'");
    }
    if (/\[REPLACE_[A-Z]+\]/.test(indexHtml)) {
        failures.push("index.html: CSP placeholders were not resolved");
    }

    const cspMatch = /<meta\b[^>]*http-equiv=["']Content-Security-Policy["'][^>]*content="([^"]+)"/i.exec(
        indexHtml
    );
    if (!cspMatch) {
        failures.push("index.html: Content-Security-Policy meta tag is missing");
    } else {
        const cspRules = new Map(
            cspMatch[1]
                .split(";")
                .map((rule) => rule.trim().split(/\s+/))
                .filter(([name]) => name)
                .map(([name, ...sources]) => [name.toLowerCase(), sources])
        );
        const originSafeRules = ["script-src", "font-src", "img-src", "manifest-src", "worker-src"];
        for (const rule of originSafeRules) {
            const sources = cspRules.get(rule) || [];
            if (!sources.includes("'self'")) {
                failures.push(`index.html: ${rule} must include origin-safe source 'self'`);
            }
            const absoluteSources = sources.filter((source) => /^https?:\/\//i.test(source));
            const allowedExternalSources =
                rule === "img-src" ? ["https://icons.duckduckgo.com"] : [];
            const unsafeSources = absoluteSources.filter(
                (source) => !allowedExternalSources.includes(source)
            );
            if (unsafeSources.length) {
                failures.push(
                    `index.html: ${rule} must not pin application asset origins (${unsafeSources.join(", ")})`
                );
            }
        }
    }

    const manifestPath = path.join(distDir, "manifest.json");
    if (fs.existsSync(manifestPath)) {
        try {
            const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
            if (manifest.name !== "Elf Vault" || manifest.short_name !== "Elf Vault") {
                failures.push("manifest.json: name and short_name must be Elf Vault");
            }
        } catch (error) {
            failures.push(`manifest.json: invalid JSON (${error.message})`);
        }
    }

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
