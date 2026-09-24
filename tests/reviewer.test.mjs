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
    "--title", "t", "--repo", opts.repo ?? dir, "--timeout-min", opts.timeoutMin ?? "1", ...(opts.extraArgs ?? [])];
  const r = spawnSync("bash", args, { cwd: opts.cwd ?? dir, encoding: "utf8", env });
  return { ...r, log: existsSync(log) ? readFileSync(log, "utf8") : "" };
}

function closeSession(dir, file, bins = ["orca"], env = {}) {
  const bin = tmp("bin-");
  for (const b of bins) { copyFileSync(path.join(FIX, b), path.join(bin, b)); chmodSync(path.join(bin, b), 0o755); }
  const log = path.join(dir, "calls.log");
  const r = spawnSync("bash", [SCRIPT, "--close-session", file], {
    cwd: dir, encoding: "utf8",
    env: { PATH: `${bin}:/usr/bin:/bin`, HOME: dir, FAKE_LOG: log, NODE: process.execPath, ...env },
  });
  return { ...r, log: existsSync(log) ? readFileSync(log, "utf8") : "" };
}
const count = (text, re) => (text.match(new RegExp(re, "gm")) ?? []).length;
// What the fake orca writes: every complete report ends with the line reviewer.sh waits for.
const ORCA_REPORT = "orca report\n<!-- end of review -->\n";
// What the fake codex writes by default: a complete report, marker included.
const CODEX_REPORT = "codex report\n<!-- end of review -->\n";

test("prefers Orca when available", () => {
  const dir = repo();
  const r = run(dir, ["orca", "codex"]);
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /reviewer: orca/);
  assert.match(r.log, /terminal create/);
  assert.doesNotMatch(r.log, /^codex/m);
  assert.equal(readFileSync(path.join(dir, "docs/reviews/out.md"), "utf8"), ORCA_REPORT);
  assert.ok(existsSync(path.join(dir, ".context/t-prompt.md")));
  assert.match(readFileSync(path.join(dir, ".git/info/exclude"), "utf8"), /\.context\//);
  assert.match(r.log, /terminal close --terminal term-1/); // no --session-file: closed after the report
});

test("falls back to codex exec without Orca", () => {
  const dir = repo();
  const r = run(dir, ["codex"]);
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /reviewer: codex-exec/);
  assert.match(r.log, /codex exec/);
  assert.equal(readFileSync(path.join(dir, "docs/reviews/out.md"), "utf8"), CODEX_REPORT);
});

test("a codex exec report without the end marker is not accepted", () => {
  const dir = repo();
  const r = run(dir, ["codex"], { env: { FAKE_CODEX_NO_MARKER: "1" } });
  assert.equal(r.status, 3, r.stderr);
  assert.doesNotMatch(r.stdout, /reviewer: codex-exec/);
  assert.match(r.stderr, /codex exec: report incomplete \(end marker missing\); partial report kept at .*\.context\/t-partial\.md/);
  assert.ok(!existsSync(path.join(dir, "docs/reviews/out.md")), "a truncated report must not stay at the output path");
  assert.equal(readFileSync(path.join(dir, ".context/t-partial.md"), "utf8"), "codex report\n");
});

test("a codex exec report with text after the end marker is not accepted", () => {
  const dir = repo();
  const r = run(dir, ["codex"], { env: { FAKE_CODEX_TRAILING: "1" } });
  assert.equal(r.status, 3, r.stderr);
  assert.match(r.stderr, /codex exec: report incomplete \(end marker missing\)/);
  assert.ok(!existsSync(path.join(dir, "docs/reviews/out.md")));
});

test("the Orca terminal is created in the reviewed repository, not the active worktree", () => {
  const dir = repo();
  const r = run(dir, ["orca", "codex"]);
  assert.equal(r.status, 0, r.stderr);
  assert.ok(r.log.includes(`orca terminal create --worktree path:${dir} `), r.log);
  assert.doesNotMatch(r.log, /--worktree active/);
});

