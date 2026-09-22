import { test, after } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { cpSync, mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { vendoredSdkUrl, REPO_ROOT } from "../scripts/typesafe-judge.mjs";
import { lockedEntry, integrityOf, assertIntegrity } from "../scripts/vendor-sdk.mjs";

const TEMP_DIRS = [];
function tmp(prefix) {
  const d = realpathSync(mkdtempSync(path.join(tmpdir(), prefix)));
  TEMP_DIRS.push(d);
  return d;
}
after(() => {
  for (const d of TEMP_DIRS) rmSync(d, { recursive: true, force: true });
});

const SDK_DIR = path.join(REPO_ROOT, "vendor-node", "@typesafe-ai", "sdk");

test("the SDK is vendored at the version package-lock.json resolves", () => {
  assert.ok(existsSync(SDK_DIR), "vendor-node/@typesafe-ai/sdk is missing — run `npm run vendor-sdk`");
  const vendored = JSON.parse(readFileSync(path.join(SDK_DIR, "package.json"), "utf8"));
  const lock = JSON.parse(readFileSync(path.join(REPO_ROOT, "package-lock.json"), "utf8"));
  const locked = lock.packages["node_modules/@typesafe-ai/sdk"].version;
  assert.equal(vendored.version, locked);
  assert.equal(vendored.name, "@typesafe-ai/sdk");
});

test("vendoredSdkUrl points at an ESM entry that exists", () => {
  const url = vendoredSdkUrl();
  assert.match(url, /^file:\/\//);
  assert.ok(existsSync(fileURLToPath(url)), `${url} does not exist`);
});

test("the vendored copy really exports TypeSafeClient and choice", async () => {
  const mod = await import(vendoredSdkUrl());
  assert.equal(typeof mod.TypeSafeClient, "function");
  assert.equal(typeof mod.choice, "function");
});

test("loadSdk resolves the vendored copy when node_modules is absent", () => {
  // The plugin cache is exactly this: our files, no node_modules. Calling
  // loadSdk() directly is the only way to reach the fallback — running the judge
  // would exit at its TYPESAFE_API_KEY guard before the import, and a dummy key
  // would drive a live API call.
  const root = tmp("no-node-modules-");
  mkdirSync(path.join(root, "scripts"), { recursive: true });
  cpSync(path.join(REPO_ROOT, "scripts", "typesafe-judge.mjs"), path.join(root, "scripts", "typesafe-judge.mjs"));
  cpSync(path.join(REPO_ROOT, "vendor-node"), path.join(root, "vendor-node"), { recursive: true });
  const judge = pathToFileURL(path.join(root, "scripts", "typesafe-judge.mjs")).href;
  const res = spawnSync(
    process.execPath,
    ["-e", `import(${JSON.stringify(judge)}).then((m) => m.loadSdk()).then((s) => console.log(typeof s.TypeSafeClient))`],
    { encoding: "utf8", cwd: root },
  );
  assert.equal(res.status, 0, res.stderr);
  assert.equal(res.stdout.trim(), "function");
});

test("lockedEntry reports the pinned version and integrity, and refuses a lock without them", () => {
  const entry = lockedEntry(REPO_ROOT);
  assert.match(entry.version, /^\d+\.\d+\.\d+$/);
  assert.match(entry.integrity, /^sha\d+-/);
  const bare = tmp("bare-lock-");
  writeFileSync(path.join(bare, "package-lock.json"), JSON.stringify({ packages: {} }));
  assert.throws(() => lockedEntry(bare), /not resolved in package-lock\.json/);
});

test("assertIntegrity accepts a matching hash and rejects tampered bytes", () => {
  const bytes = Buffer.from("tarball");
  const good = integrityOf(bytes);
  assert.equal(assertIntegrity(bytes, good), good);
  assert.throws(() => assertIntegrity(Buffer.from("tampered"), good), /integrity mismatch/);
});

test("vendoredSdkUrl throws a named error when the vendored ESM entry is gone", () => {
  const root = tmp("broken-sdk-");
  const dir = path.join(root, "vendor-node", "@typesafe-ai", "sdk");
  mkdirSync(dir, { recursive: true });
  writeFileSync(path.join(dir, "package.json"), JSON.stringify({ name: "@typesafe-ai/sdk", version: "0.6.0" }));
  assert.throws(() => vendoredSdkUrl(root), /no ESM entry/);
});

test("the judge exits 2 with a judge failed: line when no SDK can be loaded at all", () => {
  // scripts/ and config/ copied, vendor-node/ deliberately absent. The key must be
  // non-empty: main() exits at its TYPESAFE_API_KEY guard with a different message
  // before it ever reaches loadSdk(). loadSdk then throws ENOENT, offline.
  const root = tmp("broken-root-");
  mkdirSync(path.join(root, "scripts"), { recursive: true });
  mkdirSync(path.join(root, "config"), { recursive: true });
  cpSync(path.join(REPO_ROOT, "scripts", "typesafe-judge.mjs"), path.join(root, "scripts", "typesafe-judge.mjs"));
  writeFileSync(path.join(root, "config", "judge.json"), JSON.stringify({ threshold: 0.7 }));
  const res = spawnSync(process.execPath, [path.join(root, "scripts", "typesafe-judge.mjs")], {
    encoding: "utf8",
    input: JSON.stringify({
      question: "q",
      options: [{ id: "A", label: "a" }, { id: "B", label: "b" }],
      context: "c",
      recommended: "A",
    }),
    env: { ...process.env, TYPESAFE_API_KEY: "dummy" },
  });
  assert.equal(res.status, 2);
  assert.match(res.stderr, /judge failed:/);
});
