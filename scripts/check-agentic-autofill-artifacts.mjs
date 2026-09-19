#!/usr/bin/env node

import { createHash } from "node:crypto";
import {
  lstatSync,
  readFileSync,
  readdirSync,
  realpathSync,
  writeFileSync,
} from "node:fs";
import { spawnSync } from "node:child_process";
import { join, relative, resolve } from "node:path";

const values = parseArgs(process.argv.slice(2));
const evidenceDir = resolve(required(values, "evidence-dir"));
const tokenFile = values["token-file"] ? resolve(values["token-file"]) : null;
const channelFiles = [
  ...(values["stdout-file"] || []),
  ...(values["stderr-file"] || []),
  ...(values["argv-file"] || []),
].filter(Boolean);
const violations = [];
const tokens = loadTokens(tokenFile);
const artifactFiles = walk(evidenceDir);
const scanned = new Set();

for (const file of [...artifactFiles, ...channelFiles, ...processArgvFiles()]) {
  scanFile(file);
}

scanProcessArgv();
checkRequiredArtifacts();
checkRedactedSummary();

const result = {
  schema: "ch5.agentic-autofill.synthetic-e2e.artifact-check.v1",
  ok: violations.length === 0,
  evidenceDir: ".ch5/autopilot/agentic-autofill-unification-20260918/synthetic-e2e",
  scannedFiles: scanned.size,
  artifactFiles: artifactFiles.length,
  channels: ["stdout", "stderr", "logs", "argv", "screenshots", "artifacts", "receipts"],
  tokenCount: tokens.length,
  tokenDigests: tokens.map((token) =>
    createHash("sha256").update(token, "utf8").digest("hex").slice(0, 16),
  ),
  violations,
};
writeFileSync(
  join(evidenceDir, "artifact-check.json"),
  `${JSON.stringify(result, null, 2)}\n`,
  { mode: 0o600 },
);
process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
if (!result.ok) process.exitCode = 1;

function checkRequiredArtifacts() {
  const required = [
    "events.ndjson",
    "helper-summary.json",
    "cli-events.ndjson",
    "runner-events.ndjson",
    "run-summary.json",
  ];
  for (const name of required) {
    if (!artifactFiles.includes(join(evidenceDir, name))) {
      violations.push(`missing artifact: ${name}`);
    }
  }
}

function checkRedactedSummary() {
  const helper = readJson(join(evidenceDir, "helper-summary.json"));
  if (!helper) {
    violations.push("helper summary is not valid JSON");
    return;
  }
  const expectedChannels = new Set([
    "stdout",
    "stderr",
    "logs",
    "argv",
    "screenshots",
    "artifacts",
    "receipts",
  ]);
  for (const channel of helper.channels || []) expectedChannels.delete(channel);
  if (expectedChannels.size > 0) {
    violations.push(`missing leak-scan channels: ${[...expectedChannels].join(",")}`);
  }
  if (!Number.isInteger(helper.tokenCount) || helper.tokenCount < 1) {
    violations.push("synthetic raw-value scan did not receive a token set");
  }
  const run = readJson(join(evidenceDir, "run-summary.json"));
  if (
    run?.status &&
    !["passed", "helper-passed-check-pending"].includes(String(run.status))
  ) {
    violations.push(`run summary is not passed: ${String(run.status)}`);
  }
  const eventText = readFile(join(evidenceDir, "events.ndjson"));
  const events = eventText
    .split("\n")
    .filter(Boolean)
    .map((line) => safeJson(line))
    .filter(Boolean);
  const requiredSteps = [
    "extension.setup",
    "padloc.unlock-and-seed",
    "bootstrap.clean-required",
    "broker.classified",
    "broker.plan",
    "broker.approval",
    "broker.granted",
    "broker.applied",
    "privacy.blocked",
    "proof.redacted",
    "broker.revoked",
    "broker.stale-grant-blocked",
    "padloc.locked",
    "padloc.service-worker-restart",
    "broker.restart-stale-blocked",
  ];
  const seen = new Set(events.map((event) => event.step));
  for (const step of requiredSteps) {
    if (!seen.has(step)) violations.push(`missing proof step: ${step}`);
  }
  const bootstrap = events.find((event) => event.step === "bootstrap.target-descriptor");
  const clean = events.find((event) => event.step === "bootstrap.clean-required");
  if (!bootstrap || !clean || bootstrap.target !== clean.target) {
    violations.push("privacy bootstrap target/clean proof is missing or drifted");
  }
  const applied = events.find((event) => event.step === "broker.applied");
  if (!applied?.receipt || applied.receipt.status !== "completed") {
    violations.push("completed redacted apply receipt is missing");
  }
  const blocked = events.find((event) => event.step === "privacy.blocked");
  if (
    !blocked ||
    blocked.state !== "potentially-private" ||
    blocked.genericObservation !== "blocked"
  ) {
    violations.push("privacy block proof is missing");
  }
}

