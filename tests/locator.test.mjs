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

// The locator is the run of lines from `SKILLS_REPO=""` to the `done` that closes the loop.
function extractLocator(relPath) {
  const body = readFileSync(path.join(REPO_ROOT, relPath), "utf8");
  const m = body.match(/SKILLS_REPO=""\n(?:.*\n)*?done\n/);
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

function runLocator(snippet, home) {
  const res = spawnSync("bash", ["-c", snippet + '\necho "RESULT=$SKILLS_REPO"'], {
    encoding: "utf8",
    env: { ...process.env, HOME: home },
  });
  assert.equal(res.status, 0, res.stderr);
  return (res.stdout.match(/RESULT=(.*)/) ?? [])[1];
}

test("the locator is identical in all four skills apart from the skill name", () => {
  const kickoff = extractLocator("skills/kickoff/judge.md");
  const planReview = extractLocator("skills/plan-review/SKILL.md").replaceAll("plan-review", "kickoff");
  const specReview = extractLocator("skills/spec-review/SKILL.md").replaceAll("spec-review", "kickoff");
  const review = extractLocator("skills/review/SKILL.md").replaceAll("/skills/review/", "/skills/kickoff/");
  assert.equal(planReview, kickoff);
  assert.equal(specReview, kickoff);
  assert.equal(review, kickoff);
});

test("judge.md carries the locator twice: the informational block and the real one", () => {
  const body = readFileSync(path.join(REPO_ROOT, "skills/kickoff/judge.md"), "utf8");
  assert.equal(body.split('SKILLS_REPO=""').length - 1, 2);
});

test("the locator resolves the root from the pointer file", () => {
  const home = tmp("home-");
  const root = fakeDistro();
  mkdirSync(path.join(home, ".verus-skills"), { recursive: true });
  writeFileSync(path.join(home, ".verus-skills", "root"), root + "\n");
  assert.equal(runLocator(extractLocator("skills/kickoff/judge.md"), home), root);
});

test("a pointer file naming a deleted checkout is skipped, not used", () => {
  const home = tmp("home-");
  const gone = path.join(tmp("gone-"), "removed-checkout");
  mkdirSync(path.join(home, ".verus-skills"), { recursive: true });
  writeFileSync(path.join(home, ".verus-skills", "root"), gone + "\n");
  assert.equal(runLocator(extractLocator("skills/kickoff/judge.md"), home), "");
});

test("a stale pointer file falls through to the symlinked skill directory", () => {
  const home = tmp("home-");
  const root = fakeDistro();
  mkdirSync(path.join(home, ".verus-skills"), { recursive: true });
  writeFileSync(path.join(home, ".verus-skills", "root"), "/nope/nowhere\n");
  mkdirSync(path.join(home, ".claude", "skills"), { recursive: true });
  symlinkSync(path.join(root, "skills", "kickoff"), path.join(home, ".claude", "skills", "kickoff"));
  assert.equal(runLocator(extractLocator("skills/kickoff/judge.md"), home), root);
});

test("with no pointer file and no symlinks the locator yields an empty root", () => {
  assert.equal(runLocator(extractLocator("skills/kickoff/judge.md"), tmp("home-")), "");
});
