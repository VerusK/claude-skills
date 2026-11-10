# Review: VerusK/codex vs 20b101d59b62755c048c7dbdc21fbb1a40a51291 (includes uncommitted changes)

## Verdict
READY WITH FIXES — legacy-link migration can silently remove every newly installed Codex skill when the legacy and discovery directories resolve to the same location.

## Findings (confidence 7+)
[P2] (confidence: 10/10) scripts/install.mjs:386 — Cleanup assumes `legacyCodexSkills` and `codexSkills` are distinct directories: with `CODEX_HOME="$HOME/.agents"`, each `old` path is the link just created by `linkSkills`, so `unlinkSync(old)` deletes it; the same failure occurs with default configuration when `~/.codex/skills` is a symlink to `~/.agents/skills`. Both cases were reproduced with isolated temporary homes: the installer exits 0, logs eleven legacy removals, and leaves the discovery directory empty. Compare the physical directory paths before migration and skip cleanup when they alias; add installer regression tests for both configurations.

## Appendix (confidence below 7)
None

## Plan alignment notes
No plan given

## Ledger triage
None

<!-- end of review -->
