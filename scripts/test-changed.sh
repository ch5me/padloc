#!/usr/bin/env bash
set -euo pipefail

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
project_id="${CH5_PROJECT_ID:-padloc}"
ch5_root="${CH5_ROOT:-/Users/hassoncs/src/ch5}"
allow_fallback=false
dry_run=false
plan_out=""

planner_args=()

while [[ $# -gt 0 ]]; do
  case "$1" in
    --since|--files|--out)
      if [[ $# -lt 2 ]]; then
        echo "[test:changed] $1 requires a value" >&2
        exit 1
      fi
      planner_args+=("$1" "$2")
      shift 2
      ;;
    --include-untracked|--full)
      planner_args+=("$1")
      shift
      ;;
    --allow-fallback)
      allow_fallback=true
      shift
      ;;
    --dry-run)
      dry_run=true
      shift
      ;;
    --plan-out)
      if [[ $# -lt 2 ]]; then
        echo "[test:changed] --plan-out requires a value" >&2
        exit 1
      fi
      plan_out="$2"
      shift 2
      ;;
    *)
      echo "[test:changed] unknown option: $1" >&2
      exit 1
      ;;
  esac
done

tmp_plan="$(mktemp)"
tmp_json="$(mktemp)"
cleanup() {
  rm -f "$tmp_plan" "$tmp_json" "${tmp_plan}.commands.json"
}
trap cleanup EXIT

cd "$repo_root"

ch5 plan "$project_id" --root "$ch5_root" --json "${planner_args[@]}" --out "$tmp_plan" >"$tmp_json"

if [[ -n "$plan_out" ]]; then
  mkdir -p "$(dirname "$plan_out")"
  cp "$tmp_plan" "$plan_out"
fi

node - "$tmp_plan" "$allow_fallback" <<'NODE'
const fs = require("fs");

const planPath = process.argv[2];
const allowFallback = process.argv[3] === "true";
const plan = JSON.parse(fs.readFileSync(planPath, "utf8"));
const testTasks = plan.tasks.filter((task) => task.kind === "test-files");
const nonTestTasks = plan.tasks.filter((task) => task.kind !== "test-files");
const commands = [];

function shellQuote(value) {
    return `'${String(value).replace(/'/g, `'\\''`)}'`;
}

function normalizeCommand(command) {
    const extensionHarnessMatches = [...command.matchAll(/['"]?(packages\/extension\/test-harness\/[^'"\s]+\.spec\.ts)['"]?/g)];
    if (extensionHarnessMatches.length > 0) {
        const files = extensionHarnessMatches.map((match) => match[1].replace(/^packages\/extension\//, ""));
        return `npm --prefix packages/extension run test:harness -- --project=chromium-extension ${files.map(shellQuote).join(" ")}`;
    }
    return command;
}

for (const task of testTasks) {
    for (const command of task.commandHints || []) {
        const normalized = normalizeCommand(command);
        if (!commands.includes(normalized)) commands.push(normalized);
    }
}

if (plan.summary.fallbackTasks > 0 && !allowFallback) {
    process.stderr.write(
        `[test:changed] planner produced ${plan.summary.fallbackTasks} fallback task(s); refine scope before broad checks.\n`
    );
    process.stderr.write(`[test:changed] plan file: ${planPath}\n`);
    process.exit(2);
}

process.stdout.write(`[test:changed] changedFiles=${plan.summary.changedFiles}\n`);
process.stdout.write(`[test:changed] affectedNodes=${plan.summary.affectedNodes}\n`);
process.stdout.write(`[test:changed] testFiles=${plan.summary.testFiles}\n`);
process.stdout.write(`[test:changed] routeScreenshots=${plan.summary.routeScreenshots}\n`);
process.stdout.write(`[test:changed] requiredProofs=${plan.summary.requiredProofs}\n`);
process.stdout.write(`[test:changed] launchGateTasks=${plan.summary.launchGateTasks}\n`);
process.stdout.write(`[test:changed] fallbackTasks=${plan.summary.fallbackTasks}\n`);

if (commands.length === 0) {
    process.stdout.write("[test:changed] no implicated test commands.\n");
} else {
    process.stdout.write("[test:changed] implicated test commands:\n");
    for (const command of commands) process.stdout.write(`${command}\n`);
}

if (nonTestTasks.length > 0) {
    process.stdout.write("[test:changed] non-test proof tasks:\n");
    for (const task of nonTestTasks) {
        process.stdout.write(`- ${task.kind}: ${task.target}\n`);
        for (const command of task.commandHints || []) process.stdout.write(`  ${command}\n`);
    }
}

fs.writeFileSync(`${planPath}.commands.json`, JSON.stringify({ commands, nonTestTasks, summary: plan.summary }, null, 2));
NODE

commands_json="${tmp_plan}.commands.json"
if [[ "$dry_run" == true ]]; then
  exit 0
fi

mapfile -t commands < <(node -e "const fs=require('fs'); const data=JSON.parse(fs.readFileSync(process.argv[1],'utf8')); for (const cmd of data.commands) console.log(cmd);" "$commands_json")

if [[ ${#commands[@]} -eq 0 ]]; then
  exit 0
fi

for command in "${commands[@]}"; do
  echo "[test:changed] run: $command"
  bash -lc "$command"
done
