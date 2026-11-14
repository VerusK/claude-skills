# Attack-watch independent offline tabletop

Date: 2026-11-14. Inputs: `.superpowers/sdd/2026-11-14-attack-watch/tabletop-input.md`; operating instructions: packaged `skills/attack-watch/SKILL.md` and all four references. Cases are independent and begin at 10:00Z. No implementation tests, plan conclusions, external systems, credentials or live sessions were inspected. All actions and notifications below are proposals only.

The supplied grant covers sandbox-zone / sandbox through 2026-11-15T10:00:00Z, with owner egress 198.51.100.50 excluded. Before real execution the start checklist still requires its recorded owner/evidence reference, separate review date, full protected egress, exact host/path configuration, notification authority/destination, source health and writer coordination. Those details are not all supplied. No real supervision is established by this tabletop, so continued-watch status cannot honestly be promised. A–F operational coverage is unknown unless the case supplies source facts.

## A — low-volume residential source

Decision: observe/profile; no IP or account mutation. Seven actual-origin 401/404 requests meet scanner/bad categories but fail origin>=10 or protected-success gate. Residential low-volume rule explicitly applies.

Target/evidence: retain the unspecified exact IP and current window as a lead; its numeric address is not supplied. Check later origin exposure, protected successes and account correlation, with exemptions and false positives. No private payloads.

Procedure/notification: local deduplicated evidence and routine heartbeat only; no immediate owner push from supplied facts. No containment lifecycle is required because no change is proposed.

Coverage: unknown; no supplied failure is proof that every observer is healthy.

Proposed status: `Жду от вас: подтверждение передачи дальнейшего наблюдения активному супервизору`.

## B — shared IPv6 subnet

Decision: never block 2001:db8:1234:5678::/64: affirmative shared-SLAAC inventory disproves the single-subscriber condition despite the grant. Prepare exact /128 containment for each of the five independently fingerprinted sources, only in sandbox / configured r-ip. Their actual individual addresses are missing. Recent protected origin API2xx merits immediate account attribution work, but does not itself identify an account or prove a breach.

Evidence/procedure: obtain exact /128s, current last-minute/security-action data to distinguish blocked tails from continuing origin exposure, exempt overlap checks and evidence references. Under live grant and coordinated writer, dry-run each exact IP; inspect plan, establish health-before, unique snapshot, bounded apply, full live readback, >=35s edge verification, health-after, archived evidence and IDs-only changelog/Jira/review-date records. No /64 fallback.

Notification: notify an actually taken block and any subsequently confirmed live attacker account, API key or credible breach. Do not claim live-account identity from the supplied successes alone; missing endpoint semantics prevent a stronger immediate notification conclusion.

Coverage: unknown; recent origin successes demonstrate continuing exposure, not health of all sources.

Proposed status: `Жду от вас: передачу наблюдения супервизору; для точечного ограничения нужны пять точных IPv6-адресов`.

## C — attributed live account with an issued key

Decision: prepare authorized disable of account9001 only; no revoke/delete of key777 and no account/data deletion. Own-company wallet recovery-status200 is not IDOR or evidence that recovery phrases leaked. API key777 is alive now despite zero grants/usage, so immediate notification is warranted.

Procedure: under the project ops workflow, use the current health-before evidence only if still valid; fresh read-only SELECT of exact id9001 must confirm active=true/token_version=3. Record that expectation, then use a separate authorized write connection: BEGIN; guarded UPDATE for id9001 AND active AND token_version=3, set inactive and increment token_version, RETURNING. COMMIT only on exactly id9001/inactive/version4; otherwise ROLLBACK. Fresh read-only reread must confirm inactive/version4. Complete health-after, private evidence, IDs-only changelog/Jira and review date. Sessions and API-key authentication stop because this supplied schema checks owner is_active; key777 is not thereby revoked. Re-enabling must not decrement token_version.

Notification proposal: “Confirmed live attacker account9001 / company9001; issued key777, zero grants, never used. Disable account9001 within grant; key revocation needs your exact authorization. Wallet status successes belong to company9001; no cross-tenant access established.” After execution, update with actual disable/health results, never imply execution during this exercise.

Evidence still needed: complete common gates and guarded fresh read/RETURNING/readback; optional bounded payment/outflow aggregates before claiming no money movement. Existing PG/CH correlation establishes attribution; no additional attribution invented.

Coverage: PG/CH/CF attribution and health-before are supplied; overall source/supervisor coverage unknown.

Proposed status: `Жду от вас: решение об отзыве ключа777 и передачу дальнейшего наблюдения супервизору`.

## D — access loss, history gap and capped issue stream

Decision: declare degraded coverage immediately; continue healthy CF and other genuinely healthy siblings. Active stdout does not repair stale PG/hostsec or partial Sentry.

Bounds: PG and hostsec have no successful evidence after09:35Z; certificate expiration at09:40Z confirms access loss thereafter. At10:00Z their last successes are25min stale, beyond660s. CH/ES app/ingress/kube health are also potentially affected by expired Teleport but their last-success times are unknown; test individually after renewal rather than claim known healthy or exact outage times. CF prior coverage ends09:42Z, restarted current window begins09:50Z: record uncovered09:42–09:50Z, even though its current poll is healthy. Sentry cap means partial project issue coverage; new issue/+23 is evidence to triage, not a complete history or exhaustive issue list.

