#!/usr/bin/env bash
# Remove gstack, compound-engineering and superpowers leftovers from Claude and Codex.
# Usage: cleanup.sh [--yes] [--home DIR]
# No `set -u`: macOS ships bash 3.2, where expanding an empty array under -u aborts.
set -o pipefail

usage() {
  echo "usage: cleanup.sh [--yes] [--home DIR]" >&2
}

YES=0
H="$HOME"
HOME_GIVEN=0

while [ $# -gt 0 ]; do
  case "$1" in
    --yes|-y)
      YES=1; shift;;
    --home)
      if [ $# -lt 2 ]; then echo "cleanup.sh: --home requires a directory" >&2; usage; exit 1; fi
      H="$2"; HOME_GIVEN=1; shift 2;;
    --home=*)
      H="${1#--home=}"; HOME_GIVEN=1; shift
      if [ -z "$H" ]; then echo "cleanup.sh: --home requires a directory" >&2; usage; exit 1; fi;;
    -h|--help)
      usage; exit 0;;
    *)
      echo "cleanup.sh: unknown argument: $1" >&2; usage; exit 1;;
  esac
done

if [ -z "$H" ]; then
  # Never silently fall back to the real $HOME when it is unset.
  echo "cleanup.sh: no home directory (\$HOME is unset); pass --home DIR" >&2
  usage
  exit 1
fi
if [ ! -d "$H" ]; then
  echo "cleanup.sh: not a directory: $H" >&2
  exit 1
fi
if [ "$HOME_GIVEN" = 1 ]; then
  echo "cleanup: operating on $H"
fi

FAILURES=0

confirm() { # confirm "<title>"
  if [ "$YES" = 1 ]; then return 0; fi
  local ans
  printf '%s [y/N] ' "$1"
  # EOF on stdin leaves ans empty -> treated as "no".
  ans=""
  read -r ans || true
  [ "$ans" = y ] || [ "$ans" = Y ]
}

backup_path() { # backup_path <file> -> a path that does not exist yet
  local f="$1" ts cand i
  if [ ! -e "$f.bak" ]; then echo "$f.bak"; return 0; fi
  ts=$(date +%Y%m%d-%H%M%S)
  cand="$f.bak.$ts"
  i=1
  while [ -e "$cand" ]; do cand="$f.bak.$ts-$i"; i=$((i + 1)); done
  echo "$cand"
}

