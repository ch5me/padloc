import assert from "node:assert/strict";
import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const pristineTargets = JSON.parse(await readFile(join(root, "config/environment-targets.json"), "utf8"));
const pristineRequirements = JSON.parse(await readFile(join(root, "config/runtime-requirements.json"), "utf8"));

const mutations = [
    {
        name: "API URL used as the staging client URL",
        mutate({ targets }) {
            targets.targets.staging.appUrl = targets.targets.staging.apiBaseUrl;
            targets.targets.staging.allowedOrigin = targets.targets.staging.apiBaseUrl;
        },
    },
    {
        name: "missing production API URL",
        mutate({ targets }) {
            delete targets.targets.production.apiBaseUrl;
        },
    },
    {
        name: "missing stable runtime secret",
        mutate({ requirements }) {
            const vars = requirements.surfaces.api.vars;
            requirements.surfaces.api.vars = vars.filter(({ name }) => name !== "RESEND_API_KEY");
        },
    },
    {
        name: "preview substituted for the stable staging target",
        mutate({ targets }) {
            targets.stages = targets.stages.map((stage) => (stage === "staging" ? "preview" : stage));
            targets.targets.preview = { ...targets.targets.staging, stage: "preview" };
            delete targets.targets.staging;
        },
    },
    {
        name: "external HQ provider",
        mutate({ requirements }) {
            const sentry = requirements.surfaces.api.vars.find(({ name }) => name === "HQ_SENTRY_DSN");
            sentry.description = "External Sentry DSN hosted at sentry.io.";
        },
    },
    {
        name: "target stage mismatch",
        mutate({ targets }) {
            targets.targets.production.stage = "staging";
        },
    },
    {
        name: "duplicate declared stage",
        mutate({ targets }) {
            targets.stages.push("staging");
        },
    },
    {
        name: "duplicate runtime requirement",
        mutate({ requirements }) {
            const vars = requirements.surfaces.api.vars;
            vars.push(structuredClone(vars.find(({ name }) => name === "RESEND_API_KEY")));
        },
    },
];

const failures = [];
for (const { name, mutate } of mutations) {
    const fixture = await mkdtemp(join(tmpdir(), "padloc-runtime-negative-"));
    try {
        await mkdir(join(fixture, "scripts"));
        await mkdir(join(fixture, "config"));
        await cp(join(root, "scripts/check-runtime-config.mjs"), join(fixture, "scripts/check-runtime-config.mjs"), {
            recursive: true,
        });
        const state = {
            targets: structuredClone(pristineTargets),
            requirements: structuredClone(pristineRequirements),
        };
        mutate(state);

        await writeFile(
            join(fixture, "config/environment-targets.json"),
            JSON.stringify(state.targets, null, 4) + "\n"
        );
        await writeFile(
            join(fixture, "config/runtime-requirements.json"),
            JSON.stringify(state.requirements, null, 4) + "\n"
        );

        const result = spawnSync(process.execPath, [join(fixture, "scripts/check-runtime-config.mjs")], {
            encoding: "utf8",
        });
        if (result.status === 0) {
            failures.push(name);
        } else {
            console.log(`rejected: ${name}`);
        }
    } finally {
        await rm(fixture, { recursive: true, force: true });
    }
}

assert.deepEqual(failures, [], `runtime contract accepted invalid mutation(s): ${failures.join(", ")}`);
console.log("every mutation rejected");
