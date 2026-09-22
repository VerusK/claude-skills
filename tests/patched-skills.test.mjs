import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync, statSync } from "node:fs";
import path from "node:path";

const root = new URL("../skills/", import.meta.url).pathname;

function walk(dir) {
  return readdirSync(dir).flatMap((e) => {
    const p = path.join(dir, e);
    return statSync(p).isDirectory() ? walk(p) : [p];
  });
}

test("no superpowers: namespace references remain in skills/", () => {
  const hits = walk(root).filter((f) => /\.md$/.test(f) && /superpowers:/.test(readFileSync(f, "utf8")));
  assert.deepEqual(hits.map((f) => path.relative(root, f)), []);
});

test("no docs/superpowers paths remain in skills/", () => {
  const hits = walk(root).filter((f) => /\.md$/.test(f) && /docs\/superpowers\//.test(readFileSync(f, "utf8")));
  assert.deepEqual(hits.map((f) => path.relative(root, f)), []);
});

test("SDD final review routes to review and every prompt pins opus", () => {
  const sdd = readFileSync(path.join(root, "subagent-driven-development/SKILL.md"), "utf8");
  assert.match(sdd, /Invoke review <MERGE_BASE>/);
  assert.doesNotMatch(sdd, /using-git-worktrees/);
  assert.doesNotMatch(sdd, /executing-plans/);
  assert.doesNotMatch(sdd, /requesting-code-review/);
  assert.doesNotMatch(sdd, /more capable model/);
  assert.match(sdd, /unnamed/);
  for (const f of ["implementer-prompt.md", "task-reviewer-prompt.md", "re-review-prompt.md"]) {
    assert.match(readFileSync(path.join(root, "subagent-driven-development", f), "utf8"), /model: opus/);
  }
});

test("no model-tier escalation advice remains in SDD prompts", () => {
  for (const f of ["implementer-prompt.md", "task-reviewer-prompt.md", "re-review-prompt.md"]) {
    const body = readFileSync(path.join(root, "subagent-driven-development", f), "utf8");
    assert.doesNotMatch(body, /more capable model/);
  }
});

test("writing-plans routes to docs/plans/ and plan-review", () => {
  const wp = readFileSync(path.join(root, "writing-plans/SKILL.md"), "utf8");
  assert.match(wp, /docs\/plans\//);
  assert.match(wp, /plan-review/);
});

const HANDOFFS = [
  ["kickoff/SKILL.md", "writing-plans"],
  ["kickoff/SKILL.md", "test-driven-development"],
  ["writing-plans/SKILL.md", "plan-review"],
  ["writing-plans/SKILL.md", "subagent-driven-development"],
  ["plan-review/SKILL.md", "subagent-driven-development"],
  ["subagent-driven-development/SKILL.md", "review"],
  ["subagent-driven-development/SKILL.md", "finishing-a-development-branch"],
  ["review/SKILL.md", "finishing-a-development-branch"],
];

test("every hand-off names the plugin form of the target skill", () => {
  for (const [file, target] of HANDOFFS) {
    const body = readFileSync(path.join(root, file), "utf8");
    assert.match(
      body,
      new RegExp("`" + target + "` \\(`verus-skills:" + target + "` when installed as a plugin\\)"),
      `${file} does not name verus-skills:${target}`,
    );
  }
});

test("USING.md states how skills are addressed before it lists any of them", () => {
  const using = readFileSync(new URL("../USING.md", import.meta.url), "utf8");
  assert.match(using, /verus-skills:<name>/);
  assert.ok(
    using.indexOf("verus-skills:<name>") < using.indexOf("## The flow"),
    "the addressing rule must come before the skill lists",
  );
});

test("SDD names the plugin form in both finishing-a-development-branch hand-offs", () => {
  const sdd = readFileSync(path.join(root, "subagent-driven-development/SKILL.md"), "utf8");
  const hits = sdd.match(/`finishing-a-development-branch` \(`verus-skills:finishing-a-development-branch` when installed as a plugin\)/g) ?? [];
  assert.ok(hits.length >= 2, `expected the plugin form at both hand-offs, found ${hits.length}`);
});
