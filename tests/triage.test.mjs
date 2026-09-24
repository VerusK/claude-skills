import { test, after } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

const skills = new URL("../skills/", import.meta.url).pathname;
const read = (f) => readFileSync(path.join(skills, f), "utf8");
const TEMP = [];
after(() => { for (const d of TEMP) rmSync(d, { recursive: true, force: true }); });

function reviewGrepPattern() {
  const m = read("review/SKILL.md").match(/grep -iE '([^']+)' "\$LEDGER"/);
  assert.ok(m, "review's ledger collection must be a case-insensitive grep -iE on $LEDGER");
  return m[1];
}

test("review's ledger pattern catches the line SDD tells the controller to write", () => {
  const sdd = read("subagent-driven-development/SKILL.md");
  const t = sdd.match(/`Task <N>: ([^`:]+): <one-liner>`/);
  assert.ok(t, "SDD ledger template not found");
  const sample = `Task 3: ${t[1]}: something small`;
  assert.ok(new RegExp(reviewGrepPattern(), "i").test(sample), `pattern misses: ${sample}`);
});

test("the collection block prints deferred minors, rulings and parked lines", () => {
  const dir = realpathSync(mkdtempSync(path.join(tmpdir(), "ledger-")));
  TEMP.push(dir);
  const ledger = path.join(dir, "progress.md");
  writeFileSync(ledger, [
    "# SDD ledger — plan: docs/plans/x.md",
    "Task 1: minor (deferred): a small thing",
    "- Ruling: kept X — because Y — cost Z",
    "Task 2: parked — finding — Ruling: why",
    "Task 3: complete (commits a..b, review clean)",
  ].join("\n") + "\n");
  const r = spawnSync("grep", ["-iE", reviewGrepPattern(), ledger], { encoding: "utf8" });
  assert.equal(r.stdout.trim().split("\n").length, 3, r.stdout);
});

test("review, plan-review and spec-review triage asks how to fix, not whether to accept", () => {
  for (const f of ["review/SKILL.md", "plan-review/SKILL.md", "spec-review/SKILL.md"]) {
    const body = read(f);
    const s3 = body.slice(body.indexOf("## 3. Triage findings"), body.indexOf("## 4."));
    assert.match(s3, /How should .* be fixed\?/, f);
    assert.match(s3, /2–4 concrete ways to fix it/, f);
    assert.match(s3, /accepted without the judge: <finding one-liner> — <the evidence/, f);
    assert.match(s3, /"leave it as is" option is allowed only when its `description` states the strongest argument/, f);
    assert.doesNotMatch(s3, /Fix as proposed|Accept: revise the plan as the reviewer proposes|Reject: the finding is wrong/, f);
  }
});

test("section 4 applies every chosen action whatever its option letter, and every finding accepted without the judge", () => {
  for (const f of ["review/SKILL.md", "plan-review/SKILL.md", "spec-review/SKILL.md"]) {
    const body = read(f);
    const s4 = body.slice(body.indexOf("## 4."), body.indexOf("## 5."));
    assert.match(s4, /the chosen action of every judged finding, whatever its option letter and whether the judge accepted it or the user chose it/, f);
    assert.match(s4, /every finding accepted without the judge/, f);
    assert.match(s4, /A "leave it as is" choice is recorded with the decisions but changes nothing/, f);
    assert.doesNotMatch(s4, /accepted `A`\/`B`|Collect every accepted finding|print the accepted findings|"Rejected: <finding> — <reason>"/, f);
  }
});

test("judge.md forbids padding a question with an unargued option", () => {
  const rules = read("kickoff/judge.md").split("## Rules")[1] ?? "";
  assert.match(rules, /reasonable engineer could pick/);
  assert.match(rules, /only one real option is not judge-able/);
});
