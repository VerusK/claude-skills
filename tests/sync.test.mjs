import { test, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, readdirSync, symlinkSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { parseSources, validateSources, pinSources, resolveRef, updatePins, fetchFromGitHub, syncSource, repatch, readLock, summarize, hasBlockingResults, REPO_ROOT } from "../scripts/sync.mjs";

const TEMP_DIRS = [];
function tmp(prefix) {
  const d = mkdtempSync(path.join(tmpdir(), prefix));
  TEMP_DIRS.push(d);
  return d;
}
after(() => {
  for (const d of TEMP_DIRS) rmSync(d, { recursive: true, force: true });
});

function setupRoot() {
  const root = tmp("sync-");
  execFileSync("git", ["init", "-q"], { cwd: root });
  mkdirSync(path.join(root, "skills"));
  mkdirSync(path.join(root, "vendor"));
  mkdirSync(path.join(root, "patches"));
  return root;
}

function upstream(files) {
  const dir = tmp("up-");
  for (const [rel, content] of Object.entries(files)) {
    mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true });
    writeFileSync(path.join(dir, rel), content);
  }
  return dir;
}

const SHA = "a".repeat(40);
const src = { name: "demo", repo: "x/y", ref: SHA, license: "MIT", path: "skills/demo", mode: "merge", patch: true };
const fetcher = (dir, commit) => async () => ({ dir, commit });

test("parseSources normalises defaults", () => {
  const list = parseSources(`sources:\n  - name: a\n    repo: o/r\n    ref: ${SHA}\n    license: MIT\n    path: skills/a\n  - name: w\n    repo: o/r\n    path: f.md\n    mode: watch\n`);
  assert.deepEqual(list[0], { name: "a", repo: "o/r", ref: SHA, license: "MIT", path: "skills/a", mode: "merge", patch: false });
  assert.equal(list[1].ref, null);
  assert.equal(list[1].license, null);
  assert.equal(list[1].mode, "watch");
});

test("first sync copies upstream into vendor and skills", async () => {
  const root = setupRoot();
  const up = upstream({ "skills/demo/SKILL.md": "v1\n", "skills/demo/extra.md": "e\n" });
  const r = await syncSource(src, { root, fetchSource: fetcher(up, "aaa") });
  assert.equal(r.commit, "aaa");
  assert.deepEqual(r.added.sort(), ["SKILL.md", "extra.md"]);
  assert.equal(readFileSync(path.join(root, "skills/demo/SKILL.md"), "utf8"), "v1\n");
  assert.equal(readFileSync(path.join(root, "vendor/demo/SKILL.md"), "utf8"), "v1\n");
  assert.equal(readLock(root).demo.commit, "aaa");
});

test("upstream change merges into locally patched file", async () => {
  const root = setupRoot();
  await syncSource(src, { root, fetchSource: fetcher(upstream({ "skills/demo/SKILL.md": "line1\nline2\nline3\n" }), "a") });
  writeFileSync(path.join(root, "skills/demo/SKILL.md"), "line1\nOURS\nline3\n");
  const r = await syncSource(src, { root, fetchSource: fetcher(upstream({ "skills/demo/SKILL.md": "line1\nline2\nline3\nTHEIRS\n" }), "b") });
  assert.deepEqual(r.conflicts, []);
  assert.equal(readFileSync(path.join(root, "skills/demo/SKILL.md"), "utf8"), "line1\nOURS\nline3\nTHEIRS\n");
  assert.equal(readFileSync(path.join(root, "vendor/demo/SKILL.md"), "utf8"), "line1\nline2\nline3\nTHEIRS\n");
});

test("conflicting change leaves markers and reports conflict", async () => {
  const root = setupRoot();
  await syncSource(src, { root, fetchSource: fetcher(upstream({ "skills/demo/SKILL.md": "a\nb\nc\n" }), "a") });
  writeFileSync(path.join(root, "skills/demo/SKILL.md"), "a\nOURS\nc\n");
  const r = await syncSource(src, { root, fetchSource: fetcher(upstream({ "skills/demo/SKILL.md": "a\nTHEIRS\nc\n" }), "b") });
  assert.deepEqual(r.conflicts, ["SKILL.md"]);
  assert.match(readFileSync(path.join(root, "skills/demo/SKILL.md"), "utf8"), /<<<<<<< ours/);
});

