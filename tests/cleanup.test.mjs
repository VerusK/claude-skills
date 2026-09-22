import { test, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, readdirSync, existsSync, symlinkSync, lstatSync, chmodSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";

const SCRIPT = new URL("../scripts/cleanup.sh", import.meta.url).pathname;

// Every temp dir made here is removed in after(); none of the runs may see the real HOME.
const TMPDIRS = [];
function mkTmp(prefix) {
  const d = mkdtempSync(path.join(tmpdir(), prefix));
  TMPDIRS.push(d);
  return d;
}
const ENV = { ...process.env, HOME: mkTmp("home-throwaway-") };

after(() => {
  for (const d of TMPDIRS) {
    try { chmodSync(path.join(d, ".codex"), 0o700); } catch { /* not every fixture has one */ }
    try { rmSync(d, { recursive: true, force: true }); } catch { /* best effort */ }
  }
});

function fakeHome() {
  const h = mkTmp("home-");
  const mk = (p, content = "") => { mkdirSync(path.dirname(path.join(h, p)), { recursive: true }); writeFileSync(path.join(h, p), content); };
  mk(".agents/skills/gstack/SKILL.md", "x");
  mkdirSync(path.join(h, ".agents/skills/gstack-codex"), { recursive: true });
  mkdirSync(path.join(h, ".agents/skills/keep-me"), { recursive: true });
  symlinkSync("/nowhere/superpowers/skills", path.join(h, ".agents/skills/superpowers"));
  mk(".claude/plugins/cache/compound-engineering-plugin/x", "x");
  mk(".claude/plugins/marketplaces/compound-engineering-plugin/.marketplace.json", "{}");
  mk(".claude/settings.json", JSON.stringify({ enabledPlugins: { "compound-engineering@compound-engineering-plugin": false, "other@x": true } }, null, 2));
  mk(".claude/plugins/installed_plugins.json", JSON.stringify({ plugins: { "compound-engineering@compound-engineering-plugin": [{}], "other@x": [{}] } }, null, 2));
  mk(".codex/superpowers/README.md", "x");
  mk(".codex/compound-engineering/README.md", "x");
  mk(".codex/skills/compound-engineering/SKILL.md", "x");
  mk(".codex/agents/compound-engineering/ce-x.toml", "x");
  mk(".codex/config.toml", `model = "gpt"\n\n[marketplaces.compound-engineering-plugin]\nsource = "x"\n\n[marketplaces.keep]\nsource = "y"\n\n[plugins."compound-engineering@compound-engineering-plugin"]\nenabled = false\n\n[plugins."superpowers@claude-plugins-official"]\nenabled = true\n\n[plugins."keep@keep"]\nenabled = true\n`);
  return h;
}

function homeWithConfig(toml) {
  const h = mkTmp("home-toml-");
  mkdirSync(path.join(h, ".codex"), { recursive: true });
  writeFileSync(path.join(h, ".codex/config.toml"), toml);
  return h;
}

const run = (args, opts = {}) => spawnSync("bash", [SCRIPT, ...args], { encoding: "utf8", env: ENV, ...opts });

test("cleanup --yes removes leftovers and strips config sections, keeps everything else", () => {
  const h = fakeHome();
  const r = spawnSync("bash", [SCRIPT, "--yes", "--home", h], { encoding: "utf8", env: ENV });
  assert.equal(r.status, 0, r.stderr + r.stdout);
  for (const gone of [".agents/skills/gstack", ".agents/skills/gstack-codex", ".agents/skills/superpowers", ".claude/plugins/cache/compound-engineering-plugin", ".codex/superpowers", ".codex/compound-engineering", ".codex/skills/compound-engineering", ".codex/agents/compound-engineering"]) {
    assert.ok(!existsSync(path.join(h, gone)), `${gone} should be gone`);
  }
  assert.ok(existsSync(path.join(h, ".agents/skills/keep-me")));
  const toml = readFileSync(path.join(h, ".codex/config.toml"), "utf8");
  assert.doesNotMatch(toml, /compound-engineering/);
  assert.doesNotMatch(toml, /superpowers@/);
  assert.match(toml, /\[marketplaces\.keep\]\nsource = "y"/);
  assert.match(toml, /\[plugins\."keep@keep"\]\nenabled = true/);
  assert.match(toml, /^model = "gpt"/);
  assert.ok(existsSync(path.join(h, ".codex/config.toml.bak")));
  const settings = JSON.parse(readFileSync(path.join(h, ".claude/settings.json"), "utf8"));
  assert.deepEqual(Object.keys(settings.enabledPlugins), ["other@x"]);
  const installed = JSON.parse(readFileSync(path.join(h, ".claude/plugins/installed_plugins.json"), "utf8"));
  assert.deepEqual(Object.keys(installed.plugins), ["other@x"]);
});

test("cleanup without --yes and with 'n' answers removes nothing", () => {
  const h = fakeHome();
  const r = spawnSync("bash", [SCRIPT, "--home", h], { encoding: "utf8", env: ENV, input: "n\nn\nn\nn\nn\n" });
  assert.equal(r.status, 0, r.stderr);
  assert.ok(existsSync(path.join(h, ".agents/skills/gstack")));
  assert.ok(existsSync(path.join(h, ".codex/superpowers")));
});

test("cleanup aborts and leaves config.toml intact when its directory is not writable", () => {
  const h = fakeHome();
  const cfg = path.join(h, ".codex/config.toml");
  const before = readFileSync(cfg, "utf8");
  chmodSync(path.join(h, ".codex"), 0o500);
  try {
    const r = run(["--yes", "--home", h]);
    assert.equal(r.status, 1, `expected exit 1, got ${r.status}\n${r.stdout}${r.stderr}`);
    assert.equal(readFileSync(cfg, "utf8"), before, "config.toml must not be touched");
    assert.ok(!existsSync(cfg + ".bak"), "no backup should have been written");
    assert.doesNotMatch(r.stdout, /config\.toml[^\n]*edited/);
    assert.doesNotMatch(r.stdout, /cleanup done/);
  } finally {
    chmodSync(path.join(h, ".codex"), 0o700);
  }
});

test("cleanup keeps the first backup and writes no new one on a second run", () => {
  const h = fakeHome();
  assert.equal(run(["--yes", "--home", h]).status, 0);
  const r2 = run(["--yes", "--home", h]);
  assert.equal(r2.status, 0, r2.stderr + r2.stdout);
  assert.match(readFileSync(path.join(h, ".codex/config.toml.bak"), "utf8"), /compound-engineering/);
  assert.deepEqual(
    readdirSync(path.join(h, ".codex")).filter((n) => n.startsWith("config.toml.bak")).sort(),
    ["config.toml.bak"],
  );
  assert.deepEqual(
    readdirSync(path.join(h, ".claude")).filter((n) => n.startsWith("settings.json.bak")).sort(),
    ["settings.json.bak"],
  );
  assert.match(readFileSync(path.join(h, ".claude/settings.json.bak"), "utf8"), /compound-engineering/);
  assert.ok(!readdirSync(path.join(h, ".codex")).some((n) => n.includes(".tmp.")), "no temp file left behind");
});

test("cleanup drops commented headers, nested subtables and array continuations, keeping blank lines inside strings", () => {
  const input = [
    'model = "gpt"',
    "",
    "[marketplaces.compound-engineering-plugin]  # drop me",
    "matrix = [",
    "[1, 2],",
    "[3, 4],",
    "]",
    'source = "x"',
    "",
    '[plugins."compound-engineering@compound-engineering-plugin"]',
    "enabled = false",
    "",
    '[plugins."compound-engineering@compound-engineering-plugin".env]',
    'FOO = "bar"',
    "",
    "[marketplaces.keep]",
    'multi = """',
    "line1",
    "",
    "",
    "line2",
    '"""',
    'source = "y"',
    "",
    '[plugins."keep@keep"]',
    "enabled = true",
    "",
  ].join("\n");
  const expected = [
    'model = "gpt"',
    "",
    "[marketplaces.keep]",
    'multi = """',
    "line1",
    "",
    "",
    "line2",
    '"""',
    'source = "y"',
    "",
    '[plugins."keep@keep"]',
    "enabled = true",
    "",
  ].join("\n");
  const h = homeWithConfig(input);
  const r = run(["--yes", "--home", h]);
  assert.equal(r.status, 0, r.stderr + r.stdout);
  assert.equal(readFileSync(path.join(h, ".codex/config.toml"), "utf8"), expected);
  assert.equal(readFileSync(path.join(h, ".codex/config.toml.bak"), "utf8"), input);
});

test("cleanup reports a failure instead of 'edited' when a JSON file cannot be parsed", () => {
  const h = fakeHome();
  writeFileSync(path.join(h, ".claude/settings.json"), "{ not json");
  const r = run(["--yes", "--home", h]);
  const out = r.stdout + r.stderr;
  assert.equal(r.status, 0, out);
  assert.match(out, /failed: .*settings\.json/);
  assert.doesNotMatch(r.stdout, /^ +edited$/m);
  assert.match(r.stdout, /cleanup done \(1 failure\)/);
  assert.equal(readFileSync(path.join(h, ".claude/settings.json"), "utf8"), "{ not json");
  assert.ok(!existsSync(path.join(h, ".claude/settings.json.bak")), "a broken file must not be backed up");
  const installed = JSON.parse(readFileSync(path.join(h, ".claude/plugins/installed_plugins.json"), "utf8"));
  assert.deepEqual(Object.keys(installed.plugins), ["other@x"]);
});

test("cleanup accepts --home=DIR and removes the compound-engineering marketplace dir", () => {
  const h = fakeHome();
  const r = run(["--yes", `--home=${h}`]);
  assert.equal(r.status, 0, r.stderr + r.stdout);
  assert.ok(!existsSync(path.join(h, ".claude/plugins/marketplaces/compound-engineering-plugin")));
  assert.ok(!existsSync(path.join(h, ".agents/skills/gstack")));
  assert.ok(existsSync(path.join(h, ".agents/skills/keep-me")));
});

test("cleanup rejects an unknown option and removes nothing", () => {
  const h = fakeHome();
  const r = run(["--yes", "--home", h, "--bogus"]);
  assert.equal(r.status, 1);
  assert.match(r.stderr, /unknown argument/);
  assert.ok(existsSync(path.join(h, ".agents/skills/gstack")));
  assert.ok(existsSync(path.join(h, ".codex/superpowers")));
  assert.ok(!existsSync(path.join(h, ".codex/config.toml.bak")));
});

test("cleanup rejects --home without a value", () => {
  const r = run(["--yes", "--home"]);
  assert.equal(r.status, 1);
  assert.match(r.stderr, /--home requires a directory/);
  const r2 = run(["--yes", "--home="]);
  assert.equal(r2.status, 1);
  assert.match(r2.stderr, /--home requires a directory/);
});

test("cleanup prints no literal glob when no gstack-* dirs exist", () => {
  const h = mkTmp("home-empty-");
  mkdirSync(path.join(h, ".agents/skills/keep-me"), { recursive: true });
  const r = run(["--yes", "--home", h]);
  assert.equal(r.status, 0, r.stderr + r.stdout);
  assert.doesNotMatch(r.stdout, /gstack-\*/);
  assert.match(r.stdout, /nothing to remove/);
  assert.ok(existsSync(path.join(h, ".agents/skills/keep-me")));
});

test("cleanup edits the real file behind a symlinked config.toml", () => {
  const h = mkTmp("home-link-toml-");
  mkdirSync(path.join(h, ".codex"), { recursive: true });
  const real = path.join(h, "real-config.toml");
  const input = [
    'model = "gpt"',
    "",
    "[marketplaces.compound-engineering-plugin]",
    'source = "x"',
    "",
    "[marketplaces.keep]",
    'source = "y"',
    "",
  ].join("\n");
  writeFileSync(real, input);
  symlinkSync("../real-config.toml", path.join(h, ".codex/config.toml"));
  const r = run(["--yes", "--home", h]);
  assert.equal(r.status, 0, r.stderr + r.stdout);
  assert.ok(lstatSync(path.join(h, ".codex/config.toml")).isSymbolicLink(), "the symlink must survive");
  const out = readFileSync(real, "utf8");
  assert.doesNotMatch(out, /compound-engineering/);
  assert.match(out, /\[marketplaces\.keep\]\nsource = "y"/);
  assert.ok(existsSync(path.join(h, "real-config.toml.bak")), "backup belongs next to the real file");
  assert.equal(readFileSync(path.join(h, "real-config.toml.bak"), "utf8"), input);
  assert.ok(!existsSync(path.join(h, ".codex/config.toml.bak")), "no backup beside the link");
  assert.ok(!readdirSync(h).some((n) => n.includes(".tmp.")), "no temp file left behind");
  assert.match(r.stdout, /-> .*real-config\.toml$/m);
});

test("cleanup edits the real file behind a symlinked settings.json", () => {
  const h = mkTmp("home-link-json-");
  mkdirSync(path.join(h, ".claude"), { recursive: true });
  mkdirSync(path.join(h, "dotfiles/claude"), { recursive: true });
  const real = path.join(h, "dotfiles/claude/settings.json");
  const input = JSON.stringify(
    { enabledPlugins: { "compound-engineering@compound-engineering-plugin": true, "other@x": true } },
    null,
    2,
  );
  writeFileSync(real, input);
  symlinkSync("../dotfiles/claude/settings.json", path.join(h, ".claude/settings.json"));
  const r = run(["--yes", "--home", h]);
  assert.equal(r.status, 0, r.stderr + r.stdout);
  assert.ok(lstatSync(path.join(h, ".claude/settings.json")).isSymbolicLink(), "the symlink must survive");
  const j = JSON.parse(readFileSync(real, "utf8"));
  assert.deepEqual(Object.keys(j.enabledPlugins), ["other@x"]);
  assert.ok(existsSync(path.join(h, "dotfiles/claude/settings.json.bak")), "backup belongs next to the real file");
  assert.equal(readFileSync(path.join(h, "dotfiles/claude/settings.json.bak"), "utf8"), input);
  assert.ok(!existsSync(path.join(h, ".claude/settings.json.bak")), "no backup beside the link");
  assert.ok(!readdirSync(path.join(h, "dotfiles/claude")).some((n) => n.includes(".tmp.")), "no temp file left behind");
  assert.match(r.stdout, /-> .*dotfiles\/claude\/settings\.json$/m);
  assert.match(r.stdout, /^ +edited$/m);
});

test("cleanup reports a failed removal instead of 'removed'", () => {
  const h = mkTmp("home-rmfail-");
  mkdirSync(path.join(h, ".codex/superpowers"), { recursive: true });
  writeFileSync(path.join(h, ".codex/superpowers/README.md"), "x");
  chmodSync(path.join(h, ".codex"), 0o500);
  try {
    const r = run(["--yes", "--home", h]);
    const out = r.stdout + r.stderr;
    assert.equal(r.status, 0, out);
    assert.match(out, /failed: .*\.codex\/superpowers/);
    assert.doesNotMatch(r.stdout, /^ +removed$/m);
    assert.match(r.stdout, /cleanup done \(1 failure\)/);
    assert.ok(existsSync(path.join(h, ".codex/superpowers")), "the undeletable dir is still there");
  } finally {
    chmodSync(path.join(h, ".codex"), 0o700);
  }
});

test("cleanup says 'nothing to edit' when the JSON config has no compound-engineering entries", () => {
  const h = mkTmp("home-json-clean-");
  mkdirSync(path.join(h, ".claude"), { recursive: true });
  writeFileSync(path.join(h, ".claude/settings.json"), JSON.stringify({ enabledPlugins: { "other@x": true } }, null, 2));
  const r = run(["--yes", "--home", h]);
  assert.equal(r.status, 0, r.stderr + r.stdout);
  assert.doesNotMatch(r.stdout, /^ +edited$/m);
  assert.match(r.stdout, /^ +nothing to edit$/m);
  assert.ok(!existsSync(path.join(h, ".claude/settings.json.bak")), "nothing changed, so no backup");
});