test("README says both reviewer paths require the end marker", () => {
  const readme = readFileSync(fileURLToPath(new URL("../README.md", import.meta.url)), "utf8");
  assert.match(readme, /On either path a report counts as finished only once its last non-empty line is `<!-- end of review -->`, which every reviewer prompt requires/);
  assert.match(readme, /The Orca terminal opens in the reviewed repository \(`--worktree path:<repo>`\)/);
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
  assert.equal(readFileSync(path.join(dir, "docs/reviews/out.md"), "utf8"), CODEX_REPORT);
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

test("never writes info/exclude into the worktree when rev-parse fails", () => {
  const dir = repo();
  const r = run(dir, ["codex"], { shims: { git: GIT_SHIM } });
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /reviewer: codex-exec/);
  assert.match(r.stderr, /could not locate info\/exclude/);
  assert.ok(!existsSync(path.join(dir, "info")), "created <repo>/info inside the working tree");
  assert.ok(!existsSync(path.join(dir, "info/exclude")), "created <repo>/info/exclude inside the working tree");
});

// A standalone launcher tree: <root>/scripts/{reviewer.sh,config.mjs} + <root>/config/models.json.
// Values differ from the repo's own config so the assertions can only pass if the file was read.
function cfgTree(codex) {
  const root = tmp("rev-cfg-");
  mkdirSync(path.join(root, "scripts"), { recursive: true });
  mkdirSync(path.join(root, "config"), { recursive: true });
  const script = path.join(root, "scripts/reviewer.sh");
  copyFileSync(SCRIPT, script);
  chmodSync(script, 0o755);
  copyFileSync(fileURLToPath(new URL("../scripts/config.mjs", import.meta.url)), path.join(root, "scripts/config.mjs"));
  const models = JSON.parse(readFileSync(fileURLToPath(new URL("../config/models.json", import.meta.url)), "utf8"));
  models.codex = codex;
  writeFileSync(path.join(root, "config/models.json"), JSON.stringify(models));
  return { root, script };
}
function localConfig(dir, obj) {
  mkdirSync(path.join(dir, ".verus-skills"), { recursive: true });
  writeFileSync(path.join(dir, ".verus-skills/config.json"), typeof obj === "string" ? obj : JSON.stringify(obj));
}

test("under the shipped default, codex exec gets neither -m nor model_reasoning_effort", () => {
  const dir = repo();
  const r = run(dir, ["codex"]);
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.log, /^codex exec /m);
  assert.doesNotMatch(r.log, / -m /);
  assert.doesNotMatch(r.log, /model_reasoning_effort/);
});

test("under the shipped default, the Orca terminal command is plain codex", () => {
  const dir = repo();
  const r = run(dir, ["orca", "codex"]);
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.log, /terminal create .*--command codex --title/);
});

test("env overrides model and effort, each independently", () => {
  const dir = repo();
  let r = run(dir, ["codex"], { env: { REVIEWER_CODEX_MODEL: "gpt-test", REVIEWER_CODEX_REASONING: "low" } });
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.log, /codex exec .*-m gpt-test/);
  assert.match(r.log, /model_reasoning_effort=low/);
  const dir2 = repo();
  r = run(dir2, ["codex"], { env: { REVIEWER_CODEX_REASONING: "low" } });
  assert.doesNotMatch(r.log, / -m /);
  assert.match(r.log, /model_reasoning_effort=low/);
});

test("codex exec and the Orca terminal use config/models.json", () => {
  const { script } = cfgTree({ model: "cfg-model", reasoning: "minimal" });
  let r = run(repo(), ["codex"], { script });
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.log, /codex exec .*-m cfg-model/);
  assert.match(r.log, /model_reasoning_effort=minimal/);
  r = run(repo(), ["orca", "codex"], { script });
  assert.match(r.log, /terminal create .*--command codex -m cfg-model -c model_reasoning_effort=minimal/);
});

test("the Orca command passes a bracketed model to codex literally when a shell runs it", () => {
  // The token grammar allows [ and ]; unquoted, `gpt-test[1m]` is a glob that matches
  // ./gpt-test1 (bash, sh) or aborts with "no matches found" (zsh).
  const dir = repo();
  writeFileSync(path.join(dir, "gpt-test1"), "");
  const cmdFile = path.join(dir, "orca-command.txt");
  const r = run(dir, ["orca", "codex"], {
    env: { REVIEWER_CODEX_MODEL: "gpt-test[1m]", REVIEWER_CODEX_REASONING: "low", FAKE_ORCA_COMMAND_FILE: cmdFile },
  });
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /reviewer: orca/);
  const command = readFileSync(cmdFile, "utf8");
  const bin = tmp("bin-argv-");
  writeFileSync(path.join(bin, "codex"), '#!/bin/sh\nfor a in "$@"; do printf \'%s\\n\' "$a"; done > "$ARGV_FILE"\n');
  chmodSync(path.join(bin, "codex"), 0o755);
  const shells = [["sh", "-c"], ["bash", "-c"]];
  if (existsSync("/bin/zsh")) shells.push(["/bin/zsh", "-f", "-c"]);
  for (const [shell, ...flags] of shells) {
    const argvFile = path.join(dir, `argv-${path.basename(shell)}.txt`);
    const s = spawnSync(shell, [...flags, command], {
      cwd: dir, encoding: "utf8", env: { PATH: `${bin}:/usr/bin:/bin`, HOME: dir, ARGV_FILE: argvFile },
    });
    assert.equal(s.status, 0, `${shell}: ${s.stderr}\ncommand: ${command}`);
    assert.deepEqual(
      readFileSync(argvFile, "utf8").split("\n").slice(0, -1),
      ["-m", "gpt-test[1m]", "-c", "model_reasoning_effort=low"],
      `${shell} ran: ${command}`,
    );
  }
});

