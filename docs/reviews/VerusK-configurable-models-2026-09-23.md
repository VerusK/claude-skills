# Review: VerusK/configurable-models vs b8b9813221715439f01bfb7e6dbb1189007d2b07

## Verdict

NOT READY — API-key redaction can leak the complete credential, and reviewer fallback can leave two processes writing the same report.

## Findings (confidence 7+)

[P1] (confidence: 10/10) scripts/config.mjs:152 — API keys retain surrounding whitespace, but redaction only replaces the exact unnormalized string. A local HTTP probe with `TYPESAFE_API_KEY="ts_DUMMY_SECRET_123 "` observed the header `Bearer ts_DUMMY_SECRET_123`; a 400 response echoing that credential produced `judge failed: 400 invalid key ts_DUMMY_SECRET_123` on stderr. The local-file path returns keys unchanged too. This promotes the deferred trimming issue into a credential leak — normalize or reject surrounding whitespace before constructing both the client and redactor, and add CLI error/log regression cases for both key sources.

[P1] (confidence: 9/10) scripts/reviewer.sh:205 — A timed-out round-2 Orca reviewer loaded from `--session-file` is left running because only `CREATED_HANDLE` is closed. Fallback then deletes its report and starts `codex exec` against the same output path; the original reviewer can subsequently overwrite or interleave the fallback report, or make a failed fallback appear successful. Closing the session at skill hand-off happens after the report has already been consumed. The existing test explicitly requires the reused terminal to remain open — stop the terminal owned by this review and invalidate its session before fallback, and replace that expectation with a delayed-writer regression test.

[P2] (confidence: 10/10) scripts/reviewer.sh:159 — The Orca command interpolates validated values without shell quoting, although the accepted token grammar explicitly includes square brackets. Replaying the generated command with `gpt-test[1m]` under `zsh -f` fails with `no matches found` before Codex runs; under shells that expand a matching filename it can select a different argument. The array-based exec path does not have this problem — shell-quote each model/reasoning argument when building the Orca command and test execution through a shell, rather than only inspecting the fake Orca call log. The plan's single-token rule is insufficient to preserve arguments.

[P2] (confidence: 10/10) README.md:195 — The documented key setup truncates the shared local configuration file. Following it after setting `codex` or `judge` overrides silently deletes those settings and changes subsequent review behavior; for a new file, secret bytes are also written before restrictive permissions are applied — document merging `typesafe.apiKey` into an existing JSON object, and create a new file with mode 0600 from the outset. This destructive recipe is present in the plan as well.

## Appendix (confidence below 7)

None

## Plan alignment notes

The findings above include defects carried over from the plan: exact-string key redaction, the inherited fallback ownership rule, shell interpolation, and the key-setup recipe need correction in both implementation and guidance. No additional issues found in code separation or the specified precedence/dispatch wiring. `npm test` passed all 245 tests with no skips, but lacks the whitespace-key and shell-execution cases and asserts the unsafe reused-terminal behavior. Both updated patches reconstruct their corresponding skill files exactly. Live plugin dispatch/model/effort acceptance remains unverified; step 16 does not explain how local edits reach the GitHub-installed plugin.

## Ledger triage

