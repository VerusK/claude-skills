# spec-review Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use `subagent-driven-development` (`verus-skills:subagent-driven-development` when installed as a plugin) to implement this plan task-by-task; the plan must have passed plan-review before execution. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a `spec-review` skill that sends the kickoff spec to an external Codex review before the user approves it, triages findings through the TypeSafe judge (findings against the user's own decisions go to the user), revises the spec, and owns the approval gate and the hand-off to `writing-plans`.

**Architecture:** `spec-review` is a sibling of `plan-review`: the same launcher (`scripts/reviewer.sh`), the same judge protocol (`skills/kickoff/judge.md`), the same triage rules and round structure, with its own design-document reviewer prompt whose section 0 is gstack's Step 0 scope challenge made non-interactive. `kickoff`'s architectural path commits the spec and invokes `spec-review` instead of asking for approval itself. Everything is Markdown skill text guarded by string-contract tests on `node:test`; no script changes.

**Tech Stack:** Markdown skills, Node.js `node:test` contract tests, bash launcher `scripts/reviewer.sh` (unchanged).

**Spec:** `docs/specs/2026-09-24-spec-review-design.md`

## Global Constraints

- Hand-offs between skills name both the bare and the `verus-skills:` form: `` `<skill>` (`verus-skills:<skill>` when installed as a plugin) ``.
- Every subagent dispatch site uses exactly these two lines (tests compare them byte for byte): ``Claude Code: `subagent_type` = `verus-reviewer` (`verus-skills:verus-reviewer` when installed as a plugin), unnamed, in the background, no `model` parameter.`` and `In a Codex session: dispatch the same prompt with spawn_agent, unnamed, in the background; pass no model.` No `general-purpose`, no `model: opus`, no line starting with `name:` outside frontmatter.
- The locator block in a skill is byte-identical to `skills/kickoff/judge.md`'s apart from the skill name.
- Every reviewer prompt ends its report template with `<!-- end of review -->` and contains ``End the report with this exact last line: `<!-- end of review -->` ``.
- Do not change `skills/plan-review/`, `skills/review/`, `skills/writing-plans/`, `scripts/`, versions in `package.json` or the plugin manifests.
- Skill text is English; the spec and plan are Russian/English as written.
- Run `npm test` before every commit (the full suite takes about six and a half minutes — 256 tests on main: run it with a 10-minute timeout or in the background; single files with `node --test tests/<file>.test.mjs`).
- Commit messages end with a blank line and `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`.

## Review Focus

- No spec in `docs/specs/` and no argument → the skill stops with a message and never launches a reviewer (Task 1, test `§0 stops when there is no spec`).
- A finding located in the Design section whose fix would overturn a `user` decision → still goes to the user, not the judge (Task 1, test `§3 sends findings against user decisions to the user`).
- The user answers the approval question with changes instead of "yes" → no `writing-plans` until an explicit approval (Task 1, test `§6 waits for explicit approval before writing-plans`).
- An old spec with no Decisions section (e.g. `docs/superpowers/specs/…`) reviewed standalone → section 5 says so instead of inventing decisions (Task 2, test `reviewer.md handles a spec with no Decisions section`).
- A spec containing a run of seven backticks → the prompt fence is longer than that run (Task 1, test `§1 fences the spec and ends with the report line`).

---

### Task 1: `spec-review` skill orchestration

**Files:**
- Create: `skills/spec-review/SKILL.md`
- Create: `tests/spec-review.test.mjs`
- Modify: `tests/plugin.test.mjs:11-24` (skill list, test title)
- Modify: `tests/patched-skills.test.mjs` (`HANDOFFS`, `DISPATCH_SITES`, site count, session test)
- Modify: `tests/triage.test.mjs:42-64` (two loops)
- Modify: `tests/locator.test.mjs:47-53`
- Modify: `agents/verus-reviewer.md:8`

**Interfaces:**
- Consumes: `scripts/reviewer.sh` flags `--prompt-file --output --title --timeout-min --session-file --close-session`; `skills/kickoff/judge.md`.
- Produces: skill `spec-review` at `skills/spec-review/SKILL.md` reading `reviewer.md` from its own directory (Task 2 creates it); REPORT = `<spec dir>/<spec basename>.review.md`; SESSION file `.context/spec-review-<round-1 report basename>-session`; section headings `## 0. Inputs` … `## 6. Hand off`, `## Rules`; the spec section `## Spec review decisions (round N)`; hand-off `` `writing-plans` (`verus-skills:writing-plans` when installed as a plugin) ``. `tests/spec-review.test.mjs` exports nothing; later tasks append tests to it using its `read` and `section` helpers.

