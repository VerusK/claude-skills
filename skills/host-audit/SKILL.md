---
name: host-audit
description: Read-only security audit of one or more hosts/VMs over SSH (bare server, docker/k8s node, DB, balancer, storage, backup, telemetry). Inventories attack surface, reachability, trust graph, persistence, component versions/EOL, and incident traces, then writes a per-host report with prioritised findings in the language the user picks. Use when asked to audit a host, "прогнать аудит хоста", harden a server after a breach, or check a machine's exposure. For several hosts it fans out to one read-only subagent per host after asking the user the max concurrency. Everything is read-only and defensive.
---

# Host security audit

Read-only, defensive audit of a running host over SSH. The full method is in
`references/methodology.md` (keep it open while working); this file is the **orchestration
layer**: parse the host list, run one host directly or fan out to subagents for many, aggregate.

The skill is self-contained: the whole methodology is in `references/methodology.md` next to this
file. Resolve the **absolute path of the skill directory** (`$SKILL_DIR`, the folder holding this
`SKILL.md`) and use `$SKILL_DIR/references/methodology.md` everywhere below; never hard-code a path,
so the skill works from any location and for other models.

Change nothing on the hosts (rules in the methodology, section "IRON RULES"). All output goes to
`audits/<date>/…` under the current directory, never to the repository root. Secrets are masked
before anything is written to disk.

## 1. Parse the input

The user gives one or more hosts (separated by spaces, commas or newlines), plus optionally:
- `SSH_USER` (default: `$USER`);
- `IR_MODE` (`0`/`1`; default `0`, but set `1` when the IOC file names the host as a point of
  compromise);
- `IR_IOC_FILE`: the incident's IOCs (default `~/.verus-skills/host-audit/ioc.md`; a local file
  that never goes into the repository; format in Appendix B of the methodology);
- `IR_WINDOW_START` (for IR mode);
- `REPORT_LANG`: the language of the reports.

Normalise into a host list. Let `N` be the number of hosts.

Set `AUDIT_AGENT` to the name of the AI agent running the audit (`claude` | `codex` | `zcode` |
`glm` | …). Default: the model/agent executing the skill now (in Claude Code, `claude`). It is
always part of every run directory name: **`<host>_<AUDIT_AGENT>_<HHMM>`**, so runs of different
models against the same host are told apart and directories never collide.

Before starting: check access quickly (`ssh -o BatchMode=yes -o ConnectTimeout=10
$SSH_USER@<host> true`) and, if the incident material says so, each host's role: it decides
`IR_MODE` and the methodology's routes.

## 2. Ask before starting (one `AskUserQuestion` call)

Ask everything in a single `AskUserQuestion` call, before any audit command runs:

1. **Report language** (skip when the user already named one, or `REPORT_LANG` was given):
   - question: "Which language should the audit reports be written in?"; header: "Language";
   - options: `Russian`, `English`; the language the user is writing in goes first, marked
     "(Recommended)"; any other language comes through "Other".
2. **Max concurrency** (only when `N > 1`):
   - question: "How many audit subagents may run in parallel at most? (N hosts)"; header:
     "Subagents";
   - options: `3 (Recommended)`, `2`, `5`; any other number comes through "Other".

Call the answers `REPORT_LANG` and `MAX`. `REPORT_LANG` covers the report `AUDIT_<host>_<date>.md`,
the string values in `findings.json`, the index of §4c and the summary in chat. File names,
`findings.json` keys, commands, evidence excerpts, severity labels (P0/P1/P2) and finding IDs stay
as they are.

## 3. One host (N == 1)

Run the audit yourself, in the current session, strictly by `references/methodology.md`: PHASE 0
→ classification → applicable blocks (C, D, T, V, J, K always; E/F/G/H/I/O by profile) → PHASE Y
(self-check) → PHASE Z (report, in `REPORT_LANG`). Put everything in
`audits/<YYYYMMDD>/<host>_<AUDIT_AGENT>_<HHMM>/`, the report `AUDIT_<host>_<date>.md` and
`findings.json` included. Finish with a short summary for the user (host role, top findings by
severity, path to the report).

