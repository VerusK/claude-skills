# Judging a multiple-choice question with TypeSafe

Use this whenever you are about to ask the user a question that has 2–6 concrete options.

## Locate the repo

```bash
for d in "${CLAUDE_SKILL_DIR:-}" "$HOME/.claude/skills/kickoff" "$HOME/.codex/skills/kickoff"; do
  [ -n "$d" ] && [ -e "$d/SKILL.md" ] && SKILLS_REPO="$(cd "$(dirname "$(realpath "$d")")/.." && pwd)" && break
done
echo "SKILLS_REPO=$SKILLS_REPO"
```

## Call the judge

Write the question to a temp file and run the script:

```bash
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
- `judge_exit=2` (no key, network error, bad input) → ask the user as you normally would and add one line: `TypeSafe judge unavailable: <stderr line>`. Never auto-accept without a successful judge call.

## Rules

- Options must be mutually exclusive and phrased so that a reader with only the `context` can pick one. If you cannot write such a context, the question is not judge-able: ask the user directly.
- `context` must include facts, not your opinion; put your opinion in `recommended`.
- Questions about the user's personal taste, credentials, or anything outside the repo are never auto-accepted: skip the judge and ask.
