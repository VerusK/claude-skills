# Containment, lifecycle and recovery

Read in full before a mutation. Operate only under a recorded live project grant and the project's production-change procedure. Historical INFRA-640 authority does not carry forward. Notifications and Jira writes require the configured destination/project authority; never invent a channel.

## Common change contract

Record who authorized which project/zones/actions, evidence reference, UTC expiry, separate review date and verified owner egress. Profile uncertain sources first. All clauses exempt configured project **and owner** egress; reject target overlap, including a network containing an exempt address. Preserve partner/staff/webhook/monitor traffic. Coordinate **one incident writer**, including external humans/automation: a CF re-GET version guard is not atomic compare-and-swap, so a remote writer can still race between GET and PATCH. Pause mutations if coordination cannot be established.

Sequence: evidence → health before → unique private before snapshot → bounded edit → live readback including unrelated fields/order → ≥35s CF propagation → enforcement verification → health after → lifecycle records. A failing or skipped check means incomplete, even if traffic seems blocked. Recheck deploy/network confounds and escalate uncertainty. No external operational calls are authorized by a development/tabletop task.

For every actual change, archive CF rules-only snapshots and journal in the project's approved private evidence repository; commit backup artifacts under its procedure. Record a changelog row≤400 characters with UTC **and MSK** (UTC+3), what/why, exact scope/IDs, rollback “remove only this OR clause from live state”, Jira incident reference and review date. Add a Jira incident comment with IDs only, evidence/verification/health result, remaining uncertainty and review date. Completing/repairing closing fields in work Jira uses `jira-cc-close-ticket`; incident commenting follows project policy. Mark incomplete at once and complete/update lifecycle records on recovery; `already_present` is a no-change observation, not verified mutation evidence. Notify owner of actual changes, live attacker accounts/API keys, credible breach and material access loss; routine heartbeats stay local.

## Exact IP helper

Use the loaded skill's `scripts/cf_block.py`; `--help` is the CLI source of truth. Required config fields live in `cloudflare.zones[KEY]` (real zone `id`, ordered `rule_ids`), `exempt_egress`, nonempty `owner_egress`, `authority` and `hooks`. Hooks are argv arrays, no shell. Health receives appended `before|after OPERATION_DIR`; verify receives `OPERATION_DIR`. Each runs≤30s with output discarded, exit0 required. The **verify hook must actually test edge enforcement**, not merely exit0; the owner/project supplies a bounded safe probe method for the exact target/clause. Missing hooks reject apply.

```sh
python3 SKILL_DIR/scripts/cf_block.py --config FILE --state-dir DIR --zone KEY --ip 203.0.113.7 --evidence REF
# After reviewing the plan and satisfying grant/change gates:
python3 SKILL_DIR/scripts/cf_block.py --config FILE --state-dir DIR --zone KEY --ip 203.0.113.7 --evidence REF --apply
# /64 only with affirmative one-subscriber evidence and ipv6_64 grant:
python3 SKILL_DIR/scripts/cf_block.py --config FILE --state-dir DIR --zone KEY --ip 2001:db8::/64 --subscriber-evidence REF --evidence REF --apply
# Surgical rollback; same current grant/egress/hook checks:
python3 SKILL_DIR/scripts/cf_block.py --config FILE --state-dir DIR --zone KEY --rollback OPERATION_DIR --evidence REF --apply
```

Addresses above are documentation ranges. Default is dry-run: GET and private plan/snapshot only, no hooks/PATCH. Exact IP by default; IPv4 networks rejected, IPv6 broader than/64 rejected, shared/WARP /64 prohibited by evidence gate. Existing enabled block with the exact generated clause yields `already_present`. Rule selection uses only explicit ordered IDs, never shortest rule or substring guess; enabled block only. Full expression≤4096, description≤500; description stays unchanged. If no configured rule has room, stop for a scoped rule-capacity decision. Prefer attacked zone as space fills. Construct `(ip.src in {TARGETS} and not ip.src in {EXEMPT...})`, then `(<old>) or (<clause>)`.

GET retries are bounded transport-only (three total, within240s operation deadline); malformed/API errors stop. PATCH is sent **once**, even after timeout/error; live readback resolves ambiguity, never a blind PATCH retry. Snapshot rulesets, retain writable fields including parameters/logging, compare all stable content and rule order while ignoring API version/timestamps. Re-GET unchanged version/content immediately before PATCH. Readback mismatch, hook/deadline failure or uncertain identity returns nonzero `incomplete`/`rejected`; only a changed apply with successful delayed verify+health is `verified`.

### Journal and interrupted operations

```text
planned ── durable intent ──> mutation_intent ── live readback ──> applied
                                │                                │
                                └── uncertainty ──> incomplete <─┘
                                                        │
                    live reconciliation + ≥35s verify + post-health
                                                        ↓
                                                     verified
```

Each exclusive `op-UUID` directory0700 contains private0600 `operation.json`, `before.json`, and `after.json` when read. The record binds project, zone key **and CF zone ID**, ruleset/rule ID, normalized targets and exact clause **before** mutation. Rollback has its own linked record and same lifecycle. A single nonblocking local writer lock covers discovery/recovery/read/change. Durable `mutation_intent` precedes sending PATCH; a crash after remote apply retains unresolved intent. Read-only plans or failures before intent never claim remote mutation.

