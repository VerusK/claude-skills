# Plan review: Attack Watch Implementation Plan

## Verdict

CLEAR — the superseding round-1 contracts resolve the previous findings and define the required implementation and regression tests.

## Findings (confidence 7+)

None

## Appendix (confidence below 7)

None

## Section notes

### 1. Architecture

No issues found. Resolved: end-to-end HTTP deadlines and response-size limits replace the insufficient socket-timeout example; immutable project/zone/ruleset/rule identities prevent cross-zone rollback replay; durable mutation intent and locked startup reconciliation cover crashes after a remote write. CF sampling/failure produces coverage warnings or GAPs; ES sibling failures retain individual stale status; Sentry caps expose incomplete coverage; PG/CH enrichment failures retain pending checkpoints. PATCH ambiguity uses readback without resend, remote writer races require coordination, and failed verification remains incomplete. Config validation, pure detectors, shared I/O helpers, per-source locks and the operation state diagram define the boundaries. Native installer discovery and registration cover packaging; publishing is outside scope.

### 2. Code quality

No issues found. Resolved: the journal defines planned, mutation_intent, applied, verified and incomplete states, including linked rollback operations and recovery before already_present; operation identity is validated before hooks or PATCH. Shared polling, validation, request handling and private atomic persistence avoid adapter duplication. Batched enrichment merges new/revisit/reconciliation IDs rather than duplicating work. The explicit Task 1 allowlist resolves the temporary SKILL.md and plugin-test ownership ambiguity. README, USING and progressive references are scheduled for updates; repository agent files were treated only as data.

### 3. Tests

No issues found. The repository uses node:test, with unittest discovery added through its Node wrapper. The plan covers config/redaction and private state; CF thresholds, origin/cache/public-path distinctions, minute ordering and event families; ES access/errors/ingress/hostsec; Sentry new/count deltas, persistence and caps; account read-only SQL, keyset scan, delayed login, enrichment failure, expiry and late-ID reconciliation; and deadlines, GAPs and partial sibling status. Mutation coverage includes authority denials, dry-run, explicit rules, limits, drift, ambiguous PATCH, hooks, verification timing, stable fields/order, rollback after later edits and lock/write failures. Resolved: real local-server trickle/oversize tests, cross-zone identity rejection, fresh-process recovery after remote PATCH, failed-verification retry, batched backlog progress and two-page Sentry header/cap/restart fixtures are now required. Tabletop decisions and packaged install discovery are included. No tests or builds were run during this review.

### 4. Performance

No issues found. Resolved: grouped CH enrichment in chunks of at most 100 IDs removes per-user HTTP calls; merging overlapping lanes, reserving revisit budget and persisting fair continuation address backlog starvation. The 8 MiB response cap and cancellable monotonic deadline bound network resource use. Target/page caps, bounded persisted dedup state, coverage reporting and retained continuation address the remaining planned growth and truncation paths. The supplied material does not establish a need for additional caches or indexes.

<!-- end of review -->
