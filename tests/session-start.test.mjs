import { test, after } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmodSync, mkdtempSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { pointerPath, buildContext, readPointer, writePointer, ROOT } from "../scripts/session-start.mjs";

const SESSION_START = path.join(ROOT, "scripts", "session-start.mjs");
const TEMP_DIRS = [];
function tmp(prefix) {
  const d = realpathSync(mkdtempSync(path.join(tmpdir(), prefix)));
  TEMP_DIRS.push(d);
  return d;
}
after(() => {
  for (const d of TEMP_DIRS) {
    try { chmodSync(d, 0o755); } catch {}
    rmSync(d, { recursive: true, force: true });
  }
});

function fakeDistro() {
  const root = tmp("distro-");
  mkdirSync(path.join(root, "scripts"), { recursive: true });
  writeFileSync(path.join(root, "scripts", "typesafe-judge.mjs"), "// stub\n");
  writeFileSync(path.join(root, "USING.md"), "# routing\n\nuse the skills\n");
  return root;
}

test("pointerPath is $HOME/.verus-skills/root", () => {
  assert.equal(pointerPath("/tmp/h"), path.join("/tmp/h", ".verus-skills", "root"));
});

test("writePointer creates the directory and stores the root with a newline", () => {
  const home = tmp("home-");
  const p = writePointer("/some/root", home);
  assert.equal(p, pointerPath(home));
  assert.equal(readFileSync(p, "utf8"), "/some/root\n");
});

test("writePointer returns null instead of throwing when HOME is not writable", () => {
  const home = tmp("ro-home-");
  chmodSync(home, 0o500);
  assert.equal(writePointer("/some/root", home), null);
});

test("buildContext carries the root and the USING.md body", () => {
  const root = fakeDistro();
  const ctx = buildContext(root);
  assert.match(ctx, new RegExp(`Distro root: ${root.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`));
  assert.match(ctx, /use the skills/);
  assert.match(ctx, /^<EXTREMELY_IMPORTANT>/);
});

test("buildContext reports an unreadable USING.md instead of throwing", () => {
  const root = tmp("empty-distro-");
  const ctx = buildContext(root);
  assert.match(ctx, /could not read USING\.md/);
  assert.match(ctx, /^<EXTREMELY_IMPORTANT>/);
});

test("readPointer returns the stored root, and null when there is none", () => {
  const home = tmp("home-");
  assert.equal(readPointer(home), null);
  writePointer("/some/root", home);
  assert.equal(readPointer(home), "/some/root");
});

test("readPointer treats a whitespace-only pointer as absent", () => {
  // what an interrupted hook leaves behind
  const home = tmp("home-");
  mkdirSync(path.join(home, ".verus-skills"), { recursive: true });
  writeFileSync(pointerPath(home), "\n");
  assert.equal(readPointer(home), null);
});

test("buildContext warns when another distro already owns the pointer, and names it", () => {
  const mine = fakeDistro();
  const other = fakeDistro();
  const warned = buildContext(mine, other);
  assert.match(warned, /two installs of this distro are active/);
  // the uninstall advice must name the OTHER root: `make uninstall` run from the
  // running root removes none of the other install's symlinks.
  assert.ok(warned.includes(`make uninstall\` run from ${other}`), warned);
  assert.doesNotMatch(buildContext(mine, mine), /two installs/);
  assert.doesNotMatch(buildContext(mine, null), /two installs/);
  // a directory with a USING.md but no scripts/typesafe-judge.mjs is not a distro
  const decoy = tmp("not-a-distro-");
  writeFileSync(path.join(decoy, "USING.md"), "# not ours\n");
  assert.doesNotMatch(buildContext(mine, decoy), /two installs/);
});

test("running the hook warns when a different distro wrote the pointer first", () => {
  const home = tmp("home-");
  const other = fakeDistro();
  writePointer(other, home);
  const res = spawnSync(process.execPath, [SESSION_START], { encoding: "utf8", env: { ...process.env, HOME: home } });
  assert.equal(res.status, 0);
  assert.match(JSON.parse(res.stdout).hookSpecificOutput.additionalContext, /two installs of this distro are active/);
  // this session's own root wins the pointer
  assert.equal(readFileSync(pointerPath(home), "utf8"), ROOT + "\n");
});

