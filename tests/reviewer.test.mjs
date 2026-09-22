import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, readFileSync, existsSync, copyFileSync, chmodSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { spawnSync, execFileSync } from "node:child_process";

const SCRIPT = new URL("../scripts/reviewer.sh", import.meta.url).pathname;
const FIX = new URL("./fixtures/fake-bin/", import.meta.url).pathname;

function repo() {
  const dir = mkdtempSync(path.join(tmpdir(), "rev-"));
  execFileSync("git", ["init", "-q"], { cwd: dir });
  return dir;
}

function run(dir, bins) {
  const bin = mkdtempSync(path.join(tmpdir(), "bin-"));
  for (const b of bins) { copyFileSync(path.join(FIX, b), path.join(bin, b)); chmodSync(path.join(bin, b), 0o755); }
  const log = path.join(dir, "calls.log");
  const prompt = path.join(dir, "prompt.md");
  writeFileSync(prompt, "Review this.\nWrite the report to docs/reviews/out.md\n");
  const r = spawnSync("bash", [SCRIPT, "--prompt-file", prompt, "--output", "docs/reviews/out.md", "--title", "t", "--repo", dir, "--timeout-min", "1"], {
    cwd: dir, encoding: "utf8",
    env: { PATH: `${bin}:/usr/bin:/bin`, HOME: dir, FAKE_LOG: log, NODE: process.execPath },
  });
  return { ...r, log: existsSync(log) ? readFileSync(log, "utf8") : "" };
}

test("prefers Orca when available", () => {
  const dir = repo();
  const r = run(dir, ["orca", "codex"]);
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /reviewer: orca/);
  assert.match(r.log, /terminal create/);
  assert.doesNotMatch(r.log, /^codex/m);
  assert.equal(readFileSync(path.join(dir, "docs/reviews/out.md"), "utf8").trim(), "orca report");
  assert.ok(existsSync(path.join(dir, ".context/t-prompt.md")));
  assert.match(readFileSync(path.join(dir, ".git/info/exclude"), "utf8"), /\.context\//);
});

test("falls back to codex exec without Orca", () => {
  const dir = repo();
  const r = run(dir, ["codex"]);
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /reviewer: codex-exec/);
  assert.match(r.log, /codex exec/);
  assert.equal(readFileSync(path.join(dir, "docs/reviews/out.md"), "utf8").trim(), "codex report");
});

test("exits 3 when nothing is available", () => {
  const dir = repo();
  const r = run(dir, []);
  assert.equal(r.status, 3);
  assert.match(r.stderr, /no external reviewer/);
});

test("exits 1 on missing args", () => {
  const r = spawnSync("bash", [SCRIPT], { encoding: "utf8" });
  assert.equal(r.status, 1);
});
