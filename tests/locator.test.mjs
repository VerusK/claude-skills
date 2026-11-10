import { test, after } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const TEMP_DIRS = [];
function tmp(prefix) {
  const d = realpathSync(mkdtempSync(path.join(tmpdir(), prefix)));
  TEMP_DIRS.push(d);
  return d;
}
after(() => {
  for (const d of TEMP_DIRS) rmSync(d, { recursive: true, force: true });
});

// Execute the shell instructions agents actually receive, not a reimplementation.
function extractLocator(relPath) {
  const body = readFileSync(path.join(REPO_ROOT, relPath), "utf8");
  const m = body.match(/SKILL_DIR="<[^\n]+>"\nSKILLS_REPO=.*\n.*distro root not found.*\n/);
  assert.ok(m, `no locator block found in ${relPath}`);
  return m[0];
}

function fakeDistro() {
  const root = tmp("distro-");
  mkdirSync(path.join(root, "scripts"), { recursive: true });
  writeFileSync(path.join(root, "scripts", "typesafe-judge.mjs"), "// stub\n");
  writeFileSync(path.join(root, "scripts", "reviewer.sh"), "# stub\n");
  mkdirSync(path.join(root, "skills", "kickoff"), { recursive: true });
  writeFileSync(path.join(root, "skills", "kickoff", "SKILL.md"), "---\nname: kickoff\n---\n");
  return root;
}

function runLocator(snippet, home, skillDir) {
  // Supply the loaded skill path as data, even when it contains shell metacharacters.
  snippet = snippet.replace(/^SKILL_DIR=.*\n/, 'SKILL_DIR="$LOADED_SKILL_DIR"\n');
  const res = spawnSync("bash", ["-c", snippet + '\necho "RESULT=$SKILLS_REPO"'], {
    encoding: "utf8",
    env: { ...process.env, HOME: home, LOADED_SKILL_DIR: skillDir },
  });
  assert.equal(res.status, 0, res.stderr);
  return (res.stdout.match(/RESULT=(.*)/) ?? [])[1];
}

test("the locator is identical in all four skills apart from the skill name", () => {
  const kickoff = extractLocator("skills/kickoff/judge.md");
  const planReview = extractLocator("skills/plan-review/SKILL.md").replaceAll("plan-review", "kickoff");
  const specReview = extractLocator("skills/spec-review/SKILL.md").replaceAll("spec-review", "kickoff");
  const review = extractLocator("skills/review/SKILL.md").replaceAll("loaded review skill", "loaded kickoff skill");
  assert.equal(planReview, kickoff);
  assert.equal(specReview, kickoff);
  assert.equal(review, kickoff);
});

test("judge.md carries the locator twice: the informational block and the real one", () => {
  const body = readFileSync(path.join(REPO_ROOT, "skills/kickoff/judge.md"), "utf8");
  assert.equal(body.split('SKILL_DIR="<').length - 1, 2);
});

test("the loaded skill determines the version even when another session owns the global pointer", () => {
  const home = tmp("home-");
  const root = fakeDistro();
  mkdirSync(path.join(home, ".verus-skills"), { recursive: true });
  const other = fakeDistro();
  writeFileSync(path.join(home, ".verus-skills", "root"), other + "\n");
  assert.equal(runLocator(extractLocator("skills/kickoff/judge.md"), home, path.join(root, "skills", "kickoff")), root);
});

test("both sessions keep their own version across pointer rewrites", () => {
  const home = tmp("home-");
  const roots = [fakeDistro(), fakeDistro()];
  mkdirSync(path.join(home, ".verus-skills"), { recursive: true });
  for (const writer of roots) {
    writeFileSync(path.join(home, ".verus-skills", "root"), writer + "\n");
    for (const loaded of roots) {
      assert.equal(runLocator(extractLocator("skills/kickoff/judge.md"), home, path.join(loaded, "skills", "kickoff")), loaded);
    }
  }
});

test("a loaded skill symlink resolves to its checkout, independently of cwd", () => {
  const home = tmp("home-");
  const root = fakeDistro();
  mkdirSync(path.join(home, ".verus-skills"), { recursive: true });
  writeFileSync(path.join(home, ".verus-skills", "root"), "/nope/nowhere\n");
  mkdirSync(path.join(home, ".claude", "skills"), { recursive: true });
  symlinkSync(path.join(root, "skills", "kickoff"), path.join(home, ".claude", "skills", "kickoff"));
  assert.equal(runLocator(extractLocator("skills/kickoff/judge.md"), home, path.join(home, ".claude", "skills", "kickoff")), root);
});

test("a missing loaded version fails instead of silently switching to another install", () => {
  const home = tmp("home-");
  const other = fakeDistro();
  mkdirSync(path.join(home, ".verus-skills"), { recursive: true });
  writeFileSync(path.join(home, ".verus-skills", "root"), other + "\n");
  const snippet = extractLocator("skills/kickoff/judge.md").replace(/^SKILL_DIR=.*\n/, 'SKILL_DIR="$LOADED_SKILL_DIR"\n');
  const r = spawnSync("bash", ["-c", snippet], { encoding: "utf8", env: { ...process.env, HOME: home, LOADED_SKILL_DIR: "/no/such/skill" } });
  assert.equal(r.status, 2);
  assert.match(r.stderr, /distro root not found/);
});
