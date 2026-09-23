---
name: plan-review
description: External engineering review of an implementation plan before any code is written. Launches Codex (via Orca, then codex exec, then a fallback reviewer agent), routes confidence-7+ findings through the TypeSafe judge, revises the plan, and runs exactly one re-review round. Use after writing-plans, when asked to "review the plan", or before subagent-driven-development.
argument-hint: "<path to plan .md>"
---

# Plan Review

**Announce at start:** "Using plan-review on `<plan path>`."

## 0. Inputs

- `PLAN`: the argument, or the newest file in `docs/plans/`. Stop with a message if none.
- `REPORT`: `<directory of PLAN>/<plan basename without .md>.review.md` — beside the plan, always repo-relative; `reviewer.sh` rejects an absolute path. It is relative to the repo `reviewer.sh` works in, so run from the repo containing `PLAN`, or pass `--repo <that repo>` to `reviewer.sh`.
- `ROUND`: 1.
- Locate the repo and the judge protocol: read `judge.md` from the `kickoff` skill directory (same repo, `skills/kickoff/judge.md`; locate the repo with the snippet in that file, replacing `kickoff` with `plan-review`). Every fenced block below is one shell call, so a block that uses `$SKILLS_REPO` must run the locator itself.

## 1. Build the prompt

Create a temp file outside the repo (under `$TMPDIR`) containing, in order:

1. The full text of `reviewer.md` from this skill's directory.
2. `THE PLAN:` followed by the plan file verbatim inside a fence longer than any backtick run in the plan — use seven backticks unless the plan contains a run of seven or more, then go longer still.
3. `Referenced source files:` followed by the repo-relative paths mentioned in the plan that are real files: grep the plan for path-like tokens containing `/`, keep those that pass `test -f`, drop anything under `.claude/`, `.codex/`, `agents/` or `node_modules/`, deduplicate and sort, and keep at most 40 entries.
4. On round 2 only: `Previous report:` followed by the previous report verbatim (from `<REPORT>.round1.md`), then `Only report findings that are still present after the plan changes; mark fixed ones as resolved.`
5. `Write the report to <REPORT>` on its own line — the last line of the file, in round 1 and round 2 alike. Self-check before launching: `[ "$(tail -1 "$PROMPT")" = "Write the report to $REPORT" ] || echo "prompt malformed"`. If it prints `prompt malformed`, rebuild the prompt in this order and re-check; do not launch the reviewer.

Say nothing about models or reasoning effort in the prompt — the launcher pins those.

## 2. Launch the external reviewer

Substitute the real paths for the two placeholders before running:

```bash
SKILLS_REPO=""
for c in "$(cat "$HOME/.verus-skills/root" 2>/dev/null)" \
         "$HOME/.claude/skills/plan-review/../.." \
         "$HOME/.codex/skills/plan-review/../.."; do
  [ -n "$c" ] && [ -f "$c/scripts/typesafe-judge.mjs" ] && SKILLS_REPO="$(cd -P "$c" && pwd -P)" && break
done
[ -f "$SKILLS_REPO/scripts/reviewer.sh" ] || echo "reviewer not found: SKILLS_REPO=$SKILLS_REPO"

PROMPT="<the temp prompt file from section 1>"
REPORT="<REPORT, repo-relative>"
bash "$SKILLS_REPO/scripts/reviewer.sh" --prompt-file "$PROMPT" --output "$REPORT" --title plan-review --timeout-min 15
echo "reviewer_exit=$?"
```

- `0`: report is at `REPORT`; note which path ran (`reviewer: orca` / `reviewer: codex-exec`).
- `3`: dispatch the fallback reviewer with the same prompt file content as its prompt and the instruction to write `REPORT`, and wait for it. Claude Code: `subagent_type` = `verus-reviewer` (`verus-skills:verus-reviewer` when installed as a plugin), unnamed, in the background, no `model` parameter. In a Codex session: dispatch the same prompt with spawn_agent, unnamed, in the background; pass no model. On a host with no subagent tool at all, do not stop: perform the review yourself in this session following `reviewer.md` exactly, write `REPORT`, and state in the report header that it was produced by the fallback reviewer, not an independent second voice.
- `1`: fix the invocation; do not proceed.
- any other exit code (e.g. `127`): the launcher was not found or could not run — treat as `1`: fix the invocation, do not proceed.

## 3. Triage findings

Parse `## Findings (confidence 7+)`. For each finding, in order of severity:

Build a judge question:
- `question`: "How should the plan handle: <finding text>?"
- options: `A` "Accept: revise the plan as the reviewer proposes", `B` "Accept with a different fix: <your alternative, if you have one>", `C` "Reject: the finding is wrong or out of scope, because <reason>". Omit `B` if you have no alternative. Map each option to the judge's JSON fields: `label` is the text before the colon, `description` is the rest.
- `context`: a structured object — `goal` (what the plan delivers, one sentence), `decisions` (findings already triaged in this round), `facts` (the plan's Goal and Architecture lines, the spec's relevant constraint, the finding verbatim, and the relevant plan excerpt), `constraints` (the user's rules and the plan's hard limits), `consequences` (one entry per option id, each naming what concretely happens or breaks — file, behaviour, test — if that option is chosen; equal specificity and length for every id, no comparative or preference language; a map detailed only for some options is a defect, rewrite the question before judging). Facts only — a stranger reading `facts` alone must be able to pick.
- `recommended`: your pick. It is shown to the user and never sent to the judge.

Run the judge exactly as `judge.md` says. Accepted → apply the decision; unaccepted or any non-zero judge exit → ask the user with the decision block. Print every decision block in chat as it happens.

Findings in the Appendix are not acted on; leave them in the report.

## 4. Revise the plan

Apply every accepted `A`/`B` decision to `PLAN` directly (edit tasks, add tests, add steps). Append to the plan a section:

```
## Plan review decisions (round N)
<one decision block per finding, plus "Rejected: <finding> — <reason>" lines>
```

Commit: `git commit -am "docs(plan): apply plan-review round N"`.

## 5. Second round

Skip round 2 if the round-1 report has no P0/P1 at confidence 7+. Otherwise, if `ROUND` is 1 and at least one finding was accepted: copy the round-1 report to `<REPORT>.round1.md` first (`reviewer.sh` deletes `REPORT` at startup, so the only copy would be lost), then set `ROUND` to 2, rebuild the prompt (section 1, reading the previous report from `<REPORT>.round1.md`), relaunch (section 2; in Orca the same terminal session is reused via the session file, so the reviewer sees its own earlier context), triage and revise again.

Stop after round 2.

## 6. Hand off

Report to the user: rounds run, reviewer path used, findings accepted/rejected/asked, path of the final report, and — when round 2 ran — the path of the kept round-1 report (`<REPORT>.round1.md`). Then say: "Plan review done. Next: `subagent-driven-development` on `<PLAN>`." and invoke `subagent-driven-development` (`verus-skills:subagent-driven-development` when installed as a plugin).

## Rules

- Never start implementation from this skill.
- Never edit `REPORT`; it is the reviewer's artifact. Decisions go into the plan.
- One re-review round maximum. Residual P2/P3 go to the plan's `Plan review decisions (round N)` section as "deferred" — a separate heading from the `Review decisions (round N)` section the `review` skill appends after the code exists, so the two never collide in one plan.
