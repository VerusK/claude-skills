import { test, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, readFileSync, existsSync, mkdirSync, copyFileSync, chmodSync, symlinkSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync, execFileSync } from "node:child_process";

const SCRIPT = fileURLToPath(new URL("../scripts/reviewer.sh", import.meta.url));
const FIX = fileURLToPath(new URL("./fixtures/fake-bin/", import.meta.url));

const TEMP_DIRS = [];
function tmp(prefix) {
  const d = mkdtempSync(path.join(tmpdir(), prefix));
  TEMP_DIRS.push(d);
  return d;
}
after(() => {
  for (const d of TEMP_DIRS) rmSync(d, { recursive: true, force: true });
});

function repo() {
  const dir = tmp("rev-");
  execFileSync("git", ["init", "-q"], { cwd: dir });
  return dir;
}

function run(dir, bins, opts = {}) {
  const bin = tmp("bin-");
  for (const b of bins) { copyFileSync(path.join(FIX, b), path.join(bin, b)); chmodSync(path.join(bin, b), 0o755); }
  // opts.shims: { name: "<script body>" } — throwaway executables written into the temp bin dir.
  for (const [name, body] of Object.entries(opts.shims ?? {})) {
    writeFileSync(path.join(bin, name), body);
    chmodSync(path.join(bin, name), 0o755);
  }
  const log = path.join(dir, "calls.log");
  const prompt = path.join(dir, "prompt.md");
  writeFileSync(prompt, "Review this.\nWrite the report to docs/reviews/out.md\n");
  const env = { PATH: `${bin}:/usr/bin:/bin`, HOME: dir, FAKE_LOG: log, NODE: process.execPath, ...(opts.env ?? {}) };
  for (const k of Object.keys(env)) if (env[k] === undefined) delete env[k];
  // opts.script: run a copy of the launcher from elsewhere (e.g. a tree with no config/).
  const args = [opts.script ?? SCRIPT, "--prompt-file", prompt, "--output", opts.output ?? "docs/reviews/out.md",
    "--title", "t", "--repo", opts.repo ?? dir, "--timeout-min", opts.timeoutMin ?? "1"];
  const r = spawnSync("bash", args, { cwd: opts.cwd ?? dir, encoding: "utf8", env });
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
  const dir = tmp("rev-noargs-");
  const r = spawnSync("bash", [SCRIPT], {
    cwd: dir, encoding: "utf8",
    env: { PATH: "/usr/bin:/bin", HOME: dir, NODE: process.execPath },
  });
  assert.equal(r.status, 1);
  assert.match(r.stderr, /usage: reviewer\.sh/);
});

test("codex report mentioning auth still succeeds", () => {
  const dir = repo();
  const r = run(dir, ["codex"], { env: { FAKE_CODEX_STDOUT: "the authentication handler returns 401 on expired tokens" } });
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /reviewer: codex-exec/);
  assert.doesNotMatch(r.stderr, /codex exec failed/);
  assert.equal(readFileSync(path.join(dir, "docs/reviews/out.md"), "utf8").trim(), "codex report");
});

test("a codex failure reports the log tail verbatim, not a guessed cause", () => {
  const dir = repo();
  const r = run(dir, ["codex"], { env: { FAKE_CODEX_STDOUT: "stream error: 401 Unauthorized", FAKE_CODEX_NO_REPORT: "1" } });
  assert.equal(r.status, 3);
  assert.match(r.stderr, /codex exec failed: stream error: 401 Unauthorized \(full log: .*t-codex\.log\)/);
  assert.doesNotMatch(r.stderr, /authentication failed/);
});