test("the local ~/.verus-skills/config.json overrides the repo config", () => {
  const { script } = cfgTree({ model: "cfg-model", reasoning: "minimal" });
  const dir = repo();
  localConfig(dir, { codex: { model: "local-model" } });
  const r = run(dir, ["codex"], { script });
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.log, /codex exec .*-m local-model/);
  assert.match(r.log, /model_reasoning_effort=minimal/);
});

test("finds config.mjs next to itself when launched through a symlink", () => {
  const { script } = cfgTree({ model: "link-model", reasoning: "minimal" });
  const linkDir = tmp("rev-link-");
  const link = path.join(linkDir, "reviewer-link.sh");
  symlinkSync(path.relative(linkDir, script), link); // relative target on purpose
  const r = run(repo(), ["codex"], { script: link });
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.log, /codex exec .*-m link-model/);
});

test("exits 1 when config/models.json is missing and node is available", () => {
  const { root, script } = cfgTree({ model: "x", reasoning: "y" });
  rmSync(path.join(root, "config/models.json"));
  const r = run(repo(), ["codex"], { script });
  assert.equal(r.status, 1);
  assert.match(r.stderr, /config\/models\.json/);
  assert.doesNotMatch(r.log, /codex exec/);
});

test("a broken local config exits 1 without leaking the secret", () => {
  const dir = repo();
  localConfig(dir, '{"typesafe": {"apiKey": ts_DUMMY_SECRET_123}}');
  const r = run(dir, ["codex"]);
  assert.equal(r.status, 1);
  assert.match(r.stderr, /invalid JSON in ~\/\.verus-skills\/config\.json/);
  assert.ok(!r.stderr.includes("ts_DUMMY_SECRET_123") && !r.stdout.includes("ts_DUMMY_SECRET_123"));
});

test("without node the config is ignored: env or default only", () => {
  const { script } = cfgTree({ model: "cfg-model", reasoning: "minimal" });
  const dir = repo();
  localConfig(dir, { codex: { model: "local-model", reasoning: "local-r" } });
  let r = run(dir, ["codex"], { script, env: { NODE: path.join(tmpdir(), "no-such-node-bin") }, shims: { node: NODE_SHIM } });
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stderr, /node not found; Orca path disabled, config ignored \(env or default only\)/);
  assert.doesNotMatch(r.log, /cfg-model|local-model|minimal|local-r/);
  assert.doesNotMatch(r.log, / -m |model_reasoning_effort/);
  const dir2 = repo();
  r = run(dir2, ["codex"], { script, env: { NODE: path.join(tmpdir(), "no-such-node-bin"), REVIEWER_CODEX_MODEL: "gpt-envonly" }, shims: { node: NODE_SHIM } });
  assert.match(r.log, /codex exec .*-m gpt-envonly/);
  assert.doesNotMatch(r.log, /model_reasoning_effort/);
});

test("a Codex value that is not a single token stops the run before any reviewer starts, with or without node", () => {
  for (const bad of ["gpt-x -c evil=1", "gpt-test\n", "gpt-test\r", "gpt-test\r\n"]) {
  const dir = repo();
  const r = run(dir, ["orca", "codex"], { env: { REVIEWER_CODEX_MODEL: bad } });
  assert.equal(r.status, 1);
  assert.match(r.stderr, /config: REVIEWER_CODEX_MODEL must be a single token/);
  assert.doesNotMatch(r.stderr, /evil/);
  assert.doesNotMatch(r.log, /codex exec|terminal create/);
  const dir2 = repo();
  const r2 = run(dir2, ["orca", "codex"], {
    env: { REVIEWER_CODEX_MODEL: bad, NODE: path.join(tmpdir(), "no-such-node-bin") },
    shims: { node: NODE_SHIM },
  });
  assert.equal(r2.status, 1);
  assert.match(r2.stderr, /config: REVIEWER_CODEX_MODEL must be a single token/);
  assert.doesNotMatch(r2.stderr, /evil/);
  assert.doesNotMatch(r2.log, /codex exec|terminal create/);
  }
});

