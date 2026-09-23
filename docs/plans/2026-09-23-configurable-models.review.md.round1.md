# Plan review: Configurable Models, Effort and TypeSafe Key Implementation Plan

## Verdict

NEEDS CHANGES — The proposed implementation has configuration and lifecycle defects, and the specified tests cannot pass without changes omitted from the plan.

## Findings (confidence 7+)

[P1] (confidence: 9/10) Task 1 Step 4 and Task 3 Steps 6–7 — Codex values accept arbitrary non-empty strings, but the CLI transports them as two newline-delimited records and the Orca launcher interpolates them into command text: a model of `gpt-test\nlow` changes the resolved reasoning to `low`, while spaces can introduce extra command arguments — Validate resolved values from repo, local file and environment before transport, reject control characters, and quote each Orca command argument independently; add `node:test` cases for newline-bearing values and spaces/metacharacters, asserting a field-only failure or faithful single-argument transport in both launcher paths.

[P1] (confidence: 9/10) Task 1 Step 4, `findSecretKey()` — The recursive secret check returns immediately for arrays, so an otherwise valid config with `extra: [{ apiKey: "ts_DUMMY_SECRET_123" }]` passes validation and the committed-config test, violating the any-depth secret prohibition — Traverse arrays as well as objects, or reject unsupported structures; add `validateModels rejects secret fields inside nested arrays`, including mixed-case keys, and assert rejection without printing the value.

[P1] (confidence: 9/10) Task 5 Step 3; scripts/install.mjs:29 — Agent collision detection reuses `isDistroCheckout()`, which treats every nonexistent directory as this distro: a foreign dangling link to `/missing/agents/verus-worker.md` is accepted and overwritten — Require evidence of agent-link ownership instead of inferring it from a missing root; add an installer case with that exact tail shape and assert exit 1, unchanged link, and no installation writes with or without `--force`.

[P1] (confidence: 8/10) Task 3 Step 7; scripts/reviewer.sh:110 — Session-less success now closes the terminal immediately after two equal file-size polls; the existing code explicitly says `tui-idle` can precede review completion, so a reviewer that pauses over five seconds between report writes can be killed with a partial report accepted as complete — Establish an explicit completion signal before closing the terminal; extend the Orca fixture to write a report in chunks separated by more than one polling interval and assert the complete report exists before `terminal close` occurs.

[P1] (confidence: 9/10) Task 4 Step 5 and Task 5 tests; tests/judge.test.mjs:419 and tests/install.test.mjs:338 — Only the vendor-SDK copies are updated for the new static import: the missing-judge-config test still copies the judge alone, and `distroRepo()` still copies the installer alone; both now fail at module loading with missing `config.mjs`, before their intended behavior — Update every standalone script fixture to carry its transitive dependencies; preserve the deliberately absent `judge.json` in its negative test, and include agent fixtures in copied installer checkouts so reinstall/uninstall behavior is exercised end to end.

[P1] (confidence: 9/10) Task 4 Step 1; scripts/typesafe-judge.mjs:162 — The new model-forwarding test returns `answer: { A, B }` and `sufficiency: { yes, no }`, but `judge()` requires `answer.choice`, `answer.confidence`, `answer.probabilities` and `sufficiency.noul`; its first awaited call throws before either model assertion — Use the response shape already established by `tests/judge.test.mjs`, then assert both explicit-model forwarding and omission when no model is supplied.

[P1] (confidence: 9/10) Task 4 Step 1; tests/judge.test.mjs:310 — Appending `runJudge()` leaves the existing CLI helper inheriting the real HOME, and leaves the existing missing-key test expecting `TYPESAFE_API_KEY is not set`; the new loader reads the user's local secret file and the changed guard makes that assertion fail even on a clean machine — Move all judge CLI invocations onto temporary HOME directories, sanitize model/key overrides, update the old guard assertion, and retain a case where a temporary local key exists but no environment key does.

[P1] (confidence: 9/10) Task 8 Step 5; skills/plan-review/SKILL.md:70 — Triage changes to two through four genuine alternatives, but section 4 still says to apply only accepted `A`/`B` decisions; a selected fix under `C`/`D`, or a finding accepted without the judge, has no consistent application rule — Apply the chosen action regardless of option ID, explicitly include unjudged fixes, and distinguish “leave as is” by its action rather than its letter; extend the contract test to inspect section 4 and reject the old A/B-only rule.

