# Review: docs/specs/2026-09-23-configurable-models-design.md

## Verdict

NOT READY — the design leaves model changes ineffective in reused sessions, breaks the shared dispatch contract, and omits credential-safe error handling.

## Findings (confidence 7+)

[P1] (confidence: 10/10) docs/specs/2026-09-23-configurable-models-design.md:128 — §4.6 changes Codex launch flags but ignores existing Orca sessions: scripts/reviewer.sh:140 reloads the saved terminal handle and skips terminal creation, so changing config or setting a one-run override still sends the review to the previously configured Codex process; tests/reviewer.test.mjs explicitly preserves this reuse — define configuration-aware session reuse, start a fresh session when settings change, and test consecutive invocations with different model/effort values, including explicit-to-default transitions.

[P1] (confidence: 8/10) docs/specs/2026-09-23-configurable-models-design.md:99 — §§4.4/4.6 replace every shared dispatch instruction with Claude-only subagent_type identifiers, while §2 excludes Codex agent configuration and the Codex manifest installs the same skills without these agent definitions; a Codex caller has no specified way to translate verus-skills:reviewer into a supported native agent, and the replacement USING.md rule compounds that mismatch — scope these identifiers to Claude, retain an explicit native Codex dispatch path without adding model configuration to scope, and test both hosts' instructions while preserving unnamed background execution.

[P1] (confidence: 8/10) docs/specs/2026-09-23-configurable-models-design.md:140 — §4.7 specifies malformed local JSON handling but no redaction contract for the newly secret-bearing file; scripts/typesafe-judge.mjs:253 and :260 print err.message verbatim, and a local Node reproduction with an unquoted dummy apiKey showed JSON.parse including key text in its error message — require loadLocal to replace parser errors with a filename-only diagnostic, prohibit configuration values in validation errors, limit the codex CLI output to Codex fields, and test that dummy secrets never appear in stdout/stderr on failure.

[P2] (confidence: 9/10) docs/specs/2026-09-23-configurable-models-design.md:129 — §4.6 copies the installer's skip-foreign-files policy for generic agent names without handling the resulting dispatch collision: an existing worker.md is retained, but the installed skill still requests worker and can execute the foreign agent's prompt/model instead; project definitions can also override user definitions under Claude's [scope precedence rules](https://code.claude.com/docs/en/sub-agents#choose-the-subagent-scope) — use distro-specific bare identifiers, fail clearly when a required identifier is occupied, and add an acceptance test proving a collision cannot silently route work to a foreign agent.

[P2] (confidence: 9/10) docs/specs/2026-09-23-configurable-models-design.md:113 — §§3/4.5 promise that opus automatically selects the newest family version, but Claude's [model resolution rules](https://code.claude.com/docs/en/sub-agents#choose-a-model) retain the parent's exact model when the parent belongs to that family; a session pinned to an older Opus therefore keeps its subagents on that version despite the claimed automatic upgrade — document the parent-model dependency and explicit-ID option, and include a pinned-parent case in manual acceptance.

[P2] (confidence: 9/10) docs/specs/2026-09-23-configurable-models-design.md:128 — §4.6 makes configuration resolution depend on Node without deciding the existing Node-free fallback: scripts/reviewer.sh:45–50 deliberately disables only Orca when NODE is unavailable, and two reviewer tests require codex exec to remain usable; an unconditional config.mjs call would regress that supported path — specify either an env/default-only fallback with a diagnostic or an intentional Node prerequisite with migration documentation, and update the existing tests accordingly.

## Appendix (confidence below 7)

None

## Plan alignment notes

No plan given. This is a design review, not an implementation-completeness review. Evaluated correctness, code quality, test coverage, production compatibility, credential handling, and the unnamed/background requirement against the existing scripts and listed dispatch sites. The proposed tests omit the failure scenarios above. Baseline validation: npm test passed all 181 tests, with no failures or skips; this does not validate the unimplemented design.

## Ledger triage

None
