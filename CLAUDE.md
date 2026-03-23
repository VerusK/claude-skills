# claude-skills

Collection of custom skills for Claude Code.

## Structure

Each skill is a directory with `SKILL.md` entry point:

```
<skill-name>/
  SKILL.md        # Frontmatter + instructions
  agents/         # Agent prompts (read by SKILL.md at runtime)
```

## Skills

- `code-review/` — multi-agent code review (launches 5 parallel agents)

## Notes

- Claude Code discovers skills one level deep: `~/.claude/skills/<name>/SKILL.md`
- Agent files are referenced via `${CLAUDE_SKILL_DIR}/agents/` in SKILL.md
- All agent prompts should end with "Report problems only - no positive observations."