test("running the hook writes the pointer file and prints SessionStart JSON", () => {
  const home = tmp("home-");
  const res = spawnSync(process.execPath, [SESSION_START], { encoding: "utf8", env: { ...process.env, HOME: home } });
  assert.equal(res.status, 0);
  const out = JSON.parse(res.stdout);
  assert.equal(out.hookSpecificOutput.hookEventName, "SessionStart");
  assert.match(out.hookSpecificOutput.additionalContext, /Distro root: /);
  assert.equal(readFileSync(pointerPath(home), "utf8"), ROOT + "\n");
});

test("the hook still prints valid JSON when the pointer file cannot be written", () => {
  const home = tmp("ro-home-");
  chmodSync(home, 0o500);
  const res = spawnSync(process.execPath, [SESSION_START], { encoding: "utf8", env: { ...process.env, HOME: home } });
  assert.equal(res.status, 0);
  assert.equal(JSON.parse(res.stdout).hookSpecificOutput.hookEventName, "SessionStart");
});

test("the hook runs when started through a symlinked path", () => {
  // the plugin command goes through ${CLAUDE_PLUGIN_ROOT}, which is not a real
  // path when $HOME or ~/.claude is a symlink
  const home = tmp("home-");
  const link = path.join(tmp("link-"), "session-start.mjs");
  symlinkSync(SESSION_START, link);
  const res = spawnSync(process.execPath, [link], { encoding: "utf8", env: { ...process.env, HOME: home } });
  assert.equal(res.status, 0, res.stderr);
  assert.equal(JSON.parse(res.stdout).hookSpecificOutput.hookEventName, "SessionStart");
  assert.equal(readFileSync(pointerPath(home), "utf8"), ROOT + "\n");
});

function cacheDistro(base, agentDir, version) {
  const root = path.join(base, agentDir, "plugins", "cache", "verus-skills", "verus-skills", version);
  mkdirSync(path.join(root, "scripts"), { recursive: true });
  writeFileSync(path.join(root, "scripts", "typesafe-judge.mjs"), "// stub\n");
  writeFileSync(path.join(root, "USING.md"), "# routing\n\nuse the skills\n");
  return root;
}

test("buildContext does not warn when both roots are plugin-cache copies", () => {
  const base = tmp("cache-home-");
  const claude = cacheDistro(base, ".claude", "0.2.0");
  const codex = cacheDistro(base, ".codex", "0.2.0");
  assert.doesNotMatch(buildContext(claude, codex), /two installs/);
  assert.doesNotMatch(buildContext(codex, claude), /two installs/);
  const older = cacheDistro(base, ".claude", "0.1.0");
  assert.doesNotMatch(buildContext(claude, older), /two installs/);
  assert.doesNotMatch(buildContext(older, claude), /two installs/);
});

test("buildContext warns when a checkout and a plugin-cache copy share the pointer", () => {
  const base = tmp("cache-home-");
  const cached = cacheDistro(base, ".claude", "0.2.0");
  const checkout = fakeDistro();
  assert.match(buildContext(cached, checkout), /two installs of this distro are active/);
  assert.match(buildContext(checkout, cached), /two installs of this distro are active/);
});

test("buildContext matches the plugin cache on whole path segments only", () => {
  const base = tmp("cache-home-");
  const cached = cacheDistro(base, ".claude", "0.2.0");
  const lookalike = path.join(base, "myplugins", "cache", "verus-skills-old", "verus-skills", "0.2.0");
  mkdirSync(path.join(lookalike, "scripts"), { recursive: true });
  writeFileSync(path.join(lookalike, "scripts", "typesafe-judge.mjs"), "// stub\n");
  assert.match(buildContext(cached, lookalike), /two installs of this distro are active/);
});
