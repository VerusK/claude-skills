import { test, after } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { cpSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { VERSIONED, readVersions, nextVersion, setVersion } from "../scripts/bump-version.mjs";

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const TEMP_DIRS = [];
function tmp(prefix) {
  const d = realpathSync(mkdtempSync(path.join(tmpdir(), prefix)));
  TEMP_DIRS.push(d);
  return d;
}
after(() => {
  for (const d of TEMP_DIRS) rmSync(d, { recursive: true, force: true });
});

function sandbox() {
  const root = tmp("bump-");
  for (const rel of VERSIONED) {
    mkdirSync(path.join(root, path.dirname(rel)), { recursive: true });
    cpSync(path.join(REPO_ROOT, rel), path.join(root, rel));
  }
  return root;
}

test("every versioned manifest carries the same version in the repo", () => {
  const versions = Object.values(readVersions(REPO_ROOT));
  assert.equal(new Set(versions).size, 1, `versions disagree: ${JSON.stringify(readVersions(REPO_ROOT))}`);
  assert.match(versions[0], /^\d+\.\d+\.\d+$/);
});

test("package-lock.json records the same version as the manifests", () => {
  // npm owns this file; `make release` runs `npm install --package-lock-only`
  // after the bump. This test is what catches a release that skipped that step.
  const lock = JSON.parse(readFileSync(path.join(REPO_ROOT, "package-lock.json"), "utf8"));
  const manifest = Object.values(readVersions(REPO_ROOT))[0];
  assert.equal(lock.version, manifest);
  assert.equal(lock.packages[""].version, manifest);
});

test("nextVersion handles patch, minor, major and an explicit version", () => {
  assert.equal(nextVersion("1.2.3", "patch"), "1.2.4");
  assert.equal(nextVersion("1.2.3", "minor"), "1.3.0");
  assert.equal(nextVersion("1.2.3", "major"), "2.0.0");
  assert.equal(nextVersion("1.2.3", "4.5.6"), "4.5.6");
  assert.throws(() => nextVersion("1.2.3", "nonsense"), /patch\|minor\|major/);
});

test("setVersion rewrites all four manifests, marketplace entry included", () => {
  const root = sandbox();
  setVersion("9.9.9", root);
  assert.deepEqual(new Set(Object.values(readVersions(root))), new Set(["9.9.9"]));
  const mk = JSON.parse(readFileSync(path.join(root, ".claude-plugin/marketplace.json"), "utf8"));
  assert.equal(mk.plugins[0].version, "9.9.9");
  assert.equal(mk.name, "verus-skills", "unrelated fields must survive the rewrite");
});

test("readVersions reports the drift when one manifest is behind", () => {
  const root = sandbox();
  setVersion("2.0.0", root);
  const p = path.join(root, ".codex-plugin/plugin.json");
  const json = JSON.parse(readFileSync(p, "utf8"));
  json.version = "1.0.0";
  writeFileSync(p, JSON.stringify(json, null, 2) + "\n");
  assert.equal(new Set(Object.values(readVersions(root))).size, 2);
});

test("the CLI refuses an unknown bump and exits 1", () => {
  const res = spawnSync(process.execPath, [path.join(REPO_ROOT, "scripts", "bump-version.mjs"), "sideways"], {
    encoding: "utf8",
  });
  assert.equal(res.status, 1);
  assert.match(res.stderr, /patch\|minor\|major/);
});
