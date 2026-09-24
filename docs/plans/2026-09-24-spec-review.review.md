# Plan review: spec-review Implementation Plan
## Verdict
NEEDS CHANGES — the revised plan still permits a review of the wrong repository and can miss defects introduced by a later spec edit.
## Findings (confidence 7+)
[P1] (confidence: 8/10) Acceptance scenarios 1–5 and Task 1 §2 (.context/plan-review-prompt.md:1043-1053; scripts/reviewer.sh:164,182) — The scratch repo scenarios assume the reviewer runs in `$S`, but the Orca path creates a terminal in Orca's `active` worktree, independent of `TOP` or `--repo`; with Orca reachable, it can read the prompt and write the report in another checkout, then time out or review the wrong files — ensure the Orca worktree matches `TOP`, or route external repositories through `codex exec -C "$TOP"`; verify the report and reviewed repo in a scratch-repo scenario with Orca available.
[P1] (confidence: 9/10) Task 1 §§1, 6 (.context/plan-review-prompt.md:312,407) — The re-review after a user's Goal/Design change is told to “Only report findings that are still present after the spec changes,” so a new defect introduced by that change is out of scope for the second report — instruct round 2 to assess the entire revised spec and report both unresolved old findings and new findings; check this with a changed spec that introduces a new contradiction.
[P1] (confidence: 9/10) Task 1 §§4, 6 (.context/plan-review-prompt.md:382,407) — Both `git commit -am` commands commit every modified tracked file, so standalone `spec-review` in a dirty checkout can include unrelated user work in the spec-review commit; they also skip an untracked standalone spec — stage and commit only `SPEC`, and check the spec's tracked/clean state or handle an untracked spec explicitly.
[P2] (confidence: 9/10) Task 5 result check (.context/plan-review-prompt.md:989-1001; scripts/reviewer.sh:133) — `report_complete` uses `grep -qxF`, which succeeds when the marker appears anywhere, although the prompt and Task 5 comment require it as the last line; a report with the marker followed by incomplete text still exits 0 — require the marker as the final line on both reviewer paths and add a fake Codex case with trailing text after the marker.
[P2] (confidence: 8/10) Task 1 §0 (.context/plan-review-prompt.md:291-296) — The outside-repository check resolves only the parent directory, so a spec symlink inside the repo that targets a file outside it passes and sends that file to the external reviewer — resolve the spec file itself before deriving `TOP` and `REPORT`, then reject an escaped target or explicitly allow it with a test.
[P2] (confidence: 8/10) Task 1 tests and Acceptance (.context/plan-review-prompt.md:148-202,1043-1053) — The new manual scenarios cover the five original Review Focus cases but do not exercise the CLEAR no-commit branch, launcher exit 3 fallback, failed launch, judge unavailable, or a P0/P1-triggered second round; string checks cannot verify those behaviors — add scripted scenarios with those inputs and expected output, report/commit state, and hand-off behavior to the acceptance table.
## Appendix (confidence below 7)
None
## Section notes
### 1. Architecture
The first-round findings about absolute paths and post-review edits are addressed. The remaining repo-selection failure crosses the local file boundary; the second-round prompt can miss new requirements defects. The flow is linear enough without a new plan diagram. Release remains an explicit non-goal, while plugin descriptions and install documentation are covered.
### 2. Code quality
The CLEAR branch and README drift from round 1 are addressed. The path-wide commit and symlink handling need explicit boundaries. Orchestration still duplicates `plan-review`, but the sibling-skill design is a stated constraint and does not itself require a new abstraction.
### 3. Tests
The repository uses `node:test` through `npm test`. Task 5 now tests a missing marker, and the six manual scenarios cover the original focus cases. They leave the branch and failure paths named above unverified; add concrete expected report, commit and hand-off outcomes for each.
### 4. Performance
No issues found. The review is outside a hot path, source references are capped at 40, and the plan allows at most two 15-minute reviewer launches.
<!-- end of review -->
