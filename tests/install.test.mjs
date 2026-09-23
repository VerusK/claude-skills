import { test, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, readlinkSync, symlinkSync, rmSync, copyFileSync, realpathSync, lstatSync, readdirSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import path from "node:path";
import { linkSkills, unlinkSkills, ensureHook, removeHook, ensureAgentsLine, removeAgentsLine, HOOK_MARKER, REPO_ROOT, pluginInstalled, parseArgs, agentNames, agentCollisions, linkAgents, unlinkAgents } from "../scripts/install.mjs";

const TEMP_DIRS = [];
// realpath, so a checkout under a symlinked $TMPDIR (macOS: /var -> /private/var)
// matches the path Node resolves for a script run out of it.
function tmp(prefix) {
  const d = realpathSync(mkdtempSync(path.join(tmpdir(), prefix)));
  TEMP_DIRS.push(d);
  return d;
}
after(() => {
  for (const d of TEMP_DIRS) rmSync(d, { recursive: true, force: true });
});

const INSTALLER = path.join(REPO_ROOT, "scripts", "install.mjs");
const SESSION_START = path.join(REPO_ROOT, "scripts", "session-start.mjs");

// Every CLI spawn gets HOME pointed at a throwaway dir as well as --home, so a
// parsing bug can never reach the real home directory.
function runInstaller(args, extraEnv = {}) {
  const sandboxHome = tmp("sandbox-home-");
  return spawnSync(process.execPath, [INSTALLER, ...args], {
    encoding: "utf8",
    env: {
      ...process.env,
      // the stub answers `claude plugin list`; the real CLI must never decide a test
      PATH: `${path.join(REPO_ROOT, "tests", "fixtures", "fake-bin")}:${process.env.PATH}`,
      FAKE_CLAUDE_PLUGINS: "",
      HOME: sandboxHome,
      ...extraEnv,
    },
  });
}

function fakeRepo() {
  const root = tmp("repo-");
  for (const s of ["kickoff", "plan-review"]) {
    mkdirSync(path.join(root, "skills", s), { recursive: true });
    writeFileSync(path.join(root, "skills", s, "SKILL.md"), `---\nname: ${s}\n---\n`);
  }
  mkdirSync(path.join(root, "skills", "not-a-skill"));
  return root;
}

test("linkSkills symlinks every skill dir with a SKILL.md and skips foreign entries", () => {
  const root = fakeRepo();
  const target = tmp("skills-");
  mkdirSync(path.join(target, "plan-review")); // foreign real dir
  const r = linkSkills(root, target);
  assert.deepEqual(r.linked, ["kickoff"]);
  assert.deepEqual(r.skipped, ["plan-review"]);
  assert.equal(readlinkSync(path.join(target, "kickoff")), path.join(root, "skills", "kickoff"));
  assert.ok(!existsSync(path.join(target, "not-a-skill")));
  // idempotent
  assert.deepEqual(linkSkills(root, target).linked, ["kickoff"]);
});

test("unlinkSkills removes only symlinks pointing into the repo", () => {
  const root = fakeRepo();
  const target = tmp("skills-");
  linkSkills(root, target);
  symlinkSync("/somewhere/else", path.join(target, "other"));
  const r = unlinkSkills(root, target);
  assert.deepEqual(r.removed, ["kickoff", "plan-review"]);
  assert.equal(readlinkSync(path.join(target, "other")), "/somewhere/else");
});

test("ensureHook adds one SessionStart hook and is idempotent; removeHook deletes it", () => {
  const root = fakeRepo();
  const settings = path.join(tmp("cfg-"), "settings.json");
  writeFileSync(settings, JSON.stringify({ hooks: { SessionStart: [{ hooks: [{ type: "command", command: "echo keep" }] }] } }, null, 2));
  ensureHook(settings, root);
  ensureHook(settings, root);
  let s = JSON.parse(readFileSync(settings, "utf8"));
  const ours = s.hooks.SessionStart.filter((g) => g.hooks.some((h) => h.command.includes(HOOK_MARKER)));
  assert.equal(ours.length, 1);
  assert.match(ours[0].hooks[0].command, new RegExp(root.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
  assert.equal(s.hooks.SessionStart.length, 2);
  removeHook(settings, root);
  s = JSON.parse(readFileSync(settings, "utf8"));
  assert.equal(s.hooks.SessionStart.length, 1);
  assert.equal(s.hooks.SessionStart[0].hooks[0].command, "echo keep");
});

test("ensureHook creates settings.json when missing", () => {
  const root = fakeRepo();
  const settings = path.join(tmp("cfg-"), "settings.json");
  ensureHook(settings, root);
  assert.equal(JSON.parse(readFileSync(settings, "utf8")).hooks.SessionStart.length, 1);
});

test("ensureAgentsLine appends once; removeAgentsLine strips it", () => {
  const root = fakeRepo();
  const agents = path.join(tmp("codex-"), "AGENTS.md");
  writeFileSync(agents, "# mine\n");
  ensureAgentsLine(agents, root);
  ensureAgentsLine(agents, root);
  const text = readFileSync(agents, "utf8");
  assert.equal(text.split("\n").filter((l) => l.includes("USING.md")).length, 1);
  assert.match(text, /^# mine/);
  removeAgentsLine(agents, root);
  assert.equal(readFileSync(agents, "utf8"), "# mine\n");
});

// --- finding 1: filter at hook level, never drop sibling hooks -----------------

test("ensureHook/removeHook keep sibling hooks that share a SessionStart group", () => {
  const root = fakeRepo();
  const settings = path.join(tmp("cfg-"), "settings.json");
  writeFileSync(settings, JSON.stringify({
    hooks: {
      SessionStart: [{
        matcher: "startup",
        hooks: [
          { type: "command", command: `node "${path.join(root, "scripts", "session-start.mjs")}"`, timeout: 10 },
          { type: "command", command: "echo sibling" },
        ],
      }],
    },
  }, null, 2));

  ensureHook(settings, root);
  let s = JSON.parse(readFileSync(settings, "utf8"));
  const sibling = s.hooks.SessionStart.filter((g) => g.hooks.some((h) => h.command === "echo sibling"));
  assert.equal(sibling.length, 1, "sibling hook must survive ensureHook");
  assert.equal(sibling[0].matcher, "startup", "sibling group keeps its matcher");
  assert.equal(sibling[0].hooks.length, 1, "our hook is filtered out of the shared group");
  const ours = s.hooks.SessionStart.filter((g) => g.hooks.some((h) => h.command.includes(HOOK_MARKER)));
  assert.equal(ours.length, 1, "exactly one group of ours");

  removeHook(settings, root);
  s = JSON.parse(readFileSync(settings, "utf8"));
  assert.equal(s.hooks.SessionStart.length, 1);
  assert.equal(s.hooks.SessionStart[0].matcher, "startup");
  assert.deepEqual(s.hooks.SessionStart[0].hooks, [{ type: "command", command: "echo sibling" }]);
});

test("removeHook drops a group only once it is empty", () => {
  const root = fakeRepo();
  const settings = path.join(tmp("cfg-"), "settings.json");
  ensureHook(settings, root);
  removeHook(settings, root);
  const s = JSON.parse(readFileSync(settings, "utf8"));
  assert.equal(s.hooks.SessionStart, undefined);
});

// --- finding 2: strict --home parsing ------------------------------------------

test("CLI accepts --home=DIR and installs there", () => {
  const home = tmp("home-");
  const r = runInstaller([`--home=${home}`, "--skip-plugin"]);
  assert.equal(r.status, 0, r.stderr);
  const link = path.join(home, ".claude", "skills", "kickoff");
  assert.equal(readlinkSync(link), path.join(REPO_ROOT, "skills", "kickoff"));
  assert.ok(existsSync(path.join(home, ".claude", "settings.json")));
  assert.ok(existsSync(path.join(home, ".codex", "AGENTS.md")));
});

test("CLI accepts --home DIR and installs there", () => {
  const home = tmp("home-");
  const r = runInstaller(["--home", home, "--skip-plugin"]);
  assert.equal(r.status, 0, r.stderr);
  assert.equal(
    readlinkSync(path.join(home, ".codex", "skills", "kickoff")),
    path.join(REPO_ROOT, "skills", "kickoff"),
  );
});

test("CLI rejects --home without a value, --home-ish and unknown options", () => {
  for (const args of [["--home"], ["--home="], ["--homedir", "/tmp/x"], ["--bogus"], ["stray"]]) {
    const r = runInstaller(args);
    assert.equal(r.status, 1, `expected exit 1 for ${JSON.stringify(args)}`);
    assert.match(r.stderr, /usage/i, `expected usage message for ${JSON.stringify(args)}`);
  }
});

test("CLI writes nothing when option parsing fails", () => {
  const home = tmp("home-");
  const r = runInstaller(["--home", home, "--bogus"]);
  assert.equal(r.status, 1);
  assert.ok(!existsSync(path.join(home, ".claude")));
  assert.ok(!existsSync(path.join(home, ".codex")));
});

// --- finding 3: separator-safe prefix matching ---------------------------------

test("linkSkills does not clobber a link into a sibling path sharing the repo prefix", () => {
  const root = fakeRepo();
  const sibling = `${root}-old`;
  mkdirSync(path.join(sibling, "skills", "kickoff"), { recursive: true });
  const target = tmp("skills-");
  symlinkSync(path.join(sibling, "skills", "kickoff"), path.join(target, "kickoff"));
  const r = linkSkills(root, target);
  assert.deepEqual(r.skipped, ["kickoff"]);
  assert.equal(readlinkSync(path.join(target, "kickoff")), path.join(sibling, "skills", "kickoff"));
  rmSync(sibling, { recursive: true, force: true });
});

test("unlinkSkills does not remove links into a sibling of the skills dir", () => {
  const root = fakeRepo();
  mkdirSync(path.join(root, "skills-old", "kickoff"), { recursive: true });
  const target = tmp("skills-");
  linkSkills(root, target);
  symlinkSync(path.join(root, "skills-old", "kickoff"), path.join(target, "kickoff-old"));
  const r = unlinkSkills(root, target);
  assert.deepEqual(r.removed, ["kickoff", "plan-review"]);
  assert.equal(readlinkSync(path.join(target, "kickoff-old")), path.join(root, "skills-old", "kickoff"));
});

// --- finding 4: validate settings.json before any writes -----------------------

test("CLI exits 1 on malformed settings.json and creates no symlinks", () => {
  const home = tmp("home-");
  mkdirSync(path.join(home, ".claude"), { recursive: true });
  const settings = path.join(home, ".claude", "settings.json");
  writeFileSync(settings, "{ not json");
  const r = runInstaller(["--home", home, "--skip-plugin"]);
  assert.equal(r.status, 1);
  assert.match(r.stderr, /settings\.json is not valid JSON/);
  assert.match(r.stderr, new RegExp(settings.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
  assert.ok(!existsSync(path.join(home, ".claude", "skills")));
  assert.ok(!existsSync(path.join(home, ".codex")));
  assert.equal(readFileSync(settings, "utf8"), "{ not json");
});

test("CLI exits 1 when settings.json parses but is not an object", () => {
  const home = tmp("home-");
  mkdirSync(path.join(home, ".claude"), { recursive: true });
  writeFileSync(path.join(home, ".claude", "settings.json"), '["nope"]');
  const r = runInstaller(["--home", home, "--skip-plugin"]);
  assert.equal(r.status, 1);
  assert.match(r.stderr, /settings\.json is not a JSON object/);
  assert.ok(!existsSync(path.join(home, ".claude", "skills")));
});

test("CLI --uninstall exits 1 on malformed settings.json and removes nothing", () => {
  const home = tmp("home-");
  const claudeSkills = path.join(home, ".claude", "skills");
  mkdirSync(claudeSkills, { recursive: true });
  symlinkSync(path.join(REPO_ROOT, "skills", "kickoff"), path.join(claudeSkills, "kickoff"));
  writeFileSync(path.join(home, ".claude", "settings.json"), "{ not json");
  const r = runInstaller(["--home", home, "--uninstall"]);
  assert.equal(r.status, 1);
  assert.match(r.stderr, /settings\.json is not valid JSON/);
  assert.ok(existsSync(path.join(claudeSkills, "kickoff")));
});

// --- finding 5: removal is scoped to this repo ---------------------------------

test("removeHook with repoRoot leaves another checkout's hook alone", () => {
  const mine = fakeRepo();
  const other = fakeRepo();
  const settings = path.join(tmp("cfg-"), "settings.json");
  ensureHook(settings, other);
  ensureHook(settings, mine);
  removeHook(settings, mine);
  const s = JSON.parse(readFileSync(settings, "utf8"));
  assert.equal(s.hooks.SessionStart.length, 1);
  assert.ok(s.hooks.SessionStart[0].hooks[0].command.includes(other));
});

test("removeHook without repoRoot falls back to marker-only removal", () => {
  const mine = fakeRepo();
  const other = fakeRepo();
  const settings = path.join(tmp("cfg-"), "settings.json");
  ensureHook(settings, other);
  ensureHook(settings, mine);
  removeHook(settings);
  const s = JSON.parse(readFileSync(settings, "utf8"));
  assert.equal(s.hooks.SessionStart, undefined);
});

test("removeAgentsLine with repoRoot leaves another checkout's line alone", () => {
  const mine = fakeRepo();
  const other = fakeRepo();
  const agents = path.join(tmp("codex-"), "AGENTS.md");
  writeFileSync(agents, "# mine\n");
  ensureAgentsLine(agents, other);
  ensureAgentsLine(agents, mine);
  let text = readFileSync(agents, "utf8");
  assert.equal(text.split("\n").filter((l) => l.includes("USING.md")).length, 2);
  removeAgentsLine(agents, mine);
  text = readFileSync(agents, "utf8");
  const left = text.split("\n").filter((l) => l.includes("USING.md"));
  assert.equal(left.length, 1);
  assert.ok(left[0].includes(other));
  removeAgentsLine(agents);
  assert.equal(readFileSync(agents, "utf8"), "# mine\n");
});

// --- finding 6: settings round-trip and the hook script ------------------------

test("ensureHook/removeHook preserve every other settings key and hook event", () => {
  const root = fakeRepo();
  const settings = path.join(tmp("cfg-"), "settings.json");
  const original = {
    model: "opus",
    env: { TYPESAFE_API_KEY: "xyz", FOO: "bar" },
    permissions: { allow: ["Bash(git status)"], deny: ["Bash(rm)"] },
    enabledPlugins: { "superpowers@claude-plugins-official": true },
    skillOverrides: { kickoff: "disabled" },
    hooks: {
      SessionStart: [{ hooks: [{ type: "command", command: "echo keep" }] }],
      PreToolUse: [{ matcher: "Bash", hooks: [{ type: "command", command: "echo pre" }] }],
      Stop: [{ hooks: [{ type: "command", command: "echo stop" }] }],
    },
  };
  writeFileSync(settings, JSON.stringify(original, null, 2));

  ensureHook(settings, root);
  const afterInstall = JSON.parse(readFileSync(settings, "utf8"));
  assert.equal(afterInstall.model, "opus");
  assert.deepEqual(afterInstall.env, original.env);
  assert.deepEqual(afterInstall.permissions, original.permissions);
  assert.deepEqual(afterInstall.enabledPlugins, original.enabledPlugins);
  assert.deepEqual(afterInstall.skillOverrides, original.skillOverrides);
  assert.deepEqual(afterInstall.hooks.PreToolUse, original.hooks.PreToolUse);
  assert.deepEqual(afterInstall.hooks.Stop, original.hooks.Stop);
  assert.equal(afterInstall.hooks.SessionStart.length, 2);

  removeHook(settings, root);
  assert.deepEqual(JSON.parse(readFileSync(settings, "utf8")), original);
});

// --- finding I-1: a re-install from another checkout of this distro ------------

const AGENT_FILES = ["verus-explorer.md", "verus-reviewer.md", "verus-worker.md"];

// A self-contained distro checkout: what `isDistroCheckout` looks for
// (sources.yaml + scripts/install.mjs), a runnable installer with the
// scripts/config.mjs it imports, two skills and the three agent files.
function distroRepo() {
  const root = tmp("distro-");
  mkdirSync(path.join(root, "scripts"), { recursive: true });
  copyFileSync(INSTALLER, path.join(root, "scripts", "install.mjs"));
  copyFileSync(path.join(REPO_ROOT, "scripts", "config.mjs"), path.join(root, "scripts", "config.mjs"));
  writeFileSync(path.join(root, "sources.yaml"), "sources: []\n");
  writeFileSync(path.join(root, "USING.md"), "# using\n");
  for (const s of ["kickoff", "plan-review"]) {
    mkdirSync(path.join(root, "skills", s), { recursive: true });
    writeFileSync(path.join(root, "skills", s, "SKILL.md"), `---\nname: ${s}\n---\n`);
  }
  mkdirSync(path.join(root, "agents"), { recursive: true });
  for (const t of ["worker", "reviewer", "explorer"]) {
    writeFileSync(
      path.join(root, "agents", `verus-${t}.md`),
      `---\nname: verus-${t}\ndescription: fixture ${t} agent of a copied distro checkout\nmodel: opus\neffort: high\n---\n\nFixture.\n`,
    );
  }
  return root;
}

function runInstallerFrom(root, args) {
  const sandboxHome = tmp("sandbox-home-");
  return spawnSync(process.execPath, [path.join(root, "scripts", "install.mjs"), ...args], {
    encoding: "utf8",
    env: {
      ...process.env,
      // the stub answers `claude plugin list`; the real CLI must never decide a test
      PATH: `${path.join(REPO_ROOT, "tests", "fixtures", "fake-bin")}:${process.env.PATH}`,
      FAKE_CLAUDE_PLUGINS: "",
      HOME: sandboxHome,
    },
  });
}

function assertSingleInstallOf(home, root) {
  for (const dir of [".claude", ".codex"]) {
    for (const s of ["kickoff", "plan-review"]) {
      assert.equal(readlinkSync(path.join(home, dir, "skills", s)), path.join(root, "skills", s));
    }
  }
  for (const f of AGENT_FILES) {
    assert.equal(readlinkSync(path.join(home, ".claude", "agents", f)), path.join(root, "agents", f));
  }
  const settings = JSON.parse(readFileSync(path.join(home, ".claude", "settings.json"), "utf8"));
  const ours = settings.hooks.SessionStart.filter((g) => g.hooks.some((h) => h.command.includes(HOOK_MARKER)));
  assert.equal(ours.length, 1, "exactly one SessionStart hook of ours");
  assert.ok(ours[0].hooks[0].command.includes(root), "the hook points at the current checkout");
  const lines = readFileSync(path.join(home, ".codex", "AGENTS.md"), "utf8").split("\n").filter((l) => l.includes("USING.md"));
  assert.equal(lines.length, 1, "exactly one AGENTS.md line of ours");
  assert.ok(lines[0].includes(root), "the AGENTS.md line points at the current checkout");
}

test("installing from a second distro checkout re-points links, hook and AGENTS line", () => {
  const home = tmp("home-");
  const a = distroRepo();
  const b = distroRepo();
  const ra = runInstallerFrom(a, ["--home", home, "--skip-plugin"]);
  assert.equal(ra.status, 0, ra.stderr);
  const rb = runInstallerFrom(b, ["--home", home, "--skip-plugin"]);
  assert.equal(rb.status, 0, rb.stderr);
  assert.match(rb.stdout, new RegExp(`re-pointed from ${a.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`));
  assert.doesNotMatch(rb.stdout, /SKIPPED/);
  for (const f of AGENT_FILES) assert.match(rb.stdout, new RegExp(`claude agents: re-pointed from .*: ${f.replace(".", "\\.")}`));
  assertSingleInstallOf(home, b);
});

test("installing from a new checkout after the old one is gone re-points everything", () => {
  const home = tmp("home-");
  const a = distroRepo();
  const b = distroRepo();
  const ra = runInstallerFrom(a, ["--home", home, "--skip-plugin"]);
  assert.equal(ra.status, 0, ra.stderr);
  rmSync(a, { recursive: true, force: true });
  const rb = runInstallerFrom(b, ["--home", home, "--skip-plugin"]);
  assert.equal(rb.status, 0, rb.stderr);
  assert.doesNotMatch(rb.stdout, /SKIPPED/);
  for (const f of AGENT_FILES) assert.match(rb.stdout, new RegExp(`claude agents: replaced dangling link: ${f.replace(".", "\\.")}`));
  assertSingleInstallOf(home, b);
});

test("linkSkills still skips a foreign link that is not a distro checkout", () => {
  const root = distroRepo();
  const foreign = tmp("foreign-");
  mkdirSync(path.join(foreign, "skills", "kickoff"), { recursive: true });
  const target = tmp("skills-");
  symlinkSync(path.join(foreign, "skills", "kickoff"), path.join(target, "kickoff"));
  const r = linkSkills(root, target);
  assert.deepEqual(r.skipped, ["kickoff"]);
  assert.deepEqual(r.repointed, []);
  assert.equal(readlinkSync(path.join(target, "kickoff")), path.join(foreign, "skills", "kickoff"));
});

test("session-start.mjs prints a parseable SessionStart hook payload", () => {
  const r = spawnSync(process.execPath, [SESSION_START], { encoding: "utf8", env: { ...process.env, HOME: tmp("home-") } });
  assert.equal(r.status, 0, r.stderr);
  const payload = JSON.parse(r.stdout);
  assert.equal(payload.hookSpecificOutput.hookEventName, "SessionStart");
  const ctx = payload.hookSpecificOutput.additionalContext;
  assert.equal(typeof ctx, "string");
  assert.ok(ctx.length > 100);
  assert.ok(ctx.includes(readFileSync(path.join(REPO_ROOT, "USING.md"), "utf8")));
});

test("parseArgs accepts --force", () => {
  assert.equal(parseArgs(["--force"]).force, true);
  assert.equal(parseArgs([]).force, false);
});

test("pluginInstalled recognises our plugin in either agent and ignores others", () => {
  const none = () => null;
  assert.equal(pluginInstalled("/h", () => "verus-skills@verus-skills  1.0.0  enabled", none), "claude");
  assert.equal(pluginInstalled("/h", () => "superpowers@claude-plugins-official  6.3.0", none), null);
  assert.equal(pluginInstalled("/h", none, none), null);
  // Codex declares its plugins in config.toml; `claude plugin list` never sees them
  const codex = '[plugins."verus-skills@verus-skills"]\nenabled = true\n';
  assert.equal(pluginInstalled("/h", none, () => codex), "codex");
  assert.equal(pluginInstalled("/h", none, () => '[plugins."superpowers@claude-plugins-official"]\nenabled = true\n'), null);
});

test("pluginInstalled reads the Codex config from the given home", () => {
  const home = tmp("home-");
  mkdirSync(path.join(home, ".codex"), { recursive: true });
  writeFileSync(
    path.join(home, ".codex", "config.toml"),
    '[marketplaces.verus-skills]\nsource_type = "git"\n\n[plugins."verus-skills@verus-skills"]\nenabled = true\n',
  );
  assert.equal(pluginInstalled(home, () => null), "codex");
  assert.equal(pluginInstalled(tmp("home-"), () => null), null);
});

test("the installer refuses when the plugin is installed, and installs with --force", () => {
  const refused = runInstaller(["--home", tmp("home-")], {
    FAKE_CLAUDE_PLUGINS: "verus-skills@verus-skills  1.0.0  enabled",
  });
  assert.equal(refused.status, 1);
  assert.match(refused.stderr, /verus-skills@verus-skills/);
  assert.match(refused.stderr, /--force/);

  const home = tmp("home-");
  const forced = runInstaller(["--home", home, "--force"], {
    FAKE_CLAUDE_PLUGINS: "verus-skills@verus-skills  1.0.0  enabled",
  });
  assert.equal(forced.status, 0);
  assert.ok(existsSync(path.join(home, ".claude", "skills", "kickoff")));
});

test("the installer also refuses when only the Codex plugin is declared", () => {
  const home = tmp("home-");
  mkdirSync(path.join(home, ".codex"), { recursive: true });
  writeFileSync(
    path.join(home, ".codex", "config.toml"),
    '[plugins."verus-skills@verus-skills"]\nenabled = true\n',
  );
  const res = runInstaller(["--home", home]);
  assert.equal(res.status, 1);
  assert.match(res.stderr, /codex/);
  assert.match(res.stderr, /config\.toml/);
});

test("the installer proceeds when the plugin is not installed", () => {
  const home = tmp("home-");
  const res = runInstaller(["--home", home]);
  assert.equal(res.status, 0);
  assert.ok(existsSync(path.join(home, ".claude", "skills", "kickoff")));
});

test("agentNames lists the three verus agents", () => {
  assert.deepEqual(agentNames(REPO_ROOT), AGENT_FILES);
});

test("linkAgents links, is idempotent, and unlinkAgents removes only ours", () => {
  const target = tmp("agents-");
  writeFileSync(path.join(target, "someone-else.md"), "x");
  assert.deepEqual(linkAgents(REPO_ROOT, target).linked, agentNames(REPO_ROOT));
  assert.deepEqual(linkAgents(REPO_ROOT, target).linked, agentNames(REPO_ROOT));
  assert.equal(readlinkSync(path.join(target, "verus-worker.md")), path.join(REPO_ROOT, "agents", "verus-worker.md"));
  assert.deepEqual(unlinkAgents(REPO_ROOT, target).removed, agentNames(REPO_ROOT));
  assert.ok(existsSync(path.join(target, "someone-else.md")));
});

test("a link into another existing distro checkout is re-pointed, not a collision", () => {
  const target = tmp("agents-");
  const other = distroRepo();
  symlinkSync(path.join(other, "agents", "verus-worker.md"), path.join(target, "verus-worker.md"));
  assert.deepEqual(agentCollisions(REPO_ROOT, target), []);
  const r = linkAgents(REPO_ROOT, target);
  assert.deepEqual(r.repointed, [{ name: "verus-worker.md", from: other }]);
  assert.deepEqual(r.replaced, []);
  assert.equal(readlinkSync(path.join(target, "verus-worker.md")), path.join(REPO_ROOT, "agents", "verus-worker.md"));
});

test("a dangling link on an agent name is replaced, whoever left it", () => {
  const home = tmp("home-");
  const claudeAgents = path.join(home, ".claude", "agents");
  mkdirSync(claudeAgents, { recursive: true });
  const link = path.join(claudeAgents, "verus-worker.md");
  symlinkSync("/missing/agents/verus-worker.md", link);
  assert.deepEqual(agentCollisions(REPO_ROOT, claudeAgents), []);
  const r = runInstaller(["--home", home]);
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /claude agents: replaced dangling link: verus-worker\.md/);
  assert.equal(readlinkSync(link), path.join(REPO_ROOT, "agents", "verus-worker.md"));
});

test("a foreign file, or a link to an existing foreign file, on an agent name refuses the whole install", () => {
  // Shaped like a checkout (<dir>/agents/verus-worker.md), but <dir> is not a distro checkout.
  const foreignDir = tmp("foreign-");
  mkdirSync(path.join(foreignDir, "agents"), { recursive: true });
  const foreignFile = path.join(foreignDir, "agents", "verus-worker.md");
  const FOREIGN = "---\nname: verus-worker\n---\nnot ours\n";
  writeFileSync(foreignFile, FOREIGN);
  for (const plant of [
    (f) => writeFileSync(f, FOREIGN),
    (f) => symlinkSync(foreignFile, f),
  ]) {
    const home = tmp("home-");
    mkdirSync(path.join(home, ".claude", "agents"), { recursive: true });
    const foreign = path.join(home, ".claude", "agents", "verus-worker.md");
    plant(foreign);
    const snapshot = () => (lstatSync(foreign).isSymbolicLink() ? `link:${readlinkSync(foreign)}` : `file:${readFileSync(foreign, "utf8")}`);
    const before = snapshot();
    for (const extra of [[], ["--force"]]) {
      const r = runInstaller(["--home", home, ...extra]);
      assert.equal(r.status, 1, `${extra}: ${r.stdout}`);
      assert.match(r.stderr, /verus-worker\.md is not ours; move it away and re-run/);
      assert.equal(snapshot(), before, "the foreign entry must stay as it was");
      assert.deepEqual(readdirSync(path.join(home, ".claude", "agents")), ["verus-worker.md"]);
      assert.ok(!existsSync(path.join(home, ".claude", "skills")));
      assert.ok(!existsSync(path.join(home, ".claude", "settings.json")));
      assert.ok(!existsSync(path.join(home, ".codex")));
    }
    assert.equal(runInstaller(["--home", home, "--uninstall"]).status, 0);
    assert.equal(snapshot(), before, "uninstall must not remove a foreign entry");
  }
  assert.equal(readFileSync(foreignFile, "utf8"), FOREIGN);
});

test("install links the agents into ~/.claude/agents and uninstall removes them", () => {
  const home = tmp("home-");
  assert.equal(runInstaller(["--home", home]).status, 0);
  for (const f of agentNames(REPO_ROOT)) assert.equal(readlinkSync(path.join(home, ".claude", "agents", f)), path.join(REPO_ROOT, "agents", f));
  assert.equal(runInstaller(["--home", home, "--uninstall"]).status, 0);
  for (const f of agentNames(REPO_ROOT)) assert.ok(!existsSync(path.join(home, ".claude", "agents", f)));
});

test("uninstall from one distro checkout never removes another checkout's agent links", () => {
  const home = tmp("home-");
  const a = distroRepo();
  const b = distroRepo();
  assert.equal(runInstallerFrom(a, ["--home", home, "--skip-plugin"]).status, 0);
  assert.equal(runInstallerFrom(b, ["--home", home, "--skip-plugin"]).status, 0);
  const ua = runInstallerFrom(a, ["--home", home, "--uninstall"]);
  assert.equal(ua.status, 0, ua.stderr);
  assert.match(ua.stdout, /claude agents removed: none/);
  for (const f of AGENT_FILES) assert.equal(readlinkSync(path.join(home, ".claude", "agents", f)), path.join(b, "agents", f));
  const ub = runInstallerFrom(b, ["--home", home, "--uninstall"]);
  assert.equal(ub.status, 0, ub.stderr);
  assert.match(ub.stdout, /claude agents removed: verus-explorer\.md, verus-reviewer\.md, verus-worker\.md/);
  for (const f of AGENT_FILES) assert.throws(() => lstatSync(path.join(home, ".claude", "agents", f)), { code: "ENOENT" });
});

test("the key check sees ~/.verus-skills/config.json and never prints the key", () => {
  const home = tmp("home-");
  mkdirSync(path.join(home, ".verus-skills"), { recursive: true });
  writeFileSync(path.join(home, ".verus-skills", "config.json"), JSON.stringify({ typesafe: { apiKey: "ts_DUMMY_SECRET_123" } }));
  const r = runInstaller(["--home", home], { TYPESAFE_API_KEY: "" });
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /ok +TypeSafe API key/);
  assert.ok(!r.stdout.includes("ts_DUMMY_SECRET_123") && !r.stderr.includes("ts_DUMMY_SECRET_123"));
});
