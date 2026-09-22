import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { parseSources, syncSource, repatch, readLock } from "../scripts/sync.mjs";

function setupRoot() {
  const root = mkdtempSync(path.join(tmpdir(), "sync-"));
  execFileSync("git", ["init", "-q"], { cwd: root });
  mkdirSync(path.join(root, "skills"));
  mkdirSync(path.join(root, "vendor"));
  mkdirSync(path.join(root, "patches"));
  return root;
}

function upstream(files) {
  const dir = mkdtempSync(path.join(tmpdir(), "up-"));
  for (const [rel, content] of Object.entries(files)) {
    mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true });
    writeFileSync(path.join(dir, rel), content);
  }
  return dir;
}

const src = { name: "demo", repo: "x/y", ref: "main", path: "skills/demo", mode: "merge", patch: true };
const fetcher = (dir, commit) => async () => ({ dir, commit });

test("parseSources normalises defaults", () => {
  const list = parseSources(`sources:\n  - name: a\n    repo: o/r\n    path: skills/a\n  - name: w\n    repo: o/r\n    path: f.md\n    mode: watch\n`);
  assert.deepEqual(list[0], { name: "a", repo: "o/r", ref: "main", path: "skills/a", mode: "merge", patch: false });
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