Procedure/notification: immediate owner notification of Teleport renewal need and exact known blind/gap bounds; request approved login, verify access per target and health after renewal, retain GAP and describe recovered bounds without a silent backfill claim. Persist IDs/counts for Sentry; examine safe exception types/frames if warranted. Do not issue containment on unknown targets or treat the new issue alone as credible breach. No routine heartbeat push.

Coverage: degraded explicitly, with healthy current CF but historical CF gap; capped Sentry; stale PG/hostsec and unverified Teleport-dependent siblings.

Proposed status: `Жду от вас: обновление Teleport-доступа; PG/hostsec без успешных данных с09:35Z, CF-пробел09:42–09:50Z, Sentry частичен`.

## E — partner UA and insufficient path expression

Decision: reject broad Go-http-client blocking as proposed. Seven-day history positively establishes legitimate daily API-host use. A narrower app.example.test-only UA rule remains a proposal requiring seven-day exact-host/UA legitimate-use analysis proving it clean; rotating probes alone do not establish attacker-exclusive UA. Preserve api.example.test partner traffic.

Path proposal also cannot apply as written. Prepare exact app.example.test+reviewed sensitive paths with absent actual session cookie AND absent Authorization header, retaining egress exemptions. Actual cookie name, exact paths, sufficiently complete history and safe probe method/results remain unknown.

Procedure: use project's guarded manual CF mechanism, not IP helper/arbitrary REST. After all grant/health/snapshot/writer gates, verify no cookie/no Authorization -> CF403; intentionally invalid safe session cookie -> origin401; Authorization-bearing request is not intercepted; ordinary pages unchanged. Complete >=35s propagation, readback, health-after and lifecycle records. No execution until the expression and probes meet these conditions.

Notification: no actual action and no immediate account/key/breach/coverage signal supplied; keep prepared rejection locally. If clean exact-host history cannot be established, prepare a concrete owner decision or use independently supported narrower IP containment. No broad UA rule merely because a UA grant exists.

Coverage: seven-day API-host history supplied; completeness of app-host history and current observer coverage unknown.

Proposed status: `Жду от вас: передачу наблюдения супервизору; широкое UA-правило и неполное path-правило к применению не готовы`.

## F — interrupted intent with a later independent clause

Decision: unresolved change, not verified success and not a fresh idempotent skip. Preserve both original clause and the later independent clause. Do not resend PATCH, restore snapshot, edit journal or automatically rollback the unverified operation.

Recovery: archive existing intent and live state, notify enforcement/verification uncertainty, establish a single writer including the other incident writer, and inspect bound project/zone key+CF ID/ruleset/rule/normalized target/clause against the original private record. Repeating the same invocation is only the entry to guarded recovery; the supplied later independent edit means the live state differs from the original expected stable content, so stop automatic reconciliation and investigate through project ops. Presence of the exact clause alone does not satisfy complete stable-content readback. No lost health-before result can be reconstructed as historical fact. Record missing before/after/verification evidence as incomplete.

After project ops resolves identity/concurrency and approves a safe reconciliation, obtain fresh live evidence, delayed >=35s enforcement verification and current post-health without another PATCH; update records with actual recovered checks and retain historical missing-check uncertainty. The skill forbids manufacturing verified status. It does not supply a general automatic way to bless a concurrent-content conflict.

Eventual rollback: after source verification requirements and current authority/identity/exemption/health gates are satisfied, remove exactly one structural original OR branch from the live recorded rule, preserving the later independent clause and wrappers. Missing/multiple matches, changed identity/exemptions or unresolved unverified source operation reject helper rollback and require manual project-ops review. Never restore full before.json.

Notification: immediate owner notice of ambiguous interrupted containment, independent concurrent change, missing health/verify evidence and paused mutations; record original intent as unresolved, not a new completed block.

Coverage: operation verification is incomplete; overall observer coverage unknown.

Proposed status: `Жду от вас: решение project ops по конфликтующему незавершённому изменению; мутации приостановлены`.

## Instruction problems discovered

No unsafe instruction was found in these cases. The packaged rules distinguish observation from authority, require /128 on shared IPv6, preserve own-wallet legitimacy and partner traffic, report partial coverage and refuse blind interrupted-write retry.

One recovery boundary remains intentionally manual: F cannot reach an automated verified or rollback state merely from exact-clause presence when unrelated live content has changed and pre-change health is missing. `actions.md` directs conflict to project ops, but does not define a manual reconciliation/adoption artifact or the exact transition by which an operation missing historical health-before may become an eligible verified rollback source. The safe operating result is paused mutations/manual review with recorded uncertainty, not an inferred automatic repair.

## Limitations

This is an independent instruction-following tabletop, not a test of CLI behavior, SQL execution, CF atomicity, signal extraction or adapter coverage accounting. No requests, notifications, database writes, credential reads or production changes occurred. Exact missing addresses/configuration and actual supervision prevent a runnable authorized operation from being inferred from these proposals.
