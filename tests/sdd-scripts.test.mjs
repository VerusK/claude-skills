import { test, after } from "node:test";
import assert from "node:assert/strict";
import { spawnSync, execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const SCRIPTS = fileURLToPath(new URL("../skills/subagent-driven-development/scripts/", import.meta.url));
const TEMP = [];
after(() => { for (const d of TEMP) rmSync(d, { recursive: true, force: true }); });

function repo() {
  const dir = realpathSync(mkdtempSync(path.join(tmpdir(), "sdd-")));
  TEMP.push(dir);
  const git = (...a) => execFileSync("git", a, { cwd: dir, encoding: "utf8" }).trim();
  git("init", "-q");
  git("config", "user.email", "t@example.com");
  git("config", "user.name", "t");
  git("commit", "-q", "--allow-empty", "-m", "root");
  return { dir, git };
}

function commit({ dir, git }, file, body, msg) {
  mkdirSync(path.dirname(path.join(dir, file)), { recursive: true });
  writeFileSync(path.join(dir, file), body);
  git("add", "--", file);
  git("commit", "-q", "-m", msg);
  return git("rev-parse", "HEAD");
}

const run = (dir, script, args) => spawnSync("bash", [path.join(SCRIPTS, script), ...args], { cwd: dir, encoding: "utf8" });

function writePlan(dir, tasks) {
  const plan = path.join(dir, "docs/plans/p.md");
  mkdirSync(path.dirname(plan), { recursive: true });
  writeFileSync(plan, ["# Plan", "", "## Global Constraints", "", "- none", "", ...tasks].join("\n") + "\n");
  return plan;
}

test("task-brief copies a task under the cap whole", () => {
  const r = repo();
  const plan = writePlan(r.dir, ["### Task 1: Small", "", "- [ ] **Step 1: Do it**", "", "```", "x = 1", "```", "", "### Task 2: Other", "", "other"]);
  const res = run(r.dir, "task-brief", [plan, "1"]);
  assert.equal(res.status, 0, res.stderr);
  const out = res.stdout.match(/^wrote (\S+): \d+ lines$/m)[1];
  const brief = readFileSync(out, "utf8");
  assert.match(brief, /^### Task 1: Small\n/);
  assert.match(brief, /x = 1/);
  assert.doesNotMatch(brief, /Task 2|Pointer brief/);
});

test("task-brief turns a task over 10 KB into a pointer brief with line ranges", () => {
  const r = repo();
  const big = (tag) => Array.from({ length: 120 }, (_, i) => `const ${tag}${i} = "${"v".repeat(40)}";`);
  const plan = writePlan(r.dir, [
    "### Task 1: Big", "", "**Files:** `src/a.js`", "",
    "- [ ] **Step 1: Write the failing test**", "", "```js", "# not a heading inside a fence", ...big("a"), "```", "",
    "- [ ] **Step 2: Implement**", "", "```js", ...big("b"), "```", "",
    "### Task 2: Next", "", "next",
  ]);
  const lines = readFileSync(plan, "utf8").split("\n");
  const at = (s) => lines.indexOf(s) + 1;
  const res = run(r.dir, "task-brief", [plan, "1"]);
  assert.equal(res.status, 0, res.stderr);
  assert.match(res.stdout, /pointer brief/);
  const out = res.stdout.match(/^wrote (\S+):/m)[1];
  const brief = readFileSync(out, "utf8");
  assert.ok(Buffer.byteLength(brief) < 10240, `brief is ${Buffer.byteLength(brief)} bytes`);
  assert.match(brief, /^### Task 1: Big\n/);
  assert.match(brief, /\*\*Files:\*\* `src\/a\.js`/, "a small intro is copied inline");
  assert.ok(brief.includes(`lines ${at("### Task 1: Big")}-${at("### Task 2: Next") - 1}`), brief);
  const s1 = at("- [ ] **Step 1: Write the failing test**");
  const s2 = at("- [ ] **Step 2: Implement**");
  assert.match(brief, new RegExp(`- lines ${s1}-${s2 - 1} \\(\\d+ lines, \\d+ bytes\\): \\*\\*Step 1: Write the failing test\\*\\*`));
  assert.match(brief, new RegExp(`- lines ${s2}-${at("### Task 2: Next") - 1} \\(`));
  assert.doesNotMatch(brief, /not a heading inside a fence|const a0/);
  assert.doesNotMatch(brief, /Task 2: Next/);
});

test("task-brief fails with exit 3 on a missing task", () => {
  const r = repo();
  const plan = writePlan(r.dir, ["### Task 1: Only", "", "x"]);
  const res = run(r.dir, "task-brief", [plan, "7"]);
  assert.equal(res.status, 3);
  assert.match(res.stderr, /task 7 not found/);
});

test("review-package shows the range's hunks with 3 lines of context and keeps lockfiles out of the hunks", () => {
  const r = repo();
  const plan = writePlan(r.dir, ["### Task 1: x"]);
  const body = Array.from({ length: 30 }, (_, i) => `line ${i}`);
  commit(r, "src/a.js", body.join("\n") + "\n", "base file");
  const base = r.git("rev-parse", "HEAD");
  body[15] = "changed";
  commit(r, "src/a.js", body.join("\n") + "\n", "change a");
  commit(r, "package-lock.json", "{\"lock\": true}\n", "lock");
  const res = run(r.dir, "review-package", [plan, base, "HEAD"]);
  assert.equal(res.status, 0, res.stderr);
  const m = res.stdout.match(/^wrote (\S+): 2 commit\(s\), \d+ bytes$/m);
  assert.ok(m, res.stdout);
  const pkg = readFileSync(m[1], "utf8");
  assert.match(pkg, /## Files changed[\s\S]*package-lock\.json/);
  assert.doesNotMatch(pkg, /"lock": true/);
  assert.match(pkg, /\+changed/);
  assert.match(pkg, /^ line 12$/m);
  assert.doesNotMatch(pkg, /^ line 11$/m, "context is 3 lines, not 10");
});

test("review-package --commits packages only the task's own commits", () => {
  const r = repo();
  const plan = writePlan(r.dir, ["### Task 1: x"]);
  const base = r.git("rev-parse", "HEAD");
  const mine1 = commit(r, "src/mine.js", "mine 1\n", "task A part 1");
  commit(r, "src/other.js", "other\n", "task B");
  const mine2 = commit(r, "src/mine.js", "mine 2\n", "task A part 2");
  const res = run(r.dir, "review-package", ["--commits", `${mine2.slice(0, 7)},${mine1}`, plan, base, "HEAD"]);
  assert.equal(res.status, 0, res.stderr);
  const m = res.stdout.match(/^wrote (\S+): 2 commit\(s\), \d+ bytes$/m);
  assert.ok(m, res.stdout);
  const pkg = readFileSync(m[1], "utf8");
  assert.match(pkg, /task commits only/);
  assert.ok(pkg.indexOf("task A part 1") < pkg.indexOf("task A part 2"), "commits in history order");
  assert.doesNotMatch(pkg, /other|task B/);
});

test("review-package --commits refuses a commit outside BASE..HEAD", () => {
  const r = repo();
  const plan = writePlan(r.dir, ["### Task 1: x"]);
  const old = commit(r, "a.js", "a\n", "before base");
  const base = r.git("rev-parse", "HEAD");
  commit(r, "b.js", "b\n", "in range");
  const res = run(r.dir, "review-package", ["--commits", old, plan, base, "HEAD"]);
  assert.equal(res.status, 3);
  assert.match(res.stderr, /commit not in/);
});

test("review-package marks a docs-only change and only that", () => {
  const r = repo();
  const plan = writePlan(r.dir, ["### Task 1: x"]);
  const base = r.git("rev-parse", "HEAD");
  commit(r, "docs/guide.md", "# guide\n", "docs");
  commit(r, "skills/x/SKILL.md", "# skill\n", "skill text");
  let res = run(r.dir, "review-package", [plan, base, "HEAD"]);
  assert.equal(res.status, 0, res.stderr);
  assert.match(res.stdout, /, docs-only$/m);
  commit(r, "scripts/x.sh", "echo\n", "script");
  res = run(r.dir, "review-package", [plan, base, "HEAD"]);
  assert.doesNotMatch(res.stdout, /docs-only/);
});

test("sdd-workspace --remove deletes only this plan's workspace and never creates one", () => {
  const r = repo();
  const plan = writePlan(r.dir, ["### Task 1: x"]);
  let res = run(r.dir, "sdd-workspace", ["--remove", plan]);
  assert.equal(res.status, 0, res.stderr);
  assert.match(res.stdout, /no workspace for docs\/plans\/p\.md/);
  assert.equal(existsSync(path.join(r.dir, ".superpowers/sdd/p")), false);

  // Another plan with the same basename owns the first slot.
  const other = path.join(r.dir, "other/p.md");
  mkdirSync(path.dirname(other), { recursive: true });
  writeFileSync(other, "# other\n");
  const otherWs = run(r.dir, "sdd-workspace", [other]).stdout.trim();
  const ws = run(r.dir, "sdd-workspace", [plan]).stdout.trim();
  assert.notEqual(ws, otherWs);
  writeFileSync(path.join(ws, "progress.md"), "# SDD ledger\n");

  res = run(r.dir, "sdd-workspace", ["--remove", plan]);
  assert.equal(res.status, 0, res.stderr);
  assert.equal(res.stdout.trim(), `removed ${ws}`);
  assert.equal(existsSync(ws), false);
  assert.equal(existsSync(otherWs), true);
});

const SKILL_DIR = fileURLToPath(new URL("../skills/subagent-driven-development/", import.meta.url));
const AGENTS = fileURLToPath(new URL("../agents/", import.meta.url));
const text = (f) => readFileSync(f, "utf8");

test("SDD states the brief cap, the docs-only skip and cleans up through the script", () => {
  const sdd = text(path.join(SKILL_DIR, "SKILL.md"));
  assert.match(sdd, /A brief is capped at ~10 KB/);
  assert.match(sdd, /Docs-only tasks skip the task review/);
  assert.match(sdd, /docs-only, no task review/);
  assert.match(sdd, /bash scripts\/sdd-workspace --remove PLAN_FILE/);
  assert.doesNotMatch(sdd, /rm -rf <workspace>/);
  const rr = text(path.join(SKILL_DIR, "re-review-prompt.md"));
  assert.match(rr, /Read only the latest `## Fix round` section/);
  assert.doesNotMatch(rr, /^    Read the task brief: \[BRIEF_FILE\]$/m);
});

test("every subagent prompt carries the shell rules", () => {
  const files = [
    ...["verus-worker.md", "verus-reviewer.md", "verus-explorer.md"].map((f) => path.join(AGENTS, f)),
    ...["implementer-prompt.md", "task-reviewer-prompt.md", "re-review-prompt.md"].map((f) => path.join(SKILL_DIR, f)),
  ];
  for (const f of files) {
    const body = text(f);
    assert.match(body, /Never put `rm` or `find … -delete` in a command/, f);
    assert.match(body, /No bare `sleep`/, f);
    assert.match(body, /--include='\*\.md'/, f);
  }
});