function scanFile(file) {
  if (!file || scanned.has(file)) return;
  scanned.add(file);
  let stat;
  try {
    stat = lstatSync(file);
  } catch {
    violations.push(`unreadable channel: ${file}`);
    return;
  }
  if (stat.isSymbolicLink()) {
    violations.push(`symlink artifact/channel refused: ${file}`);
    return;
  }
  if (!stat.isFile()) return;
  const bytes = readFileSync(file);
  for (const token of tokens) {
    const needle = Buffer.from(token, "utf8");
    if (needle.length > 0 && bytes.indexOf(needle) !== -1) {
      violations.push(`raw synthetic value found in ${display(file)}`);
    }
  }
  if (isTextFile(file, bytes)) {
    const text = bytes.toString("utf8");
    if (/"rawValues"\s*:/i.test(text) || /"rawValue"\s*:/i.test(text)) {
      violations.push(`raw value field found in ${display(file)}`);
    }
    if (/"(password|secret|ciphertext|privateKey)"\s*:\s*"[^\"]+"/i.test(text)) {
      violations.push(`sensitive-looking plaintext field found in ${display(file)}`);
    }
  }
}

function walk(root) {
  const files = [];
  const canonicalRoot = realpathSync(root);
  for (const entry of readdirSync(root, { withFileTypes: true })) {
    const path = join(root, entry.name);
    const stat = lstatSync(path);
    if (stat.isSymbolicLink()) {
      violations.push(`symlink artifact refused: ${path}`);
      continue;
    }
    if (entry.isDirectory()) {
      files.push(...walk(path));
    } else if (entry.isFile()) {
      const canonical = realpathSync(path);
      const rel = relative(canonicalRoot, canonical);
      if (rel.startsWith("..") || rel.includes("..")) {
        violations.push(`artifact escapes evidence root: ${path}`);
      } else {
        files.push(path);
      }
    }
  }
  return files;
}

function processArgvFiles() {
  return [
    ...(values["argv-file"] || []),
    ...(values["stdout-file"] || []),
    ...(values["stderr-file"] || []),
  ];
}

function scanProcessArgv() {
  const ps = spawnSync("ps", ["-axo", "command="], {
    encoding: "utf8",
    maxBuffer: 1024 * 1024 * 4,
  });
  if (ps.status === 0) {
    for (const token of tokens) {
      if ((ps.stdout || "").includes(token)) {
        violations.push("raw synthetic value found in live process argv");
      }
    }
  }
}

function loadTokens(path) {
  if (!path) return [];
  const parsed = readJson(path);
  if (!Array.isArray(parsed)) {
    violations.push("token file is not an array");
    return [];
  }
  const tokens = parsed.filter((value) => typeof value === "string" && value.length > 0);
  for (const token of tokens) {
    const lower = token.toLowerCase();
    if (
      !lower.includes("synthetic") &&
      !lower.includes("example.invalid") &&
      !lower.includes("fixture") &&
      !/^[0-9a-f]{32,64}$/i.test(token)
    ) {
      violations.push("token set contains a non-synthetic value");
    }
  }
  return [...new Set(tokens)];
}

function readJson(path) {
  try {
    return JSON.parse(readFileSync(path, "utf8"));
  } catch {
    return null;
  }
}

function readFile(path) {
  try {
    return readFileSync(path, "utf8");
  } catch {
    return "";
  }
}

function safeJson(text) {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

function isTextFile(path, bytes) {
  if (/\.(png|jpe?g|gif|webp|pdf|zip|crx)$/i.test(path)) return false;
  return !bytes.subarray(0, 128).includes(0);
}

function display(path) {
  const index = path.indexOf(".ch5/autopilot/");
  return index >= 0 ? path.slice(index) : path;
}

function parseArgs(argv) {
  const result = {};
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (!arg.startsWith("--")) continue;
    const key = arg.slice(2);
    const value = argv[index + 1];
    if (!value || value.startsWith("--")) throw new Error(`--${key} requires a value`);
    if (new Set(["stdout-file", "stderr-file", "argv-file"]).has(key)) {
      (result[key] ||= []).push(value);
    } else {
      result[key] = value;
    }
    index += 1;
  }
  return result;
}

function required(values, key) {
  if (!values[key]) throw new Error(`--${key} is required`);
  return values[key];
}
