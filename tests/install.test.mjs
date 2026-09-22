import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, readlinkSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { linkSkills, unlinkSkills, ensureHook, removeHook, ensureAgentsLine, removeAgentsLine, HOOK_MARKER } from "../scripts/install.mjs";

function fakeRepo() {
  const root = mkdtempSync(path.join(tmpdir(), "repo-"));
  for (const s of ["kickoff", "plan-review"]) {
    mkdirSync(path.join(root, "skills", s), { recursive: true });
    writeFileSync(path.join(root, "skills", s, "SKILL.md"), `---\nname: ${s}\n---\n`);
  }
  mkdirSync(path.join(root, "skills", "not-a-skill"));
  return root;
}

test("linkSkills symlinks every skill dir with a SKILL.md and skips foreign entries", () => {
  const root = fakeRepo();
  const target = mkdtempSync(path.join(tmpdir(), "skills-"));
  mkdirSync(path.join(target, "plan-review")); // foreign real dir
  const r = linkSkills(root, target);
  assert.deepEqual(r.linked, ["kickoff"]);
  assert.deepEqual(r.skipped, ["plan-review"]);
  assert.equal(readlinkSync(path.join(target, "kickoff")), path.join(root, "skills", "kickoff"));
  assert.ok(!existsSync(path.join(target, "not-a-skill")));
  // idempotent
  assert.deepEqual(linkSkills(root, target).linked, ["kickoff"]);
});

test("unlinkSkills removes only symlinks pointing into the repo", () => {
  const root = fakeRepo();
  const target = mkdtempSync(path.join(tmpdir(), "skills-"));
  linkSkills(root, target);
  symlinkSync("/somewhere/else", path.join(target, "other"));
  const r = unlinkSkills(root, target);
  assert.deepEqual(r.removed, ["kickoff", "plan-review"]);
  assert.ok(existsSync(path.join(target, "other")) || readlinkSync(path.join(target, "other")));
});

test("ensureHook adds one SessionStart hook and is idempotent; removeHook deletes it", () => {
  const root = fakeRepo();
  const settings = path.join(mkdtempSync(path.join(tmpdir(), "cfg-")), "settings.json");
  writeFileSync(settings, JSON.stringify({ hooks: { SessionStart: [{ hooks: [{ type: "command", command: "echo keep" }] }] } }, null, 2));
  ensureHook(settings, root);
  ensureHook(settings, root);
  let s = JSON.parse(readFileSync(settings, "utf8"));
  const ours = s.hooks.SessionStart.filter((g) => g.hooks.some((h) => h.command.includes(HOOK_MARKER)));
  assert.equal(ours.length, 1);
  assert.match(ours[0].hooks[0].command, new RegExp(root.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
  assert.equal(s.hooks.SessionStart.length, 2);
  removeHook(settings, root);
  s = JSON.parse(readFileSync(settings, "utf8"));
  assert.equal(s.hooks.SessionStart.length, 1);
  assert.equal(s.hooks.SessionStart[0].hooks[0].command, "echo keep");
});

test("ensureHook creates settings.json when missing", () => {
  const root = fakeRepo();
  const settings = path.join(mkdtempSync(path.join(tmpdir(), "cfg-")), "settings.json");
  ensureHook(settings, root);
  assert.equal(JSON.parse(readFileSync(settings, "utf8")).hooks.SessionStart.length, 1);
});

test("ensureAgentsLine appends once; removeAgentsLine strips it", () => {
  const root = fakeRepo();
  const agents = path.join(mkdtempSync(path.join(tmpdir(), "codex-")), "AGENTS.md");
  writeFileSync(agents, "# mine\n");
  ensureAgentsLine(agents, root);
  ensureAgentsLine(agents, root);
  const text = readFileSync(agents, "utf8");
  assert.equal(text.split("\n").filter((l) => l.includes("USING.md")).length, 1);
  assert.match(text, /^# mine/);
  removeAgentsLine(agents, root);
  assert.equal(readFileSync(agents, "utf8"), "# mine\n");
});
