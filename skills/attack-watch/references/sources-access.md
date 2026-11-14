# Sources, configuration and access

Read before startup or after any access failure. The packaged procedures derive from the repository-only `docs/handoff/attack-watch/HANDOFF.md` §§2–7 (INFRA-640, 13–14 November 2026); that file is provenance, not an installed runtime dependency. Every operational procedure needed here is packaged in these references. Historic IPs, account IDs and grants are not defaults.

## Configuration and credentials

Copy `examples/ccinfra.json` to the persistent project incident workspace, fill resource names, real zone IDs, ordered IR rule IDs, exact host filters, account initial cursor and grant. It intentionally has null IDs/cursor, no owner egress, disabled authority and no hooks; it cannot start or apply safely until configured. Source defaults: interval300s, window600s, deadline240s, requests≤30s, total targets≤32, response≤8MiB. Counts/pages are bounded by `common.load_config`. State and output directories are0700, JSON/snapshots0600. Keep stdout files private as they contain operational IDs/IPs.

`credentials` maps a source to an environment variable name and store metadata (`store_entry`, optional `store_key`), never the value. Before obtaining credentials read the installed `keepass` skill, use its approved store adapter, and populate only the named child-process environment in memory. A file credential may be consumed with the store's file/command wrapper; its exact mechanism belongs to keepass/project configuration. Never print tokens/passwords, shell-evaluate config, write secret `.env` files into the skill, or load live credentials for a development/tabletop run. No observer fetches secrets or renews Teleport itself.

| Source | Access contract | Evidence and bounds |
|---|---|---|
| CF | Configured API base (default official client/v4), bearer env; analytics/WAF permissions scoped to needed zones | `httpRequestsAdaptiveGroups`: IP, country, host, path, method, edge/origin status, UA, security action, minute. Adaptive groups are sampled; capped query is partial. Free zones may lack ASN; firewall events show ASN/UA/rule only for matched traffic. Obtain additional ASN evidence via approved project lookup when needed. |
| ES | Project Teleport app login and local app proxy, configured loopback URL, basic username/password env | Independent app access, app exceptions, ingress and host-security targets. Raw `message` parsed locally; output exception class or aggregates, never raw text/email/query. Deployment/index filters come from config. |
| PG | Configured `tsh db connect RESOURCE --db-user USER --db-name DB`, SQL stdin | Reads start `set default_transaction_read_only = on;`. This tsh command accepts no psql CLI flags: use `\pset` SQL-input lines. No read replica in the incident schema: small pages/aggregates only. |
| CH | Project `tsh proxy db RESOURCE --db-user READONLY_USER --db-name DB --tunnel --port PORT`; configured local HTTP URL | SQL via HTTP POST. First-login aggregates in batches≤100 IDs. Aliases must differ from column names (`first_ip`, not `ip`). |
| Sentry | Configured self-hosted API/organization/projects, token env | Bounded issue-list pagination, firstSeen/lastSeen/count/IDs. For manual escalation use exception type/frames only; never request/user/vars, full event payload or raw issue title. |
| Health | Project health executable supplied as argv hook | Public endpoints plus cluster checks through Teleport kube. Confirm all required cluster checks actually ran; expired cert means incomplete health. |

## Teleport startup and renewal

Run `tsh status` at startup; inspect identity, roles and expiry, ensure enough remaining validity for the next watch period, and check app/db/kube access separately. Authenticate with the project's approved login (`ctsh login` where provided) **before** expiry; owner interaction may be required. Start/inspect the ES app login+proxy and CH tunnel using configured resource names/ports; PG uses its configured connection argv. Verify read-only minimal queries and health, then start observers. Keep the proxy/tunnel in a managed persistent process as well as the observers.

Do not treat a running proxy or a local HTTP200 as proof of valid upstream access. On expiry, notify owner of exact blind sources (PG, CH, ES, kube health as applicable), record GAP, continue healthy sources and request renewal. After renewal verify sources/health and report recovered coverage bounds; no silent backfill claim. Browser connection is exclusively authenticated Playwright MCP. If missing, diagnose its connection and report blocker; switching browser tooling needs explicit owner instruction.

## Running and observing coverage

Resolve the loaded skill directory. Run each adapter as `python3 SKILL_DIR/scripts/NAME.py --config FILE --state-dir DIR --once`, then start continuous mode without `--once`; stdin must be detached (`</dev/null`) for managed background jobs. Capture stdout/stderr privately in the incident workspace, not `/tmp`. Config subprocess hooks and PG argv use `shell=False`.

Every source emits JSONL with UTC timestamps, STARTUP/window coverage, events, ERROR classes and HEARTBEAT containing per-target success/error/partial and last-success. A successful process iteration may contain failed targets: inspect its JSONL. Windows overlap; after an outage longer than the window or restart, GAP names exact uncovered interval. This implementation queries the current window, reports gaps and does not automatically reconstruct history. Capped Sentry snapshots cannot reconstruct historical count deltas. Budget exhaustion emits COVERAGE/partial, retaining last full-success bounds and continuations where supported.

Account startup requires an explicit owner-selected initial user ID cursor; historical1505 is not a safe default. ID ASC pages≤100, ≤3 new pages/poll, ≤100 revisits/poll, 24h revisit horizon. Recent-time reconciliation has its own budget/checkpoint because lower-ID transactions can commit late. A valid empty CH aggregate is no-login, not failed enrichment; it advances new cursor and stays revisitable. CH failures retain checkpoints. REVISIT_EXPIRED reports removal and no-login count. Exhausted local PG lane budgets preserve successful provisional work and allow reserved lanes; genuine PG/CH failure remains visible and prevents falsely advancing failed evidence.

A supervisor checks every source/target, stale heartbeats beyond `2×interval+60s`, proxy health and upcoming cert expiry. Claude Monitor expires: rearm≤30min. Codex must actively poll managed background output or use a separately authorized scheduler. Persisting a process is insufficient to promise that an ended agent turn will autonomously wake and classify/act.
