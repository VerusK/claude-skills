# False positives and runtime traps

Read before attributing an attacker or explaining a change's apparent failure.

## Profile before blocking

- SPA hosts can return index.html with200 for `/.env` or arbitrary paths; compare approved body hashes or origin behavior. Edge200 served from CF cache with origin0 is not origin load/authentication.
- Apex/docs hosts may redirect301 before WAF, yielding no protected resource. Check redirect chain and actual host.
- Public `/api/landing/*`, `/api/check_pd/`, `/api/track` success is not a session. The SPA itself calls `/api/users/all`; a single path does not identify an attacker.
- A user reading their own wallet recovery-phrase status is legitimate; check requester/company/wallet ownership in PG without fetching phrases.
- Staff Teleport `tsh`/Go-http-client can ping `/webapi/ping` thousands of times with an old client. Partner Go-http-client polling on an API host may be all legitimate200.
- Telegram mini-app Android users, blackbox monitoring, provider webhooks on notify hosts and company egress to feedback hosts are legitimate classes. Establish project allowlists and current owner egress before containment. Exemptions prevent block candidates but do not hide anomalies.
- Shared hosting SLAAC /64 and WARP ranges are never one subscriber merely because one IP attacks. Use exact /128. A /64 needs affirmative subscriber proof plus its own grant.
- One-off residential IPs (<10 actual origin requests, only401/404) stay observation: mass IP blocking consumes scarce expression space without stopping rotation.
- OAuth `google/callback?error=access_denied` is often a cancelled sign-in. Exclude access lines from error signatures.
- Health failure immediately after a change can be a parallel deploy with unready pods, or the operator network/VPN. Recheck public/cluster health and deploy state, record uncertainty, and investigate before blaming/rolling back the block. Health failure still makes the operation incomplete.

## Operational traps

Keep tools in the repo/installed skill and state/logs/snapshots in a persistent incident workspace. `/tmp` and scratchpads may disappear on reboot. Use private permissions. Never restore a full CF snapshot: rollback removes only this operation's exact clause from current live state.

Teleport certificates can expire mid-watch (historic12h) and remove DB/cluster health for hours. Check status at startup, supervise expiry and request approved login before expiration; say precisely what is blind. Healthy CF does not imply healthy PG/CH/ES/kube access. Recovered access does not fill historical GAP automatically.

macOS `/bin/bash` may be3.2, so shell glue must avoid associative arrays. A bare `cat > file` blocks waiting for stdin; use a complete heredoc. Detach background Python stdin with `</dev/null`. Use managed process handles and the current runtime's background facilities, not a promise of wakeup after ending a turn.

PG timestamp columns here are epoch integers: use `to_timestamp()` for human dates, compare epochs for bounded scans. `tsh db connect` takes no psql flags. CH aggregate aliases must not shadow source columns (`argMin(ip, ts_spawn) AS first_ip`). Reads must stay small on the production master. Recent-time reconciliation covers lower-ID late commits only within its configured24h horizon; it is not historical recovery.

CF analytics lag1–3min: a just-created account may already appear in PG while absent in CF. Query windows overlap block time; check `blocked`/security action and last-minute data before re-acting. A silent watcher may be dead: require heartbeats, rearm Claude Monitor≤30min and actively poll managed Codex output. Partial/capped data remains partial.

The owner requires authenticated **Playwright MCP only** for browser automation. If disconnected, diagnose and report the connection blocker. Do not silently use another browser tool or unauthenticated alternate browser. Browser failure need not stop read-only API observers that remain healthy.
