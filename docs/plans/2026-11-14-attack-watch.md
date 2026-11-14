# Attack Watch Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use `subagent-driven-development` (`verus-skills:subagent-driven-development` when installed as a plugin) to implement this plan task-by-task; the plan must have passed plan-review before execution. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Deliver an installable attack-watch skill with configurable read-only observers, a bounded CF block helper and incident operating procedures.

**Architecture:** Python standard library adapters share validated JSON config, deadline/HTTP/secret utilities, private state and a JSONL poll runner. Detectors are pure functions over fetched rows; the supervising agent classifies and executes actions only under a project grant. No production actions during development.

**Tech Stack:** Python 3.10+, unittest, Node >=20 node:test wrapper; no new dependencies.

**Spec:** docs/specs/2026-11-14-attack-watch-design.md (including its superseding round-1 contracts).

## Global Constraints

- No live monitoring, production writes, credentials retrieval, bot activation, release publishing, Jira closure or delivery to another session in this implementation.
- No secrets or raw sensitive payloads in output, snapshots contain CF rules only.
- State/output directory mode 0700, state/snapshot mode 0600; one source lock per state directory.
- Ccinfra values are examples; no hard-coded workspace paths. Config holds store metadata and environment variable names, never secret values; subprocess config is argv with shell=False.
- Mandatory explicit grant, same project/zone/action, UTC expiry, owner egress and evidence for apply. Dry-run is default.
- Run npm test before committing script changes. Preserve pre-existing untracked docs/handoff/ content; never stage it.
- Browser work uses owner's authenticated Playwright only; no browser or external requests required for tests.
- All work in /Users/sleepwalker/orca/workspaces/claude-skills/sentinel, branch VerusK/sentinel; check branch before each commit.

## Review Focus

1. CF cached 200 and public API 200 cannot establish origin load/protected success (Task 1 tests).
2. Fifteen-minute source outage and one failed sibling must leave precise GAP and stale target status (Task 1 tests).
3. New account with no login yet and lower-id late transaction must not vanish or stall forward progress (Task 1 tests).
4. Applied PATCH whose response/verify hook fails must remain incomplete and never be blindly retried (Task 2 tests).
5. Rollback A after independent B must preserve B and all unrelated rule fields/order (Task 2 tests).

### Task 1: Configurable observer suite

**Files:** Create skills/attack-watch/scripts/{common,cf_watch,es_watch,sentry_watch,accounts_watch}.py; skills/attack-watch/examples/ccinfra.json; tests/attack_watch/test_observers.py; tests/attack-watch.test.mjs. Create any focused test fixture helper under tests/attack_watch/ if it removes duplicate setup. Keep shared poll code in common.py, not each adapter.

**Interfaces:** common.load_config(path)->dict; common.request_json(method,url,headers=None,body=None,timeout=30)->object; common.emit(source,event,**fields); common.run(source,poll)->CLI runner passing config,state,deadline into poll, persisting only successful changes. Each observer exposes poll(config,state,deadline)->list[dict] plus main CLI; pure detector functions may be named by source. Persist per-target status/last-success and bounded dedup state. Config sections: project, poll (interval/window/deadline/page budgets), credentials (source {env,store_entry,store_key}), cloudflare (zones keyed by name: id, hosts, rule_ids; exempt_egress, owner_egress; signals), elastic (url, username, password_env, indexes app/ingress/hostsec, deployments, baseline keys), sentry (url, org, projects), accounts (pg argv/resource/user/db, CH url/db, table identifiers, initial_cursor, revisit_seconds), authority (grant metadata and allowed actions), hooks (health/verify argv). Task 2 may extend strict validation for mutation fields.

- [ ] **Step 1: Test observable boundaries before implementation.** Write Python unittest fixtures for the specified predicates, persistent state and safe I/O. Node wrapper runs `python3 -m unittest discover -s tests/attack_watch -p 'test_*.py'` with timeout and asserts exit status. Example detector test contract (the implementation may return more metadata):

```python
rows = [group(ip='203.0.113.7', origin=0, edge=200, count=200,
              path='/api/users/me', ua='sqlmap')]
self.assertFalse(any(e['event']=='CANDIDATE' for e in detect_cf(rows, config)))
```

Cover two threshold categories or scanner>=5+bad>=1, origin>=10 or protected API 2xx, bad>=2-alone rejection, public paths, exact egress exclusion, KEY mutations, SESSION fingerprint, RP ids, failure-before-success minute ordering vs same-minute ambiguity and AUTH-WAVE>=80. ES: app 5xx>=3, exception class without raw message, ingress status counts, rare rule key and auth>=100. Sentry: firstSeen/new and count jump>=20, restart persistence, pagination/cap, IDs only. Accounts: read-only first SQL statement, initial cursor mandatory, epoch columns, empty CH aggregate success, enrichment failure/checkpoint retention, ASC pages and budgets, 24h revisits, expired revisit event and time reconciliation for late lower ids. Generic: malformed vs empty responses, safe error class only, deadlines, GAP intervals, partial sibling and private atomic state.

