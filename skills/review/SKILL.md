---
name: review
description: External code review by Codex (via Orca, then codex exec, then a Claude agent on opus) of a branch diff, a set of paths, or the whole codebase, against the plan and spec when they exist. Routes confidence-7+ findings through the TypeSafe judge, applies accepted fixes with one fix subagent, runs one re-review round, then hands off to finishing-a-development-branch. Use at the end of subagent-driven-development, before merge, or when asked to "review the branch", "review these files" or "review the codebase".
argument-hint: "[all | <path|glob>... | <base>] — default: branch diff vs main"
---

# Review

**Announce at start:** "Using review on `<scope description>`." — `<branch> vs <base>` in branch scope, the paths in path scope, `the whole codebase` in codebase scope.

## 0. Inputs

- `SCOPE`: the argument.
  - Empty → **branch scope**: review the diff against `BASE`.
  - `all` → **codebase scope**: review every tracked text file (`git ls-files`), no diff.
  - Anything else: if it matches tracked files (`git ls-files -- <arg>` is non-empty) → **path scope**: one or more repo-relative paths or globs, reviewed as whole files, no diff. Otherwise, if it resolves as a commit (`git rev-parse --verify "<arg>^{commit}"`) → **branch scope** with that commit as `BASE` — this is how `subagent-driven-development` invokes the skill (`review <MERGE_BASE>`). If it is neither, stop and say so.
- `BASE`: branch scope only — the commit argument if one was given, else `$(git merge-base main HEAD)`. Always validated with `git rev-parse --verify "$BASE^{commit}"`; if the block below prints `BASE invalid`, stop and ask the user for a base. Unused in path and codebase scope.
- `BRANCH`: `git branch --show-current`.
- `REPORT`: `docs/reviews/<BRANCH with / replaced by ->-<YYYY-MM-DD>.md`; path scope appends a slug of the first path (`...-<slug>.md`), codebase scope appends `-all`. If that file already exists, append `-2`, `-3`, … before `.md` — a same-day rerun and round 2 both get their own file, and `reviewer.sh` deletes its `--output` at startup, so an existing report must never be reused as the output path. Always repo-relative; `reviewer.sh` exits 1 on an absolute path. It is relative to the repo `reviewer.sh` works in, so run from the repo under review, or pass `--repo <that repo>` to `reviewer.sh`. Create `docs/reviews/` if it does not exist.
- `PLAN`, `SPEC`: the plan and the spec path from its header. Branch scope: the plan the user named, else the newest file in `docs/plans/`. Path and codebase scope: only a plan the user named, otherwise `none` — a set of files or a whole codebase is not the output of the newest plan, so never guess one. Either may be absent — send `none` rather than inventing a path.
- `LEDGER`: `.superpowers/sdd/<PLAN basename without .md>/progress.md`, when `PLAN` is a path and that file exists; otherwise `none`. This is the ledger `subagent-driven-development` keeps while it works through the plan.
- `Ledger lines:` the lines of `LEDGER` containing `Minor (deferred)`, `Ruling` or `parked` — the findings the implementation loop deferred or ruled on, which this review is the last chance to catch. `none` when `LEDGER` is `none` or no line matches. Collect them with:

  ```bash
  PLAN="<PLAN, or empty>"
  LEDGER=""
  [ -n "$PLAN" ] && LEDGER=".superpowers/sdd/$(basename "$PLAN" .md)/progress.md"
  if [ -n "$LEDGER" ] && [ -f "$LEDGER" ]; then
    grep -E 'Minor \(deferred\)|Ruling|parked' "$LEDGER" || echo none
  else
    echo none
  fi
  ```
- `ROUND`: 1.
- Locate the repo and the judge protocol: read `judge.md` from the `kickoff` skill directory (same repo, `skills/kickoff/judge.md`; locate the repo with the snippet in that file, replacing `kickoff` with `review`). Every fenced block below is one shell call, so a block that uses `$SKILLS_REPO` must run the locator itself.

Collect the inputs and the mode in one call. Substitute the real argument for the placeholder on the first line before running — a Bash tool call gets no positional arguments, so `$1` would always be empty:

