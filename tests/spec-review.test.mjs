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

const REVIEWER = "skills/spec-review/reviewer.md";
const SECTIONS = [
  "## 0. Scope challenge",
  "## 1. Requirements",
  "## 2. Scope",
  "## 3. Feasibility and failure modes",
  "## 4. Testability",
  "## 5. Decisions",
];

test("reviewer.md evaluates sections 0-5 in order and reports each one", () => {
  const body = read(REVIEWER);
  let at = -1;
  for (const h of SECTIONS) {
    const i = body.indexOf(`\n${h}\n`);
    assert.ok(i > at, `${h} missing or out of order`);
    at = i;
  }
  for (const h of ["### 0. Scope challenge", "### 1. Requirements", "### 2. Scope", "### 3. Feasibility", "### 4. Testability", "### 5. Decisions"]) {
    assert.ok(body.includes(`\n${h}\n`), `report template lacks ${h}`);
  }
  assert.match(body, /\n# Spec review: <spec title>\n## Verdict\n/);
});

test("the scope challenge is gstack's Step 0, made non-interactive", () => {
  const s0 = section(read(REVIEWER), "## 0. Scope challenge", "## 1. Requirements");
  for (const re of [/existing code already partially or fully solves/, /minimum set of changes/, /8\+ files or introduces 2\+ new services or classes/, /built-in/, /Completeness/, /Distribution/]) {
    assert.match(s0, re);
  }
  assert.match(s0, /do not search the web/);
  assert.match(s0, /Do not stop to ask questions/);
});

test("decision findings name the decision and its marker", () => {
  const s5 = section(read(REVIEWER), "## 5. Decisions", "## Confidence calibration");
  assert.match(s5, /`Decisions: 7\. Where the report lives \(auto\)`/);
  assert.match(read(REVIEWER), /Any finding, in any section, whose fix would change a recorded decision names that decision the same way/);
});

test("reviewer.md handles a spec with no Decisions section", () => {
  const s5 = section(read(REVIEWER), "## 5. Decisions", "## Confidence calibration");
  assert.match(s5, /If the spec has no Decisions section, write "No Decisions section" under 5 and raise no findings here/);
});

test("the reviewer never edits the spec", () => {
  assert.match(read(REVIEWER), /Do not edit the spec or any other file\. Do not run tests or builds\./);
});

test("NOTICE credits gstack for the spec-review prompt", () => {
  assert.match(read("NOTICE"), /adapted into plan-review\/reviewer\.md and, with its Step 0 scope challenge, into\s+spec-review\/reviewer\.md/);
});

test("kickoff's architectural path hands the committed spec to spec-review, not to writing-plans", () => {
  const arch = section(read("skills/kickoff/SKILL.md"), "**Architectural:**", "## 5. Reporting decisions");
  const commit = arch.indexOf("5. Commit the spec.");
  const invoke = arch.indexOf("Invoke `spec-review` (`verus-skills:spec-review` when installed as a plugin) with the spec path");
  assert.ok(commit >= 0 && invoke > commit, "spec-review must follow the commit");
  assert.doesNotMatch(arch, /On approval invoke `writing-plans`/);
  assert.doesNotMatch(arch, /Review it; when approved I will write the plan/);
});

test("kickoff's bounded path still goes straight to test-driven-development", () => {
  const bounded = section(read("skills/kickoff/SKILL.md"), "**Bounded:**", "**Architectural:**");
  assert.match(bounded, /hand off to `test-driven-development`/);
  assert.doesNotMatch(bounded, /spec-review/);
});

const DESCRIPTION = "Personal skills distro: kickoff to spec, external spec review, plan, external plan review, subagent execution, branch review, finish — with multiple-choice decisions judged by TypeSafe.";

test("USING.md puts spec-review between kickoff and writing-plans and forbids skipping it", () => {
  const flow = section(read("USING.md"), "## The flow", "## Outside the flow");
  const at = (s) => flow.indexOf(s);
  assert.ok(at("1. `kickoff`") >= 0 && at("1. `kickoff`") < at("2. `spec-review`") && at("2. `spec-review`") < at("3. `writing-plans`"), flow);
  assert.match(flow, /4\. `plan-review`[\s\S]*5\. `subagent-driven-development`[\s\S]*6\. `review`[\s\S]*7\. `finishing-a-development-branch`/);
  assert.match(flow, /Never skip `spec-review`, `plan-review` or `review`\./);
});

test("README shows spec-review in the flow and the skills table", () => {
  const readme = read("README.md");
  assert.match(readme, /K\[kickoff<br\/>interview \+ spec\] --> SR\[spec-review<br\/>Codex\]\n  SR --> W\[writing-plans\]/);
  assert.match(readme, /  SR -\. findings \.-> J/);
  assert.match(readme, /^kickoff → spec-review → writing-plans → plan-review → subagent-driven-development → review → finishing-a-development-branch$/m);
  assert.match(readme, /^\| 2 \| `spec-review` \|/m);
  assert.match(readme, /^\| 7 \| `finishing-a-development-branch` \|/m);
  assert.match(readme, /^\| `spec-review` \| own \|/m);
  assert.match(readme, /same eleven skills/);
  assert.match(readme, /Specs, plans and branches are reviewed by Codex/);
  assert.match(readme, /the fallback external reviewer of spec-review, plan-review and review\)/);
  assert.doesNotMatch(readme, /same ten skills/);
});

test("NOTICE lists spec-review among the own skills", () => {
  assert.match(read("NOTICE"), /kickoff, spec-review, plan-review and review are this repository's own skills/);
});

test("the plugin and marketplace descriptions mention the spec review", () => {
  assert.equal(JSON.parse(read(".claude-plugin/plugin.json")).description, DESCRIPTION);
  assert.equal(JSON.parse(read(".codex-plugin/plugin.json")).description, DESCRIPTION);
  assert.equal(JSON.parse(read(".claude-plugin/marketplace.json")).plugins[0].description, DESCRIPTION);
});
