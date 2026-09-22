---
name: plan-review
description: External engineering review of an implementation plan before any code is written. Launches Codex (via Orca, then codex exec, then a Claude agent on opus), routes confidence-7+ findings through the TypeSafe judge, revises the plan, and runs exactly one re-review round. Use after writing-plans, when asked to "review the plan", or before subagent-driven-development.
argument-hint: "<path to plan .md>"
---

# Plan Review

**Announce at start:** "Using plan-review on `<plan path>`."

## 0. Inputs

- `PLAN`: the argument, or the newest file in `docs/plans/`. Stop with a message if none.
- `REPORT`: `docs/plans/<plan basename without .md>.review.md` — always repo-relative; `reviewer.sh` rejects an absolute path.
- `ROUND`: 1.
- Locate the repo and the judge protocol: read `judge.md` from the `kickoff` skill directory (same repo, `skills/kickoff/judge.md`; locate the repo with the snippet in that file, replacing `kickoff` with `plan-review`). Every fenced block below is one shell call, so a block that uses `$SKILLS_REPO` must run the locator itself.

## 1. Build the prompt

Create a temp file outside the repo (under `$TMPDIR`) containing, in order:

1. The full text of `reviewer.md` from this skill's directory.
2. `THE PLAN:` followed by the plan file verbatim inside a fenced block.
3. `Referenced source files:` followed by every repo-relative path mentioned in the plan that exists on disk (grep the plan for path-like tokens containing `/` and check with `test -e`).
4. `Write the report to <REPORT>` on its own line, last. This must be the only line in the whole prompt that carries that phrase: verify with `grep -c 'Write the report to' "$PROMPT"` → `1`.

On round 2 append: `Previous report:` and the previous report verbatim, then `Only report findings that are still present after the plan changes; mark fixed ones as resolved.`

Say nothing about models or reasoning effort in the prompt — the launcher pins those.

## 2. Launch the external reviewer

Substitute the real paths for the two placeholders before running:

```bash
for d in "${CLAUDE_SKILL_DIR:-}" "$HOME/.claude/skills/plan-review" "$HOME/.codex/skills/plan-review"; do
  [ -n "$d" ] && [ -e "$d/SKILL.md" ] && SKILLS_REPO="$(cd "$(dirname "$(realpath "$d")")/.." && pwd)" && break
done
[ -f "$SKILLS_REPO/scripts/reviewer.sh" ] || echo "reviewer not found: SKILLS_REPO=$SKILLS_REPO"

PROMPT="<the temp prompt file from section 1>"
REPORT="<REPORT, repo-relative>"
bash "$SKILLS_REPO/scripts/reviewer.sh" --prompt-file "$PROMPT" --output "$REPORT" --title plan-review --timeout-min 15
echo "reviewer_exit=$?"
```

- `0`: report is at `REPORT`; note which path ran (`reviewer: orca` / `reviewer: codex-exec`).
- `3`: dispatch an unnamed background Claude subagent (`general-purpose`, `model: opus`) with the same prompt file content as its prompt and the instruction to write `REPORT`. Wait for it.
- `1`: fix the invocation; do not proceed.

## 3. Triage findings

Parse `## Findings (confidence 7+)`. For each finding, in order of severity:

Build a judge question:
- `question`: "How should the plan handle: <finding text>?"
- options: `A` "Accept: revise the plan as the reviewer proposes", `B` "Accept with a different fix: <your alternative, if you have one>", `C` "Reject: the finding is wrong or out of scope, because <reason>". Omit `B` if you have no alternative.
- `context`: the plan's Goal and Architecture lines, the spec's relevant constraint, and the finding verbatim.
- `recommended`: your pick.

Run the judge exactly as `judge.md` says. Accepted → apply the decision; unaccepted or any non-zero judge exit → ask the user with the decision block. Print every decision block in chat as it happens.

Findings in the Appendix are not acted on; leave them in the report.

## 4. Revise the plan

Apply every accepted `A`/`B` decision to `PLAN` directly (edit tasks, add tests, add steps). Append to the plan a section:

```
## Review decisions (round N)
<one decision block per finding, plus "Rejected: <finding> — <reason>" lines>
```

Commit: `git commit -am "docs(plan): apply plan-review round N"`.

## 5. Second round

If `ROUND` is 1 and at least one finding was accepted: set `ROUND` to 2, rebuild the prompt (section 1, including the previous report), relaunch (section 2; in Orca the same terminal session is reused via the session file, so the reviewer sees its own earlier context), triage and revise again.

Stop after round 2, or earlier when the report has no P0/P1 with confidence 7+.

## 6. Hand off

Report to the user: rounds run, reviewer path used, findings accepted/rejected/asked, path of the final report. Then say: "Plan review done. Next: `subagent-driven-development` on `<PLAN>`." and invoke it.

## Rules

- Never start implementation from this skill.
- Never edit `REPORT`; it is the reviewer's artifact. Decisions go into the plan.
- One re-review round maximum. Residual P2/P3 go to the plan's Review decisions section as "deferred".
