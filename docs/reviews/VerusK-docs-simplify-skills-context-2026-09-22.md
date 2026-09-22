# Review: VerusK/docs-simplify-skills-context vs 6581d92

> Reviewer: the fallback reviewer, a Claude subagent (Opus). This is not an independent external model. The Codex path was unavailable because of a hard usage limit until 2026-09-26.
>
> Suite: `npm test` passed, 157/157, including the real `claude plugin validate` check. The run left the working tree clean and `~/.verus-skills` absent. `vendor-node/@typesafe-ai/sdk/` was checked for shape, not read line by line. It holds 9 files at 0.6.0, matching `package-lock.json`, with no `dependencies` and no bare imports in `dist/index.mjs`. It is not gitignored.

## Verdict
READY WITH FIXES: the packaging, locator, vendoring and release wiring work and are tested. The one runtime problem is in the documented dual-agent setup. There, the SessionStart hook flags a legitimate Claude plus Codex plugin install as a conflict and advises uninstalling one of them.

## Findings (confidence 7+)
[P2] (confidence: 8/10) scripts/session-start.mjs:57-60 — False "two installs" warning in the recommended setup. README:95-114 tells the user to install the plugin for both Claude Code and Codex. Each agent's hook then writes its own cache root, `~/.claude/plugins/cache/verus-skills/verus-skills/<v>` or `~/.codex/plugins/cache/verus-skills/verus-skills/<v>`. Every session that starts after the other agent's session sees `other !== root && looksLikeDistro(other)`, prints `WARNING: two installs of this distro are active` inside the `<EXTREMELY_IMPORTANT>` block, and advises `claude plugin uninstall …` or ``make uninstall` run from <codex cache dir>``. Both pieces of advice are wrong: the first removes an install the user wants, and the second cannot be run from a cache dir. I reproduced this with a fake Codex cache path in the pointer and a scratch HOME. The same branch also covers the ledger's post-`claude plugin update` case, where an old `<version>` dir that is kept around still passes `looksLikeDistro`. — Fix: warn only when at least one of the two roots is outside a `…/plugins/cache/verus-skills/` directory, which means a symlink checkout is involved. Suppress the warning when both roots are plugin-cache copies. Add a test with two cache-shaped roots.
[P2] (confidence: 8/10) docs/plugin-acceptance.md:53-55 — The spec's manual acceptance (§5) ends with "судья отвечает `judge_exit=0` → `reviewer.sh` находится" ("the judge returns `judge_exit=0` → `reviewer.sh` is found"). The spec's first goal is that the judge and the external reviewer actually work from the plugin cache. The checklist only runs the locator (step 10) and "kickoff reaches its first question" (step 12). Nothing runs `node "$SKILLS_REPO/scripts/typesafe-judge.mjs"` from the cache, so the vendored-SDK fallback is never checked end to end. Nothing checks `[ -f "$SKILLS_REPO/scripts/reviewer.sh" ]` either. This is a plan-level omission: Task 8 Step 6 dropped these checks. — Fix: add a step after 10 that runs the judge block from `skills/kickoff/judge.md` in a shell call and records `judge_exit=0`. Also confirm there that `$SKILLS_REPO/node_modules` does not exist, so the vendored copy is the one loaded. Add a check that `$SKILLS_REPO/scripts/reviewer.sh` exists.
[P3] (confidence: 9/10) skills/review/SKILL.md:87-91,102 — The codebase-scope exclusion list drops `vendor/` and `node_modules/` but not the new `vendor-node/`. `review all` on this repo now embeds 9 generated files, about 209 KB, as "this repo's own code": minified dist, `.d.ts` files and two single-line source maps. I verified this with the same `git grep -Il` pathspec. The ``:(exclude)vendor`` pattern does not match `vendor-node`. — Fix: add `':(exclude)vendor-node'` to the pathspec and to the list on line 102 and in README.md's `review` table.

## Appendix (confidence below 7)
[P3] (confidence: 5/10) README.md:216 — The README says "Nothing reaches `claude plugin update` until the tag is pushed". For a `"source": "./"` plugin in a git marketplace, the update reads the default branch and compares the `plugin.json` version. The `verus-skills--v<x>` tag is not consulted. So a pushed release commit reaches users with or without the tag, and a tag pushed from a non-default branch does not. The tag is annotated (`git tag -a`, confirmed with `claude plugin tag --dry-run`), so `--follow-tags` does push it. — Fix: reword to say that users get the release once the bumped commit is on the default branch.
[P3] (confidence: 5/10) docs/plugin-acceptance.md:28 — Step 6 adds the marketplace from `"$PWD"`, a local directory. If the local-path install copies the checkout's untracked `node_modules/` into the cache, the acceptance run exercises the checkout's SDK rather than `vendor-node/`. — Fix: add the `node_modules` absence check from finding 2, or run the acceptance from a fresh clone without `npm install`.
[P3] (confidence: 5/10) tests/vendor-sdk.test.mjs:88-110 — Plan Review Focus 4 asks for a test of "vendor-node exists but its ESM entry file is missing → judge exits 2". The tests cover `vendor-node/` being absent, and `vendoredSdkUrl` failing when `package.json` has no entry fields. They do not cover an entry field that names a missing file. The code handles that case, because `main`'s try/catch turns `ERR_MODULE_NOT_FOUND` into exit 2, but no test pins it. — Fix: copy `vendor-node/`, delete `dist/index.mjs` and assert exit 2 and `judge failed:`.
[P3] (confidence: 4/10) skills/kickoff/judge.md:18 — The pointer is global across agents. After a plugin uninstall, a Codex session under the symlink install (which has no hook) keeps using a stale pointer into a cache dir the plugin manager retains. It does so until the next Claude session rewrites the pointer. README's `rm -rf ~/.verus-skills` step covers this if it is followed.

## Plan alignment notes
The implementation matches the plan task for task. The deviations from the spec are justified improvements:
- The matcher adds `resume`.
- `vendor-sdk.mjs` pins to the lock and verifies integrity, where the spec only pinned to `package.json`.
- `make release` has a clean-tree guard and a scoped commit.
- The symlink main-module guard in the hook was added.
- The hand-off list grew by two sites.

"judge not found" became "distro root not found", a cosmetic departure from spec §4.4. The one plan-level defect is the acceptance checklist dropping the spec's judge and reviewer runtime checks (finding 2). The spec's statement that Codex runs SessionStart hooks is what makes finding 1 fire in the documented dual-agent install.

## Ledger triage
- Ruling (Co-Authored-By trailer): OK. All 16 commits carry it.
- Ruling (network steps with the sandbox disabled): OK. This is environment-only.
- Ruling (T2 Step 7 `ls ~/.verus-skills` plus the `SESSION_START` grep): OK. The suite ran here and `~/.verus-skills` is still absent.
- Ruling (T4 strict fixes only in the new manifests): OK. skills/ validates clean.
- Ruling (continue on the renamed branch): OK. The branch is not main, and HEAD descends from 972e214.
- Ruling (keep the `npm test` recipe): OK. The two recipes are equivalent.
- Task 1 bare `catch {}` in loadSdk: OK. Any failure falls through to the vendored copy, and a real failure there still surfaces as exit 2.
- Task 1 fallback test checks only `typeof TypeSafeClient`: OK. It runs from tmpdir, outside any repo; this is low risk.
- Task 1 no detection of hand edits to vendor-node dist: OK. It is not blocking; per-file hashes could be recorded later.
- Task 1 lockedEntry missing-integrity branch untested: OK. It is a trivial guard.
- Task 1 "no ESM entry" wording and single-hash SRI assumption: OK. npm lockfiles record one sha512.
- Ruling (realpath main-module guard in session-start): OK. It is verified by the symlink test.
- Task 2 non-atomic pointer write: OK. Both readers treat empty as absent.
- Task 2 dead try/catch in looksLikeDistro: OK. It is cosmetic.
- Task 2 read-only-HOME tests fail as root: OK. The suite does not run as root.
- Task 2 false two-installs warning after a plugin update: OK to merge, but fold it into finding 1's fix. The same guard, suppressing the warning when both roots are plugin-cache copies, removes it.
- Task 2 spawn assertions omit stderr: OK. This only affects diagnostics.
- Task 2 no /tmp→/private/tmp alias test: OK. realpathSync covers it.
- Task 3 extractLocator only exercises the informational block: OK. The count test plus the identical-text test cover drift.
- Task 3 no precedence, Codex-branch or whitespace-pointer tests: OK. This is a test gap, not a bug.
- Task 3 relative path in the pointer: OK. The hook always writes an absolute path.
- Task 3 chpwd hook pollution: OK. The exposure predates this branch, and I verified the locator under `zsh -f` and interactive `zsh`.
- Task 3 "distro root not found" never asserted: OK. It is cosmetic.
- Ruling (plugin.json strict warning about CLAUDE.md): OK. I confirmed it is the only warning, via `claude plugin tag --dry-run`.
- Ruling (assert that the manifest type is marketplace): OK. It only tightens the test.
- Ruling (Claude validator's complaints about .codex-plugin): OK. This is deferred to acceptance, which does record it.
- Task 4 suite validates only marketplace.json: OK. It is not blocking.
- Task 4 manifest.type depends on validator preference: OK. It fails loudly if that preference changes.
- Task 4 skip condition ignores an old claude: OK. This is a low-probability case.
- Task 4 exact-ten-skills list: OK. This is intended by the plan.
- Ruling (release clean-tree guard and scoped commit): OK. It is pinned by tests.
- Task 5 pre-release version gives NaN: OK. No pre-release versions are in use.
- Task 5 downgrades accepted: OK. Explicit X.Y.Z is a deliberate act.
- Task 5 plugins[0] hardcoded: OK. A test pins a single entry.
- Task 5 partial bump on a write failure: OK. The versions-disagree guard catches it on the rerun.
- Task 5 first release reformats inline JSON: OK. It is one-time churn.
- Task 5 no recovery when npm test fails mid-release: OK, but document `git checkout -- <five files>`, because the clean-tree guard blocks the rerun.
- Task 5 CLI disagree and empty-argument paths untested: OK. It is not blocking.
- Task 5 untracked files and `claude plugin tag`: OK. The worst case is a commit without a tag, and rerunning `claude plugin tag .` recovers.
- Ruling (fake-bin PATH for runInstallerFrom): OK. It removes a dependency on the machine's state.
- Task 6 fail-closed substring matching: OK. `--force` exists.
- Task 6 single-quoted or inline-table TOML not detected: OK. Codex writes the double-quoted header.
- Task 6 no --uninstall-while-installed test: OK. The code path is a one-line bypass.
- Task 6 refusal test doesn't assert that the home is untouched: OK. The refusal happens before any write.
- Task 6 `claude plugin list` spawned twice with no timeout: OK. A hang would be visible to the user.
- Task 6 README `--force` comment off by one column: OK. It is cosmetic.
- Ruling (revert the stray patch rewrites): OK. I verified that both committed patches match `diff -ruN vendor/<n> skills/<n>` apart from headers.
- Task 7 repatch mtime churn: OK. The churn predates this branch.
- Ruling (fix the two missed hand-offs): OK. Both are present and tested.
- Task 7 secondary directives still bare: OK. The USING.md rule covers them.
- Task 7 no reverse check for new bare hand-offs: OK. It is not blocking.
- Task 7 parenthetical splits "the X skill": OK. It is cosmetic.
- Task 7 `new URL()` vs `path.join`: OK. It is cosmetic.
- Task 7 announcement lines keep bare names: OK. They are not invocations.
- Ruling (teardown also drops the Codex config sections): OK. It is present at acceptance step 15.
- Ruling (step 0 removes the symlink install first): OK. It is present as steps 1–4 and 16.
- Task 8 `validate .` checks only marketplace.json: OK. It is not blocking.
- Task 8 Codex acceptance uses the GitHub git source: OK for merge, since the checklist runs after landing. But it cannot be run meaningfully before the branch is pushed to main; say so, or use `source_type = "local"`.
- Task 8 CLAUDE.md omits explicit X.Y.Z: OK. README documents it.
- Task 8 no Codex update command in README: OK. It is a docs gap.
- Task 8 mixed wrapping in README: OK. It is cosmetic.
- Ruling (`rm -rf ~/.verus-skills` in before-you-start plus the step-8 no-warning check): OK. Note that the step-8 check fails spuriously once Codex step 14 has run, per finding 1.
- Task 8 "skip steps 2–4" also skips check-only steps: OK. It is a docs nit.
- Task 8 step 14 pointer blurred by a Claude session: OK. A Claude session cannot make the pointer point into the Codex cache, so a false "fired" answer is impossible; only a false "did not fire" is possible.