test("file deleted upstream is removed when unmodified, kept when modified", async () => {
  const root = setupRoot();
  await syncSource(src, { root, fetchSource: fetcher(upstream({ "skills/demo/SKILL.md": "s\n", "skills/demo/gone.md": "g\n", "skills/demo/mod.md": "m\n" }), "a") });
  writeFileSync(path.join(root, "skills/demo/mod.md"), "m-ours\n");
  const r = await syncSource(src, { root, fetchSource: fetcher(upstream({ "skills/demo/SKILL.md": "s\n" }), "b") });
  assert.deepEqual(r.removed, ["gone.md"]);
  assert.deepEqual(r.kept, ["mod.md"]);
  assert.ok(!existsSync(path.join(root, "skills/demo/gone.md")));
  assert.ok(existsSync(path.join(root, "skills/demo/mod.md")));
});

test("watch mode updates vendor only and returns a diff", async () => {
  const root = setupRoot();
  const w = { name: "w", repo: "x/y", ref: "main", path: "f.md", mode: "watch", patch: false };
  await syncSource(w, { root, fetchSource: fetcher(upstream({ "f.md": "one\n" }), "a") });
  const r = await syncSource(w, { root, fetchSource: fetcher(upstream({ "f.md": "two\n" }), "b") });
  assert.equal(r.changed, true);
  assert.match(r.diff, /-one/);
  assert.match(r.diff, /\+two/);
  assert.match(r.diff, /a\/vendor\/f\.md/);
  assert.match(r.diff, /b\/upstream\/f\.md/);
  assert.ok(!r.diff.includes(tmpdir()), `diff leaked a temp path:\n${r.diff}`);
  assert.ok(!r.diff.includes(root), `diff leaked the root path:\n${r.diff}`);
  assert.ok(!existsSync(path.join(root, "skills/w")));
  assert.equal(readFileSync(path.join(root, "vendor/w/f.md"), "utf8"), "two\n");
});

test("repatch writes a diff when skills differ from vendor, removes it when identical", async () => {
  const root = setupRoot();
  await syncSource(src, { root, fetchSource: fetcher(upstream({ "skills/demo/SKILL.md": "x\n" }), "a") });
  assert.equal(repatch(src, { root }), null);
  writeFileSync(path.join(root, "skills/demo/SKILL.md"), "y\n");
  const p = repatch(src, { root });
  assert.equal(p, path.join(root, "patches/demo.patch"));
  assert.match(readFileSync(p, "utf8"), /\+y/);
});

// --- fix round 1 -------------------------------------------------------------

function binary(marker) {
  return Buffer.concat([Buffer.from([0x00, 0x01, 0x02]), Buffer.from(marker), Buffer.from([0x00, 0xff])]);
}

test("lock entry records repo, ref, path, commit, hash and syncedAt", async () => {
  const root = setupRoot();
  await syncSource(src, { root, fetchSource: fetcher(upstream({ "skills/demo/SKILL.md": "v1\n" }), "aaa") });
  const entry = readLock(root).demo;
  assert.deepEqual(Object.keys(entry).sort(), ["commit", "hash", "path", "ref", "repo", "syncedAt"]);
  assert.equal(entry.repo, "x/y");
  assert.equal(entry.ref, SHA);
  assert.equal(entry.path, "skills/demo");
  assert.equal(entry.commit, "aaa");
  assert.match(entry.hash, /^[0-9a-f]{64}$/);
  assert.ok(!Number.isNaN(Date.parse(entry.syncedAt)));
});

