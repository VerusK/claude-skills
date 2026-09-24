# Review: VerusK/spec-review vs feb57ba8deccac6e093fa8099c7bdb89157534ac
## Verdict
READY WITH FIXES — the 282-test suite passes, but the routing conflict, reviewer blind spot, and missing acceptance evidence need resolution.
## Findings (confidence 7+)
[P2] (confidence: 9/10) USING.md:17 — “Never skip `spec-review`” applies to bounded and spike tasks, while kickoff's bounded path writes no spec and goes directly to `test-driven-development`; invoking the new skill without an argument can review the newest unrelated spec — qualify this rule for the architectural path and state the bounded/spike exceptions.
[P2] (confidence: 9/10) skills/spec-review/reviewer.md:1 — the reviewer is forbidden to read `agents/`, yet lines 10 and 35 require verification of every referenced source claim; the current spec references `agents/verus-reviewer.md`, so that claim cannot be checked — allow reading repository agent definitions as source files, or explicitly exempt those claims from the verification requirement.
[P2] (confidence: 9/10) docs/plans/2026-09-24-spec-review.md:1004 — the plan requires eleven fresh-session acceptance scenarios and a committed `docs/plans/2026-09-24-spec-review.acceptance.md`, but that artifact is absent; string-contract tests do not verify the skill's actual triage and approval flow — run the scenarios and record expected versus observed results before merge.
[P2] (confidence: 9/10) docs/plans/2026-09-24-spec-review.md:1017 — acceptance scenario 10 reuses scenario 5, whose contradiction is against a `user` decision and bypasses the judge by design; it cannot establish the judge-unavailable fallback — use an independent finding with two reasonable fixes that reaches the judge, then verify the unavailable message and user question.
[P2] (confidence: 8/10) scripts/reviewer.sh:165 — `--repo` accepts a relative directory, but the new Orca selector forwards it as `path:<relative>`, which Orca resolves outside the caller's working directory and can open the wrong checkout or fall back needlessly — normalize `REPO` with `cd "$REPO" && pwd -P` before constructing the selector and add a relative-`--repo` test.
## Appendix (confidence below 7)
None
## Plan alignment notes
The skill, kickoff hand-off, and launcher marker check follow the design. The plan's required manual acceptance is missing, and its judge-unavailable scenario cannot exercise the intended branch. The blanket routing rule and source-reading ban conflict with the spec's bounded-path exception and repository-verification requirement.
## Ledger triage
Task 1, user-edit round-2 summary: OK — the missing counts and round-1 path are a reporting detail.
Task 1, residual P2/P3 wording: OK — section 3 still directs triage of every confidence-7+ finding.
Task 1, realpath-missing hint: OK — the command fails with a diagnostic before review starts.
Task 2, findings heading/template tests: OK — the prompt contains the required headings; these are test-strength gaps.
Task 2, NOTICE line wrap: OK — formatting only.
Task 2, reviewer ban on `agents/`: BLOCKS MERGE — it prevents verifying a source claim in the current spec.
Task 3, kickoff negative assertions: OK — the positive architectural hand-off is covered.
Task 3, unchanged spike-path guard: OK — no spike-path code changed.
Task 4, stale plugin-acceptance counts: OK — outside the implementation path; update the documentation separately.
Task 4, README wording/diagram assertions: OK — documentation is present despite limited pinning.
Task 4, README step-2 basename wording: OK — the adjacent-spec report path remains understandable.
Task 5, unchecked partial-report move: OK — failure still exits 3, though the diagnostic may be inaccurate.
Task 5, unmanaged-repo fallback test: OK — the fallback branch is explicit; manual acceptance can cover it.
Task 5, Orca last-line test coverage: OK — both paths call the same `report_complete` function.
Task 5, relative `--repo`: BLOCKS MERGE — the new Orca selector can target a different path.
Task 5, stale reviewer.sh exit header: OK — comment only.
Task 5, partial-report stderr omits log path: OK — the partial path is reported and the log remains at its documented location.
<!-- end of review -->
