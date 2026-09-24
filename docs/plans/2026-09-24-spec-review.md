# spec-review Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use `subagent-driven-development` (`verus-skills:subagent-driven-development` when installed as a plugin) to implement this plan task-by-task; the plan must have passed plan-review before execution. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a `spec-review` skill that sends the kickoff spec to an external Codex review before the user approves it, triages findings through the TypeSafe judge (findings against the user's own decisions go to the user), revises the spec, and owns the approval gate and the hand-off to `writing-plans`.

**Architecture:** `spec-review` is a sibling of `plan-review`: the same launcher (`scripts/reviewer.sh`), the same judge protocol (`skills/kickoff/judge.md`), the same triage rules and round structure, with its own design-document reviewer prompt whose section 0 is gstack's Step 0 scope challenge made non-interactive. `kickoff`'s architectural path commits the spec and invokes `spec-review` instead of asking for approval itself. Everything is Markdown skill text guarded by string-contract tests on `node:test`, plus one launcher fix: `scripts/reviewer.sh`'s `codex exec` path accepts a report only with the end marker, as the Orca path already does (Task 5).

**Tech Stack:** Markdown skills, Node.js `node:test` contract tests, bash launcher `scripts/reviewer.sh` (unchanged).

**Spec:** `docs/specs/2026-09-24-spec-review-design.md`

## Global Constraints

- Hand-offs between skills name both the bare and the `verus-skills:` form: `` `<skill>` (`verus-skills:<skill>` when installed as a plugin) ``.
- Every subagent dispatch site uses exactly these two lines (tests compare them byte for byte): ``Claude Code: `subagent_type` = `verus-reviewer` (`verus-skills:verus-reviewer` when installed as a plugin), unnamed, in the background, no `model` parameter.`` and `In a Codex session: dispatch the same prompt with spawn_agent, unnamed, in the background; pass no model.` No `general-purpose`, no `model: opus`, no line starting with `name:` outside frontmatter.
- The locator block in a skill is byte-identical to `skills/kickoff/judge.md`'s apart from the skill name.
- Every reviewer prompt ends its report template with `<!-- end of review -->` and contains ``End the report with this exact last line: `<!-- end of review -->` ``.
- Do not change `skills/plan-review/`, `skills/review/`, `skills/writing-plans/`, versions in `package.json` or the plugin manifests. In `scripts/` only `scripts/reviewer.sh` changes, in Task 5.
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

- `SPEC`: the argument, or the newest spec by modification time — `ls -t docs/specs/*-design.md 2>/dev/null | head -1`; print which file was chosen. Stop with a message if none; do not launch a reviewer. Then normalize it to a path relative to the repository that contains it, so an absolute or `../` argument works:

  ```bash
  ARG="<the argument, or the ls -t result>"
  [ -f "$ARG" ] || { echo "spec not found: $ARG"; exit 1; }
  command -v realpath >/dev/null || { echo "realpath not found; pass a repo-relative spec path"; exit 1; }
  SPEC_ABS="$(realpath "$ARG")"   # resolves the file itself, so a symlink to an outside file is caught below
  TOP="$(git -C "$(dirname "$SPEC_ABS")" rev-parse --show-toplevel 2>/dev/null)"
  [ -n "$TOP" ] || { echo "spec is not inside a git repository: $SPEC_ABS"; exit 1; }
  case "$SPEC_ABS" in "$TOP"/*) ;; *) echo "spec is outside the repository: $SPEC_ABS"; exit 1;; esac
  SPEC="${SPEC_ABS#"$TOP"/}"
  echo "TOP=$TOP"; echo "SPEC=$SPEC"
  ```

  If it prints `spec not found`, `spec is not inside a git repository` or `spec is outside the repository`, stop with that message. Run every later block from `TOP` (`cd "$TOP"` first), with `SPEC` as printed.
- `REPORT`: `<directory of SPEC>/<spec basename without .md>.review.md` — beside the spec, always repo-relative; `reviewer.sh` rejects an absolute path. It is relative to the repo `reviewer.sh` works in, so run from the repo containing `SPEC`, or pass `--repo <that repo>` to `reviewer.sh`.
- `ROUND`: 1.
- Locate the repo and the judge protocol: read `judge.md` from the `kickoff` skill directory (same repo, `skills/kickoff/judge.md`; locate the repo with the snippet in that file, replacing `kickoff` with `spec-review`). Every fenced block below is one shell call, so a block that uses `$SKILLS_REPO` must run the locator itself.