On apply startup under the lock, inspect unresolved intent/applied/incomplete writes for the zone before idempotency. Re-run the same target/rollback invocation with current live grant and same identity; reconcile live expected stable content, then fresh35s verify and post-health **without a second PATCH**. Different target/config/zone/rule replay rejects before hooks/PATCH. Missing clause after ambiguous intent remains incomplete; do not silently call it applied or automatically resend. If live state conflicts with expected record, stop and investigate through project ops, preserving evidence. A pre-intent failed plan made no remote request; review it before a fresh plan. Do not edit journals to manufacture verified status.

Rollback reads the **live** expression on the recorded rule only. Remove exactly one structural generated OR branch; preserve later wrappers and unrelated edits (A then B then rollback A keeps B). Missing/multiple matching branches, changed exemption/identity or unverified source operation reject; escalate manual review rather than replacing a full snapshot. Full-snapshot restore overwrites other writers and is forbidden.

## Manual ASN / UA / path containment

The helper deliberately has no arbitrary-expression argument. Prepare exact clauses/diff and follow the project's guarded CF change mechanism with all common lifecycle checks; do not bypass it with a generic REST edit.

- **ASN:** live `asn` grant, only attacked zone, demonstrated whole-cloud scanning (multiple scanner sources and meaningful origin exposure; historic5×700req/10min was campaign evidence, not a global automatic threshold). Keep egress exclusions; no all-zone cloud ASN ban.
- **UA:** live `ua` grant and **seven days** of legitimate-use analysis for the exact host/UA. Preserve partner API hosts unless the check proves them clean too. Sampled/capped/unavailable history is insufficient to declare zero legitimate use; retain narrower IP containment or request owner decision. UA text alone is spoofable.
- **Path:** live `path` grant, exact attacked host+paths, **absent session cookie AND absent Authorization header**. Derive the project's actual cookie name; authenticated traffic is excluded when either credential is present. Verify no-cookie/no-Authorization→CF403; with session cookie→origin401 on an intentionally invalid safe session; separately verify Authorization-bearing traffic is not intercepted, and ordinary pages remain unchanged. Use a safe approved probe, not stolen/live user credentials.

## Exact account disable procedure

Only an independently attributed attacker account under live `account_disable` grant and the project's ops workflow. Correlate registration IP/UA, probes/headless behavior and login activity; a newly created pending account or missing login alone is insufficient. Escalate a confidently live attacker account promptly, including unavailable access that prevents containment. Revoking/deleting keys, deleting accounts/data and changing our credentials remain **owner-only**; prepare exact IDs and ask. Disabling kills sessions by increasing token_version; API-key authentication in this schema also requires owner `is_active`. Reversible activation is a new scoped ops change; never decrement token_version to revive old sessions.

Schema supported by these procedures:

- `users`: `id`, `owner_id` (company), `ts_spawn` epoch integer, `is_active`, `is_verified`, `token_version`.
- `wallets`: `user_id`, `ts_spawn`; `api_keys`: `owner_id`, `key_prefix`, `created_at`, `last_used_at`, `revoked_at` epoch integers; `api_key_wallet_grants`; `invoices.create_by`.
- CH `login_history`: `user_id`, `ts_spawn`, `ip`, `country`, `user_agent`, `type`, `action`, `god_mod_id`; `activity_logs` for bounded correlation.

Use configured validated identifiers, bounded numeric parameters and SQL stdin via Teleport; replace placeholders with validated integer literals/bound parameters supported by project tooling. First read uses its own read-only connection:

```sql
set default_transaction_read_only = on;
SELECT id, is_active, token_version FROM users WHERE id = :exact_id;
```

After health-before and recording this exact ID+expected token_version, use a **separate authorized write connection**. One ID per guarded transaction:

```sql
BEGIN;
UPDATE users
SET is_active = false, token_version = token_version + 1
WHERE id = :exact_id AND is_active = true AND token_version = :expected_token_version
RETURNING id, is_active, token_version;
-- Inspect RETURNING before ending transaction:
-- exactly one expected id, inactive, version=expected+1 => COMMIT;
-- zero/unexpected rows, concurrent version drift or uncertainty => ROLLBACK;
```

Never COMMIT without inspecting RETURNING. Re-read the exact account in a fresh read-only connection; for a reviewed set repeat exact guarded transactions and reread every ID. Health-after, IDs-only changelog/Jira+review date, notify and record uncertainty follow common contract. No emails/bodies/key material or recovery phrases in output.

## Forensics and escalation

Read-only aggregate IP/time→login/activity/account correlation, object-ID→company ownership, payment/outflow states, issued key IDs and grant counts. Bound queries on production master; do not retrieve private payloads. Breach evidence, cross-tenant access, money movement, uncertain identity/access, or changes outside grant go to the owner and project IR workflow. In the example ecosystem `combocards-ir` handles incident triage, `combocards-ops` production changes, `keepass` secrets. Product500/rate-limit defects become scoped product tasks; successful containment alone does not close the underlying issue.
