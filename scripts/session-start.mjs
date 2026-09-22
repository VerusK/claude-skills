#!/usr/bin/env node
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

// Works for both installs: a development checkout and the plugin cache, because
// the root is derived from this file's own location, not from an env var.
export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

export function pointerPath(home = homedir()) {
  return path.join(home, ".verus-skills", "root");
}

// The Bash tool gets neither CLAUDE_SKILL_DIR nor CLAUDE_PLUGIN_ROOT, so the
// skills read this file to find the distro. A failure here is not fatal: the
// locator still has its symlink branches.
export function writePointer(root, home = homedir()) {
  const p = pointerPath(home);
  try {
    mkdirSync(path.dirname(p), { recursive: true });
    writeFileSync(p, root + "\n");
    return p;
  } catch {
    return null;
  }
}

export function readPointer(home = homedir()) {
  try {
    return readFileSync(pointerPath(home), "utf8").trim() || null;
  } catch {
    return null;
  }
}

// The same predicate the skills' locator uses, so the hook only warns about a
// directory those skills would actually run.
const looksLikeDistro = (dir) => {
  try {
    return Boolean(dir) && existsSync(path.join(dir, "scripts", "typesafe-judge.mjs"));
  } catch {
    return false;
  }
};

// The plugin manager cannot consult the symlink install, so this is the only
// place the two meet. A warning, not a refusal: our own root still wins the
// pointer, because these are the skills the session actually loaded.
export function buildContext(root, other = null) {
  let text;
  try {
    text = readFileSync(path.join(root, "USING.md"), "utf8");
  } catch (err) {
    text = `verus-skills: could not read USING.md (${err.message})`;
  }
  const warning =
    other && other !== root && looksLikeDistro(other)
      ? `WARNING: two installs of this distro are active — this session runs ${root}, while ${other} wrote the pointer file. Keep one: \`claude plugin uninstall verus-skills@verus-skills\`, or \`make uninstall\` run from ${other}.\n\n`
      : "";
  return `<EXTREMELY_IMPORTANT>\nYou have a personal skills distro.\n\n${warning}Distro root: ${root}\n\n${text}\n</EXTREMELY_IMPORTANT>`;
}

function main() {
  const other = readPointer();
  writePointer(ROOT);
  const payload = {
    hookSpecificOutput: { hookEventName: "SessionStart", additionalContext: buildContext(ROOT, other) },
  };
  process.stdout.write(JSON.stringify(payload) + "\n");
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main();
