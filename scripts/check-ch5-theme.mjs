import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const theme = await readFile(new URL("../assets/theme.css", import.meta.url), "utf8");

const expectedTokens = [
    "--ch5-brand: #7b4dff",
    "--ch5-primary: #ff4aa5",
    "--ch5-accent: #18cfc4",
    "--ch5-background: #f8f4ef",
    "--ch5-foreground: #1c2550",
    "--ch5-primary: #7b4dff",
    "--ch5-accent: #19d7c8",
    "--ch5-background: #08122f",
    "--ch5-foreground: #f8fbff",
];

for (const token of expectedTokens) {
    assert.ok(theme.includes(token), `Missing canonical Firefly token mapping: ${token}`);
}

assert.match(theme, /--color-highlight:\s*var\(--ch5-primary\)/);
assert.match(theme, /--font-family:\s*"Avenir Next"/);
console.log("CH5 theme mapping verified.");