// --- the Orca path against a real Codex TUI ------------------------------------

test("answers the Codex directory-trust prompt and stays on the Orca path", () => {
  const dir = repo();
  const r = run(dir, ["orca", "codex"], { env: { FAKE_ORCA_TRUST_PROMPT: "1" } });
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /reviewer: orca/);
  assert.match(r.log, /terminal read/);
  assert.match(r.log, /terminal send .*--text 1 --enter/);
  assert.equal(readFileSync(path.join(dir, "docs/reviews/out.md"), "utf8"), ORCA_REPORT);
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
  assert.equal(readFileSync(path.join(dir, "docs/reviews/out.md"), "utf8"), ORCA_REPORT);
});

test("closes the terminal it created when no report ever appears", () => {
  const dir = repo();
  const r = run(dir, ["orca", "codex"], { env: { FAKE_ORCA_REPORT_DELAY: "999" } });
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /reviewer: codex-exec/);
  assert.match(r.stderr, /orca: no report produced/);
  assert.match(r.log, /terminal close --terminal term-1/);
});

test("reuses the terminal named by --session-file", () => {
  const dir = repo();
  const session = path.join(dir, ".context/review-x-session");
  mkdirSync(path.dirname(session), { recursive: true });
  writeFileSync(session, "term-1\n");
  const r = run(dir, ["orca", "codex"], { extraArgs: ["--session-file", session] });
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /reviewer: orca/);
  assert.doesNotMatch(r.log, /terminal create/);
  assert.doesNotMatch(r.log, /terminal close/);
  assert.equal(readFileSync(session, "utf8").trim(), "term-1");
});

// On fallback the Orca reviewer this review owns must stop before codex exec writes the same report.
function assertClosedBeforeExec(log) {
  const lines = log.split("\n");
  const close = lines.findIndex((l) => l.startsWith("orca terminal close --terminal term-1"));
  const exec = lines.findIndex((l) => l.startsWith("codex exec"));
  assert.ok(close >= 0, `the terminal was never closed:\n${log}`);
  assert.ok(exec > close, `codex exec started before the terminal was closed:\n${log}`);
}

test("a terminal loaded from --session-file is closed, and the session file removed, on fallback", () => {
  const dir = repo();
  const session = path.join(dir, ".context/review-x-session");
  mkdirSync(path.dirname(session), { recursive: true });
  writeFileSync(session, "term-1\n");
  const r = run(dir, ["orca", "codex"], { env: { FAKE_ORCA_STUCK_PROMPT: "1" }, extraArgs: ["--session-file", session] });
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /reviewer: codex-exec/);
  assert.doesNotMatch(r.log, /terminal create/);
  assertClosedBeforeExec(r.log);
  assert.equal(count(r.log, "terminal close"), 1);
  assert.ok(!existsSync(session), "the session file still names a closed terminal");
});

test("a session-loaded reviewer that has not finished by the deadline is closed before codex exec takes over", () => {
  // ~60 s: the delayed writer misses the Orca budget (--timeout-min 1).
  const dir = repo();
  const session = path.join(dir, ".context/review-x-session");
  mkdirSync(path.dirname(session), { recursive: true });
  writeFileSync(session, "term-1\n");
  const r = run(dir, ["orca", "codex"], { env: { FAKE_ORCA_REPORT_DELAY: "999" }, extraArgs: ["--session-file", session] });
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /reviewer: codex-exec/);
  assert.match(r.stderr, /orca: no report produced/);
  assert.doesNotMatch(r.log, /terminal create/);
  assertClosedBeforeExec(r.log);
  assert.ok(!existsSync(session), "the session file still names a closed terminal");
  assert.equal(readFileSync(path.join(dir, "docs/reviews/out.md"), "utf8"), CODEX_REPORT);
});

test("a terminal created for --session-file is closed, and no handle recorded, on fallback", () => {
  const dir = repo();
  const session = path.join(dir, ".context/review-x-session");
  const r = run(dir, ["orca", "codex"], { env: { FAKE_ORCA_STUCK_PROMPT: "1" }, extraArgs: ["--session-file", session] });
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /reviewer: codex-exec/);
  assert.match(r.log, /terminal create/);
  assertClosedBeforeExec(r.log);
  assert.ok(!existsSync(session));
});

