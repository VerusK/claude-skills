# Review: VerusK/scorpionfish vs e1defcd0586439b342890ff3fb47c40e92a8c07e

## Verdict

READY WITH FIXES — three sync defects need correction despite all 327 tests passing; live upstream synchronization and agent adherence remain unverified.

## Findings (confidence 7+)

[P2] (confidence: 10/10) scripts/sync.mjs:383 — A patch-generation failure discards the new pin even after syncSource has successfully updated vendor, skills and sources.lock.json: repatch shares the same catch, which unconditionally deletes pins[s.name]; fault injection against the actual main function left YAML at commit A and the lock at B, so the new consistency test fails and a subsequent ordinary sync can revert upstream content — separate sync failure from repatch failure, preserve and persist the pin once syncSource succeeds, and add an orchestration regression test for this case.

[P2] (confidence: 10/10) scripts/sync.mjs:364 — All upstream refs are resolved before entering the per-source error handler; one unavailable or removed repository makes updatePins throw, preventing healthy sources from syncing and preventing .sync-report.md from being generated, regressing the previous per-source failure isolation in the weekly workflow; an injected failure on the first source confirmed the healthy second source was never visited — resolve each source inside its own error boundary, report the failure and continue with the remaining sources, with a mixed-success orchestration test.

[P2] (confidence: 10/10) scripts/sync.mjs:35 — SPDX_RE checks token shape rather than SPDX validity: validateSources accepts Definitely-Not-A-License, (MIT and MIT), while rejecting the valid nested expression ((MIT OR Apache-2.0) AND BSD-2-Clause); consequently the advertised SPDX check permits invalid license metadata and can block legitimate additions — validate recognized license identifiers and expression grammar with an SPDX parser or restrict this field to verified SPDX identifiers, and test unknown identifiers plus malformed parentheses.

## Appendix (confidence below 7)

None

## Plan alignment notes

No plan given

## Ledger triage

None

## Not verified and why

- Live GitHub ref resolution, pinned tarball downloads, upstream LICENSE contents and the scheduled GitHub Actions PR flow were not exercised; verification used local code, injected failures and the repository suite, without network-dependent synchronization or changes to upstream pins.
- Kickoff decisions and worker/controller reporting were inspected as prompt text and checked by the existing structural tests; no live agent workflow was dispatched, so actual adherence to the new instructions is unverified.
- All 20 changed-file diffs were reviewed; unchanged portions of the larger documentation, skill files and patch files were sampled for surrounding behavior rather than audited in full. Both changed patch records were independently compared with vendor-to-skill diffs, and all nine vendor hashes matched their lock entries.
- The report title uses the supplied BRANCH label; the checkout identifies itself as VerusK/ai-benchmark-kickoff-filter. Review covered its base-to-HEAD changes, which match the supplied implementation scope, rather than independently checking out VerusK/scorpionfish.
- The existing tests do not cover main's mixed-source resolution failures or its post-sync repatch failure path; those paths were checked with injected failures, including an in-memory execution of the actual orchestration function. No regression tests were added because this task permits only the report to be edited.

<!-- end of review -->
