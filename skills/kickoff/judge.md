# Judging a multiple-choice question with TypeSafe

Use this whenever you are about to ask the user a question that has 2–6 concrete options.

Every fenced block below is one shell call; the locator must be at the top of any
block that uses `$SKILLS_REPO`.

## Locate the repo (informational)

This block is for reference only — it shows what the locator does. Do not rely on
it to export `SKILLS_REPO` for a later block; variables do not survive between
shell calls.

```bash
for d in "${CLAUDE_SKILL_DIR:-}" "$HOME/.claude/skills/kickoff" "$HOME/.codex/skills/kickoff"; do
  [ -n "$d" ] && [ -e "$d/SKILL.md" ] && SKILLS_REPO="$(cd "$(dirname "$(realpath "$d")")/.." && pwd)" && break
done
[ -f "$SKILLS_REPO/scripts/typesafe-judge.mjs" ] || echo "judge not found: SKILLS_REPO=$SKILLS_REPO"
echo "SKILLS_REPO=$SKILLS_REPO"
```

## Call the judge

This is the block you actually run: locator first, then the question, then the
script — all in one call.

```bash
for d in "${CLAUDE_SKILL_DIR:-}" "$HOME/.claude/skills/kickoff" "$HOME/.codex/skills/kickoff"; do
  [ -n "$d" ] && [ -e "$d/SKILL.md" ] && SKILLS_REPO="$(cd "$(dirname "$(realpath "$d")")/.." && pwd)" && break
done
[ -f "$SKILLS_REPO/scripts/typesafe-judge.mjs" ] || echo "judge not found: SKILLS_REPO=$SKILLS_REPO"
echo "SKILLS_REPO=$SKILLS_REPO"

Q=$(mktemp)
cat > "$Q" <<'JSON'
{
  "question": "<the question, one sentence>",
  "options": [
    {"id": "A", "label": "<short label>", "description": "<one line, trade-off>"},
    {"id": "B", "label": "<short label>", "description": "<one line, trade-off>"}
  ],
  "context": "<3–8 lines: task goal, relevant repo facts, constraints already settled>",
  "recommended": "A"
}
JSON
node "$SKILLS_REPO/scripts/typesafe-judge.mjs" < "$Q"; echo "judge_exit=$?"
```

## Act on the result

- `judge_exit=0` and `"accepted": true` → the decision is made. Print the `block` field to the user verbatim, record the decision (see the calling skill), continue without waiting.
- `judge_exit=0` and `"accepted": false` → ask the user. Show the same `block` first, then the options with your recommendation, then wait.
- `judge_exit` is anything other than 0 (no key, network error, bad input, or the script could not be run at all — e.g. exit 1/127 when the repo was not located or node is missing) → ask the user as you normally would and add one line: `TypeSafe judge unavailable: <stderr line>`. Never auto-accept without exit 0 and `accepted: true`.

## Rules

- Options must be mutually exclusive and phrased so that a reader with only the `context` can pick one. If you cannot write such a context, the question is not judge-able: ask the user directly.
- `context` must include facts, not your opinion; put your opinion in `recommended`.
- Escape `"` and `\` inside the JSON strings; write multi-line context as `\n` — a parse error makes the judge look unavailable when the input was yours.
- Questions about the user's personal taste, credentials, or anything outside the repo are never auto-accepted: skip the judge and ask.
