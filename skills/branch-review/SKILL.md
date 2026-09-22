---
name: branch-review
description: External whole-branch code review by Codex (via Orca, then codex exec, then a Claude agent on opus) against the plan and spec. Routes confidence-7+ findings through the TypeSafe judge, applies accepted fixes with one fix subagent, runs one re-review round, then hands off to finishing-a-development-branch. Use at the end of subagent-driven-development, before merge, or when asked to "review the branch".
argument-hint: "[merge-base commit or base branch, default main]"
---

# Branch Review

**Announce at start:** "Using branch-review against `<base>`."

## 0. Inputs

- `BASE`: the argument, else `$(git merge-base main HEAD)`.
- `BRANCH`: `git branch --show-current`.
- `REPORT`: `docs/reviews/<BRANCH with / replaced by ->-<YYYY-MM-DD>.md` — always repo-relative; `reviewer.sh` exits 1 on an absolute path. It is relative to the repo `reviewer.sh` works in, so run from the repo under review, or pass `--repo <that repo>` to `reviewer.sh`. Create `docs/reviews/` if it does not exist.
- `PLAN`, `SPEC`: newest file in `docs/plans/` and the spec path from its header; if the user named a plan, use it. Either may be absent — say so in the prompt rather than inventing a path.
- `ROUND`: 1.
- Locate the repo and the judge protocol: read `judge.md` from the `kickoff` skill directory (same repo, `skills/kickoff/judge.md`; locate the repo with the snippet in that file, replacing `kickoff` with `branch-review`). Every fenced block below is one shell call, so a block that uses `$SKILLS_REPO` must run the locator itself.

Collect the inputs and the mode in one call:

```bash
BASE="${1:-$(git merge-base main HEAD)}"
BRANCH="$(git branch --show-current)"
REPORT="docs/reviews/$(printf '%s' "$BRANCH" | tr '/' '-')-$(date +%Y-%m-%d).md"
mkdir -p "$(dirname "$REPORT")"
echo "BASE=$BASE"
echo "BRANCH=$BRANCH"
echo "REPORT=$REPORT"
[ -n "$(git status --porcelain)" ] && echo "mode=report-only" || echo "mode=full"
git log --oneline "$BASE"..HEAD | head -50
git diff "$BASE"..HEAD --stat | tail -1
```

Mode depends on the working tree:

- clean (`mode=full`) → **full mode**: review `BASE..HEAD`, fix wave, re-review, hand-off.
- dirty (`mode=report-only`) → **report-only mode**: review `git diff BASE` (working tree including uncommitted changes) so the skill is usable mid-task; the report header says `(includes uncommitted changes)`; findings are still judged and printed as decision blocks, but no fix subagent is dispatched and nothing is committed. End with the list of accepted findings for the user to apply, then stop — no hand-off to `finishing-a-development-branch`.

## 1. Build the prompt

Create a temp file outside the repo (under `$TMPDIR`) containing, in order:

1. The full text of `reviewer.md` from this skill's directory, verbatim.
2. `WHAT WAS IMPLEMENTED:` a 3–6 line summary you write from the plan and `git log --oneline BASE..HEAD`.
3. `PLAN: <path>` and `SPEC: <path>` — `none` for either one that does not exist.
4. `Ledger lines:` the plan's deferred-minor and parked lines, if the plan has a ledger; else `none`.
5. `DIFF:` followed by `git diff BASE..HEAD` (full mode) or `git diff BASE` (report-only mode) inside a fence longer than any backtick run in the diff — use seven backticks unless the diff contains a run of seven or more, then go longer still. If the diff exceeds 6000 lines, embed the `--stat` form instead plus the sentence `Run git diff <BASE> yourself; it is too large to embed.`
6. On round 2 only: `Previous report:` followed by the previous report verbatim (from `<REPORT>.round1.md`), then `Only report findings still present after the fixes; mark fixed ones as resolved.`
7. `Write the report to <REPORT>` on its own line — the last line of the file, in round 1 and round 2 alike. Self-check before launching: `[ "$(tail -1 "$PROMPT")" = "Write the report to $REPORT" ] || echo "prompt malformed"`. If it prints `prompt malformed`, rebuild the prompt in this order and re-check; do not launch the reviewer.

Say nothing about models or reasoning effort in the prompt — the launcher pins those.

