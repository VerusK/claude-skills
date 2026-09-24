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
3. `Referenced source files:` followed by the repo-relative paths mentioned in the spec that are real files: grep the spec for path-like tokens containing `/`, keep those that pass `test -f`, drop anything under `.codex/` or `node_modules/` (files under `agents/` and `.claude/` stay: the reviewer reads them as data), deduplicate and sort, and keep at most 40 entries.
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
