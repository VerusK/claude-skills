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

test("SDD final review routes to branch-review and every prompt pins opus", () => {
  const sdd = readFileSync(path.join(root, "subagent-driven-development/SKILL.md"), "utf8");
  assert.match(sdd, /branch-review/);
  assert.doesNotMatch(sdd, /using-git-worktrees/);
  assert.match(sdd, /unnamed/);
  for (const f of ["implementer-prompt.md", "task-reviewer-prompt.md", "re-review-prompt.md"]) {
    assert.match(readFileSync(path.join(root, "subagent-driven-development", f), "utf8"), /model: opus/);
  }
});
