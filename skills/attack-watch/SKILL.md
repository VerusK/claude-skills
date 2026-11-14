---
name: attack-watch
description: Continuous defensive attack watch across Cloudflare, application and host logs, Sentry and new accounts. Use for “monitor the attack”, “watch scans”, «мониторь атаку», «следи за сканами» or «сторож», with scoped grants for bounded containment.
---

# Attack watch

Run **watch → classify → act within grant → record → notify** approximately every five minutes. Observation and containment have separate authority: this skill and a past incident's instructions confer no production permission.

## Start

1. Identify the project, attacked hosts/zones, incident workspace, current incident/Jira reference and notification destination. Read [sources and access](references/sources-access.md) before starting adapters. Configure a project JSON outside the installed skill, using [the deliberately unconfigured example](examples/ccinfra.json) only as a schema guide. Keep tools in the installed skill/repo and private state/output in the persistent incident workspace.
2. Record the owner's explicit grant: owner, evidence reference, matching project, zone keys, allowed actions, UTC `expires_at`, separate `review_at`, current owner egress equal to configured owner egress and notification destination. Confirm protected staff/partner/provider egress. Reuse an existing live grant inside its scope; absent/expired/unclear scope means observe and prepare a concrete owner decision. Establish current health, Teleport validity and each source's reachable credentials through `keepass`.
3. Start all configured observers with `--config FILE --state-dir DIR`. Test access with `--once` first and inspect individual target statuses; process startup/exit alone does not establish coverage. Each script is read-only: `scripts/cf_watch.py`, `es_watch.py`, `sentry_watch.py`, `accounts_watch.py`. Read [signals](references/signals.md) before classifying events and [false positives and traps](references/false-positives-traps.md) before attributing an attacker.
4. Establish real supervision. Claude Code: Monitor watcher output and rearm at most every 30 minutes. Codex: use a managed background process and actively poll its persistent output while the agent is running. Each source must emit heartbeats; stale beyond `2 × interval + 60s` (660s at defaults), partial targets, GAP or access expiry are visible coverage incidents. Continue healthy siblings, state exactly which sources/time bounds are blind, and renew access through the owner before expiry. An ended agent turn does **not** promise future autonomous wakeups; arrange an available scheduler/supervisor or explicitly hand over/end coverage.

## Decide and act

| Evidence / action | Authority |
|---|---|
| Campaign fingerprint and ≥10 actual origin requests or protected API origin success | Exact IP under live same-project/zone `ip` grant; use helper below |
| IPv6 /64 conclusively one subscriber, never shared hosting/WARP | Separate `ipv6_64` grant and subscriber evidence; otherwise /128 only |
| Whole-cloud scanning ASN, attacker-only UA, unauthenticated sensitive paths | Only respective `asn` / `ua` / `path` grant and manual gates in actions reference |
| Account confidently attributed to attacker | Only `account_disable` grant through project's ops workflow, exact guarded transaction |
| Keys revoked/deleted, accounts/data deleted, our credentials rotated | Owner decision on exact IDs/action; historical blocking grant does not cover these |
| Low-volume residential 401/404, unclear identity, single suspicious path | Observe/profile first; no block |

Before **any** mutation, read [actions and recovery](references/actions.md). Each change requires evidence, health before, a unique private snapshot, bounded edit, readback, propagation verification after ≥35s for CF, health after, changelog, Jira comment and review date. IP helper dry-runs by default:

```sh
python3 SKILL_DIR/scripts/cf_block.py --config FILE --state-dir DIR --zone KEY --ip IP --evidence REF
```

Resolve `SKILL_DIR` from this loaded skill's actual directory. Inspect its plan; add `--apply` only after the full grant and project workflow gates hold. The helper accepts IPs and evidenced /64s, never arbitrary expressions. An `incomplete` result is an unresolved change, not permission to retry PATCH or restore a snapshot. `already_present` means no change; it is not a verified-change claim.

For this project's specialized procedures, use its IR/ops workflow; where installed, `combocards-ir` owns incident triage and `combocards-ops` owns production changes. Secrets use `keepass`. Work Jira closure/closed-field repair uses `jira-cc-close-ticket`; ordinary incident comments follow the project's workflow. Distro handoffs use bare names plus `verus-skills:<name>` when relevant. These dependencies do not expand the grant.

## Record and notify

Keep local heartbeats and deduplicated evidence; alert the configured destination only when the owner should act now: a live attacker account, API keys issued, material loss of Teleport/source coverage, credible breach evidence, or an action actually taken. Account created without a login is pending: revisit it and notify when evidence warrants immediate action; do not infer benignity or attacker identity from missing enrichment. Report enforcement uncertainty promptly. Browser work uses only the owner's authenticated Playwright MCP connection; diagnose/report missing connection rather than switching browsers.

End every reply with exactly the applicable status, honestly matching supervision:

- `Работаю дальше: …, напишу сам` only while an actual active supervisor will continue.
- `Жду от вас: …` for a specific missing owner decision/access or coverage handoff.
- `Готово: …` when the requested coverage/work ends.

A bot handoff is a new execution context: establish its own credentials, grant and notification channel, then confirm its supervisor and coverage. Installation, automatic discovery and an incident example grant do not activate a bot or transfer historic permission.