test("a codex usage-limit failure is reported verbatim", () => {
  const dir = repo();
  const msg = "ERROR: You've hit your usage limit. Visit https://example.test/usage to purchase more credits.";
  const r = run(dir, ["codex"], { env: { FAKE_CODEX_STDOUT: `run 'codex login' first\n${msg}`, FAKE_CODEX_NO_REPORT: "1" } });
  assert.equal(r.status, 3);
  assert.match(r.stderr, /codex exec failed: ERROR: You've hit your usage limit\./);
  assert.doesNotMatch(r.stderr, /authentication failed/);
});

test("excludes .context in a linked worktree", () => {
  const main = repo();
  execFileSync("git", ["-c", "user.email=t@t", "-c", "user.name=t", "commit", "-q", "--allow-empty", "-m", "init"], { cwd: main });
  const wt = path.join(tmp("revwt-"), "wt");
  execFileSync("git", ["worktree", "add", "-q", wt, "-b", "wt-branch"], { cwd: main });
  const r = run(main, ["codex"], { repo: wt, cwd: wt });
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /reviewer: codex-exec/);
  const ci = spawnSync("git", ["-C", wt, "check-ignore", "-q", ".context"], { encoding: "utf8" });
  assert.equal(ci.status, 0, "`.context` is not ignored inside the linked worktree");
  const st = spawnSync("git", ["-C", wt, "status", "--porcelain"], { encoding: "utf8" });
  assert.doesNotMatch(st.stdout, /\.context/);
});

test("rejects an absolute --output", () => {
  const dir = repo();
  const r = run(dir, ["codex"], { output: path.join(dir, "docs/reviews/out.md") });
  assert.equal(r.status, 1);
  assert.match(r.stderr, /--output must be repo-relative/);
});

// A `node` on PATH that really works: the node-preflight test must not depend on
// the ambient PATH happening to lack node.
const NODE_SHIM = `#!/bin/bash\nexec ${process.execPath} "$@"\n`;
// A `git` on PATH whose every `rev-parse` fails; everything else is the real git.
const GIT_SHIM = `#!/bin/bash\nfor a in "$@"; do [ "$a" = "rev-parse" ] && exit 128; done\nexec /usr/bin/git "$@"\n`;

test("skips Orca when node is unavailable", () => {
  const dir = repo();
  const r = run(dir, ["orca", "codex"], {
    env: { NODE: path.join(tmpdir(), "no-such-node-bin") },
    shims: { node: NODE_SHIM },
  });
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stderr, /node not found/);
  assert.match(r.stdout, /reviewer: codex-exec/);
  assert.doesNotMatch(r.log, /terminal create/);
});

test("falls back to codex when Orca is unreachable", () => {
  const dir = repo();
  const r = run(dir, ["orca", "codex"], { env: { FAKE_ORCA_REACHABLE: "false" } });
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /reviewer: codex-exec/);
  assert.match(r.log, /orca status/);
  assert.doesNotMatch(r.log, /terminal create/);
});

test("reuses an existing Orca session", () => {
  const dir = repo();
  mkdirSync(path.join(dir, ".context"), { recursive: true });
  writeFileSync(path.join(dir, ".context/t-session"), "term-1\n");
  const r = run(dir, ["orca", "codex"]);
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /reviewer: orca/);
  assert.match(r.log, /terminal show/);
  assert.doesNotMatch(r.log, /terminal create/);
  assert.equal(readFileSync(path.join(dir, ".context/t-session"), "utf8").trim(), "term-1");
});

test("never writes info/exclude into the worktree when rev-parse fails", () => {
  const dir = repo();
  const r = run(dir, ["codex"], { shims: { git: GIT_SHIM } });
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /reviewer: codex-exec/);
  assert.match(r.stderr, /could not locate info\/exclude/);
  assert.ok(!existsSync(path.join(dir, "info")), "created <repo>/info inside the working tree");
  assert.ok(!existsSync(path.join(dir, "info/exclude")), "created <repo>/info/exclude inside the working tree");
});

test("config/reviewer.json holds a non-empty model and reasoning effort", () => {
  const cfgPath = fileURLToPath(new URL("../config/reviewer.json", import.meta.url));
  const cfg = JSON.parse(readFileSync(cfgPath, "utf8"));
  for (const k of ["codexModel", "codexReasoning"]) {
    assert.equal(typeof cfg[k], "string", `${k} must be a string`);
    assert.ok(cfg[k].trim().length > 0, `${k} must not be empty`);
  }
});

