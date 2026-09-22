#!/usr/bin/env bash
# External reviewer launcher: Orca-managed Codex -> `codex exec` -> exit 3.
# Usage: reviewer.sh --prompt-file F --output REL_OUT --title T [--timeout-min N] [--session-file S] [--repo DIR]
# Exit: 0 report written; 3 no external reviewer available; 1 usage error.
set -uo pipefail

PROMPT_FILE=""; OUTPUT=""; TITLE=""; TIMEOUT_MIN=15; SESSION_FILE=""; REPO=""
need_value() { [ "$1" -ge 2 ] || { echo "missing value for $2" >&2; exit 1; }; }
while [ $# -gt 0 ]; do
  case "$1" in
    --prompt-file) need_value $# "$1"; PROMPT_FILE="$2"; shift 2;;
    --output) need_value $# "$1"; OUTPUT="$2"; shift 2;;
    --title) need_value $# "$1"; TITLE="$2"; shift 2;;
    --timeout-min) need_value $# "$1"; TIMEOUT_MIN="$2"; shift 2;;
    --session-file) need_value $# "$1"; SESSION_FILE="$2"; shift 2;;
    --repo) need_value $# "$1"; REPO="$2"; shift 2;;
    *) echo "unknown arg: $1" >&2; exit 1;;
  esac
done
if [ -z "$PROMPT_FILE" ] || [ -z "$OUTPUT" ] || [ -z "$TITLE" ]; then
  echo "usage: reviewer.sh --prompt-file F --output REL_OUT --title T [--timeout-min N] [--session-file S] [--repo DIR]" >&2
  exit 1