- [ ] **Step 1: Write the failing tests**

Create `tests/spec-review.test.mjs`:

```js
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

test("§1 fences the spec and ends with the report line", () => {
  const s1 = section(read(SKILL), "## 1. Build the prompt", "## 2.");
  assert.match(s1, /`THE SPEC:` followed by the spec file verbatim inside a fence longer than any backtick run in the spec/);
  assert.match(s1, /unless the spec contains a run of seven or more, then go longer still/);
  assert.match(s1, /\[ "\$\(tail -1 "\$PROMPT"\)" = "Write the report to \$REPORT" \] \|\| echo "prompt malformed"/);
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
  assert.match(s4, /git commit -am "docs\(spec\): apply spec-review round N"/);
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
});

test("the verus-reviewer agent lists spec-review among its callers", () => {
  assert.match(read("agents/verus-reviewer.md"), /writing-plans, spec-review, plan-review or review/);
});
```

In `tests/plugin.test.mjs`, replace the `SKILLS` array and the first test title:

```js
const SKILLS = [
  "finishing-a-development-branch",
  "kickoff",
  "plan-review",
  "review",
  "spec-review",
  "subagent-driven-development",
  "systematic-debugging",
  "test-driven-development",
  "typesafe-ai",
  "verification-before-completion",
  "writing-plans",
];

test("skills/ holds exactly the eleven skills, each with a SKILL.md", () => {
```

In `tests/patched-skills.test.mjs`:

- In `HANDOFFS`, add after `["plan-review/SKILL.md", "subagent-driven-development"],`:
  ```js
  ["spec-review/SKILL.md", "writing-plans"],
  ```
- In `DISPATCH_SITES`, add after `"plan-review/SKILL.md": ["reviewer"],`:
  ```js
  "spec-review/SKILL.md": ["reviewer"],
  ```
- Change `assert.equal(sites, 8);` to `assert.equal(sites, 9);`.
- Rename `test("plan-review and review keep one reviewer session per review", () => {` to `test("every external review keeps one reviewer session per review", () => {` and add to `SESSION_RE` after the `plan-review` entry:
  ```js
  "spec-review/SKILL.md": /SESSION="\$\(git rev-parse --show-toplevel\)\/\.context\/spec-review-\$\(basename "\$ROUND1_REPORT" \.md\)-session"/,
  ```

In `tests/triage.test.mjs`, in both tests that loop over `["review/SKILL.md", "plan-review/SKILL.md"]`, change the array to `["review/SKILL.md", "plan-review/SKILL.md", "spec-review/SKILL.md"]` and rename the first test to `"review, plan-review and spec-review triage asks how to fix, not whether to accept"`.

In `tests/locator.test.mjs`, replace the first test with:

