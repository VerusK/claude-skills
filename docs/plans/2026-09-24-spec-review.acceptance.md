# spec-review — acceptance run

Date: 2026-09-25. Branch `VerusK/spec-review` at `3780a5c`, installed with `make install ARGS=--skip-plugin` from this worktree.

Method: each scenario ran in a fresh headless session (`claude -p --model opus --dangerously-skip-permissions`) inside its own scratch git repo, so the SessionStart hook and the installed skill were exercised as in a real session. Questions the skill asked were answered by resuming the same session. The fixture repos lived in the controller's session scratchpad and were not committed.

| # | Scenario | Expected | Observed | Result |
|---|---|---|---|---|
| 1 | Empty `docs/specs/`, no argument | Stop with a message; no reviewer, no session file | Stopped at SPEC selection with "no spec"; no reviewer launched, nothing written | pass |
| 2 | Absolute spec path | Report beside the spec at `docs/specs/2026-01-01-a-design.review.md`, ends with the marker | Report at that repo-relative path, last line `<!-- end of review -->`; triage ran (`codex-exec`, Orca cannot open a terminal in an unmanaged repo) | pass |
| 3 | Seven-backtick run inside the spec | Prompt fence of 8+ backticks | Prompt file `spec-review-fence-round1.prompt.md`: opening and closing fences of 8 backticks around the 7-backtick line | pass |
| 4 | No Decisions section | `### 5. Decisions` says `No Decisions section`; no `Decisions:` finding | Exactly that | pass |
| 5 | Finding against a `user` decision | Question to the user naming the decision; no judge block for it | P0 finding against "1. Report location — `user`" asked directly with four options and a recommendation; judge not called for it | pass |
| 6 | Change request at approval (branch clone; round 2 had already run) | No new reviewer run; approval question names the unreviewed edits; no `writing-plans` | Non-goals edit committed alone (`docs(spec): apply user changes after spec-review`); no relaunch; approval question listed the edit and the round-2 changes no reviewer saw; `writing-plans` not invoked | pass |
| 7 | Clean spec → CLEAR (real Codex) | CLEAR path | Codex reported a P1 (no `VERSION` file) — CLEAR not reachable with a real reviewer on this fixture | replaced by 7b |
| 7b | Same spec, fake `codex` that always writes a CLEAR report | No decisions section, no commit, summary says CLEAR, approval question follows | Exactly that; spec unchanged, no commit, approval question printed | pass |
| 8 | No `orca`, no `codex` on PATH | `reviewer.sh` exits 3; `verus-reviewer` fallback writes the report; no "fallback" header while a subagent tool exists | `reviewer_exit=3`, `verus-reviewer` dispatched (transcript), report without the fallback header | pass (the final chat message loosely said "inside this same session") |
| 9 | Launch fails (`--timeout-min 0` patched into the installed SKILL.md, restored afterwards) | `reviewer.sh` exits 1; skill stops without triage | `reviewer_exit=1` with `--timeout-min must be a positive integer`; the agent then "fixed the invocation" (timeout 9) and relaunched, `reviewer_exit=0`, and triaged | differs — see note 1 |
| 10 | Judge unavailable (invalid key via `--settings`) | Every judge-able finding asked with `TypeSafe judge unavailable: …`; nothing auto-accepted | `TypeSafe judge unavailable: judge failed: 401 …`, all findings asked | pass (see note 2) |
| 11 | P0 contradiction → round 2 | Round 1 at 7+, fix, `<REPORT>.round1.md` kept, round 2 with the same session | Round 1: P0 + 2×P1 + 2×P2; after the answer, commits `apply spec-review round 1` and `round 2`, `.review.md.round1.md` kept, round 2 marked round-1 fixes resolved | pass |
| Orca | `reviewer.sh` in this Orca-managed worktree with a two-line prompt | Terminal opens in this worktree (`--worktree path:<repo>`), report accepted with the marker last | `reviewer: orca`, report `orca acceptance ok` + marker at `.context/acceptance-orca-report.md` | pass |

## Notes

1. **Exit 1 is read as "fix and retry".** `skills/spec-review/SKILL.md` §2 says "`1`: fix the invocation; do not proceed." The agent fixed the flag and relaunched — a reasonable reading, but it chose an arbitrary timeout (9) instead of the skill's 15. The same wording is in `plan-review` and `review`. Candidate follow-up: "fix the invocation to match this section's command exactly, then relaunch once; if it fails again, stop."
2. **The judge key in `~/.claude/settings.json` `env` overrides the process environment** inside a Claude session, so `TYPESAFE_API_KEY=… claude` does not change the key the judge sees; `--settings '{"env":{…}}'` does. Not a skill defect; worth knowing when testing.
3. **Headless sessions kill background reviewers.** In the first scenario-6 run the agent launched `reviewer.sh` with `run_in_background` and the `-p` session ended before it finished. Rerun with a "foreground only" note passed. Interactive sessions are not affected.
4. **Judge block without a recommendation.** In scenario 2 one judge block showed `Рекомендация Claude: —`: the agent omitted `recommended` for a product question. Minor deviation from §3.
5. **Dogfooding.** Scenario 6 ran `spec-review` on this branch's own spec (in a clone): 9 + 8 findings over two rounds. With "take your recommendation" answers it proposed design changes — stop with "external review unavailable" on a host without subagents instead of self-review; approve only the version the last reviewer saw (a new cycle after any edit); keep the session file when a terminal could not be closed. These changes are in the clone only and are **not** applied to this branch.
