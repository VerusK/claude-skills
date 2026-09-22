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

confirm() { # confirm "<title>"
  if [ "$YES" = 1 ]; then return 0; fi
  printf '%s [y/N] ' "$1"
  # EOF on stdin leaves ans empty -> treated as "no".
  ans=""
  read -r ans || true
  [ "$ans" = y ] || [ "$ans" = Y ]
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
  [ -f "$1" ] || return 0
  cp "$1" "$1.bak"
  node -e '
    const fs=require("fs");const [f,obj,key]=process.argv.slice(1);
    const j=JSON.parse(fs.readFileSync(f,"utf8"));
    if(j[obj]&&key in j[obj]){delete j[obj][key];fs.writeFileSync(f,JSON.stringify(j,null,2)+"\n");console.log(`  ${f}: removed ${obj}.${key}`);}
    else{console.log(`  ${f}: no ${obj}.${key}`);}
  ' "$1" "$2" "$3"
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
      strip_json_key "$SETTINGS" enabledPlugins "compound-engineering@compound-engineering-plugin"
      strip_json_key "$INSTALLED" plugins "compound-engineering@compound-engineering-plugin"
      echo "  edited"
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
    cp "$CFG" "$CFG.bak"
    awk '
      /^[[:space:]]*\[/ {
        line = $0
        sub(/^[[:space:]]+/, "", line)
        sub(/[[:space:]]+$/, "", line)
        skip = (line == "[marketplaces.compound-engineering-plugin]" ||
                line == "[plugins.\"compound-engineering@compound-engineering-plugin\"]" ||
                line == "[plugins.\"superpowers@claude-plugins-official\"]")
      }
      !skip { print }
    ' "$CFG.bak" | cat -s > "$CFG"
    echo "  edited"
  else
    echo "  skipped"
  fi
else
  echo "config.toml: nothing to edit"
fi

echo "cleanup done"
