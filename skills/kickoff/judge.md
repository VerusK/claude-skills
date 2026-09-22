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
  "context": {
    "goal": "<one sentence: what the task delivers>",
    "decisions": ["<already settled decision 1>", "..."],
    "facts": ["<repo fact with file path, e.g. 'package.json: type module, node>=20'>", "<short excerpt if it matters>"],
    "constraints": ["<user rule or hard constraint>"],
    "consequences": {"A": "<what concretely happens or breaks if A is chosen: file, behaviour, test>", "B": "<same shape, same specificity, same length>"}
  },
  "recommended": "A"
}
JSON
node "$SKILLS_REPO/scripts/typesafe-judge.mjs" < "$Q"; echo "judge_exit=$?"
```

## Act on the result

- `judge_exit=0` and `"accepted": true` → the decision is made. Print the `block` field to the user verbatim, record the decision (see the calling skill), continue without waiting.
- `judge_exit=0` and `"accepted": false` → ask the user. Show the same `block` first, then the options with your recommendation, then wait.
- `judge_exit=0`, `"accepted": false` and the block's verdict ends in `(мало данных)` → the judge was confident but the `context` did not carry enough facts to justify it. Do not re-run with the same input. Either gather the missing facts (read the file, run the command) and judge once more, or ask the user. Never treat a `(мало данных)` result as agreement with your `recommended`.
- `judge_exit` is anything other than 0 (no key, network error, bad input, or the script could not be run at all — e.g. exit 1/127 when the repo was not located or node is missing) → ask the user as you normally would and add one line: `TypeSafe judge unavailable: <stderr line>`. Never auto-accept without exit 0 and `accepted: true`.

## Rules

- Options must be mutually exclusive, and every option's `description` states the concrete consequence of taking it — not a restatement of the label.
- `consequences` is mechanical, not evaluative: one entry per option id; each names what concretely happens or breaks (file, behaviour, test) if that option is chosen — equal specificity and length for every id; no comparative or preference language ("better", "simpler", "recommended"). A `consequences` map that is detailed only for some options is a defect and the question must be rewritten before judging.
- `facts` carries the evidence: file paths, exact settings, short excerpts. A question is judge-able only if `facts` alone would let a stranger pick. If you cannot write such a `facts` list, the question is not judge-able: ask the user directly.
- `decisions` accumulates across rounds of the same interview: every answer already settled goes in, so later questions are judged against the design as it stands.
- `constraints` holds the user's rules and the hard limits; `goal` is one sentence.
- `context` must carry facts, never your opinion. Your opinion lives in `recommended`, which is shown to the user and is **never** sent to the judge — that is what keeps the judge an independent second read rather than an echo of your pick.
- Total `context` must stay under 8 KB serialised; the script rejects more. Trim excerpts, not facts.
- Escape `"` and `\` inside the JSON strings; write multi-line strings as `\n` — a parse error makes the judge look unavailable when the input was yours.
- Questions about the user's personal taste, credentials, or anything outside the repo are never auto-accepted: skip the judge and ask.
