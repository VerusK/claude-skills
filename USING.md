# Skills routing (claude-skills distro)

You have a personal skills distro installed. Before responding to any task, check whether one of these applies and invoke it with the Skill tool; if there is even a small chance a skill applies, invoke it.

Skills are named below without a prefix. Under the plugin install each one is addressed as `verus-skills:<name>` — `verus-skills:kickoff`, `verus-skills:review` and so on; under the symlink development install, by the bare name.

## The flow for any non-trivial change

1. `kickoff` — always first for a new task: classifies (spike / bounded / architectural), interviews via a decision tree, auto-answers multiple-choice questions through the TypeSafe judge, writes the spec to `docs/specs/`.
2. `spec-review` — external review of the spec by Codex before the user approves it; findings judged (findings against the user's own decisions go to the user); one re-review round; then the user's approval.
3. `writing-plans` — turns the approved spec into `docs/plans/<date>-<name>.md`.
4. `plan-review` — external review of the plan by Codex; findings judged; one re-review round.
5. `subagent-driven-development` — executes the plan task by task with fresh subagents (the `verus-worker` and `verus-reviewer` agent types) and per-task reviews.
6. `review` — external review of the whole branch by Codex; one fix wave; one re-review. It also runs standalone: on given paths or globs, or over the whole codebase.
7. `finishing-a-development-branch` — merge / PR / keep.

Each skill names the next one; follow the chain. Never skip `plan-review` or `review`, and never skip `spec-review` after an architectural kickoff — bounded and spike tasks write no spec and go straight to their own next step.

## Outside the flow

- `systematic-debugging` — any bug, failing test or unexpected behavior, before proposing a fix.
- `test-driven-development` — any implementation or bugfix, before writing code.
- `verification-before-completion` — before claiming anything is done, fixed or passing.
- `typesafe-ai` — when the project itself builds features on TypeSafe.

## Decisions

Whenever a skill auto-accepts an answer via the TypeSafe judge, the decision block (question, options with probabilities, choice, confidence, sufficiency) is printed in chat immediately and recorded in the spec, plan or review report. The user always sees what was decided and from what.

## Rules

- Subagents are dispatched unnamed and in the background, never as named teammates with their own windows. In Claude Code they run as the distro's agent types via `subagent_type` — `verus-worker`, `verus-reviewer`, `verus-explorer` (prefixed `verus-skills:` under the plugin install) — whose model and effort come from `config/models.json`; never pass a `model` parameter. In a Codex session they are dispatched with spawn_agent, with no model. The user reads your summary, not the subagents.
- Work in the current checkout; never create git worktrees.
- User instructions (CLAUDE.md, AGENTS.md, direct requests) override skills.