test("codex exec is pinned to the configured model and reasoning effort", () => {
  const dir = repo();
  const r = run(dir, ["codex"]);
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.log, /codex exec .*-m gpt-6-astra/);
  assert.match(r.log, /model_reasoning_effort=high/);
});

test("the Orca codex terminal is pinned to the configured model and reasoning effort", () => {
  const dir = repo();
  const r = run(dir, ["orca", "codex"]);
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.log, /terminal create .*--command codex -m gpt-6-astra -c model_reasoning_effort=high/);
});

test("env overrides the configured model and reasoning effort", () => {
  const dir = repo();
  const r = run(dir, ["codex"], {
    env: { REVIEWER_CODEX_MODEL: "gpt-test", REVIEWER_CODEX_REASONING: "low" },
  });
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.log, /codex exec .*-m gpt-test/);
  assert.match(r.log, /model_reasoning_effort=low/);
  assert.doesNotMatch(r.log, /gpt-6-astra/);
});

test("falls back to the built-in defaults when config/reviewer.json is missing", () => {
  const dir = repo();
  const lone = tmp("rev-nocfg-");
  mkdirSync(path.join(lone, "scripts"), { recursive: true });
  const script = path.join(lone, "scripts/reviewer.sh");
  copyFileSync(SCRIPT, script);
  chmodSync(script, 0o755);
  assert.ok(!existsSync(path.join(lone, "config/reviewer.json")));
  const r = run(dir, ["codex"], { script });
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.log, /codex exec .*-m gpt-6-astra/);
  assert.match(r.log, /model_reasoning_effort=high/);
});

// A standalone launcher tree: <root>/scripts/reviewer.sh + <root>/config/reviewer.json.
// Values differ from the repo's own config so the assertions below can only pass
// if the file was actually read (and not the hard-coded defaults).
function cfgTree(cfg) {
  const root = tmp("rev-cfg-");
  mkdirSync(path.join(root, "scripts"), { recursive: true });
  mkdirSync(path.join(root, "config"), { recursive: true });
  const script = path.join(root, "scripts/reviewer.sh");
  copyFileSync(SCRIPT, script);
  chmodSync(script, 0o755);
  writeFileSync(path.join(root, "config/reviewer.json"), JSON.stringify(cfg));
  return { root, script };
}

test("codex exec uses the model and reasoning effort from config/reviewer.json", () => {
  const dir = repo();
  const { script } = cfgTree({ codexModel: "cfg-model", codexReasoning: "minimal" });
  const r = run(dir, ["codex"], { script });
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.log, /codex exec .*-m cfg-model/);
  assert.match(r.log, /model_reasoning_effort=minimal/);
  assert.doesNotMatch(r.log, /gpt-6-astra/);
});

test("the Orca terminal uses the model and reasoning effort from config/reviewer.json", () => {
  const dir = repo();
  const { script } = cfgTree({ codexModel: "cfg-model", codexReasoning: "minimal" });
  const r = run(dir, ["orca", "codex"], { script });
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.log, /terminal create .*--command codex -m cfg-model -c model_reasoning_effort=minimal/);
  assert.doesNotMatch(r.log, /gpt-6-astra/);
});

test("finds config/reviewer.json when launched through a symlink", () => {
  const dir = repo();
  const { script } = cfgTree({ codexModel: "link-model", codexReasoning: "minimal" });
  const linkDir = tmp("rev-link-");
  const link = path.join(linkDir, "reviewer-link.sh");
  symlinkSync(path.relative(linkDir, script), link); // relative target on purpose
  const r = run(dir, ["codex"], { script: link });
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.log, /codex exec .*-m link-model/);
  assert.match(r.log, /model_reasoning_effort=minimal/);
});