## 1. Build the prompt

Create a temp file outside the repo (under `$TMPDIR`) containing, in order:

1. The full text of `reviewer.md` from this skill's directory.
2. `THE SPEC:` followed by the spec file verbatim inside a fence longer than any backtick run in the spec — use seven backticks unless the spec contains a run of seven or more, then go longer still.
3. `Referenced source files:` followed by the repo-relative paths mentioned in the spec that are real files: grep the spec for path-like tokens containing `/`, keep those that pass `test -f`, drop anything under `.claude/`, `.codex/`, `agents/` or `node_modules/`, deduplicate and sort, and keep at most 40 entries.
4. On round 2 only: `Previous report:` followed by the previous report verbatim (from `<REPORT>.round1.md`), then `Review the whole revised spec: report every finding from the previous report that is still present, mark fixed ones as resolved, and report new findings the spec changes introduced.`
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

If the report has no confidence-7+ finding (`None` under `## Findings (confidence 7+)`), skip this section: append nothing and commit nothing; the section-6 summary says the report was CLEAR.

Otherwise apply to `SPEC` directly (edit the affected sections) the chosen action of every judged finding, whatever its option letter and whether the judge accepted it or the user chose it, the user's answer to every finding against a `user` decision, and every finding accepted without the judge. A "leave it as is" choice is recorded with the decisions but changes nothing in the spec. Do not edit the spec's Decisions section: it is the interview record, and a later section supersedes it. Append to the spec a section:

```
## Spec review decisions (round N)
<one decision block per judged finding, the question and the user's answer for each finding against a `user` decision, one "accepted without the judge: …" line per finding decided without it, and a "Left as is: <finding> — <argument>" line for each finding the judge or the user chose to leave>
```

Commit only the spec, so unrelated work in the checkout stays out and an untracked spec is included: `git add -- "$SPEC" && git commit -m "docs(spec): apply spec-review round N" -- "$SPEC"`.

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

Wait for the user's explicit approval. If they ask for changes instead, apply them to the spec and commit only the spec (`git add -- "$SPEC" && git commit -m "docs(spec): apply user changes after spec-review" -- "$SPEC"`). Then, if the changes touch Goal, Non-goals, Design or Decisions and round 2 has not run, run round 2 on the edited spec: copy the round-1 report to `<REPORT>.round1.md`, set `ROUND` to 2, go through sections 1–4 again (section 2 with the same SESSION value — the session was closed, so the launcher opens a fresh terminal), close the session again, and come back to this paragraph. Otherwise ask for approval again, naming the edits no reviewer saw. On approval invoke `writing-plans` (`verus-skills:writing-plans` when installed as a plugin) with the spec path. Invoke nothing else.

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
- Modify: `README.md:12`, `README.md:24`, `README.md:29-56` (mermaid, ASCII flow, step table), `README.md:79-83` (skills table), `README.md:110`
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