test("summarize reports conflicts and merge errors on separate lines", () => {
  const out = summarize([
    { name: "demo", commit: "abcdef1234", changed: true, conflicts: ["SKILL.md"], added: [], removed: [], kept: [], mergeErrors: [] },
    { name: "bin", commit: "1234567890", changed: true, conflicts: [], added: [], removed: [], kept: ["logo.png"], mergeErrors: ["logo.png — Cannot merge binary files"] },
  ]);
  assert.match(out, /## demo — CONFLICTS \(abcdef1\)/);
  assert.match(out, /- conflicts \(markers left in skills\/demo\): SKILL\.md/);
  assert.match(out, /- merge error, local copy kept: logo\.png — Cannot merge binary files/);
});

test("summarize tolerates results without mergeErrors", () => {
  const out = summarize([{ name: "x", commit: "0000000", changed: false, conflicts: [], added: [], removed: [], kept: [] }]);
  assert.match(out, /## x — unchanged/);
});

test("unmergeable binary file is reported as a merge error and the local copy is kept", async () => {
  const root = setupRoot();
  const ours = binary("OURS");
  await syncSource(src, { root, fetchSource: fetcher(upstream({ "skills/demo/bin.dat": binary("BASE") }), "a") });
  writeFileSync(path.join(root, "skills/demo/bin.dat"), ours);
  const r = await syncSource(src, { root, fetchSource: fetcher(upstream({ "skills/demo/bin.dat": binary("THEIRS") }), "b") });

  assert.deepEqual(r.conflicts, []);
  assert.equal(r.mergeErrors.length, 1);
  assert.match(r.mergeErrors[0], /^bin\.dat — /);
  assert.match(r.mergeErrors[0], /binary/i);
  assert.deepEqual(r.kept, ["bin.dat"]);
  assert.ok(readFileSync(path.join(root, "skills/demo/bin.dat")).equals(ours), "local copy must be left untouched");
  assert.ok(readFileSync(path.join(root, "vendor/demo/bin.dat")).equals(binary("THEIRS")), "vendor must advance to upstream");
});

test("dangling symlinks in upstream are skipped instead of crashing the sync", async () => {
  const root = setupRoot();
  const up = upstream({ "skills/demo/SKILL.md": "s\n" });
  symlinkSync("nowhere.md", path.join(up, "skills/demo/dead.md"));
  const r = await syncSource(src, { root, fetchSource: fetcher(up, "a") });
  assert.deepEqual(r.added, ["SKILL.md"]);
  assert.equal(readFileSync(path.join(root, "skills/demo/SKILL.md"), "utf8"), "s\n");
});

test("vendor swap leaves no temporary directories behind", async () => {
  const root = setupRoot();
  await syncSource(src, { root, fetchSource: fetcher(upstream({ "skills/demo/SKILL.md": "v1\n" }), "a") });
  await syncSource(src, { root, fetchSource: fetcher(upstream({ "skills/demo/SKILL.md": "v2\n" }), "b") });
  assert.deepEqual(readdirSync(path.join(root, "vendor")), ["demo"]);
  assert.equal(readFileSync(path.join(root, "vendor/demo/SKILL.md"), "utf8"), "v2\n");
});

// --- fix round 2 -------------------------------------------------------------

test("hasBlockingResults flags conflicts and merge errors, ignores clean runs", () => {
  const clean = { name: "a", conflicts: [], mergeErrors: [] };
  assert.equal(hasBlockingResults([clean]), false);
  assert.equal(hasBlockingResults([{ name: "a", conflicts: ["SKILL.md"], mergeErrors: [] }]), true);
  assert.equal(hasBlockingResults([{ name: "a", conflicts: [], mergeErrors: ["logo.png — x"] }]), true);
  assert.equal(hasBlockingResults([clean, { name: "b", conflicts: [], mergeErrors: ["p — x"] }]), true);
  assert.equal(hasBlockingResults([{ name: "a", conflicts: [] }]), false); // no mergeErrors field
  assert.equal(hasBlockingResults([]), false);
});

test("summarize headers merge errors, with conflicts taking precedence", () => {
  const out = summarize([
    { name: "bin", commit: "1234567890", changed: true, conflicts: [], added: [], removed: [], kept: ["logo.png"], mergeErrors: ["logo.png — Cannot merge binary files"] },
    { name: "both", commit: "abcdef1234", changed: true, conflicts: ["SKILL.md"], added: [], removed: [], kept: [], mergeErrors: ["logo.png — Cannot merge binary files"] },
    { name: "quiet", commit: "0000000", changed: true, conflicts: [], added: ["new.md"], removed: [], kept: [], mergeErrors: [] },
  ]);
  assert.match(out, /## bin — MERGE ERRORS \(1234567\)/);
  assert.match(out, /## both — CONFLICTS \(abcdef1\)/);
  assert.match(out, /## quiet — updated/);
});

test("merge error messages carry repo-relative paths, not absolute ones", async () => {
  const root = setupRoot();
  await syncSource(src, { root, fetchSource: fetcher(upstream({ "skills/demo/bin.dat": binary("BASE") }), "a") });
  writeFileSync(path.join(root, "skills/demo/bin.dat"), binary("OURS"));
  const r = await syncSource(src, { root, fetchSource: fetcher(upstream({ "skills/demo/bin.dat": binary("THEIRS") }), "b") });

  assert.equal(r.mergeErrors.length, 1);
  assert.ok(!r.mergeErrors[0].includes(root), `merge error leaked the root path:\n${r.mergeErrors[0]}`);
  assert.ok(!r.mergeErrors[0].includes(tmpdir()), `merge error leaked a temp path:\n${r.mergeErrors[0]}`);
  assert.match(r.mergeErrors[0], /skills\/demo\/bin\.dat/);
});

test("watch diff keeps a/ b/ prefixes even when git config disables them", async () => {
  const root = setupRoot();
  const cfgDir = tmp("gitcfg-");
  const cfg = path.join(cfgDir, "config");
  writeFileSync(cfg, "[diff]\n\tnoprefix = true\n\tmnemonicPrefix = true\n");
  const prevGlobal = process.env.GIT_CONFIG_GLOBAL;
  const prevSystem = process.env.GIT_CONFIG_SYSTEM;
  process.env.GIT_CONFIG_GLOBAL = cfg;
  process.env.GIT_CONFIG_SYSTEM = "/dev/null";
  try {
    const w = { name: "w", repo: "x/y", ref: "main", path: "f.md", mode: "watch", patch: false };
    await syncSource(w, { root, fetchSource: fetcher(upstream({ "f.md": "one\n" }), "a") });
    const r = await syncSource(w, { root, fetchSource: fetcher(upstream({ "f.md": "two\n" }), "b") });
    assert.match(r.diff, /a\/vendor\/f\.md/);
    assert.match(r.diff, /b\/upstream\/f\.md/);
  } finally {
    if (prevGlobal === undefined) delete process.env.GIT_CONFIG_GLOBAL; else process.env.GIT_CONFIG_GLOBAL = prevGlobal;
    if (prevSystem === undefined) delete process.env.GIT_CONFIG_SYSTEM; else process.env.GIT_CONFIG_SYSTEM = prevSystem;
  }
});

test("stale vendor tmp directories from earlier runs are pruned", async () => {
  const root = setupRoot();
  const stale = path.join(root, "vendor", "demo.tmp-999999");
  mkdirSync(stale, { recursive: true });
  writeFileSync(path.join(stale, "junk.md"), "junk\n");
  await syncSource(src, { root, fetchSource: fetcher(upstream({ "skills/demo/SKILL.md": "v1\n" }), "a") });
  assert.deepEqual(readdirSync(path.join(root, "vendor")), ["demo"]);
});

// ---- H3: every external source is pinned to a commit and carries a license ----

const REAL_SOURCES = parseSources(readFileSync(path.join(REPO_ROOT, "sources.yaml"), "utf8"));

test("every source in sources.yaml has a 40-hex ref commit and an SPDX license", () => {
  assert.ok(REAL_SOURCES.length > 0);
  for (const s of REAL_SOURCES) {
    assert.match(s.ref ?? "", /^[0-9a-f]{40}$/, `${s.name}: ref must be a full commit sha, not a branch`);
    assert.ok(s.license, `${s.name}: license is missing`);
  }
  assert.deepEqual(validateSources(REAL_SOURCES), []);
});

test("sources.lock.json records exactly the pinned commit of every source", () => {
  const lock = readLock(REPO_ROOT);
  for (const s of REAL_SOURCES) {
    assert.equal(lock[s.name]?.commit, s.ref, `${s.name}: lock commit differs from the pinned ref (run make sync)`);
    assert.equal(lock[s.name]?.ref, s.ref, `${s.name}: lock ref differs from the pinned ref (run make sync)`);
  }
});

test("local mode and patch flags survive pinning", () => {
  const watch = REAL_SOURCES.filter((s) => s.mode === "watch").map((s) => s.name).sort();
  assert.deepEqual(watch, ["gstack-plan-eng-review", "superpowers-code-reviewer"]);
  assert.ok(REAL_SOURCES.find((s) => s.name === "writing-plans").patch);
});

test("validateSources flags branch refs, missing ref and license, bad SPDX and duplicates", () => {
  const ok = { name: "a", repo: "o/r", ref: SHA, license: "MIT", path: "p", mode: "merge", patch: false };
  assert.deepEqual(validateSources([ok]), []);
  assert.deepEqual(validateSources([ok, { ...ok, license: "Apache-2.0 OR MIT" }]).length, 1, "duplicate name only");
  const problems = validateSources([
    { ...ok, name: "branch", ref: "main" },
    { ...ok, name: "noref", ref: null },
    { ...ok, name: "nolic", license: null },
    { ...ok, name: "badlic", license: "my own terms!" },
    { ...ok, name: "short", ref: "abc123" },
  ]);
  assert.equal(problems.length, 5);
  assert.match(problems.join("\n"), /branch.*commit sha/);
  assert.match(problems.join("\n"), /nolic.*license/);
  assert.match(problems.join("\n"), /badlic.*SPDX/);
});

test("validateSources can skip the pin check for an update run", () => {
  const s = { name: "a", repo: "o/r", ref: "main", license: "MIT", path: "p", mode: "merge", patch: false };
  assert.equal(validateSources([s]).length, 1);
  assert.deepEqual(validateSources([s], { requirePinned: false }), []);
});

test("fetchFromGitHub refuses an unpinned ref before touching the network", async () => {
  await assert.rejects(() => fetchFromGitHub({ ...src, ref: "main" }), /not pinned/);
});

test("pinSources rewrites only ref lines and keeps comments, mode and patch", () => {
  const text = `# header comment\nsources:\n  - name: a\n    repo: o/r\n    ref: ${SHA}\n    license: MIT\n    path: skills/a\n    patch: true\n  # watch-only\n  - name: w\n    repo: o/r\n    ref: ${SHA}\n    license: MIT\n    path: f.md\n    mode: watch\n`;
  const NEW = "b".repeat(40);
  const out = pinSources(text, { w: NEW });
  assert.match(out, /# header comment/);
  assert.match(out, /# watch-only/);
  const list = parseSources(out);
  assert.equal(list[0].ref, SHA);
  assert.equal(list[1].ref, NEW);
  assert.equal(list[0].patch, true);
  assert.equal(list[1].mode, "watch");
  assert.throws(() => pinSources(text, { nope: NEW }), /unknown source/);
});

test("resolveRef returns a sha as is and reads a branch through the injected lister", async () => {
  assert.equal(await resolveRef(src, SHA), SHA);
  const lines = (out) => async () => out;
  assert.equal(await resolveRef(src, "main", { lsRemote: lines(`${"c".repeat(40)}\trefs/heads/main\n`) }), "c".repeat(40));
  // annotated tag: the peeled commit wins over the tag object
  assert.equal(await resolveRef(src, "v1", { lsRemote: lines(`${"d".repeat(40)}\trefs/tags/v1\n${"e".repeat(40)}\trefs/tags/v1^{}\n`) }), "e".repeat(40));
  await assert.rejects(() => resolveRef(src, "nope", { lsRemote: lines("") }), /cannot resolve/);
});

test("updatePins moves the pin of the selected sources and leaves the rest", async () => {
  const root = tmp("pins-");
  const text = `sources:\n  - name: a\n    repo: o/r\n    ref: ${SHA}\n    license: MIT\n    path: skills/a\n  - name: b\n    repo: o/r\n    ref: ${SHA}\n    license: MIT\n    path: skills/b\n`;
  writeFileSync(path.join(root, "sources.yaml"), text);
  const NEW = "f".repeat(40);
  const list = parseSources(text);
  const pins = await updatePins(list.filter((s) => s.name === "b"), { to: null, lsRemote: async () => `${NEW}\tHEAD\n` });
  assert.deepEqual(pins, { b: NEW });
  writeFileSync(path.join(root, "sources.yaml"), pinSources(text, pins));
  const after = parseSources(readFileSync(path.join(root, "sources.yaml"), "utf8"));
  assert.equal(after[0].ref, SHA);
  assert.equal(after[1].ref, NEW);
});