[P2] (confidence: 9/10) Task 7 Step 3; skills/review/SKILL.md section 0 — Close-at-start cannot recover an interrupted code review after its first report exists: the next invocation selects a new `-N` report, derives a different SESSION, and closes that nonexistent session while the earlier terminal remains open — Persist a discoverable active-session reference for the review scope, or define explicit interrupted-review recovery; add a sequence test that completes round 1, omits final cleanup, computes the next report name, and verifies the old handle is closed before the new review starts.

[P2] (confidence: 9/10) Task 4 Step 1 — The local-key CLI test checks only exit 2 and absence of the script's guard text; it still passes if the SDK never receives the key, and the redaction test calls only `failureMessage()`; no planned test proves successful CLI resolution reaches the real SDK request — Add a local HTTP fixture server and asynchronous child-process tests: `CLI sends local key and resolved model` must observe the Authorization header and model and return valid output with exit 0; repeat with environment overrides, and return an error containing the dummy key to verify actual stderr redaction and exit 2.

[P2] (confidence: 8/10) Tasks 1–3, planned failure-path tests — Several newly specified branches have no behavioral coverage: non-ENOENT local read failures, root/section arrays and empty local fields, missing agent files/frontmatter/model lines, and closing an already-dead terminal; the current fake Orca always succeeds at close — Add table-driven `node:test` cases for invalid local shapes and a directory at the local-config file path (field/file-only errors), missing/malformed agent files after a pending valid change (exit 1 and all agent bytes unchanged), and a fake close failure representing an already-dead terminal (exit 0 and session file removed).

[P2] (confidence: 9/10) Task 9 Steps 1–2; README.md sections The flow, Decisions and reviewers, Skills, and From a checkout — Adding the new settings section leaves existing claims that every subagent runs on Opus, the key comes only from the environment, and occupied install names are skipped; the flow diagram also retains `opus subagents` — Update these existing descriptions alongside the new section, distinguish skill-name skipping from agent-name refusal, and describe the configured agent tiers consistently throughout the README.

## Appendix (confidence below 7)

None

## Section notes

### 1. Architecture

The config-to-launcher boundary permits malformed transport and extra arguments; the config-to-validator boundary misses array-contained secrets; installer ownership detection can replace foreign dangling links. Agent generation prevalidates missing fields before writing, but sequential write failures can still leave partial updates, so its “nothing on any error” comment overstates the guarantee. Missing/broken local config and SDK unavailability have defined failure paths. Review completion and interrupted-session recovery remain incomplete; a short lifecycle diagram should identify create, persist, reuse, completion, fallback and close transitions. Generated agents have a build command and an existing release mechanism, but plugin discovery and effective model/effort remain manual acceptance checks.

### 2. Code quality

The A/B-only application rule and stale README descriptions contradict the new behavior. The installer extends a skill-specific ownership heuristic to a stricter agent collision contract without adapting it. Repeated fixture construction has already missed two imported-script consumers; share fixture setup within each test suite. Review launch/cleanup blocks repeat locator and session reconstruction logic, making the changing-report-name recovery error easier to introduce.

### 3. Tests

Assessment is static; no tests or builds were run. The framework is `node:test` with `node:assert/strict`. Paths traced: config read/parse/shape/precedence/redaction/CLI; generation validate/render/write/drift; launcher resolution/default flags/no-Node fallback/session create/reuse/close; judge resolution/guard/SDK request/error output; installer preflight/link/repoint/unlink/key check; dispatch instructions; review round/stop handling; ledger collection and triage. Planned tests cover the main happy paths, but the broken fixtures/mock, inherited HOME, unverified SDK request, failure branches and session sequencing need the concrete cases above. Text-presence assertions establish dispatch wording, not runtime model selection or cleanup ordering; the manual host checks remain necessary.

### 4. Performance

No issues found. Config reads are bounded startup work, generation handles three agents, and the plan adds no material request fan-out, unbounded polling, or growing in-memory collections; terminal retention problems are addressed as lifecycle findings above.