On line 12 change `same ten skills` to `same eleven skills`. On line 24 change `Plans and branches are reviewed by Codex` to `Specs, plans and branches are reviewed by Codex`. On line 110 change `` `verus-reviewer` (task reviews, re-reviews, plan reviews, the fallback external reviewer) `` to `` `verus-reviewer` (task reviews, re-reviews, plan reviews, the fallback external reviewer of spec-review, plan-review and review) ``. (Line 75 is Task 5's.)

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

### Task 5: `reviewer.sh` requires the end marker last on both paths and opens Orca in the reviewed repo

**Files:**
- Modify: `scripts/reviewer.sh:126-133` (comment, `report_complete`), `scripts/reviewer.sh:164` (Orca worktree selector), `scripts/reviewer.sh:243-249` (codex-exec result check)
- Modify: `tests/fixtures/fake-bin/codex`
- Modify: `tests/reviewer.test.mjs` (three `"codex report"` assertions at lines 81, 107, 437; one new test)
- Modify: `README.md:75`

**Interfaces:**
- Consumes: `END_MARKER` and `report_complete()` in `scripts/reviewer.sh:132-133` (today `grep -qxF "$END_MARKER" "$REPO/$OUTPUT"`, a match on any line).
- Produces: `report_complete()` is true only when the report's last non-empty line is the marker, on both paths; the Orca terminal is created in the reviewed repository (`--worktree "path:$REPO"`), so a repository Orca does not manage falls through to `codex exec -C "$REPO"`; on the `codex exec` path, exit `0` only when `report_complete` holds; a non-empty report without it is moved to `.context/<title>-partial.md`, stderr says `codex exec: report incomplete (end marker missing); partial report kept at <path>`, and the launcher falls through to exit `3` — so `spec-review`, `plan-review` and `review` all dispatch their fallback reviewer instead of triaging a truncated report.

- [ ] **Step 1: Write the failing tests**

In `tests/fixtures/fake-bin/codex`, add a knob line to the header comment and write the marker by default:

```bash
#!/usr/bin/env bash
# Fake codex CLI. Env knobs:
#   FAKE_CODEX_STDOUT=<text>  -> echoed to stdout (the launcher captures it in the log)
#   FAKE_CODEX_NO_REPORT=1    -> do not write the report file
#   FAKE_CODEX_NO_MARKER=1    -> write the report without the end marker (a truncated review)
#   FAKE_CODEX_TRAILING=1     -> write the marker, then more text after it
echo "codex $*" >> "${FAKE_LOG:?}"
prompt=$(cat)
if [ -n "${FAKE_CODEX_STDOUT:-}" ]; then
  printf '%s\n' "$FAKE_CODEX_STDOUT"
fi
if [ -z "${FAKE_CODEX_NO_REPORT:-}" ]; then
  out=$(printf '%s\n' "$prompt" | grep -o 'Write the report to [^ ]*' | awk '{print $5}')
  if [ -n "$out" ]; then
    mkdir -p "$(dirname "$out")"
    if [ -n "${FAKE_CODEX_NO_MARKER:-}" ]; then
      echo "codex report" > "$out"
    elif [ -n "${FAKE_CODEX_TRAILING:-}" ]; then
      printf 'codex report\n<!-- end of review -->\npartial tail\n' > "$out"
    else
      printf 'codex report\n<!-- end of review -->\n' > "$out"
    fi
  fi
fi
exit 0
```

In `tests/reviewer.test.mjs`, next to `const ORCA_REPORT = …`, add:

```js
// What the fake codex writes by default: a complete report, marker included.
const CODEX_REPORT = "codex report\n<!-- end of review -->\n";
```

Replace each of the three assertions
`assert.equal(readFileSync(path.join(dir, "docs/reviews/out.md"), "utf8").trim(), "codex report");`
with
`assert.equal(readFileSync(path.join(dir, "docs/reviews/out.md"), "utf8"), CODEX_REPORT);`

Add after the test `"falls back to codex exec without Orca"`:

```js
test("a codex exec report without the end marker is not accepted", () => {
  const dir = repo();
  const r = run(dir, ["codex"], { env: { FAKE_CODEX_NO_MARKER: "1" } });
  assert.equal(r.status, 3, r.stderr);
  assert.doesNotMatch(r.stdout, /reviewer: codex-exec/);
  assert.match(r.stderr, /codex exec: report incomplete \(end marker missing\); partial report kept at .*\.context\/t-partial\.md/);
  assert.ok(!existsSync(path.join(dir, "docs/reviews/out.md")), "a truncated report must not stay at the output path");
  assert.equal(readFileSync(path.join(dir, ".context/t-partial.md"), "utf8"), "codex report\n");
});

test("a codex exec report with text after the end marker is not accepted", () => {
  const dir = repo();
  const r = run(dir, ["codex"], { env: { FAKE_CODEX_TRAILING: "1" } });
  assert.equal(r.status, 3, r.stderr);
  assert.match(r.stderr, /codex exec: report incomplete \(end marker missing\)/);
  assert.ok(!existsSync(path.join(dir, "docs/reviews/out.md")));
});

test("the Orca terminal is created in the reviewed repository, not the active worktree", () => {
  const dir = repo();
  const r = run(dir, ["orca", "codex"]);
  assert.equal(r.status, 0, r.stderr);
  assert.ok(r.log.includes(`orca terminal create --worktree path:${dir} `), r.log);
  assert.doesNotMatch(r.log, /--worktree active/);
});

test("README says both reviewer paths require the end marker", () => {
  const readme = readFileSync(fileURLToPath(new URL("../README.md", import.meta.url)), "utf8");
  assert.match(readme, /On either path a report counts as finished only once its last non-empty line is `<!-- end of review -->`, which every reviewer prompt requires/);
  assert.match(readme, /The Orca terminal opens in the reviewed repository \(`--worktree path:<repo>`\)/);
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `node --test tests/reviewer.test.mjs`
Expected: FAIL in the four new tests only — the markerless and the trailing-text reports exit `0` with `reviewer: codex-exec`, the Orca log shows `--worktree active`, and README still has the old sentence. The three rewritten assertions pass (the fake now writes the marker).

- [ ] **Step 3: Change the `codex exec` result check in `scripts/reviewer.sh`**

Replace

```bash
  if [ -s "$REPO/$OUTPUT" ]; then
    echo "reviewer: codex-exec"
    exit 0
  else
    TAIL="$(grep -v '^[[:space:]]*$' "$LOG" 2>/dev/null | tail -1)"
    echo "codex exec failed: ${TAIL:-(log empty)} (full log: $LOG)" >&2
  fi
```

with

```bash
  if report_complete; then
    echo "reviewer: codex-exec"
    exit 0
  elif [ -s "$REPO/$OUTPUT" ]; then
    # Killed at the timeout or cut short: a report without the marker is not a review.
    PARTIAL="$REPO/.context/${TITLE}-partial.md"
    mv -f "$REPO/$OUTPUT" "$PARTIAL"
    echo "codex exec: report incomplete (end marker missing); partial report kept at $PARTIAL" >&2
  else
    TAIL="$(grep -v '^[[:space:]]*$' "$LOG" 2>/dev/null | tail -1)"
    echo "codex exec failed: ${TAIL:-(log empty)} (full log: $LOG)" >&2
  fi
```

Replace `report_complete` (line 133) with a last-non-empty-line check, used by both paths:

```bash
report_complete() { [ "$(grep -v '^[[:space:]]*$' "$REPO/$OUTPUT" 2>/dev/null | tail -1)" = "$END_MARKER" ]; }
```

On line 164 change `orca terminal create --worktree active` to `orca terminal create --worktree "path:$REPO"` (the rest of the line unchanged). A repository Orca does not manage makes `terminal create` fail, `CREATED_HANDLE` stays empty, and the launcher continues to the `codex exec -C "$REPO"` path as it already does when create fails.

In the comment above `END_MARKER` (lines 126–131), change `the Orca path accepts the report — and only then` / `# closes a session-less terminal — once that line is in the file.` to say that both paths accept the report only once that line is in the file, and the Orca path only then closes a session-less terminal:

```bash
# The reviewer streams the report and can pause between writes long enough for
# the TUI to look idle, so neither "the file exists" nor "its size held still"
# means "finished". reviewer.md makes every reviewer end the report with
# END_MARKER as its last line; both the Orca and the codex-exec path accept the
# report only once that line is its last non-empty line, and the Orca path only
# then closes a session-less terminal.
```

- [ ] **Step 4: Update `README.md:75`**

Replace the sentence `On the Orca path a report counts as finished only once its last line is `<!-- end of review -->`, which both reviewer prompts require.` with:

`On either path a report counts as finished only once its last non-empty line is `<!-- end of review -->`, which every reviewer prompt requires; a `codex exec` report without it is moved to `.context/<title>-partial.md` and the launcher exits `3`. The Orca terminal opens in the reviewed repository (`--worktree path:<repo>`); a repository Orca does not manage goes to `codex exec`.`

- [ ] **Step 5: Run the tests to verify they pass**

Run: `node --test tests/reviewer.test.mjs`
Expected: PASS.

- [ ] **Step 6: Run the full suite**

Run: `npm test` (timeout 10 minutes)
Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add scripts/reviewer.sh tests/fixtures/fake-bin/codex tests/reviewer.test.mjs README.md
git commit -m "fix(reviewer): a report counts only with the end marker last; Orca opens in the reviewed repo

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

## Acceptance (manual, after all tasks)

Run each scenario in a fresh session, record the observed result next to the expected one in `docs/plans/2026-09-24-spec-review.acceptance.md` (a table: scenario, expected, observed, pass/fail), and commit that file. Scenarios 1–5 and 7–11 use a scratch repo (not managed by Orca, so the launcher takes the `codex exec` path after Task 5): `S=$(mktemp -d) && git -C "$S" init -q && mkdir -p "$S/docs/specs"`, with the session started in `$S`. Scenario 6 uses this repo, where the Orca path runs.

| # | Setup | Action | Expected |
|---|---|---|---|
| 1 | `$S` with an empty `docs/specs/` | `spec-review` (no argument) | Stops with a message that no spec was found; no `.context/spec-review-*-session` file, no reviewer launched. |
| 2 | `$S/docs/specs/2026-01-01-a-design.md` with Goal/Non-goals/Design/Testing/Decisions, committed | `spec-review $S/docs/specs/2026-01-01-a-design.md` (absolute path) | `SPEC=docs/specs/2026-01-01-a-design.md` printed; the report appears at `docs/specs/2026-01-01-a-design.review.md` and contains `<!-- end of review -->`. |
| 3 | A spec in `$S` whose Design contains a line of seven backticks inside a four-backtick code sample | `spec-review <that spec>` | The prompt file under `$TMPDIR` wraps the spec in a fence of eight or more backticks (`grep -n '^````````' <prompt>` shows the opening and closing fence). |
| 4 | A spec in `$S` with no Decisions section | `spec-review <that spec>` | The report's `### 5. Decisions` says `No Decisions section`; no finding cites `Decisions:`. |
| 5 | A spec in `$S` whose Decisions has `### 1. Report location — user` choosing `/tmp/report.md` while Design says the report is beside the spec | `spec-review <that spec>` | The contradiction finding arrives as a question to the user with the decision named; no judge decision block is printed for it. |
| 6 | This repo, after all tasks, on `docs/specs/2026-09-24-spec-review-design.md` | Run `spec-review`; at the approval question ask for a change to Non-goals | If round 2 has not run, it runs on the edited spec before approval is asked again; if it has, the approval question names the unreviewed edit. `writing-plans` is not invoked until an explicit yes; answer no at the end. |
| 7 | `$S` with a short, complete, internally consistent spec (Goal one line, Non-goals, Design naming no files, Testing with one command, no Decisions) | `spec-review <that spec>` until the report says CLEAR (if Codex still reports 7+ findings, fix them by hand and rerun) | With a CLEAR report: no `## Spec review decisions` section is appended, `git log` shows no `docs(spec): apply spec-review` commit, the summary says CLEAR, the approval question follows. |
| 8 | `$S` with the scenario-2 spec; start the session with `PATH` stripped of `orca` and `codex` (e.g. a PATH of `/usr/bin:/bin` plus the directory holding `node` and `claude`) | `spec-review <that spec>` | `reviewer.sh` exits `3`; the `verus-reviewer` fallback writes the report; the report header says it came from the fallback reviewer only if no subagent tool exists. |
| 9 | `$S` with the scenario-2 spec; temporarily change `--timeout-min 15` to `--timeout-min 0` in the installed `skills/spec-review/SKILL.md`, restore it afterwards | `spec-review <that spec>` | `reviewer.sh` exits `1` with the usage line; the skill stops without triage, and `.context/spec-review-*-session` is closed. |
| 10 | `$S` with a spec that has no Decisions section and whose Testing section gives no check for one Design requirement (a finding with more than one reasonable fix); start the session with `TYPESAFE_API_KEY=` and no key in `~/.verus-skills/config.json` (move it aside, restore afterwards) | `spec-review <that spec>` | Each judge-able finding is asked to the user with the line `TypeSafe judge unavailable: …`; nothing is auto-accepted. |
| 11 | `$S` with a spec whose Goal promises a feature that its Non-goals exclude (a P0/P1 contradiction) | `spec-review <that spec>` | Round 1 reports the contradiction at 7+; after the fix, `<REPORT>.round1.md` exists and round 2 runs with the same session; the round-2 report marks the finding resolved or still present. |


## Plan review decisions (round 1)

Reviewer: Codex via Orca (`reviewer: orca`), report `docs/plans/2026-09-24-spec-review.review.md`.

accepted without the judge: an absolute SPEC path produces an absolute REPORT that reviewer.sh rejects — `scripts/reviewer.sh:39`: `/*) echo "--output must be repo-relative" >&2; exit 1;;`. Task 1 §0 now normalizes SPEC to a repo-relative path and stops on a missing file, a non-git location or a path outside the repository.

accepted without the judge: README prose not updated for spec-review — `README.md:12` "same ten skills", `README.md:24` "Plans and branches are reviewed by Codex", `README.md:110` reviewer roles. Task 4 now edits all three and asserts them.

```
Решение (Jev): How should a user's change request after the external spec review, before approval, be handled?
  A. Re-review within budget  100%
  B. Name unreviewed edits    0%
  C. Always re-review         0%
  Рекомендация Claude: A
  Данных достаточно: 78%
  Выбрано: A, confidence 0.99, данных 0.78, порог 0.7/0.6 → принято автоматически
```

```
Решение (Jev): How should spec-review §4 handle a round with nothing to record (report CLEAR or no confidence-7+ findings)?
  A. Skip section and commit  93%
  B. Record a CLEAR section   7%
  Рекомендация Claude: A
  Данных достаточно: 80%
  Выбрано: A, confidence 0.87, данных 0.80, порог 0.7/0.6 → принято автоматически
```

```
Решение (Jev): How should spec-review guard against a reviewer report that exists but lacks the end marker after reviewer.sh exits 0?
  A. Check, then fallback  82%
  B. Check, then stop      10%
  C. Fix reviewer.sh       6%
  D. Leave as plan-review  2%
  Рекомендация Claude: C
  Данных достаточно: 51%
  Выбрано: A, confidence 0.76, данных 0.51, порог 0.7/0.6 → спросить пользователя (мало данных)
```

User chose **C**: Task 5 fixes the `codex exec` path in `scripts/reviewer.sh`; the spec's Non-goal "no reviewer.sh changes" is revised (spec §7).

```
Решение (Jev): How should the plan verify spec-review's behaviour beyond string-contract tests?
  A. Contract tests + one run   0%
  B. Scripted manual scenarios  99%
  C. Automated harness          1%
  Рекомендация Claude: B
  Данных достаточно: 56%
  Выбрано: B, confidence 0.97, данных 0.56, порог 0.7/0.6 → спросить пользователя (мало данных)
```

User chose **B**: the Acceptance section is now six scripted scenarios with expected outcomes, recorded in `docs/plans/2026-09-24-spec-review.acceptance.md`.

## Plan review decisions (round 2)

Reviewer: Codex via Orca (`reviewer: orca`), report `docs/plans/2026-09-24-spec-review.review.md`; round-1 report kept as `docs/plans/2026-09-24-spec-review.review.md.round1.md`.

accepted without the judge: the round-2 prompt told the reviewer to report only findings still present, so a defect introduced by the user's edit would go unreported — Task 1 §1 item 4 quoted "Only report findings that are still present after the spec changes". Now it asks for unresolved old findings and new ones on the whole revised spec; a test pins the sentence.

accepted without the judge: `git commit -am` sweeps unrelated tracked changes into the spec commit and skips an untracked spec — Task 1 §4 and §6. Both commits are now `git add -- "$SPEC" && git commit -m … -- "$SPEC"`; a test forbids `git commit -am` in the skill.

```
Решение (Jev): How should the plan handle Orca opening the reviewer terminal in Orca's active worktree rather than in the repository being reviewed?
  A. Scenarios in this worktree  2%
  B. Select worktree by path     98%
  C. Leave as is                 0%
  Рекомендация Claude: B
  Данных достаточно: 67%
  Выбрано: B, confidence 0.97, данных 0.67, порог 0.7/0.6 → принято автоматически
```

```
Решение (Jev): How should reviewer.sh decide that a report is complete, given report_complete matches the end marker on any line?
  A. Last non-empty line  95%
  B. Keep any-line match  5%
  Рекомендация Claude: B
  Данных достаточно: 72%
  Выбрано: A, confidence 0.90, данных 0.72, порог 0.7/0.6 → принято автоматически
```

```
Решение (Jev): How should spec-review §0 handle a spec path that is a symlink pointing outside the repository?
  A. Resolve the file  97%
  B. Reject symlinks   3%
  C. Leave as is       0%
  Рекомендация Claude: B
  Данных достаточно: 63%
  Выбрано: A, confidence 0.95, данных 0.63, порог 0.7/0.6 → принято автоматически
```

```
Решение (Jev): Should the acceptance table also cover the branches spec-review copies from plan-review (CLEAR round, launcher exit 3, failed launch, judge unavailable, P0/P1-triggered round 2)?
  A. Add forced scenarios  98%
  B. Keep six scenarios    2%
  Рекомендация Claude: A
  Данных достаточно: 72%
  Выбрано: A, confidence 0.96, данных 0.72, порог 0.7/0.6 → принято автоматически
```

Deferred: none. Round 2 was the last round.

## Review decisions (round 1)

Reviewer: Codex via Orca (`reviewer: orca`), report `docs/reviews/VerusK-spec-review-2026-09-24.md`. Fixes: commit `ea5f217`.

accepted without the judge: "Never skip `spec-review`" in USING.md also covered bounded and spike tasks, which write no spec — USING.md:17 vs skills/kickoff/SKILL.md Bounded path "hand off to test-driven-development … no plan document". The rule is now scoped to an architectural kickoff.

accepted without the judge: acceptance scenario 10 reused scenario 5, whose finding is against a `user` decision and never reaches the judge — plan Acceptance rows 5 and 10. Row 10 now uses a spec with an untested requirement (a finding with more than one fix).

accepted without the judge: a relative `--repo` reached Orca as `path:<relative>` — scripts/reviewer.sh stored `--repo` as given, checked only `-d`, then built `--worktree "path:$REPO"`. REPO is now normalized with `cd && pwd -P`; a test covers a relative `--repo`.

```
Решение (Jev): How should the spec-review reviewer prompt's ban on reading agents/ and .claude/ be reconciled with verifying the spec's file claims?
  A. Allow repo agents as data  76%
  B. Exempt those claims        23%
  C. Leave as plan-review       1%
  Рекомендация Claude: A
  Данных достаточно: 46%
  Выбрано: A, confidence 0.65, данных 0.46, порог 0.7/0.6 → спросить пользователя (мало данных)
```

User chose **A**: the reviewer may read this repository's `agents/` and `.claude/` as data when the spec names them; SKILL.md §1 keeps them in Referenced source files.

```
Решение (Jev): When and how should the eleven manual acceptance scenarios for spec-review be run?
  A. Before merge, from worktree  99%
  B. After merge                  0%
  C. Controller dry-run now       1%
  Рекомендация Claude: A
  Данных достаточно: 66%
  Выбрано: A, confidence 0.98, данных 0.66, порог 0.7/0.6 → принято автоматически
```

The user consented to `make install` from this worktree for the acceptance run and back from the main checkout afterwards.

Ledger triage (reviewer): the two lines marked BLOCKS MERGE (reviewer ban on `agents/`, relative `--repo`) are fixed above; the other fifteen deferred minors were judged OK for merge.

## Review decisions (round 2)

Reviewer: Codex via Orca (`reviewer: orca`), report `docs/reviews/VerusK-spec-review-2026-09-24-2.md`. All four round-1 fixes marked resolved; both BLOCKS MERGE ledger lines now OK.

Remaining finding [P2]: the acceptance file `docs/plans/2026-09-24-spec-review.acceptance.md` is absent — covered by the round-1 decision (run before merge from this worktree); pending the user's fresh-session run. No code change.

Deferred (P2/P3 from the ledger, judged OK for merge by the reviewer): the fifteen `minor (deferred)` lines in `.superpowers/sdd/2026-09-24-spec-review/progress.md`, notably stale "ten skills" counts in `docs/plugin-acceptance.md`, the unchecked `mv` in reviewer.sh's partial-report branch, and the stale reviewer.sh exit header.
