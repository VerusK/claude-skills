import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

const root = new URL("../skills/", import.meta.url).pathname;

function walk(dir) {
  return readdirSync(dir).flatMap((e) => {
    const p = path.join(dir, e);
    return statSync(p).isDirectory() ? walk(p) : [p];
  });
}

test("no superpowers: namespace references remain in skills/", () => {
  const hits = walk(root).filter((f) => /\.md$/.test(f) && /superpowers:/.test(readFileSync(f, "utf8")));
  assert.deepEqual(hits.map((f) => path.relative(root, f)), []);
});

test("no docs/superpowers paths remain in skills/", () => {
  const hits = walk(root).filter((f) => /\.md$/.test(f) && /docs\/superpowers\//.test(readFileSync(f, "utf8")));
  assert.deepEqual(hits.map((f) => path.relative(root, f)), []);
});

test("SDD final review routes to review and keeps the SDD rules", () => {
  const sdd = readFileSync(path.join(root, "subagent-driven-development/SKILL.md"), "utf8");
  assert.match(sdd, /Invoke review <MERGE_BASE>/);
  assert.doesNotMatch(sdd, /using-git-worktrees/);
  assert.doesNotMatch(sdd, /executing-plans/);
  assert.doesNotMatch(sdd, /requesting-code-review/);
  assert.doesNotMatch(sdd, /more capable model/);
  assert.match(sdd, /unnamed/);
});

test("no model-tier escalation advice remains in SDD prompts", () => {
  for (const f of ["implementer-prompt.md", "task-reviewer-prompt.md", "re-review-prompt.md"]) {
    const body = readFileSync(path.join(root, "subagent-driven-development", f), "utf8");
    assert.doesNotMatch(body, /more capable model/);
  }
});

test("writing-plans routes to docs/plans/ and plan-review", () => {
  const wp = readFileSync(path.join(root, "writing-plans/SKILL.md"), "utf8");
  assert.match(wp, /docs\/plans\//);
  assert.match(wp, /plan-review/);
});

const HANDOFFS = [
  ["kickoff/SKILL.md", "writing-plans"],
  ["kickoff/SKILL.md", "test-driven-development"],
  ["writing-plans/SKILL.md", "plan-review"],
  ["writing-plans/SKILL.md", "subagent-driven-development"],
  ["plan-review/SKILL.md", "subagent-driven-development"],
  ["subagent-driven-development/SKILL.md", "review"],
  ["subagent-driven-development/SKILL.md", "finishing-a-development-branch"],
  ["review/SKILL.md", "finishing-a-development-branch"],
];

test("every hand-off names the plugin form of the target skill", () => {
  for (const [file, target] of HANDOFFS) {
    const body = readFileSync(path.join(root, file), "utf8");
    assert.match(
      body,
      new RegExp("`" + target + "` \\(`verus-skills:" + target + "` when installed as a plugin\\)"),
      `${file} does not name verus-skills:${target}`,
    );
  }
});

test("USING.md states how skills are addressed before it lists any of them", () => {
  const using = readFileSync(new URL("../USING.md", import.meta.url), "utf8");
  assert.match(using, /verus-skills:<name>/);
  assert.ok(
    using.indexOf("verus-skills:<name>") < using.indexOf("## The flow"),
    "the addressing rule must come before the skill lists",
  );
});

test("SDD names the plugin form in both finishing-a-development-branch hand-offs", () => {
  const sdd = readFileSync(path.join(root, "subagent-driven-development/SKILL.md"), "utf8");
  const hits = sdd.match(/`finishing-a-development-branch` \(`verus-skills:finishing-a-development-branch` when installed as a plugin\)/g) ?? [];
  assert.ok(hits.length >= 2, `expected the plugin form at both hand-offs, found ${hits.length}`);
});

const CODEX_LINE = "In a Codex session: dispatch the same prompt with spawn_agent, unnamed, in the background; pass no model.";
const claudeLine = (tier) =>
  `Claude Code: \`subagent_type\` = \`verus-${tier}\` (\`verus-skills:verus-${tier}\` when installed as a plugin), unnamed, in the background, no \`model\` parameter.`;
// file (relative to skills/) → the tiers of its dispatch sites, one entry per site
const DISPATCH_SITES = {
  "subagent-driven-development/implementer-prompt.md": ["worker"],
  "subagent-driven-development/task-reviewer-prompt.md": ["reviewer"],
  "subagent-driven-development/re-review-prompt.md": ["reviewer"],
  "writing-plans/plan-document-reviewer-prompt.md": ["reviewer"],
  "plan-review/SKILL.md": ["reviewer"],
  "review/SKILL.md": ["reviewer", "worker"],
  "kickoff/SKILL.md": ["explorer"],
};

test("every dispatch site names the agent type for Claude Code and spawn_agent for Codex", () => {
  let sites = 0;
  for (const [file, tiers] of Object.entries(DISPATCH_SITES)) {
    const body = readFileSync(path.join(root, file), "utf8");
    for (const tier of new Set(tiers)) {
      const n = body.split(claudeLine(tier)).length - 1;
      assert.equal(n, tiers.filter((t) => t === tier).length, `${file}: Claude Code line for verus-${tier}`);
    }
    assert.equal(body.split(CODEX_LINE).length - 1, tiers.length, `${file}: Codex line count`);
    assert.doesNotMatch(body, /general-purpose/, file);
    assert.doesNotMatch(body, /model: opus/, file);
    // a `name:` parameter in a dispatch opens a window; the file's own frontmatter `name:` is not a dispatch
    assert.doesNotMatch(body.replace(/^---\n[\s\S]*?\n---\n/, ""), /^\s*name:/m, file);
    assert.doesNotMatch(body, /e\.g\. a Codex session/, file);
    sites += tiers.length;
  }
  assert.equal(sites, 8);
});

test("the SDD model rule and the routing docs describe both hosts", () => {
  const sdd = readFileSync(path.join(root, "subagent-driven-development/SKILL.md"), "utf8");
  assert.match(sdd, /config\/models\.json/);
  assert.doesNotMatch(sdd, /Always pass the model explicitly/);
  for (const doc of ["../USING.md", "../CLAUDE.md"]) {
    const body = readFileSync(new URL(doc, import.meta.url), "utf8");
    assert.doesNotMatch(body, /model: opus/, doc);
    assert.match(body, /verus-worker/, doc);
  }
  const using = readFileSync(new URL("../USING.md", import.meta.url), "utf8");
  assert.match(using, /spawn_agent/);
  assert.match(using, /subagent_type/);
});

const launchBlock = (file) => {
  const body = readFileSync(path.join(root, file), "utf8");
  return body.slice(body.indexOf("## 2. Launch the external reviewer"), body.indexOf("## 3."));
};

test("plan-review and review keep one reviewer session per review", () => {
  const SESSION_RE = {
    "plan-review/SKILL.md": /SESSION="\$\(git rev-parse --show-toplevel\)\/\.context\/plan-review-\$\(basename "\$ROUND1_REPORT" \.md\)-session"/,
    "review/SKILL.md": /SESSION="\$\(git rev-parse --show-toplevel\)\/\.context\/review-\$\(printf '%s' "\$BRANCH" \| tr '\/' '-'\)\$SUFFIX-session"/,
  };
  for (const [file, re] of Object.entries(SESSION_RE)) {
    const body = readFileSync(path.join(root, file), "utf8");
    const launch = launchBlock(file);
    assert.match(launch, re, file);
    assert.match(launch, /\[ "\$ROUND" = 1 \] && bash "\$SKILLS_REPO\/scripts\/reviewer\.sh" --close-session "\$SESSION"/, file);
    assert.match(launch, /--session-file "\$SESSION"/, file);
    assert.match(launch, /^echo "SESSION=\$SESSION"$/m, `${file}: section 2 prints SESSION for section 6`);
    assert.match(body, /SESSION="<the SESSION printed by section 2>"/, `${file}: section 6 takes the printed value`);
    assert.doesNotMatch(body, /the SESSION value from section 2/, `${file}: no placeholder the agent must rebuild by hand`);
    const handOff = body.slice(body.indexOf("## 6. Hand off"));
    assert.match(handOff, /--close-session "\$SESSION"/, `${file}: closes the session at the end`);
    assert.match(body, /Whenever this skill stops[^\n]*--close-session/, `${file}: rule for every exit`);
  }
  assert.doesNotMatch(launchBlock("review/SKILL.md"), /ROUND1_REPORT/, "review's session must not depend on a report");
  assert.match(readFileSync(path.join(root, "review/SKILL.md"), "utf8"), /^echo "SUFFIX=\$SUFFIX"$/m, "section 0 prints SUFFIX for section 2");
});

test("review keys its session by branch and scope, so the next review of the same scope finds an interrupted one", () => {
  const line = launchBlock("review/SKILL.md").split("\n").find((l) => l.startsWith("SESSION="));
  assert.ok(line, "no SESSION= line in review's launch block");
  assert.doesNotMatch(line, /REPORT|date/, "the session must not depend on the report name or the date");
  const repo = realpathSync(mkdtempSync(path.join(tmpdir(), "review-session-")));
  try {
    execFileSync("git", ["init", "-q"], { cwd: repo });
    execFileSync("git", ["checkout", "-q", "-b", "feat/x"], { cwd: repo });
    const session = (suffix) =>
      execFileSync("bash", ["-c", `BRANCH="$(git branch --show-current)"\nSUFFIX="${suffix}"\n${line}\nprintf '%s' "$SESSION"`], { cwd: repo, encoding: "utf8" });
    assert.equal(session(""), path.join(repo, ".context", "review-feat-x-session"));
    assert.equal(session("-all"), path.join(repo, ".context", "review-feat-x-all-session"));
    assert.equal(session("-scripts-reviewer-sh"), path.join(repo, ".context", "review-feat-x-scripts-reviewer-sh-session"));
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
});