## 4. Several hosts (N > 1): fan out to subagents

### 4a. Concurrency

`MAX` comes from §2. Never more than `MAX` subagents at once; the remaining hosts start as the
running ones finish.

### 4b. One subagent per host

One subagent per host (the `Agent` tool), **read-only**:
- `subagent_type`: `verus-worker` (`verus-skills:verus-worker` under the plugin): model and effort
  come from the distro's `config/models.json` (Opus class); do not pass `model`.
- Unnamed and in the background (`run_in_background`), like every subagent of the distro.
- `description`: `audit <host>` (3–5 words).
- Launch up to `MAX` `Agent` calls in one message (they run in parallel); start the next host each
  time a completion notification arrives, so that no more than `MAX` run at once.

**Prompt for each subagent** (substitute host/SSH_USER/IR_MODE/IR_IOC_FILE/IR_WINDOW_START/REPORT_LANG):
> Run a **read-only** security audit of host `<host>` strictly by the methodology in
> `$SKILL_DIR/references/methodology.md` (substitute the absolute path; read it first). Parameters:
> `SSH_USER=<...>`, `IR_MODE=<...>`, `IR_IOC_FILE=<...>`, `IR_WINDOW_START=<...>`,
> `REPORT_LANG=<...>`, `AUDIT_BASE=<absolute path>/audits`.
> Change nothing on the host. All evidence, `findings.json` and the report `AUDIT_<host>_<date>.md`
> go to `audits/<date>/<host>_claude_<HHMM>/` (directory name strictly `<host>_<agent>_<HHMM>`;
> you run as agent `claude`, so `AUDIT_AGENT=claude`; your own unique directory, do not touch
> anyone else's files). Write the report in `REPORT_LANG`.
> Mask secrets before writing to disk (the runner from Appendix A of the methodology). Run network
> Bash commands with `dangerouslyDisableSandbox`. Reply with ONLY a short summary in
> `REPORT_LANG`: host role, whether it is a crown-jewel host, finding counts by severity
> (P0/P1/P2), the 3–5 main attack paths one line each, and the absolute path to the report. No raw
> dumps in the reply.

Give each subagent the absolute `AUDIT_BASE` path so that all of them write into one shared folder.

### 4c. Aggregate

When every subagent is back, write the index `audits/<date>/INDEX_<date>.md` in `REPORT_LANG`: a
table "host → role → P0 / P1 / P2 → path to report", plus the **links between hosts** you noticed
(shared keys, VM templates, backup↔prod trust; see BLOCK T of the methodology). Give the user this
index and a short summary; the details stay in the reports, no dumps in chat.

## 5. Boundaries

- Read-only, authorised audits only. If a host is unreachable or `sudo -n` asks for a password,
  record it in the report as a coverage limitation and move on; never try to work around it.
- Generate no outbound traffic on the host's behalf (details: rule 2 of the methodology).
- Check versions against vendor bulletins online (BLOCK V) with `WebSearch`/`WebFetch`; facts come
  from public sources, not from memory.

## 6. Portability and hand-off to other models

The skill is self-contained: the `host-audit/` folder (this `SKILL.md` plus
`references/methodology.md`) is all it needs. To hand it to another model or project, copy the
folder whole. The incident's IOCs are not in the folder: `IR_IOC_FILE` travels separately and only
to those allowed to see it.

Outside the distro (no `verus-worker` agent), launch the §4b subagents as `general-purpose` with
`model: opus`; in Codex, through `spawn_agent` with no model.

When the target environment has no `Skill`/`AskUserQuestion`/`Agent` tools:
- `SKILL.md` reads as a plain runbook and `references/methodology.md` as a detailed prompt.
- The questions of §2 are asked as plain text in chat.
- Without `Agent`, the §4b fan-out becomes a sequential run, one host at a time; the rule
  "subagents that execute code are Opus class" still holds wherever subagents exist.
