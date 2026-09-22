#!/usr/bin/env node
// Install/uninstall the distro: symlinks, SessionStart hook, Codex AGENTS.md line.
import { existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, readlinkSync, symlinkSync, unlinkSync, writeFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { homedir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
export const HOOK_MARKER = "scripts/session-start.mjs";
const AGENTS_MARKER = "<!-- claude-skills-using -->";

const USAGE = "usage: install.mjs [--home DIR] [--uninstall] [--skip-plugin]";

function isSymlink(p) {
  try { return lstatSync(p).isSymbolicLink(); } catch { return false; }
}

// Prefix match that only accepts a real path boundary, so `<repo>-old` and
// `<repo>/skills-old` are never mistaken for `<repo>` / `<repo>/skills`.
function isUnder(target, dir) {
  const base = dir.endsWith(path.sep) ? dir : dir + path.sep;
  return typeof target === "string" && target.startsWith(base);
}

export function skillDirs(repoRoot) {
  const base = path.join(repoRoot, "skills");
  return readdirSync(base).filter((d) => existsSync(path.join(base, d, "SKILL.md"))).sort();
}

export function linkSkills(repoRoot, targetDir) {
  mkdirSync(targetDir, { recursive: true });
  const linked = [], skipped = [];
  for (const name of skillDirs(repoRoot)) {
    const src = path.join(repoRoot, "skills", name);
    const dst = path.join(targetDir, name);
    if (isSymlink(dst)) {
      if (readlinkSync(dst) === src) { linked.push(name); continue; }
      if (isUnder(readlinkSync(dst), repoRoot)) unlinkSync(dst);
      else { skipped.push(name); continue; }
    } else if (existsSync(dst)) { skipped.push(name); continue; }
    symlinkSync(src, dst);
    linked.push(name);
  }
  return { linked, skipped };
}

export function unlinkSkills(repoRoot, targetDir) {
  const removed = [];
  if (!existsSync(targetDir)) return { removed };
  for (const name of readdirSync(targetDir)) {
    const p = path.join(targetDir, name);
    if (isSymlink(p) && isUnder(readlinkSync(p), path.join(repoRoot, "skills"))) { unlinkSync(p); removed.push(name); }
  }
  return { removed: removed.sort() };
}

function readJson(p, fallback) {
  return existsSync(p) ? JSON.parse(readFileSync(p, "utf8")) : fallback;
}
function writeJson(p, obj) {
  mkdirSync(path.dirname(p), { recursive: true });
  writeFileSync(p, JSON.stringify(obj, null, 2) + "\n");
}
function hookCommand(repoRoot) {
  return `node "${path.join(repoRoot, "scripts", "session-start.mjs")}"`;
}
// With repoRoot: match only this checkout's hook. Without: marker-only fallback.
function ourHookMatcher(repoRoot) {
  const needle = repoRoot ? hookCommand(repoRoot) : HOOK_MARKER;
  return (h) => typeof h?.command === "string" && h.command.includes(needle);
}

// Filter at hook level: siblings sharing a group (and the group's `matcher`)
// survive; a group is dropped only once its `hooks` array is empty.
function stripOurHooks(groups, repoRoot) {
  if (!Array.isArray(groups)) return groups;
  const isOurs = ourHookMatcher(repoRoot);
  const out = [];
  for (const g of groups) {
    if (!Array.isArray(g?.hooks)) { out.push(g); continue; }
    const kept = g.hooks.filter((h) => !isOurs(h));
    if (kept.length === g.hooks.length) out.push(g);
    else if (kept.length > 0) out.push({ ...g, hooks: kept });
  }
  return out;
}

export function ensureHook(settingsPath, repoRoot) {
  const s = readJson(settingsPath, {});
  s.hooks ??= {};
  s.hooks.SessionStart = stripOurHooks(s.hooks.SessionStart ?? [], repoRoot);
  if (!Array.isArray(s.hooks.SessionStart)) s.hooks.SessionStart = [];
  s.hooks.SessionStart.push({ hooks: [{ type: "command", command: hookCommand(repoRoot), timeout: 10 }] });
  writeJson(settingsPath, s);
}

export function removeHook(settingsPath, repoRoot) {
  const s = readJson(settingsPath, null);
  if (!Array.isArray(s?.hooks?.SessionStart)) return;
  s.hooks.SessionStart = stripOurHooks(s.hooks.SessionStart, repoRoot);
  if (s.hooks.SessionStart.length === 0) delete s.hooks.SessionStart;
  writeJson(settingsPath, s);
}

function agentsLine(repoRoot) {
  return `- Read \`${path.join(repoRoot, "USING.md")}\` for the skills workflow before starting any task. ${AGENTS_MARKER}`;
}

// With repoRoot: match only this checkout's line. Without: marker-only fallback.
function isOurAgentsLine(line, repoRoot) {
  if (!line.includes(AGENTS_MARKER)) return false;
  return repoRoot ? line === agentsLine(repoRoot) : true;
}

export function ensureAgentsLine(agentsPath, repoRoot) {
  const line = agentsLine(repoRoot);
  const existing = existsSync(agentsPath) ? readFileSync(agentsPath, "utf8") : "";
  const kept = existing.split("\n").filter((l) => !isOurAgentsLine(l, repoRoot)).join("\n").replace(/\n*$/, "\n");
  mkdirSync(path.dirname(agentsPath), { recursive: true });
  writeFileSync(agentsPath, (existing ? kept : "") + line + "\n");
}

export function removeAgentsLine(agentsPath, repoRoot) {
  if (!existsSync(agentsPath)) return;
  const kept = readFileSync(agentsPath, "utf8").split("\n").filter((l) => !isOurAgentsLine(l, repoRoot)).join("\n");
  writeFileSync(agentsPath, kept.replace(/\n*$/, "\n"));
}

function which(bin) {
  try { execFileSync("which", [bin], { stdio: "pipe" }); return true; } catch { return false; }
}

function uninstallSuperpowersPlugin() {
  try {
    const out = execFileSync("claude", ["plugin", "list"], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] });
    if (!/superpowers@claude-plugins-official/.test(out)) return "superpowers plugin: not installed";
    execFileSync("claude", ["plugin", "uninstall", "superpowers@claude-plugins-official"], { stdio: "inherit" });
    return "superpowers plugin: uninstalled";
  } catch (err) {
    return `superpowers plugin: could not uninstall automatically (${err.message}); run: claude plugin uninstall superpowers@claude-plugins-official`;
  }
}