```bash
SCOPE="<the skill argument, or empty string>"

BRANCH="$(git branch --show-current)"
DIRT="$(git status --porcelain -- . ':(exclude)docs/reviews' ':(exclude).context')"
if [ -n "$DIRT" ]; then MODE="report-only"; else MODE="full"; fi

BASE=""; KIND=""; SUFFIX=""
if [ -z "$SCOPE" ]; then
  KIND="branch"
elif [ "$SCOPE" = "all" ]; then
  KIND="codebase"; SUFFIX="-all"
elif [ -n "$(git ls-files -- $SCOPE)" ]; then
  KIND="paths"
  SUFFIX="-$(printf '%s' "${SCOPE%% *}" | tr -cs 'A-Za-z0-9' '-' | sed 's/^-//; s/-$//')"
elif git rev-parse --verify --quiet "$SCOPE^{commit}" >/dev/null; then
  KIND="branch"; BASE="$SCOPE"
else
  echo "SCOPE is neither tracked paths nor a commit: $SCOPE"; exit 1
fi

if [ "$KIND" = "branch" ]; then
  BASE="${BASE:-$(git merge-base main HEAD)}"
  git rev-parse --verify --quiet "$BASE^{commit}" >/dev/null || { echo "BASE invalid: $BASE"; exit 1; }
fi

mkdir -p docs/reviews
STEM="docs/reviews/$(printf '%s' "$BRANCH" | tr '/' '-')-$(date +%Y-%m-%d)$SUFFIX"
REPORT="$STEM.md"; N=2
while [ -e "$REPORT" ]; do REPORT="$STEM-$N.md"; N=$((N + 1)); done

echo "KIND=$KIND"
echo "BRANCH=$BRANCH"
echo "BASE=$BASE"
echo "REPORT=$REPORT"
echo "MODE=$MODE"
if [ "$MODE" = "report-only" ]; then printf 'report-only because the working tree is dirty:\n%s\n' "$DIRT"; fi

if [ "$KIND" = "branch" ]; then
  git log --oneline "$BASE"..HEAD | head -50
  if [ "$MODE" = "full" ]; then
    echo "diff_lines=$(git diff "$BASE"..HEAD | grep -c '')"
  else
    echo "diff_lines=$(git diff "$BASE" | grep -c '')"
  fi
else
  FILELIST="$(mktemp "${TMPDIR:-/tmp}/review-files.XXXXXX")"
  if [ "$KIND" = "codebase" ]; then
    git grep -Il '' -- . \
      ':(exclude)vendor' ':(exclude)node_modules' ':(exclude)docs/reviews' \
      ':(exclude).superpowers' ':(exclude).context' \
      ':(exclude)*package-lock.json' ':(exclude)*yarn.lock' ':(exclude)*pnpm-lock.yaml' \
      ':(exclude)*Cargo.lock' ':(exclude)*poetry.lock' ':(exclude)*composer.lock' \
      ':(exclude)*Gemfile.lock' ':(exclude)*go.sum' > "$FILELIST"
  else
    git grep -Il '' -- $SCOPE > "$FILELIST"
  fi
  echo "FILELIST=$FILELIST"
  echo "files=$(grep -c '' "$FILELIST")"
  echo "file_lines=$(while IFS= read -r f; do wc -l < "$f"; done < "$FILELIST" | awk '{s+=$1} END {print s+0}')"
fi
```

`git grep -Il ''` lists tracked text files only, so binaries never reach the prompt. Codebase scope additionally excludes vendored and generated material — `vendor/`, `node_modules/`, `docs/reviews/`, `.superpowers/`, `.context/` and lockfiles — none of which is this repo's own code; path scope reviews exactly the paths the user named, with no exclusions.

Mode depends on the working tree, ignoring this skill's and the launcher's own artifacts (`docs/reviews/`, `.context/`) — a report left behind by an earlier run must not flip the next run into report-only:

- clean (`MODE=full`) → **full mode**: review, fix wave, re-review, hand-off.
- dirty (`MODE=report-only`) → **report-only mode**: in branch scope review `git diff BASE` (working tree including uncommitted changes), in path and codebase scope review the working-tree contents of the files, so the skill is usable mid-task; the report title says `(includes uncommitted changes)`; findings are still judged and printed as decision blocks, but no fix subagent is dispatched and nothing is committed. End with the list of accepted findings for the user to apply, then stop — no hand-off to `finishing-a-development-branch`.

The block prints the `git status --porcelain` lines that caused `MODE=report-only`; show them to the user so the mode is never a surprise.

## 1. Build the prompt

Create a temp file outside the repo (under `$TMPDIR`) containing, in order:

