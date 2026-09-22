# Plugin acceptance checklist

Run once, by hand, after the packaging plan lands. Record the answers inline.

## Before you start

The plugin and the symlink install ship the same ten skills and the same
SessionStart hook. With both active, a bare skill name resolves through the
symlink, the two hooks race to write `~/.verus-skills/root`, and the Codex steps
land on top of the `~/.codex/skills` symlinks. So remove any symlink install
first, and remember where it came from so the Teardown can put it back.

1. Find the checkout that owns the current symlinks:

   ```bash
   readlink ~/.claude/skills/kickoff
   ```

   It prints `<checkout>/skills/kickoff`. Record `<checkout>`: ______

   If it prints nothing, there is no symlink install. Skip steps 2–4 and step 16.

2. Uninstall the symlink install from that checkout, then clear the pointer file it may have left behind. A stale pointer would make the plugin's first session report two installs.

   ```bash
   (cd <checkout> && make uninstall)
   rm -rf ~/.verus-skills
   ```

3. Check that neither skills directory still holds any of the ten skills. The loop must print nothing:

   ```bash
   for s in kickoff writing-plans plan-review subagent-driven-development review \
            finishing-a-development-branch systematic-debugging test-driven-development \
            verification-before-completion typesafe-ai; do
     for d in ~/.claude/skills ~/.codex/skills; do
       { [ -e "$d/$s" ] || [ -L "$d/$s" ]; } && echo "still there: $d/$s"
     done
   done
   ```

4. `grep -n session-start.mjs ~/.claude/settings.json` → no match. The symlink install's SessionStart hook is gone.

## Claude Code

Run these from the checkout under test.

5. `claude plugin validate . --strict --json` → exit 0.
6. `claude plugin marketplace add "$PWD"` → `claude plugin marketplace list` shows the marketplace `verus-skills`.
7. `claude plugin install verus-skills@verus-skills` → `claude plugin list` shows it.
8. Start a new session. The context carries the `USING.md` routing block and a `Distro root:` line, and no `WARNING: two installs` line.
9. `cat ~/.verus-skills/root` → an existing directory under `~/.claude/plugins/cache/verus-skills/verus-skills/<version>`.
10. Run the locator snippet from `skills/kickoff/judge.md` in a shell call → `SKILLS_REPO` is that directory.
11. `claude plugin details verus-skills@verus-skills` → lists all ten skills.
12. Invoke the kickoff skill on a throwaway task → it announces itself and reaches its first question.

Record: **does a bare skill name resolve inside the plugin, or is the `verus-skills:` prefix required?** ______

Record: **is the slash command `/kickoff` or `/verus-skills:kickoff`?** ______

## Codex

13. Add the `[marketplaces.verus-skills]` and `[plugins."verus-skills@verus-skills"]` sections to `~/.codex/config.toml`, then start `codex`.
14. The skills are listed, and `~/.verus-skills/root` points into `~/.codex/plugins/cache/`.

Record: **did the inline `hooks` block in `.codex-plugin/plugin.json` fire the SessionStart hook?** ______

If it did not, the Codex install has no pointer file. Note it and open a follow-up, because the locator's symlink branches do not exist under a plugin install.

## Teardown

15. Remove the plugin install:

    ```bash
    claude plugin uninstall verus-skills@verus-skills
    claude plugin marketplace remove verus-skills
    rm -rf ~/.verus-skills
    ```

    Also drop the `[marketplaces.verus-skills]` and `[plugins."verus-skills@verus-skills"]` sections from `~/.codex/config.toml`. The symlink installer treats the plugin section alone as an install, and refuses while it is there.

16. Restore the symlink install from the checkout recorded in step 1, not from the checkout under test. Running it from any other checkout re-points the symlinks there.

    ```bash
    (cd <checkout> && make install)
    readlink ~/.claude/skills/kickoff
    ```

    `make install` succeeds now that the plugin is gone, and `readlink` prints the same path as step 1.