export function parseArgs(argv) {
  const opts = { home: null, uninstall: false, skipPlugin: false };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--home") {
      if (i + 1 >= argv.length || !argv[i + 1]) return { error: "--home requires a directory" };
      opts.home = argv[++i];
    } else if (arg.startsWith("--home=")) {
      const value = arg.slice("--home=".length);
      if (!value) return { error: "--home requires a directory" };
      opts.home = value;
    } else if (arg === "--uninstall") {
      opts.uninstall = true;
    } else if (arg === "--skip-plugin") {
      opts.skipPlugin = true;
    } else {
      return { error: `unknown option: ${arg}` };
    }
  }
  return opts;
}

function main() {
  const opts = parseArgs(process.argv.slice(2));
  if (opts.error) {
    console.error(`install: ${opts.error}`);
    console.error(USAGE);
    process.exitCode = 1;
    return;
  }
  const home = opts.home ?? homedir();
  const claudeSkills = path.join(home, ".claude", "skills");
  const codexSkills = path.join(home, ".codex", "skills");
  const settings = path.join(home, ".claude", "settings.json");
  const agents = path.join(home, ".codex", "AGENTS.md");

  // Validate before touching anything: a broken settings.json used to blow up
  // half-way through, after the symlinks had already been created.
  if (existsSync(settings)) {
    let parsed;
    try {
      parsed = JSON.parse(readFileSync(settings, "utf8"));
    } catch {
      console.error(`settings.json is not valid JSON: ${settings}`);
      console.error("fix or move it, then re-run");
      process.exitCode = 1;
      return;
    }
    if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
      console.error(`settings.json is not a JSON object: ${settings}`);
      console.error("fix or move it, then re-run");
      process.exitCode = 1;
      return;
    }
  }

  if (opts.uninstall) {
    console.log("claude skills removed:", unlinkSkills(REPO_ROOT, claudeSkills).removed.join(", ") || "none");
    console.log("codex skills removed:", unlinkSkills(REPO_ROOT, codexSkills).removed.join(", ") || "none");
    removeHook(settings, REPO_ROOT);
    removeAgentsLine(agents, REPO_ROOT);
    console.log("hook and AGENTS.md line removed");
    return;
  }

  for (const [label, dir] of [["claude", claudeSkills], ["codex", codexSkills]]) {
    const r = linkSkills(REPO_ROOT, dir);
    console.log(`${label}: linked ${r.linked.join(", ")}`);
    if (r.skipped.length) console.log(`${label}: SKIPPED (name taken by a foreign entry): ${r.skipped.join(", ")}`);
  }
  ensureHook(settings, REPO_ROOT);
  console.log(`SessionStart hook set in ${settings}`);
  ensureAgentsLine(agents, REPO_ROOT);
  console.log(`USING.md referenced from ${agents}`);
  if (!opts.skipPlugin) console.log(uninstallSuperpowersPlugin());

  const checks = [
    ["TYPESAFE_API_KEY", Boolean(process.env.TYPESAFE_API_KEY), "add it to the env block of ~/.claude/settings.json (and ~/.zshenv for Codex)"],
    ["codex", which("codex"), "npm install -g @openai/codex && codex login"],
    ["orca", which("orca"), "optional; Orca-managed Codex sessions need the Orca CLI"],
  ];
  for (const [name, ok, hint] of checks) console.log(`${ok ? "ok " : "MISSING"} ${name}${ok ? "" : ` — ${hint}`}`);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main();
