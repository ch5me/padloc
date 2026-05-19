import { readFileSync } from "fs";

const targets = JSON.parse(readFileSync(new URL("../config/environment-targets.json", import.meta.url), "utf8"));
const reqs = JSON.parse(readFileSync(new URL("../config/runtime-requirements.json", import.meta.url), "utf8"));

const requiredStages = ["local", "staging", "production"];
for (const stage of requiredStages) {
    if (!targets.targets?.[stage]) {
        throw new Error(`Missing environment target: ${stage}`);
    }
    for (const key of ["appUrl", "apiBaseUrl", "allowedOrigin"]) {
        if (!targets.targets[stage][key]) {
            throw new Error(`Target ${stage} missing field ${key}`);
        }
    }
}

for (const [surface, config] of Object.entries(reqs.surfaces || {})) {
    if (!Array.isArray(config.vars)) {
        throw new Error(`Surface ${surface} is missing vars[]`);
    }
    for (const item of config.vars) {
        if (!item.name || !item.delivery || !Array.isArray(item.requiredIn)) {
            throw new Error(`Invalid runtime requirement on surface ${surface}`);
        }
    }
}

console.log("runtime-config:check ok");
