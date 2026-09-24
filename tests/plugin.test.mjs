import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const read = (rel) => JSON.parse(readFileSync(path.join(ROOT, rel), "utf8"));

const SKILLS = [
  "finishing-a-development-branch",
  "kickoff",
  "plan-review",
  "review",
  "spec-review",
  "subagent-driven-development",
  "systematic-debugging",
  "test-driven-development",
  "typesafe-ai",
  "verification-before-completion",
  "writing-plans",
];

test("skills/ holds exactly the eleven skills, each with a SKILL.md", () => {
  const dirs = readdirSync(path.join(ROOT, "skills"), { withFileTypes: true })
    .filter((e) => e.isDirectory())
    .map((e) => e.name)
    .sort();
  assert.deepEqual(dirs, SKILLS);
  for (const s of SKILLS) assert.ok(existsSync(path.join(ROOT, "skills", s, "SKILL.md")), `${s}/SKILL.md missing`);
});

test("the plugin and the marketplace are both named verus-skills", () => {
  assert.equal(read(".claude-plugin/plugin.json").name, "verus-skills");
  assert.equal(read(".codex-plugin/plugin.json").name, "verus-skills");
  const mk = read(".claude-plugin/marketplace.json");
  assert.equal(mk.name, "verus-skills");
  assert.equal(mk.plugins.length, 1);
  assert.equal(mk.plugins[0].name, "verus-skills");
  assert.equal(mk.plugins[0].source, "./");
});

test("the Codex manifest points at skills/", () => {
  assert.equal(read(".codex-plugin/plugin.json").skills, "./skills/");
});

test("the hook runs session-start.mjs from the plugin root on SessionStart", () => {
  const groups = read("hooks/hooks.json").hooks.SessionStart;
  assert.equal(groups.length, 1);
  const cmd = groups[0].hooks[0].command;
  assert.equal(groups[0].hooks[0].type, "command");
  assert.match(cmd, /\$\{CLAUDE_PLUGIN_ROOT\}/);
  const resolved = cmd.replaceAll("${CLAUDE_PLUGIN_ROOT}", ROOT).match(/"([^"]+)"/)[1];
  assert.ok(existsSync(resolved), `${resolved} does not exist`);
});

test("the hook fires on resume too, so a continued session keeps the routing block", () => {
  // The symlink installer registers its hook with no matcher, i.e. on every
  // SessionStart source. Dropping `resume` here would lose both the USING.md
  // block and the pointer file on every resumed session under the plugin.
  const matcher = read("hooks/hooks.json").hooks.SessionStart[0].matcher;
  assert.equal(matcher, "startup|clear|compact|resume");
});

test("the Codex manifest inlines the same hooks as hooks/hooks.json", () => {
  assert.deepEqual(read(".codex-plugin/plugin.json").hooks, read("hooks/hooks.json"));
});

test("claude plugin validate accepts the repo", { skip: spawnSync("which", ["claude"]).status !== 0 }, () => {
  const res = spawnSync("claude", ["plugin", "validate", ROOT, "--strict", "--json"], { encoding: "utf8" });
  assert.equal(res.status, 0, res.stdout + res.stderr);
  // With no manifest at all the validator still exits 0 and reports
  // `"manifest": null`, so the exit code alone proves nothing.
  assert.equal(JSON.parse(res.stdout).manifest?.type, "marketplace", res.stdout);
});

test("the plugin ships the three verus agents", () => {
  for (const t of ["worker", "reviewer", "explorer"]) {
    const text = readFileSync(path.join(ROOT, "agents", `verus-${t}.md`), "utf8");
    assert.match(text, new RegExp(`^---\\nname: verus-${t}\\n`));
  }
});
