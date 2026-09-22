# Plugin acceptance checklist

Run once, by hand, after the packaging plan lands. Record the answers inline.

## Claude Code

1. `claude plugin validate . --strict --json` → exit 0.
2. `claude plugin marketplace add "$PWD"` → the marketplace `verus-skills` is listed by `claude plugin marketplace list`.
3. `claude plugin install verus-skills@verus-skills` → `claude plugin list` shows it.
4. Start a new session. The context carries the `USING.md` routing block and a `Distro root:` line.
5. `cat ~/.verus-skills/root` → an existing directory under `~/.claude/plugins/cache/verus-skills/verus-skills/<version>`.
6. Run the locator snippet from `skills/kickoff/judge.md` in a shell call → `SKILLS_REPO` is that directory.
7. `claude plugin details verus-skills@verus-skills` → all ten skills listed.
8. Invoke the kickoff skill on a throwaway task → it announces itself and reaches its first question.

Record: **does a bare skill name resolve inside the plugin, or is the `verus-skills:` prefix required?** ______

Record: **is the slash command `/kickoff` or `/verus-skills:kickoff`?** ______

## Codex

9. Add the `[marketplaces.verus-skills]` and `[plugins."verus-skills@verus-skills"]` sections to `~/.codex/config.toml`, start `codex`.
10. The skills are listed; `~/.verus-skills/root` points into `~/.codex/plugins/cache/`.

Record: **did the inline `hooks` block in `.codex-plugin/plugin.json` fire the SessionStart hook?** ______

If it did not, the Codex install has no pointer file: note it and open a follow-up, since the locator's symlink branches do not exist under a plugin install.

## Teardown

11. `claude plugin uninstall verus-skills@verus-skills`, `claude plugin marketplace remove verus-skills`, `rm -rf ~/.verus-skills`.
12. `make install` (the symlink path) → succeeds again now that the plugin is gone.
