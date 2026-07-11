import { execFileSync } from "node:child_process";
import { writeFile } from "node:fs/promises";

const previous =
    process.env.PREVIOUS_STABLE_TAG ||
    execFileSync("git", ["describe", "--tags", "--abbrev=0", "--match", "v[0-9]*", "HEAD^"], {
        encoding: "utf8",
    }).trim();
const commits = execFileSync("git", ["log", "--format=%h%x09%s", `${previous}..HEAD`], { encoding: "utf8" })
    .trim()
    .split("\n")
    .filter(Boolean);
const categories = { Security: [], Added: [], Changed: [], Fixed: [], Deprecated: [], Removed: [], "Known issues": [] };
for (const line of commits) {
    const subject = line.split("\t")[1] || "";
    const target = /^fix(?:\([^)]*\))?:/i.test(subject)
        ? "Fixed"
        : /^feat(?:\([^)]*\))?:/i.test(subject)
        ? "Added"
        : /security|cve|vulnerab/i.test(subject)
        ? "Security"
        : "Changed";
    categories[target].push(line);
}
let output = `# CH5 Auth release notes\n\n> DRAFT: generated from commits since ${previous}. A human must edit and approve these notes before stable promotion.\n`;
for (const [heading, lines] of Object.entries(categories))
    output += `\n## ${heading}\n\n${lines.length ? lines.map((line) => `- ${line}`).join("\n") : "- None recorded."}\n`;
await writeFile(process.env.RELEASE_NOTES || "RELEASE_NOTES.md", output);
