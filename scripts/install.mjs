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

function isSymlink(p) {
  try { return lstatSync(p).isSymbolicLink(); } catch { return false; }
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
      if (readlinkSync(dst).startsWith(repoRoot)) unlinkSync(dst);
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
    if (isSymlink(p) && readlinkSync(p).startsWith(path.join(repoRoot, "skills"))) { unlinkSync(p); removed.push(name); }
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
function isOurGroup(g) {
  return Array.isArray(g?.hooks) && g.hooks.some((h) => typeof h?.command === "string" && h.command.includes(HOOK_MARKER));
}

export function ensureHook(settingsPath, repoRoot) {
  const s = readJson(settingsPath, {});
  s.hooks ??= {};
  s.hooks.SessionStart = (s.hooks.SessionStart ?? []).filter((g) => !isOurGroup(g));
  s.hooks.SessionStart.push({ hooks: [{ type: "command", command: hookCommand(repoRoot), timeout: 10 }] });
  writeJson(settingsPath, s);
}

export function removeHook(settingsPath) {
  const s = readJson(settingsPath, null);
  if (!s?.hooks?.SessionStart) return;
  s.hooks.SessionStart = s.hooks.SessionStart.filter((g) => !isOurGroup(g));
  if (s.hooks.SessionStart.length === 0) delete s.hooks.SessionStart;
  writeJson(settingsPath, s);
}

export function ensureAgentsLine(agentsPath, repoRoot) {
  const line = `- Read \`${path.join(repoRoot, "USING.md")}\` for the skills workflow before starting any task. ${AGENTS_MARKER}`;
  const existing = existsSync(agentsPath) ? readFileSync(agentsPath, "utf8") : "";
  const kept = existing.split("\n").filter((l) => !l.includes(AGENTS_MARKER)).join("\n").replace(/\n*$/, "\n");
  mkdirSync(path.dirname(agentsPath), { recursive: true });
  writeFileSync(agentsPath, (existing ? kept : "") + line + "\n");
}

export function removeAgentsLine(agentsPath) {
  if (!existsSync(agentsPath)) return;
  const kept = readFileSync(agentsPath, "utf8").split("\n").filter((l) => !l.includes(AGENTS_MARKER)).join("\n");
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

function main() {
  const args = process.argv.slice(2);
  const home = args.includes("--home") ? args[args.indexOf("--home") + 1] : homedir();
  const claudeSkills = path.join(home, ".claude", "skills");
  const codexSkills = path.join(home, ".codex", "skills");
  const settings = path.join(home, ".claude", "settings.json");
  const agents = path.join(home, ".codex", "AGENTS.md");

  if (args.includes("--uninstall")) {
    console.log("claude skills removed:", unlinkSkills(REPO_ROOT, claudeSkills).removed.join(", ") || "none");
    console.log("codex skills removed:", unlinkSkills(REPO_ROOT, codexSkills).removed.join(", ") || "none");
    removeHook(settings);
    removeAgentsLine(agents);
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
  if (!args.includes("--skip-plugin")) console.log(uninstallSuperpowersPlugin());

  const checks = [
    ["TYPESAFE_API_KEY", Boolean(process.env.TYPESAFE_API_KEY), "add it to the env block of ~/.claude/settings.json (and ~/.zshenv for Codex)"],
    ["codex", which("codex"), "npm install -g @openai/codex && codex login"],
    ["orca", which("orca"), "optional; Orca-managed Codex sessions need the Orca CLI"],
  ];
  for (const [name, ok, hint] of checks) console.log(`${ok ? "ok " : "MISSING"} ${name}${ok ? "" : ` — ${hint}`}`);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main();
