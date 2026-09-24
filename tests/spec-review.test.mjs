import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const read = (rel) => readFileSync(path.join(ROOT, rel), "utf8");
// Text from the heading `from` up to the next `to` (or the end).
const section = (body, from, to) => {
  const i = body.indexOf(from);
  assert.ok(i >= 0, `missing heading: ${from}`);
  const j = to ? body.indexOf(to, i + from.length) : -1;
  return body.slice(i, j < 0 ? body.length : j);
};
const SKILL = "skills/spec-review/SKILL.md";

test("spec-review has frontmatter with name and an argument hint", () => {
  const body = read(SKILL);
  assert.match(body, /^---\nname: spec-review\ndescription: .{40,}\nargument-hint: "<path to spec \.md>"\n---\n/);
});

test("§0 stops when there is no spec and puts the report beside the spec", () => {
  const s0 = section(read(SKILL), "## 0. Inputs", "## 1.");
  assert.match(s0, /ls -t docs\/specs\/\*-design\.md 2>\/dev\/null \| head -1/);
  assert.match(s0, /Stop with a message if none/);
  assert.match(s0, /<directory of SPEC>\/<spec basename without \.md>\.review\.md/);
});

test("§0 normalizes an absolute or relative spec path to a repo-relative one", () => {
  const s0 = section(read(SKILL), "## 0. Inputs", "## 1.");
  assert.match(s0, /SPEC_ABS="\$\(realpath "\$ARG"\)"/);
  assert.doesNotMatch(s0, /pwd -P\)\/\$\(basename/, "resolving only the parent lets a symlink escape the repo");
  assert.match(s0, /TOP="\$\(git -C "\$\(dirname "\$SPEC_ABS"\)" rev-parse --show-toplevel 2>\/dev\/null\)"/);
  assert.match(s0, /SPEC="\$\{SPEC_ABS#"\$TOP"\/\}"/);
  for (const msg of ["spec not found", "spec is not inside a git repository", "spec is outside the repository"]) {
    assert.ok(s0.includes(msg), msg);
  }
});

test("§1 fences the spec and ends with the report line", () => {
  const s1 = section(read(SKILL), "## 1. Build the prompt", "## 2.");
  assert.match(s1, /`THE SPEC:` followed by the spec file verbatim inside a fence longer than any backtick run in the spec/);
  assert.match(s1, /unless the spec contains a run of seven or more, then go longer still/);
  assert.match(s1, /\[ "\$\(tail -1 "\$PROMPT"\)" = "Write the report to \$REPORT" \] \|\| echo "prompt malformed"/);
  assert.match(s1, /Review the whole revised spec: report every finding from the previous report that is still present, mark fixed ones as resolved, and report new findings the spec changes introduced\./);
  assert.doesNotMatch(s1, /Only report findings that are still present/);
});

test("§2 launches the reviewer as spec-review with a 15-minute timeout", () => {
  const s2 = section(read(SKILL), "## 2. Launch the external reviewer", "## 3.");
  assert.match(s2, /--title spec-review --timeout-min 15 --session-file "\$SESSION"/);
});

test("§3 sends findings against user decisions to the user, before any other triage", () => {
  const s3 = section(read(SKILL), "## 3. Triage findings", "## 4.");
  assert.match(s3, /marked `user`, or its fix would change what such a decision settled: do not call the judge/);
  assert.match(s3, /A finding against an `auto` decision is triaged like any other finding/);
  assert.ok(s3.indexOf("marked `user`") < s3.indexOf("**One reasonable fix**"), "the user-decision rule comes first");
});

test("§4 appends Spec review decisions and leaves the Decisions section alone", () => {
  const s4 = section(read(SKILL), "## 4. Revise the spec", "## 5.");
  assert.match(s4, /## Spec review decisions \(round N\)/);
  assert.match(s4, /Do not edit the spec's Decisions section/);
  assert.match(s4, /If the report has no confidence-7\+ finding \(`None` under `## Findings \(confidence 7\+\)`\), skip this section: append nothing and commit nothing/);
  assert.match(s4, /git add -- "\$SPEC" && git commit -m "docs\(spec\): apply spec-review round N" -- "\$SPEC"/);
  assert.doesNotMatch(read(SKILL), /git commit -am/, "a spec-review commit must never sweep in unrelated tracked changes");
});

test("§5 keeps the round-1 report before relaunching", () => {
  const s5 = section(read(SKILL), "## 5. Second round", "## 6.");
  assert.match(s5, /Skip round 2 if the round-1 report has no P0\/P1 at confidence 7\+/);
  assert.match(s5, /copy the round-1 report to `<REPORT>\.round1\.md` first/);
});

test("§6 waits for explicit approval before writing-plans", () => {
  const s6 = section(read(SKILL), "## 6. Hand off", "## Rules");
  const wait = s6.indexOf("Wait for the user's explicit approval");
  const invoke = s6.indexOf("invoke `writing-plans` (`verus-skills:writing-plans` when installed as a plugin)");
  assert.ok(wait >= 0 && invoke > wait, "approval must come before the writing-plans hand-off");
  assert.match(s6, /Invoke nothing else/);
  assert.match(s6, /if the changes touch Goal, Non-goals, Design or Decisions and round 2 has not run, run round 2 on the edited spec/);
  assert.match(s6, /naming the edits no reviewer saw/);
  assert.doesNotMatch(s6, /do not re-run the reviewer/);
});

test("the verus-reviewer agent lists spec-review among its callers", () => {
  assert.match(read("agents/verus-reviewer.md"), /writing-plans, spec-review, plan-review or review/);
});