fi
case "$OUTPUT" in
  /*) echo "--output must be repo-relative" >&2; exit 1;;
esac
# A non-numeric or zero budget would make every poll loop exit instantly.
case "$TIMEOUT_MIN" in
  ''|*[!0-9]*) TIMEOUT_MIN="";;
esac
if [ -z "$TIMEOUT_MIN" ] || [ "$TIMEOUT_MIN" -lt 1 ]; then
  echo "--timeout-min must be a positive integer" >&2
  echo "usage: reviewer.sh --prompt-file F --output REL_OUT --title T [--timeout-min N] [--session-file S] [--repo DIR]" >&2
  exit 1
fi
[ -f "$PROMPT_FILE" ] || { echo "prompt file not found: $PROMPT_FILE" >&2; exit 1; }
REPO="${REPO:-$(git rev-parse --show-toplevel 2>/dev/null)}"
[ -d "$REPO" ] || { echo "not inside a git repo; pass --repo" >&2; exit 1; }
NODE_BIN="${NODE:-node}"
ORCA_DISABLED=""
NODE_OK=1
command -v "$NODE_BIN" >/dev/null 2>&1 || { echo "node not found; Orca path disabled" >&2; ORCA_DISABLED=1; NODE_OK=""; }

# Codex model / reasoning effort: env > config/reviewer.json > hard defaults.
# NB: without node the file cannot be parsed, so the codex path falls back to
# env/defaults rather than losing the pinning altogether.
# Locate this script: BASH_SOURCE survives sourcing, and symlinks (including
# relative ones, and chains of them) are followed before taking the dirname.
SELF="${BASH_SOURCE[0]:-$0}"
HOPS=0
while [ -L "$SELF" ] && [ "$HOPS" -lt 40 ]; do
  LINK="$(readlink "$SELF")"
  case "$LINK" in
    /*) SELF="$LINK";;
    *) SELF="$(dirname "$SELF")/$LINK";;
  esac
  HOPS=$(( HOPS + 1 ))
done
SELF_DIR="$(cd "$(dirname "$SELF")" 2>/dev/null && pwd -P)"
CFG="${SELF_DIR:-.}/../config/reviewer.json"
cfg_get() { # cfg_get <key> <default>
  local v=""
  if [ -n "$NODE_OK" ] && [ -f "$CFG" ]; then
    v="$("$NODE_BIN" -e 'const fs=require("fs");let j;try{j=JSON.parse(fs.readFileSync(process.argv[1],"utf8"))}catch{process.exit(1)};const v=j&&j[process.argv[2]];if(typeof v!=="string"||!v.trim())process.exit(1);process.stdout.write(v.trim())' "$CFG" "$1" 2>/dev/null)" || v=""
  fi
  if [ -n "$v" ]; then printf '%s' "$v"; else printf '%s' "$2"; fi
}
CODEX_MODEL="${REVIEWER_CODEX_MODEL:-$(cfg_get codexModel gpt-6-astra)}"
CODEX_REASONING="${REVIEWER_CODEX_REASONING:-$(cfg_get codexReasoning high)}"

# Stage the prompt inside the repo so a sandboxed Codex can read it.
mkdir -p "$REPO/.context" "$REPO/$(dirname "$OUTPUT")"
if [ -d "$REPO/.git" ] || [ -f "$REPO/.git" ]; then
  # NB: in a linked worktree git reads <common-dir>/info/exclude, not <gitdir>/info/exclude.
  EXCL="$(cd "$REPO" && git rev-parse --path-format=absolute --git-path info/exclude 2>/dev/null)"
  if [ -z "$EXCL" ]; then # git < 2.31 has no --path-format
    # NB: never default the common dir to "." — a failing rev-parse would then
    # create <repo>/info/exclude inside the working tree.
    COMMON=""
    GCD="$(cd "$REPO" && git rev-parse --git-common-dir 2>/dev/null)"
    [ -n "$GCD" ] && COMMON="$(cd "$REPO" && cd "$GCD" 2>/dev/null && pwd)"
    [ -n "${COMMON:-}" ] && EXCL="$COMMON/info/exclude"
  fi
  if [ -n "$EXCL" ]; then
    mkdir -p "$(dirname "$EXCL")"
    # A repo that already ignores .context/ (its own .gitignore, a global one)
    # needs no exclude entry — never write one it did not ask for.
    git -C "$REPO" check-ignore -q .context 2>/dev/null ||
      grep -qx '\.context/' "$EXCL" 2>/dev/null ||
      echo '.context/' >> "$EXCL"
  else
    echo "warning: could not locate info/exclude; .context/ not excluded" >&2
  fi
fi
PROMPT_REL=".context/${TITLE}-prompt.md"
cp "$PROMPT_FILE" "$REPO/$PROMPT_REL"
[ -z "$SESSION_FILE" ] && SESSION_FILE="$REPO/.context/${TITLE}-session"
rm -f "$REPO/$OUTPUT"

json_get() { # json_get '<js expr over j>'  (reads stdin)
  "$NODE_BIN" -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{let j;try{j=JSON.parse(s)}catch{process.exit(1)};const v=(function(j){return eval(process.argv[1])})(j);if(v===undefined||v===null||v===false){process.exit(1)};process.stdout.write(String(v))})' "$1"
}
# Prefer the documented shapes, then fall back to a generic walk for any {handle:"…"}.
find_handle() { json_get '(j&&j.result&&j.result.terminal&&j.result.terminal.handle)||(j&&j.result&&j.result.startupTerminal&&j.result.startupTerminal.handle)||(function f(o){if(!o||typeof o!=="object")return;if(typeof o.handle==="string")return o.handle;for(const v of Object.values(o)){const r=f(v);if(r)return r}})(j)'; }

# The reviewer streams the report as it writes it, so "the file exists" is not
# "the file is finished": accept it only once its size held still across two
# consecutive polls.
output_size() { wc -c < "$REPO/$OUTPUT" 2>/dev/null | tr -d ' '; }
wait_for_output() { # poll for a stable, non-empty report for N seconds
  local deadline=$(( $(date +%s) + $1 ))
  local prev="" cur=""
  while [ "$(date +%s)" -lt "$deadline" ]; do
    if [ -s "$REPO/$OUTPUT" ]; then
      cur="$(output_size)"
      [ -n "$prev" ] && [ "$cur" = "$prev" ] && return 0
      prev="$cur"
    else
      prev=""
    fi
    sleep 5
  done
  return 1
}

# Codex's TUI can sit on a question (directory trust, an approval) that
# `tui-idle` cannot tell from readiness; Orca reports it as agentWait.
stuck_on_prompt() { # stuck_on_prompt <handle>
  orca terminal show --terminal "$1" --json 2>/dev/null |
    json_get '(function f(o){if(!o||typeof o!=="object")return;if(o.agentWait&&o.agentWait.reason==="agent-interactive-prompt")return true;for(const v of Object.values(o)){const r=f(v);if(r)return r}})(j)' >/dev/null
}

# ---------- 1. Orca ----------
if [ -z "$ORCA_DISABLED" ] && command -v orca >/dev/null 2>&1 && orca status --json 2>/dev/null | json_get 'j.result&&j.result.runtime&&j.result.runtime.reachable===true' >/dev/null; then
  HANDLE=""
  # Only a terminal this run created may be closed on the way out; one loaded
  # from the session file belongs to an earlier round.
  CREATED_HANDLE=""
  REPORTED=""
  if [ -f "$SESSION_FILE" ]; then
    HANDLE="$(cat "$SESSION_FILE")"
    orca terminal show --terminal "$HANDLE" --json >/dev/null 2>&1 || HANDLE=""
  fi
  if [ -z "$HANDLE" ]; then
    CREATED_HANDLE="$(orca terminal create --worktree active --command "codex -m $CODEX_MODEL -c model_reasoning_effort=$CODEX_REASONING" --title "$TITLE" --json 2>/dev/null | find_handle || true)"
    if [ -n "$CREATED_HANDLE" ]; then
      orca terminal wait --terminal "$CREATED_HANDLE" --for tui-idle --timeout-ms 90000 --json 2>/dev/null | json_get 'j.result&&j.result.wait&&j.result.wait.satisfied===true' >/dev/null && HANDLE="$CREATED_HANDLE"
    fi
    if [ -n "$HANDLE" ]; then
      # First run in a checkout: Codex asks "Do you trust the contents of this
      # directory?" and tui-idle is satisfied while it waits for the answer.
      if orca terminal read --terminal "$HANDLE" --json 2>/dev/null | grep -qi 'trust'; then
        orca terminal send --terminal "$HANDLE" --text 1 --enter --wait-submit 10 --json >/dev/null 2>&1
        orca terminal wait --terminal "$HANDLE" --for tui-idle --timeout-ms 60000 --json >/dev/null 2>&1 || true
        if stuck_on_prompt "$HANDLE"; then
          echo "orca: still at an interactive prompt after the trust answer, falling back" >&2
          HANDLE=""; REPORTED=1
        fi
      fi
    fi
  fi
  if [ -n "$HANDLE" ]; then
    MSG="Read the file $PROMPT_REL and follow its instructions exactly. Write the report to $OUTPUT"
    if orca terminal send --terminal "$HANDLE" --text "$MSG" --enter --wait-submit 10 --json >/dev/null 2>&1; then
      if stuck_on_prompt "$HANDLE"; then
        echo "orca: the prompt went to an interactive prompt, not the reviewer; falling back" >&2
      else
        # tui-idle is an early-exit hint only — it is satisfied seconds after the
        # send, long before the review is written. The report file is the signal.
        DEADLINE=$(( $(date +%s) + TIMEOUT_MIN * 60 ))
        orca terminal wait --terminal "$HANDLE" --for tui-idle --timeout-ms $(( TIMEOUT_MIN * 60000 )) --json >/dev/null 2>&1 || true
        REMAIN=$(( DEADLINE - $(date +%s) ))
        [ "$REMAIN" -lt 10 ] && REMAIN=10
        if wait_for_output "$REMAIN"; then
          echo "$HANDLE" > "$SESSION_FILE"
          echo "reviewer: orca"
          exit 0
        fi
        echo "orca: no report produced, falling back" >&2
      fi
    else
      echo "orca: no report produced, falling back" >&2
    fi
  elif [ -z "$REPORTED" ]; then
    echo "orca: could not start a codex terminal, falling back" >&2
  fi
  [ -n "$CREATED_HANDLE" ] && { orca terminal close --terminal "$CREATED_HANDLE" --json >/dev/null 2>&1 || true; }
fi

# ---------- 2. codex exec ----------
if command -v codex >/dev/null 2>&1; then
  LOG="$REPO/.context/${TITLE}-codex.log"
  ( cd "$REPO" && codex exec -C "$REPO" -m "$CODEX_MODEL" -s workspace-write --enable web_search_cached -c model_reasoning_effort="$CODEX_REASONING" - < "$REPO/$PROMPT_REL" > "$LOG" 2>&1 ) &
  PID=$!
  deadline=$(( $(date +%s) + TIMEOUT_MIN * 60 ))
  while kill -0 "$PID" 2>/dev/null; do
    [ "$(date +%s)" -ge "$deadline" ] && { kill "$PID" 2>/dev/null; echo "codex exec: timeout after ${TIMEOUT_MIN}m" >&2; break; }
    sleep 2
  done
  wait "$PID" 2>/dev/null
  # The report is the source of truth: a review that merely *discusses* auth/401
  # is a success. When there is no report, report what codex actually said —
  # the log opens with the echoed prompt, so guessing a cause out of it (an auth
  # grep, say) misreads the prompt's own text as codex's failure.
  if [ -s "$REPO/$OUTPUT" ]; then
    echo "reviewer: codex-exec"
    exit 0
  else
    TAIL="$(grep -v '^[[:space:]]*$' "$LOG" 2>/dev/null | tail -1)"
    echo "codex exec failed: ${TAIL:-(log empty)} (full log: $LOG)" >&2
  fi
fi

echo "no external reviewer available (Orca and codex both failed or missing)" >&2
exit 3