1. OK — T6/T7/T8 shared-file ruling: the final files retain the dispatch, session and triage changes together.
2. OK — T3 staging ruling: the old reviewer config is deleted in the reviewed branch.
3. OK — T4 copied-config ruling: the isolated SDK fixtures include the new module/config dependencies and pass.
4. OK — Task 1 missing filename in validation errors: diagnostics still identify the affected field without exposing its value.
5. OK — Task 1 unreachable final defaults: required repository values supply the defaults; the misleading test title does not change resolution.
6. BLOCKS MERGE — Task 1 untrimmed API key/judge model: the API-key case demonstrably bypasses redaction, as reported above.
7. OK — Task 1 secret-key substring matching: conservative rejection does not reject any supported schema field.
8. OK — Task 1 failed stat treated as secure: this affects the advisory permissions warning after a successful read, not credential resolution.
9. OK — Task 1 missing depth-3 plain-object test: recursive traversal is implemented and nested object/array cases exercise it.
10. OK — Task 2 inherited HOME: the generator currently reads only its repository configuration; isolate HOME as test hardening.
11. OK — Task 2 duplicate frontmatter keys: this is a malformed hand-edited definition; rejecting duplicates can be added separately.
12. OK — Task 2 non-atomic multi-file writes: the promised no-write behavior covers validation failures, which occur before writes; partial I/O failures remain visible through drift checks.
13. OK — Task 2 weak lost-effort test: the adjacent malformed-file test includes a pending valid change and checks all files.
14. OK — Task 2 weak error-prefix assertions: the config tests separately check field-specific validation diagnostics.
15. OK — Task 3 marker accepted on any line: the producer contract explicitly requires one occurrence at the end; stricter consumer validation is follow-up hardening.
16. OK — Task 3 CRLF/trailing-space marker rejection: the report contract requires the exact marker line; mismatches fail closed into fallback.
17. OK — Task 3 partial report retained without Codex: the launcher returns 3, requiring the caller to obtain a fallback report rather than treating the partial file as success.
18. BLOCKS MERGE — Task 3 session-loaded terminal survives fallback: it can race the fallback writer and corrupt the report consumed by triage.
19. OK — Task 3 failed session-file write: shell redirection does emit an error, although exit status is not propagated; skill-generated paths use the already-created `.context` directory.
20. OK — Task 3 unchecked short config output: the shipped CLI emits exactly two lines on success and exits nonzero on validation failure.
21. OK — Task 3 stale exit-code header: diagnostic documentation is incomplete, but config errors return the intended nonzero code.
22. OK — Task 3 unchecked first-run statuses: dedicated success/session tests cover those paths; stronger setup assertions are nonblocking.
23. BLOCKS MERGE — Task 3 square-bracket globbing: accepted values do not survive the Orca shell command literally, as reproduced above.
24. OK — Task 4 missing positive logging assertions: runtime wiring forwards the selected level; add positive stderr assertions to make these tests sensitive to logging being disabled accidentally.
25. OK — Task 4 misplaced helper comment: readability issue only.
26. OK — Task 4 invalid log level: an invalid environment option fails explicitly; it is not a value from either config JSON, and the resolved key still passes through error redaction.
27. OK — Task 4 masked header suffix: the SDK exposes a masked identifier, not the full credential; the full-key whitespace leak is tracked separately above.
28. OK — Task 5 differing symlink normalization: preflight resolves relative targets before mutation, and `isUnder` includes a path boundary; raw reporting/uninstall normalization can be improved separately.
29. OK — Task 5 incomplete idempotency assertions: the same-target branch exits before recording replacement/repointing.
30. OK — Task 5 malformed local config reported as missing key: misleading diagnosis, but it neither exposes the key nor falsely reports it available.
31. OK — Task 5 raw EEXIST in linkAgents: the CLI preflight rejects occupied regular files before any installation writes.
32. OK — Task 5 0644 key fixture: installer key resolution does not emit the judge's permissions warning; the judge warning has its own integration test.
33. OK — Task 6 stale same-model language: re-dispatching the same implementer agent type preserves its configured model and does not require a model override.
34. OK — Task 6 incomplete Model Selection assertions: all concrete dispatch sites have explicit agent-type/no-model contract checks.
35. OK — Task 6 missing broad stale-wording guard: reviewed dispatch sites no longer pin Opus; a wider text guard is optional.
36. OK — Task 6 kickoff's same-prompt wording: the surrounding instruction defines broad repository lookups; the controller can supply that task to either host.
37. OK — Task 7 SESSION-printing ruling: both launch blocks print the value and cleanup blocks explicitly consume it.
38. OK — Task 7 overly broad hand-off test slice: cleanup commands exist in the hand-off blocks themselves; narrow the assertion as test maintenance.
39. OK — Task 7 untested early-stop cleanup: report-only and red-suite branches explicitly invoke the closing block.
40. OK — Task 7 irrelevant plan-review stop cases: extra cleanup cases do not introduce a new executable path.
41. OK — Task 7 try/finally and inherited Git HOME: the test cleans its temporary repository; isolate Git configuration for portability.
42. OK — Task 7 error bullets omit cleanup: the general stop rule covers cleanup, while invocation errors instruct the caller to repair and retry.
43. OK — Task 8 stale summary outcome names: decision recording and the fix-list logic handle both new outcomes; summary labels can be updated separately.
44. OK — Task 8 code-centric evidence placeholder: file/line evidence also applies to plan errors and does not restrict other concrete evidence.
45. OK — Task 8 removed consequences sentence: equal specificity remains required locally and the stronger instruction remains in judge.md.
46. OK — Task 8 SDD wording/repatch concern: case-insensitive collection accepts the older capitalization, and both regenerated patches exactly match the current skills.
47. OK — Task 9 misplaced legacy-session note: documentation flow issue without a changed uninstall command.
48. BLOCKS MERGE — Task 9 key printf/permissions recipe: it destroys existing overrides and writes secret bytes before setting mode 0600.
49. OK — Task 9 acceptance reinstall/revert ambiguity: a revert command is now present; the remaining source/install ambiguity must be clarified before using this step as acceptance evidence.
50. OK — Task 9 plugin users lack a direct key-setup pointer: the shared key source is described in Decisions and reviewers; a nearby install link is a documentation improvement.
51. OK — Task 9 local pin versus GitHub plugin: the checklist cannot validate a local pin until it identifies a local plugin source or published revision; no passing result is claimed for this added step.
<!-- end of review -->
