import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const configPath = join(root, "pitchfork.toml");
const configText = readFileSync(configPath, "utf8");

function withoutComments(text) {
    return text.replace(/^\s*#.*$/gm, "");
}

function readSections(text) {
    const matches = [...text.matchAll(/^\[([^\]]+)\]\s*$/gm)];
    const sections = new Map();
    for (let index = 0; index < matches.length; index += 1) {
        const match = matches[index];
        const end = matches[index + 1]?.index ?? text.length;
        sections.set(match[1], text.slice(match.index + match[0].length, end));
    }
    return sections;
}

function assignment(section, key) {
    const match = withoutComments(section).match(
        new RegExp(`^\\s*${key}\\s*=\\s*(.+?)\\s*$`, "m")
    );
    return match?.[1];
}

function stringValue(value, label) {
    assert.ok(value, `${label} is missing`);
    if (!value.startsWith('"') || !value.endsWith('"')) return value;
    return JSON.parse(value);
}

function stringArray(value, label) {
    assert.ok(value, `${label} is missing`);
    const match = value.match(/^\[([^\]]*)\]$/);
    assert.ok(match, `${label} must be an array`);
    return [...match[1].matchAll(/"([^"\\]*(?:\\.[^"\\]*)*)"/g)].map((item) => item[1]);
}

function inlineTable(section, key) {
    const value = assignment(section, key);
    assert.ok(value, `${key} is missing`);
    const match = value.match(/^\{([^}]*)\}$/);
    assert.ok(match, `${key} must be an inline table`);
    return match[1];
}

function tableNumber(table, key) {
    const match = table.match(new RegExp(`\\b${key}\\s*=\\s*(\\d+)\\b`));
    return match ? Number(match[1]) : undefined;
}

function tableNumbers(table, key) {
    const match = table.match(new RegExp(`\\b${key}\\s*=\\s*\\[([^\\]]*)\\]`));
    return match ? [...match[1].matchAll(/\b\d+\b/g)].map((item) => Number(item[0])) : undefined;
}

function tableString(table, key) {
    return table.match(new RegExp(`\\b${key}\\s*=\\s*"([^"]*)"`))?.[1];
}

const sections = readSections(configText);
const daemonNames = [...sections.keys()]
    .filter((name) => /^daemons\.[^.]+$/.test(name))
    .map((name) => name.slice("daemons.".length));
const daemons = new Map(daemonNames.map((name) => [name, sections.get(`daemons.${name}`)]));

for (const name of ["api", "web", "v3", "maildev", "tauri", "openwiki"]) {
    assert.ok(daemons.has(name), `missing daemon declaration: ${name}`);
}

for (const [name, section] of daemons) {
    const run = stringValue(assignment(section, "run"), `${name}.run`);

    const portValue = assignment(section, "port");
    if (!portValue) continue;
    const port = inlineTable(section, "port");
    const expectedPorts = tableNumbers(port, "expect");
    assert.ok(expectedPorts?.length, `${name}.port.expect must be a non-empty array`);
    const bump = tableNumber(port, "bump");
    assert.ok(Number.isInteger(bump) && bump > 0, `${name}.port.bump must be positive`);

    const readyPortValue = assignment(section, "ready_port");
    const readyHttpValue = assignment(section, "ready_http");
    assert.ok(readyPortValue || readyHttpValue, `${name} must declare readiness`);
    if (readyPortValue) {
        const readyPort = tableNumber(inlineTable(section, "ready_port"), "port");
        assert.ok(expectedPorts.includes(readyPort), `${name}.ready_port must match port.expect`);
    }
    if (readyHttpValue) {
        const readyHttp = inlineTable(section, "ready_http");
        assert.ok(tableString(readyHttp, "url"), `${name}.ready_http.url is missing`);
        assert.ok(tableNumbers(readyHttp, "status")?.includes(200), `${name}.ready_http must accept HTTP 200`);
    }

    for (const expectedPort of expectedPorts) {
        assert.doesNotMatch(run, new RegExp(`\\b${expectedPort}\\b`), `${name}.run hardcodes its assigned port`);
    }
}

const web = daemons.get("web");
assert.deepEqual(stringArray(assignment(web, "depends"), "web.depends"), ["api"]);
const webRun = stringValue(assignment(web, "run"), "web.run");
assert.match(webRun, /PL_PWA_PORT="\$PORT"/);
assert.match(webRun, /PL_PWA_URL="http:\/\/127\.0\.0\.1:\$PORT"/);
assert.match(assignment(sections.get("daemons.web.env"), "PL_SERVER_URL"), /\{\{\s*daemons\.api\.port\s*\}\}/);

for (const [sectionName, section] of sections) {
    if (!sectionName.startsWith("daemons.")) continue;
    const owner = sectionName.split(".")[1];
    const dependencies = stringArray(assignment(daemons.get(owner), "depends") ?? "[]", `${owner}.depends`);
    for (const match of withoutComments(section).matchAll(/\{\{\s*daemons\.([^\s.}]+)\.port\s*\}\}/g)) {
        const target = match[1];
        assert.ok(daemons.has(target), `${sectionName} references undeclared daemon: ${target}`);
        assert.ok(dependencies.includes(target), `${sectionName} references ${target} without depending on it`);
    }
}

console.log(`pitchfork config ok: ${daemonNames.join(", ")}`);
