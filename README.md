# claude-skills

Collection of custom skills for [Claude Code](https://claude.ai/claude-code).

## Available Skills

| Skill | Command | Description |
|-------|---------|-------------|
| [Code Review](code-review/) | `/code-review` | Multi-agent code review (quality, security, performance, testing, a11y) |

More skills coming soon: planning, plan review, refactoring.

## Installation

### Quick (via Claude Code)

Open Claude Code and run:

```
install skills from https://github.com/VerusK/claude-skills
```

Claude will clone the repo and symlink all skills for you.

### Manual

```bash
git clone https://github.com/VerusK/claude-skills.git
cd claude-skills

# Symlink all skills into personal skills directory
for skill in */SKILL.md; do
  ln -sf "$(pwd)/$(dirname "$skill")" ~/.claude/skills/
done
```

> Claude Code discovers skills only one level deep (`~/.claude/skills/<name>/SKILL.md`),
> so each skill must be symlinked individually — a single symlink to the whole repo won't work.

### Update

```bash
cd claude-skills && git pull
```

Symlinks pick up changes automatically. To add newly added skills after pull:

```bash
for skill in */SKILL.md; do
  ln -sf "$(pwd)/$(dirname "$skill")" ~/.claude/skills/
done
```

## Uninstall

```bash
# Remove all skills from this repo
for skill in ~/.claude/skills/*; do
  [ -L "$skill" ] && readlink "$skill" | grep -q "claude-skills" && rm "$skill"
done

# Or remove a specific skill
rm ~/.claude/skills/code-review
```

## Usage

### Code Review

```
# Review current branch changes vs main
/code-review

# Review a specific branch
/code-review feature/auth

# Review a specific file
/code-review src/api/handler.ts
```

Launches parallel review agents and produces a single report grouped by severity (critical / warning / suggestion).

## Structure

```
<skill-name>/
  SKILL.md        # Skill entry point (frontmatter + instructions)
  agents/         # Agent prompts for parallel execution
```

## License

MIT