1. The full text of `reviewer.md` from this skill's directory, verbatim.
2. A 3–6 line summary, under a scope-appropriate header. Branch scope: `WHAT WAS IMPLEMENTED:`, written from the plan and `git log --oneline BASE..HEAD`. Path and codebase scope: `WHAT IS UNDER REVIEW:`, describing what the files under review are and what they are for — nothing was necessarily "implemented", so do not claim it was.
3. The scope block, one value per line, so the reviewer knows what it is looking at:

   ```
   BRANCH: <BRANCH>
   BASE: <BASE>
   SCOPE: <branch | paths <the paths as given> | all>
   MODE: <full | report-only …>
   ```

   - `BASE:` only in branch scope; omit the line entirely otherwise.
   - `MODE: full` in full mode.
   - In report-only mode, branch scope: `MODE: report-only — the diff is the working tree vs <BASE> and includes uncommitted changes; title the report "... (includes uncommitted changes)"`.
   - In report-only mode, path or codebase scope: `MODE: report-only — the files below are the working-tree versions and include uncommitted changes; title the report "... (includes uncommitted changes)"`.
4. `PLAN: <path>` and `SPEC: <path>` — `none` for either one that does not exist.
5. `Ledger lines:` the lines collected from `LEDGER` in section 0; `none` when `PLAN` is `none` or the plan has no ledger.
6. The material under review, by scope. Every fence is longer than any backtick run in the content it wraps — use seven backticks unless the content contains a run of seven or more, then go longer still.
   - **Branch scope**: `DIFF:` followed by `git diff BASE..HEAD` (full mode) or `git diff BASE` (report-only mode) in a fence. If `diff_lines` from section 0 exceeds 6000, embed the `--stat` form instead plus the sentence `Run git diff <BASE>..HEAD yourself (full mode) or git diff <BASE> (report-only); it is too large to embed.` — name the command that produced the diff you would have embedded, so the reviewer reproduces the reviewed material and not a different one.
   - **Path and codebase scope**: `FILES:` followed by every path in `FILELIST`, each as a `### <path>` header and then that file's contents in a fence. If `file_lines` from section 0 exceeds 6000, embed the paths only (one per line, no contents) plus the sentence `Read these files yourself; they are too large to embed.`
7. On round 2 only: `Previous report:` followed by the round-1 report verbatim, then `Only report findings still present after the fixes; mark fixed ones as resolved.`
8. `Write the report to <REPORT>` on its own line — the last line of the file, in round 1 and round 2 alike. Self-check before launching: `[ "$(tail -1 "$PROMPT")" = "Write the report to $REPORT" ] || echo "prompt malformed"`. If it prints `prompt malformed`, rebuild the prompt in this order and re-check; do not launch the reviewer.

Say nothing about models or reasoning effort in the prompt — the launcher pins those.

## 2. Launch the external reviewer

Substitute the real paths for the two placeholders before running:

```bash
for d in "${CLAUDE_SKILL_DIR:-}" "$HOME/.claude/skills/review" "$HOME/.codex/skills/review"; do
  [ -n "$d" ] && [ -e "$d/SKILL.md" ] && SKILLS_REPO="$(cd "$(dirname "$(realpath "$d")")/.." && pwd)" && break
done
[ -f "$SKILLS_REPO/scripts/reviewer.sh" ] || echo "reviewer not found: SKILLS_REPO=$SKILLS_REPO"

PROMPT="<the temp prompt file from section 1>"
REPORT="<REPORT, repo-relative>"
bash "$SKILLS_REPO/scripts/reviewer.sh" --prompt-file "$PROMPT" --output "$REPORT" --title review --timeout-min 20
echo "reviewer_exit=$?"
```

- `0`: report is at `REPORT`; note which path ran (`reviewer: orca` / `reviewer: codex-exec`).
- `3`: dispatch an unnamed background Claude subagent (`general-purpose`, `model: opus`) with the same prompt file content as its prompt and the instruction to write `REPORT`. Wait for it. On a host with no subagent tool (e.g. a Codex session), do not stop: perform the review yourself in this session following `reviewer.md` exactly, write `REPORT`, and state in the report header that it was produced by the fallback reviewer, not an independent second voice.
- `1`: fix the invocation; do not proceed.
- any other exit code (e.g. `127`): the launcher was not found or could not run — treat as `1`: fix the invocation, do not proceed.

### Commit the report

In full mode, commit the report as soon as it exists — every round, whether or not a fix wave follows, and before anything else reads the working tree:

```bash
REPORT="<REPORT, repo-relative>"
git add "$REPORT" && git commit -m "docs(review): $(basename "$REPORT" .md)"
```

That keeps the tree clean for the fix wave and stops an untracked report from pushing the next run into report-only. Never edit `REPORT` — it is only ever committed. In report-only mode nothing is committed; skip this step.

## 3. Triage findings

Parse `## Findings (confidence 7+)`. For each finding, in order of severity:

Build a judge question:
- `question`: "How should the code handle: <finding text>?"
- options: `A` "Fix as proposed: apply the reviewer's fix", `B` "Fix differently: <your alternative, if you have one>", `C` "Reject: the finding is wrong or out of scope, because <reason>". Omit `B` if you have no alternative. Map each option to the judge's JSON fields: `label` is the text before the colon, `description` is the rest.
- `context`: a structured object — `goal` (what the branch delivers, one sentence), `decisions` (findings already triaged in this round), `facts` (the summary from step 1.2, the finding verbatim, the relevant spec or plan constraint, and the code excerpt the finding points at), `constraints` (the user's rules and the spec's hard limits), `consequences` (per option id: when that option would be the wrong call). Facts only — a stranger reading `facts` alone must be able to pick.
- `recommended`: your pick. It is shown to the user and never sent to the judge.

Run the judge exactly as `judge.md` says. Accepted → record the decision; unaccepted or any non-zero judge exit → ask the user with the decision block. Print every decision block in chat as it happens.

`## Ledger triage` lines marked BLOCKS MERGE are treated as P1 findings and go through the same triage.

Findings in the Appendix are not acted on; leave them in the report.

## 4. Fix wave (full mode only)

In report-only mode skip this section and section 5: print the accepted findings as a checklist for the user to apply, then stop. Nothing is committed in report-only mode.

The report is already committed by the step at the end of section 2, so the tree is clean here. Find the repo's test command, in this order: the plan's header, `CLAUDE.md` or `AGENTS.md`, then `package.json` scripts / `Makefile` targets / `pyproject.toml`. If none of them names one, say so in the hand-off and skip the suite rather than guessing.

Collect every accepted finding into one list and dispatch ONE unnamed background fix subagent (`general-purpose`, `model: opus`): give it the list, the spec path, the test command you found, and the rules "fix all of them, run the full suite, commit as `fix(review): <summary>`; do not touch anything outside the findings; do not amend or rebase existing commits". Wait for it. Verify the suite yourself with `verification-before-completion` before continuing.

If the suite is red after the fix wave, report the failing tests to the user and stop — do not start round 2 and do not hand off to `finishing-a-development-branch`.

Then record the decisions. If `PLAN` is `none` — always the case in path and codebase scope unless the user named a plan — **skip the append and its commit entirely**: print the decision blocks in chat instead and go on to section 5. There is no file to write them to, and inventing one is out of scope.

Otherwise append to `PLAN`:

```
## Review decisions (round N)
<one decision block per finding, plus "Rejected: <finding> — <reason>" lines>
```

Then commit the plan change: `git add "<PLAN>" && git commit -m "docs(plan): apply review round N"`.

## 5. Second round

Skip round 2 if the round-1 report has no P0/P1 at confidence 7+, or if the suite is red. Otherwise, if `ROUND` is 1 and at least one finding was fixed: set `ROUND` to 2, compute a fresh `REPORT` by re-running the suffix loop from section 0 (the round-1 report now exists, so round 2 gets the next `-N` name and `reviewer.sh` cannot delete the round-1 file), rebuild the prompt (section 1, reading the previous report from the round-1 path), relaunch (section 2; in Orca the same terminal session is reused via the session file, so the reviewer sees its own earlier context), and triage again. The round-2 report is committed by the step at the end of section 2, like every other round. Run one more fix wave only if a P0/P1 at confidence 7+ remains.

Stop after round 2.

## 6. Hand off

Report to the user: scope reviewed, rounds run, reviewer path used, findings fixed/rejected/asked, path of every report written (round 1 and, if it ran, round 2), and suite status.

In branch scope and full mode, then say: "Review done. Using `finishing-a-development-branch`." and invoke it. Path scope, codebase scope and report-only mode end with the summary — there is no branch to finish.

## Rules

- Never edit `REPORT`; it is the reviewer's artifact. Decisions go into the plan, fixes go into code.
- Each round writes its own report file; an existing report is never reused as `--output`.
- In full mode every round commits its report as soon as the launcher returns, fix wave or not.
- `PLAN`/`SPEC` and the ledger are branch-scope inputs; in path and codebase scope they are `none` unless the user named a plan, and the plan append is then skipped.
- Exactly one fix subagent per round; never one per finding.
- Report-only mode never commits, never dispatches a fix subagent, never hands off.
- Path and codebase scope never hand off to `finishing-a-development-branch`.
- Two rounds maximum. Residual P2/P3 are listed as deferred in the plan section above, so `finishing-a-development-branch` can show them.
