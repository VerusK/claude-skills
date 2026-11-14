# Signals and interpretation

Read when classifying events. Default CF window is10min with overlap and1–3min analytics lag. Counts are estimates at volume; sample/cap warnings narrow coverage. Events are leads for corroboration, not breach proof or mutation authority. Apply the false-positive reference before action.

## Cloudflare

The historic fingerprint mixed `curl/7.88.1` and Chrome Windows/X11 Linux from one IP, scanner tools sqlmap/nuclei/ffuf, probes on API keys/admin/users/all/disable-2fa/two-factor-auth/disable/recovery-phrase/import_phrase/AML PDF-to-chat/invoices-bulk-update paths, encoded slashes (`auth%2Fregister`, `recovery-phrase%2F`). Attackers later used low-volume residential proxies, WARP, CORS proxies (allOrigins), cloud servers and headless repeated `/login`. UA/path alone is not identity. Patterns and public/session/auth paths are configurable; inspect current project config rather than importing historic assumptions.

| Event | Default predicate | Meaning / next check |
|---|---|---|
| CANDIDATE | ≥2 categories of scanner≥5, bad-path≥3, distinct-path≥80, 4xx≥150; **or** scanner≥5 and bad≥1. Also require actual origin≥10 **or** protected API origin2xx≥1. Exempt egress removed from candidates. | bad≥2 alone insufficient; classify fingerprint and origin exposure. Low-volume401/404 residential traffic stays observation. |
| KEY | Any edge2xx POST/PUT/PATCH/DELETE on `/api/api-keys*` | Immediate attention; origin_status is included. Edge/cache2xx alone does not prove key creation. Correlate bounded PG key IDs/owner. |
| SESSION | Same fingerprint as CANDIDATE plus protected session endpoint origin2xx | Potential live account; confirm account attribution. Default endpoints users/owner, users/me, api-keys list. |
| RP-ENUM | Recovery-phrase request volume and wallet IDs receiving2xx | Verify each wallet belongs to requesting company in PG. Own-wallet recovery status200 is legitimate; no IDOR claim without ownership check. Never retrieve/output phrases. |
| AUTH-HIT | Same IP has failure then strictly later success minute on configured2FA/set-initial-password endpoints | Same-minute failure/success ordering is ambiguous. Exclude login: typo→success is normal. |
| AUTH-WAVE | ≥80 POSTs on configured2FA/initial-password paths, excluding login | Investigate bursts and correlate origin/account evidence. |

Actual origin means `originResponseStatus>0`; cached edge200 with origin0 is not origin load. Protected success requires200≤status<300 and origin evidence. Public landing/check_pd/track endpoints do not establish authenticated success. Edge403/origin0 means edge block. After blocking inspect security action and the latest minute: overlap tails can remain candidates. Free-zone analytics may omit ASN; firewall events contain only matches and cannot provide an unbiased request denominator.

## Application, ingress, hosts and Sentry

- APP5XX: at least3 app5xx in the window. Parse access `'METHOD /path HTTP/1.1' STATUS Nms` separately from errors, filtered by configured deployment.
- APPERR: exception class/new signature, with no raw message. Access log strings containing `ERROR` or OAuth `?error=access_denied` are not exception evidence.
- Ingress: aggregate status counts; separate coverage target from app access/errors.
- HOSTSEC: auditd rule keys outside configured daily baseline, e.g. usermgmt/sudoers/SSH/identity/cron/units/Teleport, and auth events≥100/window. The incident baseline had frequent root-exec, null and secrets rules; use current project's24h baseline, not a global allowlist. Preserve role/kind attribution without printing raw audit payloads.
- SENTRY: firstSeen in window/new issue or count jump≥20 between polls. Emit IDs/counts; inspect exception types/frames only if escalation warrants it. Binary-CSV import500s can be fuzzing/product defects; file exact product evidence separately. Count snapshots, paging caps and source outages cannot prove continuous history.

## New accounts and read-only forensics

NEWUSER includes account ID, company ID, epoch creation, active/verified flags, wallet count and first-login IP/country. Missing first login is **pending**, not benign and not an attacker verdict; revisit for24h including delayed activation/login. PG is timelier than CF for newly created accounts. Compare campaign IP/UA, probe activity and headless behavior; registration alone is insufficient. Keep IDs/timestamps/signatures rather than private account fields in persistent observer state.

For suspected breaches, map IPs→account IDs by time correlation in `login_history`/`activity_logs`; verify every successful object-ID access against company ownership. Check payments/outflows and key/grant counts via bounded aggregates in the project's schema. Historical investigation found own-wallet accesses, not cross-tenant access; that conclusion is not transferable to another incident. Aggregate only: no emails, request bodies, tokens, recovery phrases or user variables. Credible cross-tenant access or money movement warrants immediate owner/project IR escalation.
