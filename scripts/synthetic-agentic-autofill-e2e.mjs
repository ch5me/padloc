#!/usr/bin/env node

import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";

const vaultRoot = resolve(new URL("..", import.meta.url).pathname);
const evidenceDir = join(
  vaultRoot,
  ".ch5",
  "autopilot",
  "agentic-autofill-unification-20260918",
  "synthetic-e2e",
);
const args = parseArgs(process.argv.slice(2));
const magicBrowserRoot = resolve(required(args, "magic-browser-tree"));
const helperPath = join(magicBrowserRoot, "scripts", "synthetic-agentic-autofill-e2e.mjs");
const checkerPath = join(vaultRoot, "scripts", "check-agentic-autofill-artifacts.mjs");
const vaultFixture = join(
  vaultRoot,
  "scripts",
  "fixtures",
  "agentic-autofill",
  "synthetic-login.html",
);
const magicBrowserFixture = join(
  magicBrowserRoot,
  "scripts",
  "fixtures",
  "agentic-autofill",
  "synthetic-login.html",
);
const tempDir = join(tmpdir(), `elf-vault-agentic-autofill-${process.pid}`);
const runnerEvents = [];
let tokenFile;

try {
  if (!existsSync(helperPath) || !existsSync(checkerPath)) {
    throw new Error("synthetic runner/helper/checker files are missing");
  }
  rmSync(evidenceDir, { recursive: true, force: true });
  mkdirSync(evidenceDir, { recursive: true, mode: 0o700 });
  mkdirSync(tempDir, { recursive: true, mode: 0o700 });

  const fixtureHash = assertFixtureParity(vaultFixture, magicBrowserFixture);
  const apiUrl = ensureApi();
  record("api.ready", { apiUrl, fixtureHash });

  const build = run(
    process.execPath,
    ["scripts/build-web-extension.cjs"],
    {
      cwd: vaultRoot,
      env: {
        ...process.env,
        PL_SERVER_URL: apiUrl,
        PL_AGENTIC_AUTOFILL_FIXTURES: "true",
      },
    },
  );
  if (build.status !== 0) throw new Error("Elf Vault synthetic extension build failed");
  record("extension.build", { exitCode: build.status });

  const helper = run(
    process.execPath,
    [
      helperPath,
      "--elf-vault-root",
      vaultRoot,
      "--evidence-dir",
      evidenceDir,
      "--token-file",
      join(tempDir, "raw-synthetic-values.json"),
      "--api-url",
      apiUrl,
      "--fixture",
      magicBrowserFixture,
      ...(args.headed === "true" ? ["--headed", "true"] : []),
    ],
    {
      cwd: magicBrowserRoot,
      env: {
        ...process.env,
        PL_SERVER_URL: apiUrl,
        PL_AGENTIC_AUTOFILL_FIXTURES: "true",
      },
    },
  );
  record("helper.complete", { exitCode: helper.status });
  if (helper.status !== 0) throw new Error("Magic Browser synthetic helper failed");

  const helperResult = parseJsonOutput(helper.stdout);
  tokenFile = helperResult?.tokenFile;
  if (!tokenFile || !existsSync(tokenFile)) {
    throw new Error("synthetic helper did not leave its ephemeral leak-scan token input");
  }

  const channelFiles = {
    runnerStdout: join(tempDir, "runner.stdout"),
    runnerStderr: join(tempDir, "runner.stderr"),
    runnerArgv: join(tempDir, "runner.argv"),
    helperStdout: join(tempDir, "helper.stdout"),
    helperStderr: join(tempDir, "helper.stderr"),
    helperArgv: join(tempDir, "helper.argv"),
  };
  writeFileSync(channelFiles.runnerStdout, "", { mode: 0o600 });
  writeFileSync(channelFiles.runnerStderr, "", { mode: 0o600 });
  writeFileSync(channelFiles.runnerArgv, process.argv.join("\n"), { mode: 0o600 });
  writeFileSync(channelFiles.helperStdout, helper.stdout, { mode: 0o600 });
  writeFileSync(channelFiles.helperStderr, helper.stderr, { mode: 0o600 });
  writeFileSync(channelFiles.helperArgv, helper.command.join("\n"), { mode: 0o600 });
  writeEvidence({
    ok: true,
    status: "helper-passed-check-pending",
    fixtureHash,
    apiUrl,
    helper: helperResult,
    runnerEvents,
  });

  let check = runChecker(checkerPath, tokenFile, channelFiles);
  if (check.status !== 0) throw new Error("artifact/leak checker failed after helper run");

  writeEvidence({
    ok: true,
    status: "passed",
    fixtureHash,
    apiUrl,
    helper: helperResult,
    checker: parseJsonOutput(check.stdout),
    runnerEvents,
  });
  check = runChecker(checkerPath, tokenFile, channelFiles);
  if (check.status !== 0) throw new Error("artifact/leak checker failed on final evidence");

  process.stdout.write(
    `${JSON.stringify(
      {
        ok: true,
        schema: "ch5.agentic-autofill.synthetic-e2e.runner.v1",
        evidenceDir,
        fixtureHash,
        helper: helperResult,
        checker: parseJsonOutput(check.stdout),
      },
      null,
      2,
    )}\n`,
  );
} catch (error) {
  writeEvidence({
    ok: false,
    status: "failed",
    error: "synthetic end-to-end proof failed",
    runnerEvents,
  });
  process.stderr.write(
    `synthetic-agentic-autofill-e2e failed: ${error instanceof Error ? error.message : String(error)}\n`,
  );
  process.exitCode = 1;
} finally {
  if (tokenFile && existsSync(tokenFile)) rmSync(tokenFile, { force: true });
  rmSync(tempDir, { recursive: true, force: true });
}