test("codex exec stays pinned when node is unavailable", () => {
  const dir = repo();
  const r = run(dir, ["codex"], {
    env: { NODE: path.join(tmpdir(), "no-such-node-bin"), REVIEWER_CODEX_MODEL: "gpt-envonly" },
    shims: { node: NODE_SHIM },
  });
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stderr, /node not found/);
  assert.match(r.log, /codex exec .*-m gpt-envonly/);
  assert.match(r.log, /model_reasoning_effort=high/);
});

// --- the Orca path against a real Codex TUI ------------------------------------

test("answers the Codex directory-trust prompt and stays on the Orca path", () => {
  const dir = repo();
  const r = run(dir, ["orca", "codex"], { env: { FAKE_ORCA_TRUST_PROMPT: "1" } });
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /reviewer: orca/);
  assert.match(r.log, /terminal read/);
  assert.match(r.log, /terminal send .*--text 1 --enter/);
  assert.equal(readFileSync(path.join(dir, "docs/reviews/out.md"), "utf8").trim(), "orca report");
});

test("abandons Orca and closes the terminal when the TUI stays on a prompt", () => {
  const dir = repo();
  const r = run(dir, ["orca", "codex"], { env: { FAKE_ORCA_STUCK_PROMPT: "1" } });
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /reviewer: codex-exec/);
  assert.match(r.stderr, /interactive prompt/);
  assert.match(r.log, /terminal close --terminal term-1/);
});

test("waits the full budget for a report that arrives late", () => {
  const dir = repo();
  const started = Date.now();
  const r = run(dir, ["orca", "codex"], { env: { FAKE_ORCA_REPORT_DELAY: "8" } });
  const elapsed = (Date.now() - started) / 1000;
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /reviewer: orca/);
  assert.ok(elapsed >= 8, `gave up after ${elapsed}s, before the report existed`);
  assert.equal(readFileSync(path.join(dir, "docs/reviews/out.md"), "utf8").trim(), "orca report");
});

test("closes the terminal it created when no report ever appears", () => {
  const dir = repo();
  const r = run(dir, ["orca", "codex"], { env: { FAKE_ORCA_REPORT_DELAY: "999" } });
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /reviewer: codex-exec/);
  assert.match(r.stderr, /orca: no report produced/);
  assert.match(r.log, /terminal close --terminal term-1/);
});

test("a reused Orca session terminal is never closed", () => {
  const dir = repo();
  mkdirSync(path.join(dir, ".context"), { recursive: true });
  writeFileSync(path.join(dir, ".context/t-session"), "term-1\n");
  const r = run(dir, ["orca", "codex"], { env: { FAKE_ORCA_STUCK_PROMPT: "1" } });
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /reviewer: codex-exec/);
  assert.doesNotMatch(r.log, /terminal close/);
});

test("rejects a --timeout-min that is not a positive integer", () => {
  for (const bad of ["0", "-1", "abc", "1.5"]) {
    const dir = repo();
    const r = run(dir, ["codex"], { timeoutMin: bad });
    assert.equal(r.status, 1, `expected exit 1 for --timeout-min ${bad}`);
    assert.match(r.stderr, /usage: reviewer\.sh/);
  }
});

test("leaves info/exclude alone when .context is already git-ignored", () => {
  const dir = repo();
  writeFileSync(path.join(dir, ".gitignore"), ".context/\n");
  const r = run(dir, ["codex"]);
  assert.equal(r.status, 0, r.stderr);
  const excl = path.join(dir, ".git/info/exclude");
  if (existsSync(excl)) assert.doesNotMatch(readFileSync(excl, "utf8"), /\.context\//);
});

test("rejects an option with no value", () => {
  const dir = tmp("rev-noval-");
  const r = spawnSync("bash", [SCRIPT, "--prompt-file"], {
    cwd: dir, encoding: "utf8",
    env: { PATH: "/usr/bin:/bin", HOME: dir, NODE: process.execPath },
  });
  assert.equal(r.status, 1);
  assert.match(r.stderr, /missing value for --prompt-file/);
});