```js
test("the locator is identical in all four skills apart from the skill name", () => {
  const kickoff = extractLocator("skills/kickoff/judge.md");
  const planReview = extractLocator("skills/plan-review/SKILL.md").replaceAll("plan-review", "kickoff");
  const specReview = extractLocator("skills/spec-review/SKILL.md").replaceAll("spec-review", "kickoff");
  const review = extractLocator("skills/review/SKILL.md").replaceAll("/skills/review/", "/skills/kickoff/");
  assert.equal(planReview, kickoff);
  assert.equal(specReview, kickoff);
  assert.equal(review, kickoff);
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `node --test tests/spec-review.test.mjs tests/plugin.test.mjs tests/patched-skills.test.mjs tests/triage.test.mjs tests/locator.test.mjs`
Expected: FAIL — `ENOENT ... skills/spec-review/SKILL.md` in the new and modified tests, and the skill-list test fails because `skills/spec-review` does not exist.

- [ ] **Step 3: Write `skills/spec-review/SKILL.md`**

`````markdown
---
name: spec-review
description: External review of a design spec before the user approves it. Launches Codex (via Orca, then codex exec, then a fallback reviewer agent), routes confidence-7+ findings through the TypeSafe judge (findings against the user's own decisions go to the user), revises the spec, runs at most one re-review round, then asks the user to approve the spec and hands off to writing-plans. Use after kickoff writes a spec, or when asked to "review the spec".
argument-hint: "<path to spec .md>"
---

# Spec Review

**Announce at start:** "Using spec-review on `<spec path>`."

## 0. Inputs

- `SPEC`: the argument, or the newest spec by modification time — `ls -t docs/specs/*-design.md 2>/dev/null | head -1`; print which file was chosen. Stop with a message if none; do not launch a reviewer.
- `REPORT`: `<directory of SPEC>/<spec basename without .md>.review.md` — beside the spec, always repo-relative; `reviewer.sh` rejects an absolute path. It is relative to the repo `reviewer.sh` works in, so run from the repo containing `SPEC`, or pass `--repo <that repo>` to `reviewer.sh`.
- `ROUND`: 1.
- Locate the repo and the judge protocol: read `judge.md` from the `kickoff` skill directory (same repo, `skills/kickoff/judge.md`; locate the repo with the snippet in that file, replacing `kickoff` with `spec-review`). Every fenced block below is one shell call, so a block that uses `$SKILLS_REPO` must run the locator itself.

## 1. Build the prompt

Create a temp file outside the repo (under `$TMPDIR`) containing, in order:

1. The full text of `reviewer.md` from this skill's directory.
2. `THE SPEC:` followed by the spec file verbatim inside a fence longer than any backtick run in the spec — use seven backticks unless the spec contains a run of seven or more, then go longer still.
3. `Referenced source files:` followed by the repo-relative paths mentioned in the spec that are real files: grep the spec for path-like tokens containing `/`, keep those that pass `test -f`, drop anything under `.claude/`, `.codex/`, `agents/` or `node_modules/`, deduplicate and sort, and keep at most 40 entries.
4. On round 2 only: `Previous report:` followed by the previous report verbatim (from `<REPORT>.round1.md`), then `Only report findings that are still present after the spec changes; mark fixed ones as resolved.`
5. `Write the report to <REPORT>` on its own line — the last line of the file, in round 1 and round 2 alike. Self-check before launching: `[ "$(tail -1 "$PROMPT")" = "Write the report to $REPORT" ] || echo "prompt malformed"`. If it prints `prompt malformed`, rebuild the prompt in this order and re-check; do not launch the reviewer.

Say nothing about models or reasoning effort in the prompt — the launcher pins those.

## 2. Launch the external reviewer

Substitute the real values for the four placeholders before running:

```bash
SKILLS_REPO=""
for c in "$(cat "$HOME/.verus-skills/root" 2>/dev/null)" \
         "$HOME/.claude/skills/spec-review/../.." \
         "$HOME/.codex/skills/spec-review/../.."; do
  [ -n "$c" ] && [ -f "$c/scripts/typesafe-judge.mjs" ] && SKILLS_REPO="$(cd -P "$c" && pwd -P)" && break
done
[ -f "$SKILLS_REPO/scripts/reviewer.sh" ] || echo "reviewer not found: SKILLS_REPO=$SKILLS_REPO"

PROMPT="<the temp prompt file from section 1>"
REPORT="<REPORT, repo-relative>"
ROUND="<1 or 2>"
ROUND1_REPORT="<the round-1 REPORT; in round 2 the same value as in round 1>"
SESSION="$(git rev-parse --show-toplevel)/.context/spec-review-$(basename "$ROUND1_REPORT" .md)-session"
echo "SESSION=$SESSION"
# Round 1 starts fresh: close an orphan left by an interrupted earlier review of this spec.
[ "$ROUND" = 1 ] && bash "$SKILLS_REPO/scripts/reviewer.sh" --close-session "$SESSION"
bash "$SKILLS_REPO/scripts/reviewer.sh" --prompt-file "$PROMPT" --output "$REPORT" --title spec-review --timeout-min 15 --session-file "$SESSION"
echo "reviewer_exit=$?"
```

- `0`: report is at `REPORT`; note which path ran (`reviewer: orca` / `reviewer: codex-exec`).
- `3`: dispatch the fallback reviewer with the same prompt file content as its prompt and the instruction to write `REPORT`, and wait for it. Claude Code: `subagent_type` = `verus-reviewer` (`verus-skills:verus-reviewer` when installed as a plugin), unnamed, in the background, no `model` parameter. In a Codex session: dispatch the same prompt with spawn_agent, unnamed, in the background; pass no model. On a host with no subagent tool at all, do not stop: perform the review yourself in this session following `reviewer.md` exactly, write `REPORT`, and state in the report header that it was produced by the fallback reviewer, not an independent second voice.
- `1`: fix the invocation; do not proceed. An Orca terminal that could not be closed is left recorded in the session file, and the section-6 close retries it.
- any other exit code (e.g. `127`): the launcher was not found or could not run — treat as `1`: fix the invocation, do not proceed.

## 3. Triage findings

Parse `## Findings (confidence 7+)`. For each finding, in order of severity:

First check whether the finding touches a recorded decision. **A finding against a `user` decision** — it names a question in the spec's Decisions section marked `user`, or its fix would change what such a decision settled: do not call the judge. Ask the user directly: the finding verbatim, the decision it contradicts, 2–4 concrete ways to resolve it (keeping the decision is one of them, with its strongest argument), and your recommendation. A finding against an `auto` decision is triaged like any other finding below.

Then decide whether the finding is a real choice.

**One reasonable fix** — for example a false claim about the repository with an obvious correction, or a contradiction between two sections where one side is plainly the intended one: do not call the judge. Accept it and print, in place of a decision block:

`accepted without the judge: <finding one-liner> — <the evidence: file:line, command output, the spec text on both sides>`

Record that line with the decisions (section 4).

**Otherwise build a judge question about how to fix it:**
- `question`: "How should <the finding, in a few words> be fixed?"
- options: 2–4 concrete ways to fix it, each one a reasonable engineer could pick, each with its concrete consequence in `description`. The reviewer's proposal may be one of them. A "leave it as is" option is allowed only when its `description` states the strongest argument for leaving it; never add a bare "reject". Map each option to the judge's JSON fields: `label` is a short name, `description` the consequence.
- `context`: a structured object — `goal` (the spec's Goal, one sentence), `decisions` (the spec's recorded decisions the finding touches, and findings already triaged in this round), `facts` (the finding verbatim, the relevant spec excerpt, and the repository fact it rests on with file path and short excerpt), `constraints` (the user's rules and the spec's Non-goals), `consequences` (one entry per option id, each naming what concretely happens or breaks — file, behaviour, test — if that option is chosen; equal specificity and length for every id, no comparative or preference language). Facts only — a stranger reading `facts` alone must be able to pick.
- `recommended`: your pick. It is shown to the user and never sent to the judge.

Run the judge exactly as `judge.md` says. Accepted → apply the decision; unaccepted or any non-zero judge exit → ask the user with the decision block. Print every decision block in chat as it happens.

Findings in the Appendix are not acted on; leave them in the report.

## 4. Revise the spec

Apply to `SPEC` directly (edit the affected sections) the chosen action of every judged finding, whatever its option letter and whether the judge accepted it or the user chose it, the user's answer to every finding against a `user` decision, and every finding accepted without the judge. A "leave it as is" choice is recorded with the decisions but changes nothing in the spec. Do not edit the spec's Decisions section: it is the interview record, and a later section supersedes it. Append to the spec a section:

```
## Spec review decisions (round N)
<one decision block per judged finding, the question and the user's answer for each finding against a `user` decision, one "accepted without the judge: …" line per finding decided without it, and a "Left as is: <finding> — <argument>" line for each finding the judge or the user chose to leave>
```

Commit: `git commit -am "docs(spec): apply spec-review round N"`.

## 5. Second round

Skip round 2 if the round-1 report has no P0/P1 at confidence 7+. Otherwise, if `ROUND` is 1 and at least one finding changed the spec: copy the round-1 report to `<REPORT>.round1.md` first (`reviewer.sh` deletes `REPORT` at startup, so the only copy would be lost), then set `ROUND` to 2, rebuild the prompt (section 1, reading the previous report from `<REPORT>.round1.md`), relaunch (section 2; pass the same SESSION as round 1 — in Orca that reuses round 1's terminal, so the reviewer sees its own earlier context), triage and revise again.

Stop after round 2.

## 6. Hand off

First close this review's reviewer session:

```bash
SKILLS_REPO=""
for c in "$(cat "$HOME/.verus-skills/root" 2>/dev/null)" \
         "$HOME/.claude/skills/spec-review/../.." \
         "$HOME/.codex/skills/spec-review/../.."; do
  [ -n "$c" ] && [ -f "$c/scripts/typesafe-judge.mjs" ] && SKILLS_REPO="$(cd -P "$c" && pwd -P)" && break
done
SESSION="<the SESSION printed by section 2>"
bash "$SKILLS_REPO/scripts/reviewer.sh" --close-session "$SESSION"
```

Report to the user: rounds run, reviewer path used, findings accepted/left/asked, path of the final report, and — when round 2 ran — the path of the kept round-1 report (`<REPORT>.round1.md`). Then say: "Spec written and reviewed: `<SPEC>`. Review it; when approved I will write the plan with `writing-plans`."

Wait for the user's explicit approval. If they ask for changes instead, edit the spec, commit it, and ask again; do not re-run the reviewer. On approval invoke `writing-plans` (`verus-skills:writing-plans` when installed as a plugin) with the spec path. Invoke nothing else.

## Rules

- Never start implementation or write the plan from this skill before the user approves the spec.
- Never edit `REPORT`; it is the reviewer's artifact. Decisions go into the spec.
- One re-review round maximum. Residual P2/P3 go to the spec's `Spec review decisions (round N)` section as "deferred".
- Whenever this skill stops — hand-off, a stop after round 1 or 2, a failed launch, a user who does not approve — first run `reviewer.sh --close-session "$SESSION"` (section 6), so review terminals never pile up.
`````

- [ ] **Step 4: Update `agents/verus-reviewer.md`**

Change line 8 from
`You are a reviewer subagent dispatched by a verus-skills skill (subagent-driven-development, writing-plans, plan-review or review).`
to
`You are a reviewer subagent dispatched by a verus-skills skill (subagent-driven-development, writing-plans, spec-review, plan-review or review).`

Do not touch the frontmatter (`make models` owns `model:` and `effort:`).

- [ ] **Step 5: Run the tests to verify they pass**

Run: `node --test tests/spec-review.test.mjs tests/plugin.test.mjs tests/patched-skills.test.mjs tests/triage.test.mjs tests/locator.test.mjs tests/models.test.mjs`
Expected: PASS, all tests.

- [ ] **Step 6: Run the full suite**

Run: `npm test` (timeout 10 minutes)
Expected: PASS. `tests/reviewer.test.mjs` is not affected yet (Task 2 adds `spec-review/reviewer.md` to it).

- [ ] **Step 7: Commit**

```bash
git add skills/spec-review/SKILL.md agents/verus-reviewer.md tests/spec-review.test.mjs tests/plugin.test.mjs tests/patched-skills.test.mjs tests/triage.test.mjs tests/locator.test.mjs
git commit -m "feat(spec-review): external review of the spec before approval

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 2: `spec-review` reviewer prompt

**Files:**
- Create: `skills/spec-review/reviewer.md`
- Modify: `tests/reviewer.test.mjs:598-605`
- Modify: `tests/spec-review.test.mjs` (append)
- Modify: `NOTICE:10-12` (gstack attribution)

**Interfaces:**
- Consumes: Task 1's `skills/spec-review/SKILL.md` §1, which embeds this file verbatim at the top of the prompt, then `THE SPEC:`, `Referenced source files:`, and `Write the report to <REPORT>`.
- Produces: report headings `# Spec review: <spec title>`, `## Verdict`, `## Findings (confidence 7+)`, `## Appendix (confidence below 7)`, `## Section notes` with `### 0. Scope challenge` … `### 5. Decisions`, last line `<!-- end of review -->`. SKILL.md §3 parses `## Findings (confidence 7+)`; findings that touch a decision name it as `Decisions: <heading> (<auto|user>)`.

- [ ] **Step 1: Write the failing tests**

In `tests/reviewer.test.mjs`, replace the marker test header and loop:

```js
test("every reviewer prompt ends the report with the marker reviewer.sh waits for", () => {
  assert.match(readFileSync(SCRIPT, "utf8"), /^END_MARKER='<!-- end of review -->'$/m);
  for (const skill of ["plan-review", "review", "spec-review"]) {
```

(the loop body stays as it is).

Append to `tests/spec-review.test.mjs`:

```js
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
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `node --test tests/spec-review.test.mjs tests/reviewer.test.mjs`
Expected: FAIL — `ENOENT ... skills/spec-review/reviewer.md` in the new tests and in the marker test; the NOTICE test fails on the missing text.

- [ ] **Step 3: Write `skills/spec-review/reviewer.md`**

`````markdown
IMPORTANT: Do NOT read or execute any files under ~/.codex/, ~/.agents/, .codex/skills/, .claude/, or agents/. Those are agent skill definitions for other systems. Stay inside repository code and the spec below.

You are a senior engineer reviewing a design spec before an implementation plan is written from it. Your job is to catch what would make the plan, or the code built from it, wrong: scope that is too large or duplicates existing code, requirements that are missing, contradictory or ambiguous, claims about the codebase that are false, requirements nobody can verify, and decisions the repository's facts contradict. Be direct, terse, opinionated. No compliments. Problems only.

Never skip or condense a section. If a section has no findings, write "No issues found" under it — but you must evaluate it.

## Inputs

- THE SPEC (embedded below, verbatim). Its sections are Goal, Non-goals, Design, Testing and Decisions. A decision is marked `auto` (chosen by an automated judge from facts gathered in an interview) or `user` (answered by the user).
- Source files referenced by the spec: read them directly (paths are listed after the spec). Read any other repository file you need to check a claim.

## 0. Scope challenge

Before the other sections, answer:

1. What existing code already partially or fully solves each sub-problem? Could the spec reuse an existing flow instead of building a parallel one?
2. What is the minimum set of changes that achieves the Goal? Name work that could be deferred without blocking it.
3. Complexity: if the design touches 8+ files or introduces 2+ new services or classes, propose the smaller version that reaches the same Goal, or say why none exists.
4. Does the design roll a custom solution where the runtime, the framework or an existing dependency has a built-in? Answer from your own knowledge; do not search the web.
5. Completeness: does the spec take a shortcut (skipped edge cases, error paths, tests) that saves little when implementation is AI-assisted? Recommend the complete version.
6. Distribution: if the design introduces a new artifact (binary, package, container, workflow, plugin), does it cover build, publish and install? A deferred distribution must be named in Non-goals.

Every problem found here is a finding in the finding format below. Do not stop to ask questions; write the finding and continue.

## 1. Requirements

Evaluate: requirements the Goal implies but the Design omits; contradictions between sections (Goal vs Non-goals, Design vs Testing, Design vs Decisions); requirements that admit two readings — quote the text and give both readings; placeholders (TBD, "handle errors appropriately", unnamed files or values).

## 2. Scope

Evaluate: Non-goals that are missing or contradict the Design; whether the spec is small enough for one implementation plan — if it spans independent subsystems, name the split.

## 3. Feasibility and failure modes

Check every claim the spec makes about existing files, functions, interfaces, commands and behaviour against the repository; a false claim is a finding that cites the file and line contradicting it. For each new integration point or code path the design introduces, describe one realistic production failure and whether the design handles it.

## 4. Testability

For each requirement, check that the Testing section names a way to verify it (a test, a command, a manual check with an expected result). A requirement with no verification is a finding; propose the concrete check (name, input, expected output) in the idioms of the repository's test framework (detect it from package.json, pyproject, go.mod, Makefile).

## 5. Decisions

For each decision marked `auto`, check its chosen option against the repository's facts and the rest of the spec. Flag it when a fact contradicts it or the Design no longer matches it. Flag a decision marked `user` only when a repository fact makes it unworkable. Every finding in this section names the decision by its heading and marker, e.g. `Decisions: 7. Where the report lives (auto)`. If the spec has no Decisions section, write "No Decisions section" under 5 and raise no findings here.

Any finding, in any section, whose fix would change a recorded decision names that decision the same way.

## Confidence calibration

Every finding carries a confidence score (1–10):

| Score | Meaning |
|---|---|
| 9–10 | Verified against specific spec text or code. Concrete failure demonstrated. |
| 7–8 | High-confidence pattern match. Very likely correct. |
| 5–6 | Moderate. Could be a false positive; say what would confirm it. |
| 3–4 | Suspicious but may be fine. Appendix only. |
| 1–2 | Speculation. Report only if severity would be P0. |

Finding format, one per line, most severe first:

`[P0|P1|P2|P3] (confidence: N/10) <spec section or file:line> — <what is wrong> — <what to do instead>`

P0 = the spec cannot be implemented as written or does not reach its Goal. P1 = will cause rework of the plan or the code. P2 = should fix before planning. P3 = nice to have.

## Report

The report path is named on its own line at the end of this prompt. Save the report there, as Markdown, with exactly these headings:

```
# Spec review: <spec title>
## Verdict
<CLEAR | NEEDS CHANGES> — one sentence.
## Findings (confidence 7+)
<lines in finding format, or "None">
## Appendix (confidence below 7)
<lines in finding format, or "None">
## Section notes
### 0. Scope challenge
### 1. Requirements
### 2. Scope
### 3. Feasibility
### 4. Testability
### 5. Decisions
<one short paragraph each, "No issues found" when clean>
<!-- end of review -->
```

End the report with this exact last line: `<!-- end of review -->` — write it once, after everything else. The launcher treats the report as finished only when that line is in the file, so a report without it is discarded.

Do not edit the spec or any other file. Do not run tests or builds. Do not print the report to stdout; write the file and stop.
`````

- [ ] **Step 4: Update `NOTICE`**

Replace

```
- garrytan/gstack (Garry Tan) — the plan-eng-review methodology (plan-eng-review/SKILL.md.tmpl,
  tracked as a watch-only source) adapted into plan-review/reviewer.md.
  https://github.com/garrytan/gstack
```

with

```
- garrytan/gstack (Garry Tan) — the plan-eng-review methodology (plan-eng-review/SKILL.md.tmpl,
  tracked as a watch-only source) adapted into plan-review/reviewer.md and, with its Step 0 scope challenge, into
  spec-review/reviewer.md.
  https://github.com/garrytan/gstack
```

- [ ] **Step 5: Run the tests to verify they pass**

Run: `node --test tests/spec-review.test.mjs tests/reviewer.test.mjs`
Expected: PASS.

- [ ] **Step 6: Run the full suite**

Run: `npm test` (timeout 10 minutes)
Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add skills/spec-review/reviewer.md NOTICE tests/reviewer.test.mjs tests/spec-review.test.mjs
git commit -m "feat(spec-review): design-document reviewer prompt with gstack scope challenge

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 3: `kickoff` hands the spec to `spec-review`

**Files:**
- Modify: `skills/kickoff/SKILL.md:75-76`
- Modify: `tests/patched-skills.test.mjs` (`HANDOFFS`)
- Modify: `tests/spec-review.test.mjs` (append)

**Interfaces:**
- Consumes: skill `spec-review` (Task 1), which takes the spec path as its argument and owns approval and the `writing-plans` hand-off.
- Produces: kickoff's architectural path ends by invoking `` `spec-review` (`verus-skills:spec-review` when installed as a plugin) `` with the spec path.

- [ ] **Step 1: Write the failing tests**

In `tests/patched-skills.test.mjs` `HANDOFFS`, replace `["kickoff/SKILL.md", "writing-plans"],` with `["kickoff/SKILL.md", "spec-review"],`.

Append to `tests/spec-review.test.mjs`:

```js
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
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `node --test tests/spec-review.test.mjs tests/patched-skills.test.mjs`
Expected: FAIL — `kickoff/SKILL.md does not name verus-skills:spec-review` and `spec-review must follow the commit`.

- [ ] **Step 3: Edit `skills/kickoff/SKILL.md`**

Replace lines 75–76:

```
5. Commit the spec. Tell the user: "Spec written and committed to `<path>`. Review it; when approved I will write the plan with `writing-plans`."
6. On approval invoke `writing-plans` (`verus-skills:writing-plans` when installed as a plugin). Invoke nothing else.
```

with:

```
5. Commit the spec. Tell the user: "Spec written and committed to `<path>`. Sending it to an external review before you approve it."
6. Invoke `spec-review` (`verus-skills:spec-review` when installed as a plugin) with the spec path. It revises the spec, asks for the user's approval and hands off to the plan. Invoke nothing else.
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `node --test tests/spec-review.test.mjs tests/patched-skills.test.mjs`
Expected: PASS.

- [ ] **Step 5: Run the full suite**

Run: `npm test` (timeout 10 minutes)
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add skills/kickoff/SKILL.md tests/patched-skills.test.mjs tests/spec-review.test.mjs
git commit -m "feat(kickoff): hand the committed spec to spec-review

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 4: Flow documentation and plugin descriptions

**Files:**
- Modify: `USING.md:9-16`
- Modify: `README.md:29-56` (mermaid, ASCII flow, step table), `README.md:75` (reviewer prompts sentence), `README.md:79-83` (skills table)
- Modify: `NOTICE:16` (own skills list)
- Modify: `.claude-plugin/plugin.json:3`, `.codex-plugin/plugin.json:3`, `.claude-plugin/marketplace.json:13`
- Modify: `tests/spec-review.test.mjs` (append)

**Interfaces:**
- Consumes: skill names and behaviour from Tasks 1–3.
- Produces: user-facing docs only; `USING.md` is also injected by the SessionStart hook as the routing context.

- [ ] **Step 1: Write the failing tests**

Append to `tests/spec-review.test.mjs`:

```js
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
  assert.match(readme, /which every reviewer prompt requires/);
});

