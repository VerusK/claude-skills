#!/usr/bin/env node
// SessionStart hook: inject USING.md as additional context (Claude Code format).
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
let text;
try {
  text = readFileSync(path.join(root, "USING.md"), "utf8");
} catch (err) {
  text = `claude-skills: could not read USING.md (${err.message})`;
}
const context = `<EXTREMELY_IMPORTANT>\nYou have a personal skills distro.\n\n${text}\n</EXTREMELY_IMPORTANT>`;
process.stdout.write(JSON.stringify({ hookSpecificOutput: { hookEventName: "SessionStart", additionalContext: context } }) + "\n");