test("without --session-file every run creates a terminal, closes it after the report, and ignores the old default file", () => {
  const dir = repo();
  mkdirSync(path.join(dir, ".context"), { recursive: true });
  writeFileSync(path.join(dir, ".context/t-session"), "stale-handle\n");
  assert.equal(run(dir, ["orca", "codex"]).status, 0);
  const r = run(dir, ["orca", "codex"]);
  assert.equal(r.status, 0, r.stderr);
  assert.equal(count(r.log, "terminal create"), 2);
  assert.equal(count(r.log, "terminal close --terminal term-1"), 2);
  assert.doesNotMatch(r.log, /stale-handle/);
  assert.equal(readFileSync(path.join(dir, ".context/t-session"), "utf8").trim(), "stale-handle");
});

test("with --session-file a successful run keeps the terminal and records its handle", () => {
  const dir = repo();
  const session = path.join(dir, ".context/review-x-session");
  const r = run(dir, ["orca", "codex"], { extraArgs: ["--session-file", session] });
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.log, /terminal create/);
  assert.doesNotMatch(r.log, /terminal close/);
  assert.equal(readFileSync(session, "utf8").trim(), "term-1");
});

test("round 2 with the same --session-file reuses round 1's terminal", () => {
  const dir = repo();
  const session = path.join(dir, ".context/review-x-session");
  run(dir, ["orca", "codex"], { extraArgs: ["--session-file", session] });
  const r = run(dir, ["orca", "codex"], { extraArgs: ["--session-file", session] });
  assert.equal(r.status, 0, r.stderr);
  assert.equal(count(r.log, "terminal create"), 1);
});

test("a restarted review closes the orphan terminal first, then starts fresh with the new settings", () => {
  const dir = repo();
  const session = path.join(dir, ".context/plan-review-p-session");
  run(dir, ["orca", "codex"], { extraArgs: ["--session-file", session] }); // interrupted review: file + terminal left behind
  const c = closeSession(dir, session);
  assert.equal(c.status, 0, c.stderr);
  assert.match(c.log, /terminal close --terminal term-1/);
  assert.ok(!existsSync(session));
  const r = run(dir, ["orca", "codex"], { env: { REVIEWER_CODEX_MODEL: "gpt-new" }, extraArgs: ["--session-file", session] });
  assert.equal(r.status, 0, r.stderr);
  assert.equal(count(r.log, "terminal create"), 2);
  assert.match(r.log, /terminal create .*--command codex -m gpt-new/);
  assert.equal(readFileSync(session, "utf8").trim(), "term-1");
});

test("a later run without --session-file picks up changed settings", () => {
  const dir = repo();
  run(dir, ["orca", "codex"], { env: { REVIEWER_CODEX_MODEL: "gpt-old" } });
  const r = run(dir, ["orca", "codex"]);
  assert.match(r.log, /terminal create .*--command codex -m gpt-old/);
  assert.match(r.log, /terminal create .*--command codex --title/);
});

test("--close-session closes exactly the terminal in the file and removes the file", () => {
  const dir = repo();
  const session = path.join(dir, "s");
  writeFileSync(session, "term-9\n");
  const r = closeSession(dir, session);
  assert.equal(r.status, 0, r.stderr);
  assert.equal(count(r.log, "terminal close"), 1);
  assert.match(r.log, /terminal close --terminal term-9 --json/);
  assert.ok(!existsSync(session));
});

// A reviewer terminal that could not be closed may still be writing the report: no fallback.
test("a session-loaded terminal that cannot be closed stops the run: exit 1, no codex exec, session kept", () => {
  // ~60 s: the markerless report keeps the run on Orca for the whole budget (--timeout-min 1).
  const dir = repo();
  const session = path.join(dir, ".context/review-x-session");
  mkdirSync(path.dirname(session), { recursive: true });
  writeFileSync(session, "term-1\n");
  const r = run(dir, ["orca", "codex"], {
    env: { FAKE_ORCA_NO_MARKER: "1", FAKE_ORCA_CLOSE_FAIL: "1" }, extraArgs: ["--session-file", session],
  });
  assert.equal(r.status, 1, r.stderr);
  assert.match(r.stderr, /^orca: could not close reviewer terminal term-1; not falling back$/m);
  assert.doesNotMatch(r.log, /terminal create/);
  assert.match(r.log, /terminal close --terminal term-1/);
  assert.doesNotMatch(r.log, /^codex exec/m);
  assert.doesNotMatch(r.stdout, /reviewer:/);
  assert.ok(existsSync(session), "the session file was removed, so --close-session can no longer reach the terminal");
  assert.equal(readFileSync(session, "utf8").trim(), "term-1");
});

