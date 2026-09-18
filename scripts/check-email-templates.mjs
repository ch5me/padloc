import { readdirSync, readFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const assetsDir = join(root, "assets", "email");
const generatedFile = join(root, "packages", "worker", "src", "email", "templates.ts");
const generator = join(root, "scripts", "bundle-templates.ts");
const tsNode = join(root, "node_modules", ".bin", "ts-node");

const failures = [];
const fail = (message) => failures.push(message);

const sourceFiles = readdirSync(assetsDir)
    .filter((file) => file.endsWith(".html") || file.endsWith(".txt"))
    .sort();
const sourceTemplates = new Map();
for (const file of sourceFiles) {
    const extension = file.slice(file.lastIndexOf("."));
    const name = file.slice(0, -extension.length);
    const entry = sourceTemplates.get(name) ?? {};
    entry[extension === ".html" ? "html" : "txt"] = readFileSync(join(assetsDir, file), "utf8");
    sourceTemplates.set(name, entry);
}

for (const [name, source] of sourceTemplates) {
    if (!source.html || !source.txt) fail(`${name} must have both HTML and text sources`);
    const content = `${source.html ?? ""}\n${source.txt ?? ""}`;
    for (const legacy of ["CH5 Auth", "CH5 organization", "Open Padloc", "Open CH5 Auth", "https://pad.ch5.me"]) {
        if (content.includes(legacy)) fail(`${name} still contains legacy branding or host: ${legacy}`);
    }
    if (name !== "plain") {
        if (!content.includes("Elf Vault")) fail(`${name} does not contain Elf Vault branding`);
        if (!content.includes("support@ch5.me")) fail(`${name} must retain support@ch5.me`);
    }
}

const actionVariables = {
    "confirm-org-member-invite": "acceptInviteUrl",
    "join-org-invite": "acceptInviteUrl",
    "join-org-invite-accepted": "confirmMemberUrl",
    "join-org-invite-completed": "openAppUrl",
};
for (const [name, variable] of Object.entries(actionVariables)) {
    const source = sourceTemplates.get(name);
    const placeholder = `{{ ${variable} }}`;
    if (!source?.html?.includes(placeholder) || !source?.txt?.includes(placeholder)) {
        fail(`${name} must use the ${variable} stage-configured action placeholder`);
    }
}

const generatorResult = spawnSync(tsNode, ["--compiler-options", '{"module":"commonjs"}', generator, "--check"], {
    cwd: root,
    encoding: "utf8",
});
if (generatorResult.status !== 0) {
    fail(`generator check failed:\n${generatorResult.stdout}${generatorResult.stderr}`);
}

const sampleVars = {
    title: "Elf Vault test",
    code: "123456",
    location: "Seattle",
    invitedBy: "Morgan",
    orgName: "Acme",
    invitee: "Taylor",
    acceptInviteUrl: "https://staging.vault.elf.dance/signup?invite=abc",
    confirmMemberUrl: "https://staging.vault.elf.dance/org/confirm?invite=abc",
    openAppUrl: "https://staging.vault.elf.dance/org/acme",
    message: "Elf Vault test message",
};
const probe = `
import { getTemplate, interpolate, templateNames } from ${JSON.stringify(pathToFileURL(generatedFile).href)};
const vars = ${JSON.stringify(sampleVars)};
const raw = {};
const rendered = {};
for (const name of templateNames) {
    const template = getTemplate(name);
    raw[name] = template;
    rendered[name] = {
        html: interpolate(template.html, vars),
        txt: interpolate(template.txt, vars),
    };
}
process.stdout.write(JSON.stringify({ raw, rendered }));
`;
const probeResult = spawnSync(process.execPath, ["--experimental-strip-types", "--input-type=module", "-e", probe], {
    cwd: root,
    encoding: "utf8",
    maxBuffer: 2 * 1024 * 1024,
});
if (probeResult.status !== 0) {
    fail(`generated template probe failed:\n${probeResult.stdout}${probeResult.stderr}`);
} else {
    let result;
    try {
        result = JSON.parse(probeResult.stdout);
    } catch (error) {
        fail(`generated template probe returned invalid JSON: ${error.message}`);
    }

    if (result) {
        for (const [name, source] of sourceTemplates) {
            const generated = result.raw?.[name];
            if (!generated) {
                fail(`generated templates are missing ${name}`);
                continue;
            }
            if (generated.html !== source.html) fail(`${name}.html differs from its source`);
            if (generated.txt !== source.txt) fail(`${name}.txt differs from its source`);

            for (const format of ["html", "txt"]) {
                const rendered = result.rendered?.[name]?.[format] ?? "";
                if (rendered.includes("{{")) fail(`${name}.${format} has unresolved variables`);
                if (rendered.includes("https://pad.ch5.me")) {
                    fail(`${name}.${format} contains the legacy pad.ch5.me host`);
                }
            }
        }

        const expectedLinks = {
            "confirm-org-member-invite": sampleVars.acceptInviteUrl,
            "join-org-invite": sampleVars.acceptInviteUrl,
            "join-org-invite-accepted": sampleVars.confirmMemberUrl,
            "join-org-invite-completed": sampleVars.openAppUrl,
        };
        for (const [name, expectedLink] of Object.entries(expectedLinks)) {
            const rendered = result.rendered?.[name];
            if (!rendered || !rendered.html.includes(expectedLink) || !rendered.txt.includes(expectedLink)) {
                fail(`${name} does not render its stage-configured action link`);
            }
        }
    }
}

if (failures.length) {
    console.error(failures.map((failure) => `FAIL: ${failure}`).join("\n"));
    process.exitCode = 1;
} else {
    console.log(`Email template check passed (${sourceTemplates.size} template pairs).`);
}
