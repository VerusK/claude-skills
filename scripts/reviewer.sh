#!/usr/bin/env bash
# External reviewer launcher: Orca-managed Codex -> `codex exec` -> exit 3.
# Usage: reviewer.sh --prompt-file F --output REL_OUT --title T [--timeout-min N] [--session-file S] [--repo DIR]
# Exit: 0 report written; 3 no external reviewer available; 1 usage error.
set -uo pipefail

PROMPT_FILE=""; OUTPUT=""; TITLE=""; TIMEOUT_MIN=15; SESSION_FILE=""; REPO=""
while [ $# -gt 0 ]; do
  case "$1" in
    --prompt-file) PROMPT_FILE="$2"; shift 2;;
    --output) OUTPUT="$2"; shift 2;;
    --title) TITLE="$2"; shift 2;;
    --timeout-min) TIMEOUT_MIN="$2"; shift 2;;
    --session-file) SESSION_FILE="$2"; shift 2;;
    --repo) REPO="$2"; shift 2;;
    *) echo "unknown arg: $1" >&2; exit 1;;
  esac
done
if [ -z "$PROMPT_FILE" ] || [ -z "$OUTPUT" ] || [ -z "$TITLE" ]; then
  echo "usage: reviewer.sh --prompt-file F --output REL_OUT --title T [--timeout-min N] [--session-file S] [--repo DIR]" >&2
  exit 1
fi
[ -f "$PROMPT_FILE" ] || { echo "prompt file not found: $PROMPT_FILE" >&2; exit 1; }
REPO="${REPO:-$(git rev-parse --show-toplevel 2>/dev/null)}"
[ -d "$REPO" ] || { echo "not inside a git repo; pass --repo" >&2; exit 1; }
NODE_BIN="${NODE:-node}"

# Stage the prompt inside the repo so a sandboxed Codex can read it.
mkdir -p "$REPO/.context" "$REPO/$(dirname "$OUTPUT")"
if [ -d "$REPO/.git" ] || [ -f "$REPO/.git" ]; then
  EXCL="$(cd "$REPO" && git rev-parse --absolute-git-dir 2>/dev/null)/info/exclude"
  mkdir -p "$(dirname "$EXCL")"
  grep -qx '\.context/' "$EXCL" 2>/dev/null || echo '.context/' >> "$EXCL"
fi
PROMPT_REL=".context/${TITLE}-prompt.md"
cp "$PROMPT_FILE" "$REPO/$PROMPT_REL"
[ -z "$SESSION_FILE" ] && SESSION_FILE="$REPO/.context/${TITLE}-session"
rm -f "$REPO/$OUTPUT"

json_get() { # json_get '<js expr over j>'  (reads stdin)
  "$NODE_BIN" -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{let j;try{j=JSON.parse(s)}catch{process.exit(1)};const v=(function(j){return eval(process.argv[1])})(j);if(v===undefined||v===null||v===false){process.exit(1)};process.stdout.write(String(v))})' "$1"
}
find_handle() { json_get '(function f(o){if(!o||typeof o!=="object")return;if(typeof o.handle==="string")return o.handle;for(const v of Object.values(o)){const r=f(v);if(r)return r}})(j)'; }

wait_for_output() { # poll for the report for N minutes
  local deadline=$(( $(date +%s) + $1 * 60 ))
  while [ "$(date +%s)" -lt "$deadline" ]; do
    [ -s "$REPO/$OUTPUT" ] && return 0
    sleep 5
  done
  return 1
}

# ---------- 1. Orca ----------
if command -v orca >/dev/null 2>&1 && orca status --json 2>/dev/null | json_get 'j.result&&j.result.runtime&&j.result.runtime.reachable===true' >/dev/null; then
  HANDLE=""
  if [ -f "$SESSION_FILE" ]; then
    HANDLE="$(cat "$SESSION_FILE")"
    orca terminal show --terminal "$HANDLE" --json >/dev/null 2>&1 || HANDLE=""
  fi
  if [ -z "$HANDLE" ]; then
    HANDLE="$(orca terminal create --worktree active --command codex --title "$TITLE" --json 2>/dev/null | find_handle || true)"
    if [ -n "$HANDLE" ]; then
      orca terminal wait --terminal "$HANDLE" --for tui-idle --timeout-ms 90000 --json 2>/dev/null | json_get 'j.result&&j.result.wait&&j.result.wait.satisfied===true' >/dev/null || HANDLE=""
    fi
  fi
  if [ -n "$HANDLE" ]; then
    MSG="Read the file $PROMPT_REL and follow its instructions exactly. Write the report to $OUTPUT"
    if orca terminal send --terminal "$HANDLE" --text "$MSG" --enter --wait-submit 10 --json >/dev/null 2>&1; then
      orca terminal wait --terminal "$HANDLE" --for tui-idle --timeout-ms $(( TIMEOUT_MIN * 60000 )) --json >/dev/null 2>&1 || true
      if [ -s "$REPO/$OUTPUT" ] || wait_for_output 1; then
        echo "$HANDLE" > "$SESSION_FILE"
        echo "reviewer: orca"
        exit 0
      fi
    fi
    echo "orca: no report produced, falling back" >&2
  else
    echo "orca: could not start a codex terminal, falling back" >&2
  fi
fi

# ---------- 2. codex exec ----------
if command -v codex >/dev/null 2>&1; then
  LOG="$REPO/.context/${TITLE}-codex.log"
  ( cd "$REPO" && codex exec -C "$REPO" -s workspace-write --enable web_search_cached -c model_reasoning_effort=high - < "$REPO/$PROMPT_REL" > "$LOG" 2>&1 ) &
  PID=$!
  deadline=$(( $(date +%s) + TIMEOUT_MIN * 60 ))
  while kill -0 "$PID" 2>/dev/null; do
    [ "$(date +%s)" -ge "$deadline" ] && { kill "$PID" 2>/dev/null; echo "codex exec: timeout after ${TIMEOUT_MIN}m" >&2; break; }
    sleep 2
  done
  wait "$PID" 2>/dev/null
  if grep -qi 'not logged in\|authentication\|401' "$LOG" 2>/dev/null; then
    echo "codex exec: authentication failed (run 'codex login')" >&2
  elif [ -s "$REPO/$OUTPUT" ]; then
    echo "reviewer: codex-exec"
    exit 0
  else
    echo "codex exec: no report produced (see $LOG)" >&2
  fi
fi

echo "no external reviewer available (Orca and codex both failed or missing)" >&2
exit 3