test("a created terminal that cannot be closed stops the run: exit 1, no codex exec", () => {
  // ~60 s: the markerless report keeps the run on Orca for the whole budget (--timeout-min 1).
  const dir = repo();
  const r = run(dir, ["orca", "codex"], { env: { FAKE_ORCA_NO_MARKER: "1", FAKE_ORCA_CLOSE_FAIL: "1" } });
  assert.equal(r.status, 1, r.stderr);
  assert.match(r.stderr, /^orca: could not close reviewer terminal term-1; not falling back$/m);
  assert.match(r.log, /terminal create/);
  assert.match(r.log, /terminal close --terminal term-1/);
  assert.doesNotMatch(r.log, /^codex exec/m);
  assert.doesNotMatch(r.stdout, /reviewer:/);
});

test("--close-session on a missing file, or without orca, exits 0", () => {
  const dir = repo();
  const r = closeSession(dir, path.join(dir, "absent"));
  assert.equal(r.status, 0, r.stderr);
  assert.doesNotMatch(r.log, /terminal close/);
  const session = path.join(dir, "s2");
  writeFileSync(session, "term-2\n");
  const r2 = closeSession(dir, session, []);
  assert.equal(r2.status, 0, r2.stderr);
  assert.ok(!existsSync(session));
});

test("--close-session exits 0 and removes the file when the terminal is already gone", () => {
  const dir = repo();
  const session = path.join(dir, "s3");
  writeFileSync(session, "term-dead\n");
  const r = closeSession(dir, session, ["orca"], { FAKE_ORCA_CLOSE_FAIL: "1" });
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.log, /terminal close --terminal term-dead --json/);
  assert.ok(!existsSync(session));
});

test("a report written in chunks is accepted, and its terminal closed, only after the end marker", () => {
  // Chunk 1 has no marker; chunk 2 lands 7 s later, after one 5 s poll saw an unchanged size.
  const dir = repo();
  const r = run(dir, ["orca", "codex"], { env: { FAKE_ORCA_REPORT_CHUNKS: "1" } });
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /reviewer: orca/);
  assert.equal(readFileSync(path.join(dir, "docs/reviews/out.md"), "utf8"), "orca report, part 1\npart 2\n<!-- end of review -->\n");
  const lines = r.log.split("\n");
  const chunk2 = lines.indexOf("report chunk 2 written");
  const close = lines.findIndex((l) => l.startsWith("orca terminal close --terminal term-1"));
  assert.ok(chunk2 >= 0 && close > chunk2, `the terminal was closed before the report was complete:\n${r.log}`);
  assert.doesNotMatch(r.log, /^codex/m);
});

test("an Orca report without the end marker is never accepted: the run falls back to codex exec", () => {
  // ~60 s: the Orca budget (--timeout-min 1) runs out before the fallback.
  const dir = repo();
  const r = run(dir, ["orca", "codex"], { env: { FAKE_ORCA_NO_MARKER: "1", FAKE_CODEX_NO_REPORT: "1" } });
  assert.equal(r.status, 3);
  assert.match(r.stderr, /orca: no report produced \(end marker missing\), falling back/);
  const lines = r.log.split("\n");
  const close = lines.findIndex((l) => l.startsWith("orca terminal close --terminal term-1"));
  const exec = lines.findIndex((l) => l.startsWith("codex exec"));
  assert.ok(close >= 0 && exec > close, r.log);
  assert.ok(!existsSync(path.join(dir, "docs/reviews/out.md")), "the unfinished Orca report must not pass as the codex result");
});

test("every reviewer prompt ends the report with the marker reviewer.sh waits for", () => {
  assert.match(readFileSync(SCRIPT, "utf8"), /^END_MARKER='<!-- end of review -->'$/m);
  for (const skill of ["plan-review", "review", "spec-review"]) {
    const body = readFileSync(fileURLToPath(new URL(`../skills/${skill}/reviewer.md`, import.meta.url)), "utf8");
    assert.match(body, /End the report with this exact last line: `<!-- end of review -->`/, skill);
    assert.match(body, /\n<!-- end of review -->\n```\n/, `${skill}: the report template ends with the marker`);
  }
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