remove_paths() { # remove_paths <title> <path>...
  local title="$1"; shift
  local existing=()
  local p
  for p in "$@"; do
    # Only ever touch paths inside the home we were pointed at.
    case "$p" in
      "$H"/*) ;;
      *) continue;;
    esac
    if [ -e "$p" ] || [ -L "$p" ]; then existing+=("$p"); fi
  done
  if [ ${#existing[@]} -eq 0 ]; then
    echo "$title: nothing to remove"
    return 0
  fi
  echo "$title:"
  printf '  %s\n' "${existing[@]}"
  if confirm "Remove these?"; then
    for p in "${existing[@]}"; do rm -rf "$p"; done
    echo "  removed"
  else
    echo "  skipped"
  fi
  return 0
}

strip_json_key() { # strip_json_key <file> <top-level object key> <entry key>
  local f="$1" obj="$2" key="$3" tmp status bak
  [ -f "$f" ] || return 0
  tmp="$f.tmp.$$"
  # node writes the edited copy to <tmp> and exits 3 when there is nothing to do,
  # so the original is only ever replaced after a complete, successful rewrite.
  node -e '
    const fs = require("fs");
    const [f, obj, key, tmp] = process.argv.slice(1);
    let j;
    try { j = JSON.parse(fs.readFileSync(f, "utf8")); }
    catch (e) { console.error("  " + f + ": " + e.message); process.exit(1); }
    if (j && typeof j === "object" && j[obj] && typeof j[obj] === "object" && key in j[obj]) {
      delete j[obj][key];
      try { fs.writeFileSync(tmp, JSON.stringify(j, null, 2) + "\n"); }
      catch (e) { console.error("  " + f + ": " + e.message); process.exit(1); }
      process.exit(0);
    }
    console.log("  " + f + ": no " + obj + "." + key);
    process.exit(3);
  ' "$f" "$obj" "$key" "$tmp"
  status=$?
  if [ "$status" = 3 ]; then
    rm -f "$tmp"
    return 0
  fi
  if [ "$status" != 0 ] || [ ! -f "$tmp" ]; then
    rm -f "$tmp"
    echo "  failed: $f" >&2
    FAILURES=$((FAILURES + 1))
    return 1
  fi
  bak=$(backup_path "$f")
  if ! cp "$f" "$bak"; then
    echo "cleanup.sh: cannot back up $f" >&2
    rm -f "$tmp"
    exit 1
  fi
  if ! mv "$tmp" "$f"; then
    echo "cleanup.sh: cannot write $f (backup kept at $bak)" >&2
    rm -f "$tmp"
    exit 1
  fi
  echo "  $f: removed $obj.$key (backup: $bak)"
  return 0
}

# 1. gstack in the shared agents dir (plus the superpowers symlink)
gstack_dirs=()
for d in "$H"/.agents/skills/gstack "$H"/.agents/skills/gstack-*; do
  if [ -e "$d" ] || [ -L "$d" ]; then gstack_dirs+=("$d"); fi
done
remove_paths "gstack (Claude / .agents)" "${gstack_dirs[@]}" "$H/.agents/skills/superpowers"

# 2. Claude compound-engineering plugin files
remove_paths "compound-engineering (Claude plugin cache)" \
  "$H/.claude/plugins/cache/compound-engineering-plugin" \
  "$H/.claude/plugins/marketplaces/compound-engineering-plugin"

# 2b. compound-engineering entries in Claude JSON config
SETTINGS="$H/.claude/settings.json"
INSTALLED="$H/.claude/plugins/installed_plugins.json"
if [ -f "$SETTINGS" ] || [ -f "$INSTALLED" ]; then
  if ! command -v node >/dev/null 2>&1; then
    echo "compound-engineering (Claude JSON config): node not found, skipping" >&2
  else
    echo "compound-engineering entries in Claude JSON config:"
    [ -f "$SETTINGS" ] && echo "  $SETTINGS (enabledPlugins)"
    [ -f "$INSTALLED" ] && echo "  $INSTALLED (plugins)"
    if confirm "Remove compound-engineering entries (backup to .bak)?"; then
      json_ok=1
      strip_json_key "$SETTINGS" enabledPlugins "compound-engineering@compound-engineering-plugin" || json_ok=0
      strip_json_key "$INSTALLED" plugins "compound-engineering@compound-engineering-plugin" || json_ok=0
      if [ "$json_ok" = 1 ]; then echo "  edited"; fi
    else
      echo "  skipped"
    fi
  fi
else
  echo "compound-engineering entries in Claude JSON config: nothing to remove"
fi

# 3. Codex files
remove_paths "Codex leftovers" \
  "$H/.codex/superpowers" \
  "$H/.codex/compound-engineering" \
  "$H/.codex/skills/compound-engineering" \
  "$H/.codex/agents/compound-engineering"

# 4. Codex config.toml sections
CFG="$H/.codex/config.toml"
if [ -f "$CFG" ]; then
  echo "config.toml sections to drop: [marketplaces.compound-engineering-plugin], [plugins.\"compound-engineering@compound-engineering-plugin\"], [plugins.\"superpowers@claude-plugins-official\"]"
  if confirm "Edit $CFG (backup to .bak)?"; then
    CFG_TMP="$CFG.tmp.$$"
    # POSIX awk only. The rewrite goes to a temp file next to the original; the
    # original is never used as a redirect target and is replaced only on success.
    if ! awk -v t1='[marketplaces.compound-engineering-plugin]' \
             -v t2='[plugins."compound-engineering@compound-engineering-plugin"]' \
             -v t3='[plugins."superpowers@claude-plugins-official"]' '
      function trim(s) { sub(/^[ \t\r]+/, "", s); sub(/[ \t\r]+$/, "", s); return s }
      # Normalised header of a section line, or "" when the line is not a header.
      # Quotes are honoured, unquoted spaces squeezed out and a trailing
      # # comment ignored; "[1, 2]," (an array continuation) is not a header.
      function header(s,   i, c, q, depth, out, rest) {
        s = trim(s)
        if (substr(s, 1, 1) != "[") return ""
        q = ""; depth = 0; out = ""
        for (i = 1; i <= length(s); i++) {
          c = substr(s, i, 1)
          if (q != "") { out = out c; if (c == q) q = ""; continue }
          if (c == DQ || c == SQ) { q = c; out = out c; continue }
          if (c == " " || c == "\t" || c == "\r") continue
          if (c == "#") return ""
          out = out c
          if (c == "[") { depth++; continue }
          if (c == "]") {
            depth--
            if (depth == 0) {
              rest = trim(substr(s, i + 1))
              if (rest == "" || substr(rest, 1, 1) == "#") return out
              return ""
            }
          }
        }
        return ""
      }
      # A header is dropped when it is a target or a subtable of one.
      function dropped(h,   i) {
        for (i = 1; i <= NT; i++) {
          if (h == T[i]) return 1
          if (substr(h, 1, length(P[i])) == P[i]) return 1
        }
        return 0
      }
      BEGIN {
        DQ = "\""; SQ = sprintf("%c", 39)
        NT = 3; T[1] = t1; T[2] = t2; T[3] = t3
        for (i = 1; i <= NT; i++) P[i] = substr(T[i], 1, length(T[i]) - 1) "."
      }
      {
        h = header($0)
        if (h != "") {
          ns = dropped(h)
          if (ns && !skip) pending = 0
          if (!ns && skip) {
            # At most one blank line stands in for a dropped block; blank lines
            # anywhere else (multi-line strings included) are left alone.
            if (pending && emitted && !prevblank) { print ""; prevblank = 1 }
            pending = 0
          }
          skip = ns
        }
        if (skip) { if ($0 ~ /^[ \t\r]*$/) pending = 1; next }
        print
        emitted = 1
        prevblank = ($0 ~ /^[ \t\r]*$/)
      }
    ' "$CFG" > "$CFG_TMP"; then
      echo "cleanup.sh: cannot rewrite $CFG" >&2
      rm -f "$CFG_TMP"
      exit 1
    fi
    if cmp -s "$CFG_TMP" "$CFG"; then
      rm -f "$CFG_TMP"
      echo "  nothing to edit"
    else
      CFG_BAK=$(backup_path "$CFG")
      if ! cp "$CFG" "$CFG_BAK"; then
        echo "cleanup.sh: cannot back up $CFG" >&2
        rm -f "$CFG_TMP"
        exit 1
      fi
      if ! mv "$CFG_TMP" "$CFG"; then
        echo "cleanup.sh: cannot write $CFG (backup kept at $CFG_BAK)" >&2
        rm -f "$CFG_TMP"
        exit 1
      fi
      echo "  edited (backup: $CFG_BAK)"
    fi
  else
    echo "  skipped"
  fi
else
  echo "config.toml: nothing to edit"
fi

if [ "$FAILURES" -gt 1 ]; then
  echo "cleanup done ($FAILURES failures)"
elif [ "$FAILURES" -gt 0 ]; then
  echo "cleanup done (1 failure)"
else
  echo "cleanup done"
fi
exit 0