test("NOTICE lists spec-review among the own skills", () => {
  assert.match(read("NOTICE"), /kickoff, spec-review, plan-review and review are this repository's own skills/);
});

test("the plugin and marketplace descriptions mention the spec review", () => {
  assert.equal(JSON.parse(read(".claude-plugin/plugin.json")).description, DESCRIPTION);
  assert.equal(JSON.parse(read(".codex-plugin/plugin.json")).description, DESCRIPTION);
  assert.equal(JSON.parse(read(".claude-plugin/marketplace.json")).plugins[0].description, DESCRIPTION);
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `node --test tests/spec-review.test.mjs`
Expected: FAIL in the four new tests (USING order, README mermaid, NOTICE list, descriptions).

- [ ] **Step 3: Edit `USING.md`**

Replace the numbered flow list and the rule line under `## The flow for any non-trivial change` with:

```
1. `kickoff` — always first for a new task: classifies (spike / bounded / architectural), interviews via a decision tree, auto-answers multiple-choice questions through the TypeSafe judge, writes the spec to `docs/specs/`.
2. `spec-review` — external review of the spec by Codex before the user approves it; findings judged (findings against the user's own decisions go to the user); one re-review round; then the user's approval.
3. `writing-plans` — turns the approved spec into `docs/plans/<date>-<name>.md`.
4. `plan-review` — external review of the plan by Codex; findings judged; one re-review round.
5. `subagent-driven-development` — executes the plan task by task with fresh subagents (the `verus-worker` and `verus-reviewer` agent types) and per-task reviews.
6. `review` — external review of the whole branch by Codex; one fix wave; one re-review. It also runs standalone: on given paths or globs, or over the whole codebase.
7. `finishing-a-development-branch` — merge / PR / keep.

Each skill names the next one; follow the chain. Never skip `spec-review`, `plan-review` or `review`.
```

(Line 1 keeps its current text; copy it from the file if it differs from the above.)

- [ ] **Step 4: Edit `README.md`**

Replace the mermaid block body with:

```
flowchart LR
  K[kickoff<br/>interview + spec] --> SR[spec-review<br/>Codex]
  SR --> W[writing-plans]
  W --> PR[plan-review<br/>Codex]
  PR --> SDD[subagent-driven-development<br/>verus-worker + verus-reviewer]
  SDD --> BR[review<br/>Codex]
  BR --> F[finishing-a-development-branch]
  K -. questions .-> J[(TypeSafe judge)]
  SR -. findings .-> J
  PR -. findings .-> J
  BR -. findings .-> J
```

Replace the ASCII flow block body with (copy exactly; columns are aligned):

```
kickoff → spec-review → writing-plans → plan-review → subagent-driven-development → review → finishing-a-development-branch
   │         │  ▲                          │  ▲                       │                  │
   │         ├──┘ 1 re-review + approval   ├──┘ 1 re-review           │                  │
   │         └─ findings → TypeSafe        └─ findings → TypeSafe     └ per-task reviews │
   └─ questions → TypeSafe                                                               └ findings → TypeSafe, 1 fix wave, 1 re-review
```

In the step table, insert after the `| 1 | \`kickoff\` | … |` row:

```
| 2 | `spec-review` | Codex reviews the spec (scope challenge, requirements, scope, feasibility, testability, `auto` decisions) and writes the report next to the spec as `<spec-name>.review.md`. Findings rated 7+/10 are judged — those against the user's own decisions go to the user — the spec is revised, one re-review, then the user approves the spec. |
```

and renumber the following rows 2→3, 3→4, 4→5, 5→6, 6→7; in the `review` row change `then the hand-off to step 6.` to `then the hand-off to step 7.`

On line 75 change `which both reviewer prompts require` to `which every reviewer prompt requires`.

In the skills table, insert after the `plan-review` row:

```
| `spec-review` | own | scope challenge from [gstack plan-eng-review](https://github.com/garrytan/gstack) (watched) | this repo | MIT |
```

- [ ] **Step 5: Edit `NOTICE` and the plugin descriptions**

In `NOTICE`, change `kickoff, plan-review and review are this repository's own skills; they are marked "own" in` to `kickoff, spec-review, plan-review and review are this repository's own skills; they are marked "own" in`.

In `.claude-plugin/plugin.json`, `.codex-plugin/plugin.json` and the plugin entry of `.claude-plugin/marketplace.json` (line 13), set `description` to:

```
Personal skills distro: kickoff to spec, external spec review, plan, external plan review, subagent execution, branch review, finish — with multiple-choice decisions judged by TypeSafe.
```

Leave the marketplace's top-level `description` (line 4) unchanged.

- [ ] **Step 6: Run the tests to verify they pass**

Run: `node --test tests/spec-review.test.mjs tests/plugin.test.mjs`
Expected: PASS.

- [ ] **Step 7: Run the full suite**

Run: `npm test` (timeout 10 minutes)
Expected: PASS.

- [ ] **Step 8: Commit**

```bash
git add USING.md README.md NOTICE .claude-plugin/plugin.json .codex-plugin/plugin.json .claude-plugin/marketplace.json tests/spec-review.test.mjs
git commit -m "docs: spec-review in the flow, skills table and plugin descriptions

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

## Acceptance (manual, after all tasks)

In a fresh session in this repo, run `spec-review docs/specs/2026-09-24-spec-review-design.md`. Expected: the report appears at `docs/specs/2026-09-24-spec-review-design.review.md` and ends with `<!-- end of review -->`; the spec gains `## Spec review decisions (round 1)` (or has no changes and the report is CLEAR); the skill asks for approval and does not invoke `writing-plans` until the user says yes. Record the result in the branch review.
