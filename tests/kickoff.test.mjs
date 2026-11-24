import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const kickoff = readFileSync(new URL("../skills/kickoff/SKILL.md", import.meta.url), "utf8");

function section(heading) {
  const start = kickoff.indexOf(`## ${heading}`);
  assert.notEqual(start, -1, `missing section ${heading}`);
  const next = kickoff.indexOf("\n## ", start + 1);
  return kickoff.slice(start, next === -1 ? undefined : next);
}

test("the worth-doing filter sits after context exploration and before the decision tree", () => {
  const order = ["## 2. Explore context", "## 2b. Is it worth doing?", "## 3. The decision tree"].map((h) => kickoff.indexOf(h));
  assert.ok(order.every((i) => i >= 0), "all three headings exist");
  assert.deepEqual([...order].sort((a, b) => a - b), order);
});

test("the filter asks the three questions and passes on a single yes", () => {
  const s = section("2b. Is it worth doing?");
  assert.match(s, /Real pain or risk/);
  assert.match(s, /Holds other work/);
  assert.match(s, /No cheap 80%/);
  assert.match(s, /at least one "yes"/);
});

test("with no yes the agent proposes the minimal option or not doing it, and the owner decides", () => {
  const s = section("2b. Is it worth doing?");
  assert.match(s, /cheapest option/);
  assert.match(s, /not doing it/);
  assert.match(s, /owner question/);
});

test("the agent answers from facts and asks the user only when no fact can be found", () => {
  const s = section("2b. Is it worth doing?");
  assert.match(s, /from facts you found/);
  assert.match(s, /ask the user only about a fact no file, command or tool can give you/);
});

test("it covers architectural and bounded-over-a-day work, not spikes", () => {
  const s = section("2b. Is it worth doing?");
  assert.match(s, /architectural, and bounded work bigger than about a day/);
  assert.match(s, /A spike skips this section/);
});

test("the answers are recorded in the spec and in the bounded chat design", () => {
  assert.match(kickoff, /Goal, \*\*Worth doing\*\*/);
  assert.match(kickoff, /worth-doing answers when the task is bigger than about a day/);
});

test("the existing kickoff structure is intact", () => {
  for (const h of ["## 1. Classify", "## 3. The decision tree", "## 4. Paths", "## 5. Reporting decisions", "## Red flags"]) {
    assert.ok(kickoff.includes(h), h);
  }
  assert.match(kickoff, /<HARD-GATE>/);
});