- [ ] **Step 2: Run red.** `node --test tests/attack-watch.test.mjs`; record the expected missing-observer behavior before writing production code. Avoid live network; fake HTTP/subprocess boundaries only.

- [ ] **Step 3: Implement config and shared runner.** Validate types, finite bounded positive counts, identifiers, IP networks, URLs (HTTPS externally, loopback HTTP for proxies), credentials by environment only, target count<=32. Standard JSONL runner supports --config --state-dir --once; continuous default interval300/window600/deadline240, per request<=30. Lock source state with flock, atomic replace private temp file; no payload in exceptions. Each target reports startup/coverage/GAP and last_success; budget errors preserve prior bounds. Observer state is outside skill. Use configured credential env names without shell expansion. Example ccinfra config retains known resource/store names but null/unconfigured actual zone/rule IDs, initial_cursor and owner grant so startup cannot accidentally touch prod.

```python
# request boundaries: raise a safe typed failure, never echo remote text
with urllib.request.urlopen(req, timeout=min(30, remaining)) as response:
    return json.load(response)
```

- [ ] **Step 4: Implement all four adapters.** Port supplied query logic, correcting the explorer/spec discrepancies. CF adaptive groups include datetimeMinute and host filtering; emit sampled/limit coverage. Query ES app/access/error, ingress and hostsec separately so partial targets are visible, with hits truncation warnings. Sentry bounded paging and persisted issue counts; no full event endpoint. PG query over configured tsh argv/SQL stdin with no psql flags, numeric/identifier validation; bounded keyset scan and recent-time reconciliation, CH per-user first login aggregates (non-shadowing aliases), reserved revisit budget. Per-target deadlines prevent hot streams starving heartbeat. Mask or omit raw message/title/UA/query fields; IDs/IP/country and sanitized exception class suffice.

- [ ] **Step 5: Verify and commit.** Run Python suite and npm test. If the exact eleven-skill test fails because new skill directory exists without SKILL.md, keep Task 1 scripts in place and update the registration assertion now to add attack-watch plus a minimal valid SKILL.md whose full text Task 2 replaces; document this interface. Test wrapper checks frontmatter/linked packaged files only after Task 2. Check branch, stage only Task 1 files and commit `feat(attack-watch): add configurable read-only observers`. Report RED/GREEN commands, output, interfaces and concerns.

### Task 2: Bounded mutation helper and complete operating skill

**Files:** Create skills/attack-watch/scripts/cf_block.py; tests/attack_watch/test_block.py; skills/attack-watch/SKILL.md; skills/attack-watch/references/{sources-access,signals,actions,false-positives-traps}.md. Modify example config/common validation only as needed for mutation fields, tests/attack-watch.test.mjs, tests/plugin.test.mjs, README.md and USING.md. No source/vendor/patch entries: new skill is native.

**Interfaces:** Consume common config/request/state helpers from Task 1 (inspect implemented signatures before using). CLI `python3 cf_block.py --config FILE --state-dir DIR --zone KEY --ip IP [--subscriber-evidence REF] --evidence REF [--apply]`; rollback takes `--rollback OPERATION_DIR` and same grant gates. No arbitrary expression argument. Config authority object includes owner, evidence, project, zones, actions, expires_at (UTC required), review_at and owner_egress; hooks health and verify are argv lists with no shell. Health called with phase and operation directory; verify called with operation directory, exit0 required. CLI --help documents actual invocation.

- [ ] **Step 1: Add failing behavioral tests.** Build fake CF rulesets and transport hooks. Assert dry-run never PATCHes; expired/wrong project/zone/action grant, unknown egress, excluded address/network overlap, unsafe CIDR, missing /64 subscriber evidence and hooks reject before PATCH. Explicit fallback IDs only, full rule size4096 and description<=500. Existing enabled exact clause is idempotent (separate already_present outcome, not verified claim). Disabled/non-block rule is rejected. Re-GET version drift aborts. Mock PATCH stores changed state then raises timeout: readback succeeds, exactly one PATCH. Assert preservation of unrelated fields/order, detecting mismatch, health fail before/after, verify invoked after >=35sec (fake clock), incomplete operation persisted with nonzero result. Test A then B then rollback A preserves B; local lock contention and private backups; failure of atomic replace preserves previous state.

```python
result = execute_block(config, ['203.0.113.7'], apply=False, transport=fake)
self.assertEqual(fake.patch_count, 0)
self.assertEqual(result['status'], 'planned')
```

- [ ] **Step 2: Run red.** `python3 -m unittest discover -s tests/attack_watch -p test_block.py`; record expected missing helper failure, then implement only covered behavior.

