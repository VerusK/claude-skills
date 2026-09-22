import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";

const SCRIPT = new URL("../scripts/cleanup.sh", import.meta.url).pathname;

function fakeHome() {
  const h = mkdtempSync(path.join(tmpdir(), "home-"));
  const mk = (p, content = "") => { mkdirSync(path.dirname(path.join(h, p)), { recursive: true }); writeFileSync(path.join(h, p), content); };
  mk(".agents/skills/gstack/SKILL.md", "x");
  mkdirSync(path.join(h, ".agents/skills/gstack-codex"), { recursive: true });
  mkdirSync(path.join(h, ".agents/skills/keep-me"), { recursive: true });
  symlinkSync("/nowhere/superpowers/skills", path.join(h, ".agents/skills/superpowers"));
  mk(".claude/plugins/cache/compound-engineering-plugin/x", "x");
  mk(".claude/settings.json", JSON.stringify({ enabledPlugins: { "compound-engineering@compound-engineering-plugin": false, "other@x": true } }, null, 2));
  mk(".claude/plugins/installed_plugins.json", JSON.stringify({ plugins: { "compound-engineering@compound-engineering-plugin": [{}], "other@x": [{}] } }, null, 2));
  mk(".codex/superpowers/README.md", "x");
  mk(".codex/compound-engineering/README.md", "x");
  mk(".codex/skills/compound-engineering/SKILL.md", "x");
  mk(".codex/agents/compound-engineering/ce-x.toml", "x");
  mk(".codex/config.toml", `model = "gpt"\n\n[marketplaces.compound-engineering-plugin]\nsource = "x"\n\n[marketplaces.keep]\nsource = "y"\n\n[plugins."compound-engineering@compound-engineering-plugin"]\nenabled = false\n\n[plugins."superpowers@claude-plugins-official"]\nenabled = true\n\n[plugins."keep@keep"]\nenabled = true\n`);
  return h;
}

test("cleanup --yes removes leftovers and strips config sections, keeps everything else", () => {
  const h = fakeHome();
  const r = spawnSync("bash", [SCRIPT, "--yes", "--home", h], { encoding: "utf8" });
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
  const r = spawnSync("bash", [SCRIPT, "--home", h], { encoding: "utf8", input: "n\nn\nn\nn\nn\n" });
  assert.equal(r.status, 0, r.stderr);
  assert.ok(existsSync(path.join(h, ".agents/skills/gstack")));
  assert.ok(existsSync(path.join(h, ".codex/superpowers")));
});