function ensureApi() {
  const up = run("ch5-svc", ["up", "api"], { cwd: vaultRoot });
  if (up.status !== 0) throw new Error("ch5-svc could not start the local API");
  const status = run("ch5-svc", ["status", "--json"], { cwd: vaultRoot });
  if (status.status !== 0) throw new Error("ch5-svc status failed");
  const parsed = parseJsonOutput(status.stdout);
  const api = parsed?.daemons?.find((daemon) => daemon.name === "api");
  if (!api?.serving || !Number.isInteger(api.resolvedPort)) {
    throw new Error("local API is not serving");
  }
  return `http://127.0.0.1:${api.resolvedPort}`;
}

function runChecker(checkerPathValue, rawTokenPath, channelFiles) {
  return run(
    process.execPath,
    [
      checkerPathValue,
      "--evidence-dir",
      evidenceDir,
      "--token-file",
      rawTokenPath,
      "--stdout-file",
      channelFiles.runnerStdout,
      "--stderr-file",
      channelFiles.runnerStderr,
      "--argv-file",
      channelFiles.runnerArgv,
      "--stdout-file",
      channelFiles.helperStdout,
      "--stderr-file",
      channelFiles.helperStderr,
      "--argv-file",
      channelFiles.helperArgv,
    ],
    { cwd: vaultRoot },
  );
}

function assertFixtureParity(left, right) {
  if (!existsSync(left) || !existsSync(right)) {
    throw new Error("synthetic fixture missing in one repository");
  }
  const leftBytes = readFileSync(left);
  const rightBytes = readFileSync(right);
  const leftHash = createHash("sha256").update(leftBytes).digest("hex");
  const rightHash = createHash("sha256").update(rightBytes).digest("hex");
  if (leftHash !== rightHash) throw new Error("Padloc and Magic Browser fixtures drifted");
  return leftHash;
}

function writeEvidence(payload) {
  writeFileSync(
    join(evidenceDir, "runner-events.ndjson"),
    `${runnerEvents.map((event) => JSON.stringify(event)).join("\n")}\n`,
    { mode: 0o600 },
  );
  writeFileSync(
    join(evidenceDir, "run-summary.json"),
    `${JSON.stringify(
      {
        schema: "ch5.agentic-autofill.synthetic-e2e.run-summary.v1",
        ...payload,
        evidenceRoot: ".ch5/autopilot/agentic-autofill-unification-20260918/synthetic-e2e",
        rawValuePolicy: "synthetic values only; raw values never written to evidence",
      },
      null,
      2,
    )}\n`,
    { mode: 0o600 },
  );
}

function record(step, details) {
  runnerEvents.push({ step, ...details });
}

function run(command, commandArgs, options = {}) {
  const result = spawnSync(command, commandArgs, {
    cwd: options.cwd || vaultRoot,
    env: options.env || process.env,
    encoding: "utf8",
    maxBuffer: 1024 * 1024 * 20,
  });
  return {
    ...result,
    command: [command, ...commandArgs],
    stdout: result.stdout || "",
    stderr: result.stderr || "",
  };
}

function parseJsonOutput(text) {
  const starts = [];
  for (let index = 0; index < text.length; index += 1) {
    if (text[index] === "{" || text[index] === "[") starts.push(index);
  }
  for (let index = starts.length - 1; index >= 0; index -= 1) {
    try {
      return JSON.parse(text.slice(starts[index]).trim());
    } catch {
      // CLI diagnostics can precede the JSON document.
    }
  }
  return null;
}

function parseArgs(argv) {
  const result = {};
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (!arg.startsWith("--")) continue;
    const key = arg.slice(2);
    const value = argv[index + 1];
    if (!value || value.startsWith("--")) throw new Error(`--${key} requires a value`);
    result[key] = value;
    index += 1;
  }
  return result;
}

function required(values, key) {
  if (!values[key]) throw new Error(`--${key} is required`);
  return values[key];
}
