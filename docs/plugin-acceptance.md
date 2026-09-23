# Plugin acceptance checklist

Run by hand after a packaging change lands on `main` and is pushed. The plugin is
installed from GitHub, so it tests what users get. Record the answers inline.

Last run: **2026-09-23**, `main` at `266d08e`, Claude Code 2.1.x, codex-cli 0.155.1.
Every step passed. The results are recorded under each step and in
[Results](#results-2026-09-23).

## Before you start

The plugin and the symlink install ship the same ten skills and the same
SessionStart hook. With both active:

- a bare skill name resolves through the symlink,
- the two hooks race to write `~/.verus-skills/root`,
- the Codex steps land on top of the `~/.codex/skills` symlinks.

So remove any symlink install first, and record where it came from so the
Teardown can put it back. Back up `~/.claude/settings.json`,
`~/.codex/config.toml` and `~/.codex/AGENTS.md` too, so you can diff them at the
end.

1. Find the checkout that owns the current symlinks:

   ```bash
   readlink ~/.claude/skills/kickoff
   ```

   It prints `<checkout>/skills/kickoff`. Record `<checkout>`: `/Users/sleepwalker/Projects/claude-skills`

   If it prints nothing, there is no symlink install. Skip steps 2 and 17, but still run steps 3 and 4.

2. Uninstall the symlink install from that checkout. If a pointer file exists, clear it. A stale pointer would make the plugin's first session report two installs.

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

5. From the checkout, `claude plugin validate . --strict --json` → exit 0.
6. `claude plugin marketplace add VerusK/claude-skills`. Then `claude plugin marketplace list` shows `verus-skills` with `Source: GitHub (VerusK/claude-skills)`.

   Do **not** add the marketplace from a local path (`claude plugin marketplace add "$PWD"`). Claude Code loads a `Directory` marketplace in place from the source folder. `CLAUDE_PLUGIN_ROOT`, the hook and the skills all point at the checkout, so neither the plugin cache nor the install path is exercised.

7. `claude plugin install verus-skills@verus-skills` → `claude plugin list` shows it enabled. `~/.claude/plugins/installed_plugins.json` records the `gitCommitSha` of `main`.
8. Start a new session. Check three things:
   - the context carries the `USING.md` routing block,
   - it has a `Distro root:` line under `~/.claude/plugins/cache/verus-skills/verus-skills/<version>`,
   - it has no `WARNING: two installs` line.

   If you check this with a headless `claude -p`, don't put the warning text into the prompt. A model asked "does your context contain `WARNING: two installs`?" sees the phrase in the question itself. Read the injected block instead, for example from the `--debug hooks` log under `~/.claude/debug/`.

   If a symlink install or a `Directory` marketplace ran just before, the first session may still warn. That warning is correct: the old pointer names a checkout. The next session must not warn.
9. `cat ~/.verus-skills/root` → the same cache directory as the `Distro root:` line.
10. Run the locator snippet from the cached `skills/kickoff/judge.md` in a shell call → `SKILLS_REPO` is that directory.
11. Run the "Call the judge" block from `skills/kickoff/judge.md` in one shell call. Use a trivial two-option question with a structured `context`, for example "Name the throwaway branch `tmp-a` or `tmp-b`?". Append these checks to the same call:

    ```bash
    [ -f "$SKILLS_REPO/scripts/reviewer.sh" ] && echo "reviewer.sh found" || echo "reviewer.sh missing"
    node -e 'import(process.argv[1]).then(async m => { const s = await import(m.vendoredSdkUrl()); console.log("vendored SDK:", typeof s.TypeSafeClient) })' "file://$SKILLS_REPO/scripts/typesafe-judge.mjs"
    ```

    Expected: `judge_exit=0`, `reviewer.sh found`, `vendored SDK: function`.

    Claude Code runs `npm install` for a plugin with dependencies, so the cache has `node_modules`, and the judge loads the SDK from there. The second check proves that the vendored copy under `vendor-node/` also loads from the cache. Codex needs that copy, because it installs no dependencies.

12. `claude plugin details verus-skills@verus-skills` → lists all ten skills and one SessionStart hook.
13. In a throwaway git repo, run `claude -p "/kickoff add a hello.sh script that prints hello"`. It announces kickoff and reaches its first question. The judge's decision blocks show that the judge ran from the cache.

Record: **does a bare skill name resolve inside the plugin, or is the `verus-skills:` prefix required?** A bare name resolves. A Skill tool call with `kickoff` loaded the plugin's skill. The prefix is optional.

Record: **is the slash command `/kickoff` or `/verus-skills:kickoff`?** Both work, and both reach kickoff's first question.

## Codex

14. Install through Codex's own CLI:

    ```bash
    codex plugin marketplace add VerusK/claude-skills
    codex plugin add verus-skills@verus-skills
    ```

    This writes `[marketplaces.verus-skills]` and `[plugins."verus-skills@verus-skills"]` to `~/.codex/config.toml`. The plugin lands in `~/.codex/plugins/cache/verus-skills/verus-skills/<version>`, which has no `node_modules`.

15. Start `codex` interactively. It shows **Hooks need review**; trust the `verus-skills` SessionStart hook. Then check:
    - the skills are listed as `verus-skills:<name>`,
    - the context has a `Distro root:` line under `~/.codex/plugins/cache/`,
    - `~/.verus-skills/root` points there.

    `codex exec` skips untrusted hooks silently. For a one-off non-interactive check, use `codex exec --dangerously-bypass-hook-trust …`. It trusts nothing permanently. `codex exec --skip-git-repo-check` also adds a `[projects."<dir>"] trust_level = "trusted"` entry for the directory it ran in, so remove it afterwards.

Record: **did the inline `hooks` block in `.codex-plugin/plugin.json` fire the SessionStart hook?** Yes, once it is trusted. It runs exactly once per session: one `Distro root:` line, and the routing block appears once. With the Claude Code install also present, it gives no two-installs warning, since both roots are plugin caches. Untrusted, it does not run at all.

## Teardown

16. Remove the plugin from both agents:

    ```bash
    claude plugin uninstall verus-skills@verus-skills
    claude plugin marketplace remove verus-skills
    codex plugin remove verus-skills@verus-skills
    codex plugin marketplace remove verus-skills
    rm -rf ~/.verus-skills
    ```

    The Codex commands drop both sections from `~/.codex/config.toml`. The symlink installer treats the plugin section alone as an install, and refuses while it is there. Claude Code keeps the old cache copy until its own in-use sweep removes it, and that is harmless.

17. Restore the symlink install from the checkout recorded in step 1, not from the checkout under test. Running it from any other checkout re-points the symlinks there. `--skip-plugin` keeps the `superpowers` plugin installed. Plain `make install` uninstalls it.

    ```bash
    (cd <checkout> && make install ARGS="--skip-plugin")
    readlink ~/.claude/skills/kickoff
    ```

    `make install` succeeds now that the plugin is gone, and `readlink` prints the same path as step 1. Diff the three config files against the backups taken before step 1.

## Results (2026-09-23)

| Step | Result |
|---|---|
| 1–4 | symlink install removed from `/Users/sleepwalker/Projects/claude-skills`; no skills, hook or AGENTS.md line left |
| 5 | `validate --strict` exit 0 |
| 6–7 | GitHub marketplace added; plugin 1.0.0 installed at `266d08e` |
| 8–9 | routing block and `Distro root: ~/.claude/plugins/cache/verus-skills/verus-skills/1.0.0`; pointer matches; no warning on the second session (the first warned, correctly, because a `Directory`-marketplace session had just written the checkout path) |
| 10 | locator → the Claude cache directory |
| 11 | `judge_exit=0`, `reviewer.sh found`, `node_modules present` (Claude Code installed the dependencies), vendored SDK loads from the cache |
| 12 | ten skills, one SessionStart hook, about 919 always-on tokens |
| 13 | bare `kickoff`, `/kickoff` and `/verus-skills:kickoff` all reach kickoff's first question |
| 14 | Codex CLI installed the plugin; its cache has no `node_modules` |
| 15 | untrusted: hook skipped; trusted (bypass flag): one `Distro root:` under the Codex cache, pointer updated, no two-installs warning |
| 16–17 | both plugins removed; symlinks restored with `--skip-plugin`; `config.toml` and `AGENTS.md` byte-identical to the backups; `settings.json` equal on every key |
