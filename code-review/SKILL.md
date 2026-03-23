---
name: code-review
description: >
  Multi-agent code review for quality, security, performance, testing, and accessibility.
  Auto-activate after code modifications or when the user asks for a code review.
argument-hint: "[branch|file|path]"
allowed-tools: Read, Glob, Grep, Bash(git diff*), Bash(git log*), Bash(git show*), Agent
---

# Code Review

Run a thorough, multi-agent code review of the current changes.

## 1. Gather Changes

Determine the review scope:
- If `$ARGUMENTS` is provided, use it as scope (branch name, file path, or glob pattern)
- If on `main`/`master` branch: review the full codebase (warn user this may be slow)
- Otherwise: `git diff main...HEAD` for all changes on the current branch

Collect the diff and list of changed files. If the diff is large, split by file or directory.

## 2. Launch Review Agents

Launch ALL applicable agents **in parallel** using the Agent tool. Pass each agent the diff/changed files and its review instructions from `${CLAUDE_SKILL_DIR}/agents/`.

| Agent | Instructions File | When to Launch |
|-------|------------------|----------------|
| Code Quality | `${CLAUDE_SKILL_DIR}/agents/code-quality.md` | Always |
| Security | `${CLAUDE_SKILL_DIR}/agents/security.md` | Always |
| Performance | `${CLAUDE_SKILL_DIR}/agents/performance.md` | Always |
| Testing | `${CLAUDE_SKILL_DIR}/agents/testing.md` | Always |
| Accessibility | `${CLAUDE_SKILL_DIR}/agents/accessibility.md` | Only if changes include frontend code (JSX, TSX, HTML, CSS, Vue, Svelte) |

Each agent prompt MUST include:
1. The review instructions (read from the agent's file)
2. The diff or changed file contents
3. Instruction to report problems only, no positive observations

## 3. Compile Report

After all agents complete, compile a single review report:

### Report Format

```
## Code Review: [branch or scope]

### Critical
[Issues that must be fixed before merge]

### Warnings
[Issues that should be addressed]

### Suggestions
[Improvements to consider]

### Summary
- Files reviewed: N
- Issues found: N critical, N warnings, N suggestions
- Review agents: [list of agents that ran]
```

Rules:
- Deduplicate findings across agents (same issue found by multiple agents = report once)
- Sort by severity: critical first, then warnings, then suggestions
- Each finding must include: file path, line number, description, and fix suggestion
- If no issues found, say so clearly
