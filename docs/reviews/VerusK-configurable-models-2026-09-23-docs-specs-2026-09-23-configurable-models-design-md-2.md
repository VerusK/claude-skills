# Review: docs/specs/2026-09-23-configurable-models-design.md

## Verdict

READY WITH FIXES — the revised session lifecycle still needs genuinely unique review-run identifiers and cleanup for successful launches without a session file.

## Findings (confidence 7+)

[P1] (confidence: 9/10) docs/specs/2026-09-23-configurable-models-design.md:166 — §4.6 derives the supposedly per-run session filename from the round-1 report stem, but skills/plan-review/SKILL.md:14 uses the same report path every time a plan is reviewed; if the previous review stops after its successful first round but before --close-session, a new review of that plan selects the same live handle and inherits its old model, contrary to the fresh-terminal guarantee. The proposed reuse test cannot distinguish this new review from round 2 — allocate a fresh run identifier or mktemp session path at the start of each review, retain it only for that review's rounds, and test restarting the same plan review with changed settings while its previous session file and terminal remain alive.

[P2] (confidence: 9/10) docs/specs/2026-09-23-configurable-models-design.md:165 — §4.6 creates a fresh terminal for every invocation without --session-file but specifies closure only for failures or through --close-session <file>; a successful invocation has no session file for that cleanup command, and the existing success path in scripts/reviewer.sh:174–177 exits before terminal cleanup. Repeated standalone reviews therefore accumulate live terminals, contrary to decision 13's cleanup requirement — explicitly close the terminal created by a successful invocation when no session file was supplied, preserve explicit sessions until --close-session, and extend §5's two-invocation test to assert both terminals are closed.

## Appendix (confidence below 7)

None

## Plan alignment notes

No plan given. Resolved at design level: round-1 finding 2 (Codex dispatch), finding 3 (secret redaction), finding 4 (agent-name collisions), finding 5 (Opus alias caveat), and finding 6 (Node-free fallback). Finding 1 (Orca session reuse) remains partially resolved as detailed above; keeping round 1's model within the same review is now an explicit accepted decision. Correctness, code quality, tests, production compatibility, and unnamed/background dispatch were evaluated. Baseline npm test passed all 181 tests, with no failures or skips; the proposed implementation remains untested.

## Ledger triage

None