- [ ] **Step 3: Implement helper.** Parse and normalize addresses/networks with ipaddress, exact IP by default; IPv6 /64 only with grant/subscriber evidence, never broader. Compose exact clause `(ip.src in {...} and not ip.src in {EXEMPT...})` appended as `(<old>) or (<clause>)`. Select only configured ordered rule IDs, enabled block with enough room. Persist a unique operation before snapshot (no reuse overwrite), clause and lifecycle status; version guard immediately before PATCH, preserve all writable stable fields; compare stable rule content minus API version/timestamps and ruleset ordering. Retry GET transport errors boundedly within deadline; PATCH once only then readback on ambiguity. On changed apply, record applied, verify after35s hook and post-health then verified; any uncertainty => incomplete and nonzero. Rollback surgically removes this operation's exact wrapper clause from live expression even after later wrappers; reject ambiguous/multiple matches. Preserve intervening edits. Coordinate remote writer explicitly in docs (CF version guard is not atomic CAS).

- [ ] **Step 4: Write operational text from handoff, with progressive references.** SKILL.md triggers continuous watch/scans/«сторож», defines startup grant/access check, loop/supervision and owner-vs-autonomous table, notifications and required status lines. Read HANDOFF fully; preserve every material §2–7 rule in a reference. Source/access reference documents env/store bindings via keepass, Teleport PG/CH/ES startup/status/renewal and health; no live credential loading here. Signals reference lists exact default predicates and warns sampled/capped evidence; no IDOR claim without ownership check. Actions reference covers CF helper usage, lifecycle changelog <=400 chars UTC+MSK/Jira/review date, rollback live-state only, manual ASN/UA/path gates, account read+transactional disable+returning+reread using exact schema and one id+expected token_version guard (ids only; keys revoke/delete remains owner), forensics aggregates and IR/ops handoff. False-positive/traps reference preserves SPA200/cache/redirect/public endpoints, legitimate own recovery phrase, staff/partners/mini-app/webhook/monitoring/owner egress, deploy/network health confound, cert expiry, overlap tails, macOS bash3.2, no tools/state in tmp and Playwright-only browser rule. Explain Claude Monitor rearm<=30min and Codex managed background/poll with heartbeat stale threshold; ending a turn does not promise autonomous wakeups. No hard-coded production paths in body. Bot handoff requires its credentials/grant/channel; example grant disabled/unconfigured, no inherited incident permission.

- [ ] **Step 5: Integrate and verify.** Add native skill to plugin expected list, README table/count and USING outside-flow routing (both names). Node test checks packaged frontmatter/references and installer discovery with isolated temp home. Add tabletop fixtures/assertions for low-volume residential no-block, shared /64 no-block, pending live attacker account, stale Teleport, UA seven-day gate, path cookie+Authorization conditions and notification/lifecycle decision outcomes (independent reviewer also walks these). Run `npm test`, Python compile with pycache outside repo, skill-creator quick_validate.py when available; inspect git diff for secrets/hard-coded ccinfra workspace paths. Before commit check branch, stage specific paths only; commit `feat(attack-watch): add guarded blocks and operating procedures`. Return test evidence, IDs and owner deployment requirements.

## Plan review decisions (round 1)
Accepted without the judge: all four confidence-7+ findings identify concrete missing bounds/recovery or the N+1 bottleneck; the following requirements supersede affected steps. Evidence: plan-review round-1 Findings, Task 1 limits and Task 2 idempotency/rollback constraints.

- Task 1 HTTP helper enforces a monotonic end-to-end deadline (including connect/redirect/body) and max_response_bytes default 8MiB. A cancellable subprocess boundary is acceptable if urllib cannot enforce this reliably; kill/join timed-out worker, suppress stderr/raw response and return safe ERROR without coverage progress. Test real local server trickle and oversized body. Subprocess timeouts consume the same remaining deadline. Provide an optional response metadata return (`request_json(..., with_headers=True)` => body+headers) for Sentry Link pagination; fixture two serialized pages and cap/restart continuity.
- Task 1 CH enrichment batches validated integer IDs from new/revisit/reconciliation sets (chunks<=100) into one grouped first-login query per chunk, merging results by user_id. Empty set or missing user row means valid no-login, not error. Reserve revisit budget, persist fair continuation per lane; test 300 new+100 revisit+overlap across restart, bounded CH query count and both lanes advancing. Explicit Task 1 commit allowlist includes temporary SKILL.md and tests/plugin.test.mjs when needed for suite compatibility.
- Task 2 operation record binds immutable project, zone key AND CF zone ID, ruleset ID, rule ID, normalized targets and clause before mutation. CLI/config/record identities must match before hooks or PATCH. Rollback only recorded rule, reject wrong-zone replay even if clauses match. Tests assert no PATCH on identity mismatch.
- Task 2 journal lifecycle: planned -> mutation_intent (durable before sending PATCH) -> applied -> verified; any uncertain outcome -> incomplete. Rollback uses its own linked operation with equivalent states. On startup under the writer lock, inspect unresolved mutation_intent/applied/incomplete records for the target zone/rule before any already_present shortcut. Live readback and complete verification/post-health without second PATCH, or report explicit incomplete/nonzero. A missing clause after ambiguous intent is not silently treated as applied. Test fresh process restart after remote PATCH before journal update and failed verify followed by retry. A small state diagram in references/actions.md documents transitions. Already_present is a distinct no-change outcome, not a verified-change claim.
