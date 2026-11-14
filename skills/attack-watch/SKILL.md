---
name: attack-watch
description: Use for continuous defensive attack observation across Cloudflare, Elasticsearch, Sentry and new accounts.
---

# Attack watch

This Task 1 package provides read-only observer scripts. Operational supervision and mutation procedures are pending Task 2; this package grants observation only.

Configure project sources and environment credential names from [the example](examples/ccinfra.json), replacing its deliberately unconfigured zone IDs and initial account cursor. Use the project secrets workflow to populate the named environment variables. Store observer state in a private project incident directory outside this skill.

Run the selected script with `--config FILE --state-dir DIRECTORY --once` for one bounded poll; omit `--once` for continuous polling. Scripts: [Cloudflare](scripts/cf_watch.py), [Elasticsearch](scripts/es_watch.py), [Sentry](scripts/sentry_watch.py), [accounts](scripts/accounts_watch.py). Inspect JSONL heartbeat target status and last-success bounds; ERROR, GAP and COVERAGE events describe unavailable or partial evidence. A running observer requires an active supervisor; ending an agent turn does not promise future wakeups.