## 2. Launch the external reviewer

Substitute the real paths for the two placeholders before running:

```bash
for d in "${CLAUDE_SKILL_DIR:-}" "$HOME/.claude/skills/branch-review" "$HOME/.codex/skills/branch-review"; do
  [ -n "$d" ] && [ -e "$d/SKILL.md" ] && SKILLS_REPO="$(cd "$(dirname "$(realpath "$d")")/.." && pwd)" && break
done
[ -f "$SKILLS_REPO/scripts/reviewer.sh" ] || echo "reviewer not found: SKILLS_REPO=$SKILLS_REPO"

PROMPT="<the temp prompt file from section 1>"
REPORT="<REPORT, repo-relative>"
bash "$SKILLS_REPO/scripts/reviewer.sh" --prompt-file "$PROMPT" --output "$REPORT" --title branch-review --timeout-min 20
echo "reviewer_exit=$?"
```

- `0`: report is at `REPORT`; note which path ran (`reviewer: orca` / `reviewer: codex-exec`).
- `3`: dispatch an unnamed background Claude subagent (`general-purpose`, `model: opus`) with the same prompt file content as its prompt and the instruction to write `REPORT`. Wait for it.
- `1`: fix the invocation; do not proceed.
- any other exit code (e.g. `127`): the launcher was not found or could not run — treat as `1`: fix the invocation, do not proceed.

## 3. Triage findings

Parse `## Findings (confidence 7+)`. For each finding, in order of severity:

Build a judge question:
- `question`: "How should the branch handle: <finding text>?"
- options: `A` "Fix as proposed: apply the reviewer's fix", `B` "Fix differently: <your alternative, if you have one>", `C` "Reject: the finding is wrong or out of scope, because <reason>". Omit `B` if you have no alternative. Map each option to the judge's JSON fields: `label` is the text before the colon, `description` is the rest.
- `context`: the summary from step 1.2, the finding verbatim, and the relevant spec or plan constraint.
- `recommended`: your pick.

Run the judge exactly as `judge.md` says. Accepted → record the decision; unaccepted or any non-zero judge exit → ask the user with the decision block. Print every decision block in chat as it happens.

`## Ledger triage` lines marked BLOCKS MERGE are treated as P1 findings and go through the same triage.

Findings in the Appendix are not acted on; leave them in the report.

## 4. Fix wave (full mode only)

In report-only mode skip this section and section 5: print the accepted findings as a checklist for the user to apply, then stop.

Collect every accepted finding into one list and dispatch ONE unnamed background fix subagent (`general-purpose`, `model: opus`): give it the list, the spec path, the repo test command, and the rule "fix all of them, run the full suite, commit as `fix(review): <summary>`; do not touch anything outside the findings". Wait for it. Verify the suite yourself with `verification-before-completion` before continuing.

Append to `PLAN`:

```
## Branch review decisions (round N)
<one decision block per finding, plus "Rejected: <finding> — <reason>" lines>
```

Commit the plan change: `git commit -am "docs(plan): apply branch-review round N"`.

## 5. Second round

Skip round 2 if the round-1 report has no P0/P1 at confidence 7+. Otherwise, if `ROUND` is 1 and at least one finding was fixed: copy the round-1 report to `<REPORT>.round1.md` first (`reviewer.sh` deletes `REPORT` at startup, so the only copy would be lost), then set `ROUND` to 2, rebuild the prompt (section 1, reading the previous report from `<REPORT>.round1.md`), relaunch (section 2; in Orca the same terminal session is reused via the session file, so the reviewer sees its own earlier context), and triage again. Run one more fix wave only if a P0/P1 at confidence 7+ remains.

Stop after round 2.

## 6. Hand off

Report to the user: rounds run, reviewer path used, findings fixed/rejected/asked, path of the final report, suite status, and — when round 2 ran — the path of the kept round-1 report (`<REPORT>.round1.md`). Then say: "Branch review done. Using `finishing-a-development-branch`." and invoke it.

## Rules

- Never edit `REPORT`; it is the reviewer's artifact. Decisions go into the plan.
- Exactly one fix subagent per round; never one per finding.
- Report-only mode never commits, never dispatches a fix subagent, never hands off.
- Two rounds maximum. Residual P2/P3 are listed as deferred in the plan section above, so `finishing-a-development-branch` can show them.
