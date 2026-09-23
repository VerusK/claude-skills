# Configurable Models, Effort and TypeSafe Key Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use `subagent-driven-development` (`verus-skills:subagent-driven-development` when installed as a plugin) to implement this plan task-by-task; the plan must have passed plan-review before execution. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** One edit switches the model or effort of every layer (Claude subagents, the Codex reviewer, the TypeSafe judge), and the TypeSafe key lives in one local file — plus two side fixes to how reviews hand findings to the judge.

**Architecture:** `config/models.json` (committed) and `~/.verus-skills/config.json` (local, holds the key) are loaded and merged by one module, `scripts/config.mjs`, whose errors never echo a value. Claude subagents run as three plugin agent types (`verus-worker`, `verus-reviewer`, `verus-explorer`) whose frontmatter `make models` generates from the config; every dispatch site names the agent type for Claude Code and `spawn_agent` for Codex, unnamed and in the background. `reviewer.sh` reads the Codex model through `config.mjs`, keeps one Orca terminal per review, and gains `--close-session`.

**Tech Stack:** Node 20+ ESM, bash, `node --test` with `node:assert/strict`, Claude Code plugin agent definitions (markdown + YAML frontmatter).

**Spec:** `docs/specs/2026-09-23-configurable-models-design.md`

## Global Constraints

- Node `>=20`, ESM only.
- Tier keys in `config/models.json`: `worker`, `reviewer`, `explorer`. Agent ids: `verus-worker`, `verus-reviewer`, `verus-explorer` (files `agents/verus-<tier>.md`, frontmatter `name: verus-<tier>`). Plugin form: `verus-skills:verus-<tier>`.
- Allowed effort values: `low|medium|high|xhigh|max`.
- Shipped defaults: worker `opus`/`high`, reviewer `opus`/`xhigh`, explorer `opus`/`medium`; codex `default`/`default`; judge `jev-latest`.
- Local file: `~/.verus-skills/config.json`, all fields optional: `typesafe.apiKey`, `codex.model`, `codex.reasoning`, `judge.model`. Group- or world-readable (`mode & 0o077`) with a key → warning on stderr, not an error.
- Precedence: Codex model `REVIEWER_CODEX_MODEL` > local `codex.model` > repo `codex.model` > `default`; Codex effort `REVIEWER_CODEX_REASONING` > local `codex.reasoning` > repo `codex.reasoning` > `default`; judge model `TYPESAFE_DEFAULT_MODEL` > local `judge.model` > repo `judge.model` > `jev-latest`; key `TYPESAFE_API_KEY` > local `typesafe.apiKey`.
- Codex `default` means the flag (`-m` or `-c model_reasoning_effort=…`) is not passed at all.
- No error message anywhere contains a configuration value. Parse errors of the local file say only `invalid JSON in ~/.verus-skills/config.json`; the parser's message is never passed on (not as text, not as `cause`).
- `config/models.json` never holds a secret-like field (`apiKey`, `key`, `token`, `secret`, any case, any depth).
- Every subagent dispatch: unnamed (never a `name` parameter), in the background, never a `model` parameter (it would override the agent's configured model).
- Repository, `package.json` name, `HOOK_MARKER` and `<!-- claude-skills-using -->` keep the name `claude-skills`.
- After editing `skills/subagent-driven-development/` or `skills/writing-plans/` run `make repatch`; revert header-only timestamp churn in other `patches/*.patch` with `git checkout -- <file>`.
- Tests: `npm test` (`node --test tests/*.test.mjs`), offline, without the `claude` binary; temp dirs via `mkdtempSync`, removed in `after()`; never read or write the real `~/.verus-skills`, `~/.claude` or `~/.codex` — set `HOME` to a temp dir.
- Every commit ends with `Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>`.
- Work in the current checkout; never create git worktrees.

## Review Focus

1. **Copied judges in tests** — `tests/vendor-sdk.test.mjs` copies `scripts/typesafe-judge.mjs` alone into temp roots; once the judge imports `./config.mjs` and reads `config/models.json`, those copies must carry both or every such test breaks for the wrong reason. Test in Task 4.
2. **Launcher run from a copy or a symlink** — `reviewer.sh` must find `config.mjs` next to its resolved self, not next to the symlink. Test in Task 3.
3. **No local file at all** (most machines) — every consumer treats a missing `~/.verus-skills/config.json` as "no overrides", never as an error. Test in Task 1.
4. **Valid JSON, wrong shape** in the local file (e.g. `"codex": "gpt-x"`, `"typesafe": {"apiKey": 42}`) — a field-only error, no value echoed. Test in Task 1.
5. **Hand-edited agent file** without a `model:` or `effort:` line — `make models` refuses, naming the file, and writes nothing. Test in Task 2.

---

### Task 1: Two-layer config loader with secret-safe errors

**Files:**
- Create: `config/models.json`
- Create: `scripts/config.mjs`
- Create: `tests/config.test.mjs`

**Interfaces:**
- Consumes: nothing.
- Produces, all exported from `scripts/config.mjs`:
  - `REPO_ROOT: string`, `TIERS: ["worker","reviewer","explorer"]`, `EFFORTS: ["low","medium","high","xhigh","max"]`, `LOCAL_DISPLAY: "~/.verus-skills/config.json"`
  - `localPath(home?: string): string`
  - `validateModels(cfg: object): object` (throws field-only `Error`)
  - `loadModels(root?: string): object`
  - `validateLocal(obj: object): object`
  - `loadLocal(home?: string): { data: object, insecure: boolean } | null` (null when the file does not exist)
  - `resolveCodex(env?: object, opts?: { home?: string, root?: string }): { model: string, reasoning: string }`
  - `resolveJudgeModel(env?: object, opts?: { home?: string, root?: string }): string`
  - `resolveApiKey(env?: object, opts?: { home?: string }): string | null`
  - `redact(text: string, secret: string | null): string`
  - CLI: `node scripts/config.mjs codex` prints exactly two lines, `<model>\n<reasoning>\n`, exit 0; any error → one `config: <field-only message>` line on stderr, exit 1; unknown section → `usage: config.mjs codex`, exit 1.

- [ ] **Step 1: Write the failing test**

Create `tests/config.test.mjs`:

```js
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmodSync, copyFileSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  REPO_ROOT, TIERS, EFFORTS, loadModels, validateModels, loadLocal, resolveCodex,
  resolveJudgeModel, resolveApiKey, redact,
} from "../scripts/config.mjs";

const SECRET = "ts_DUMMY_SECRET_123";
const TEMP_DIRS = [];
function tmp(prefix) {
  const d = realpathSync(mkdtempSync(path.join(tmpdir(), prefix)));
  TEMP_DIRS.push(d);
  return d;
}
after(() => { for (const d of TEMP_DIRS) rmSync(d, { recursive: true, force: true }); });

const MODELS = {
  subagents: {
    worker: { model: "opus", effort: "high" },
    reviewer: { model: "opus", effort: "xhigh" },
    explorer: { model: "opus", effort: "medium" },
  },
  codex: { model: "default", reasoning: "default" },
  judge: { model: "jev-latest" },
};

// A throwaway root with config/models.json and a copy of scripts/config.mjs.
function root(models = MODELS) {
  const r = tmp("cfg-root-");
  mkdirSync(path.join(r, "config"), { recursive: true });
  mkdirSync(path.join(r, "scripts"), { recursive: true });
  writeFileSync(path.join(r, "config", "models.json"), typeof models === "string" ? models : JSON.stringify(models));
  copyFileSync(path.join(REPO_ROOT, "scripts", "config.mjs"), path.join(r, "scripts", "config.mjs"));
  return r;
}
function home(local, mode = 0o600) {
  const h = tmp("cfg-home-");
  if (local !== undefined) {
    mkdirSync(path.join(h, ".verus-skills"), { recursive: true });
    const f = path.join(h, ".verus-skills", "config.json");
    writeFileSync(f, typeof local === "string" ? local : JSON.stringify(local));
    chmodSync(f, mode);
  }
  return h;
}
function cli(r, h, env = {}) {
  return spawnSync(process.execPath, [path.join(r, "scripts", "config.mjs"), "codex"], {
    encoding: "utf8",
    env: { PATH: process.env.PATH, HOME: h, ...env },
  });
}

test("the committed config/models.json is valid and ships the agreed defaults", () => {
  const cfg = loadModels(REPO_ROOT);
  assert.deepEqual(cfg, MODELS);
  assert.deepEqual(TIERS, ["worker", "reviewer", "explorer"]);
  assert.deepEqual(EFFORTS, ["low", "medium", "high", "xhigh", "max"]);
});

test("validateModels names the field, never the value", () => {
  const bad = structuredClone(MODELS);
  bad.subagents.worker.effort = "turbo-9000";
  assert.throws(() => validateModels(bad), (e) => /subagents\.worker\.effort/.test(e.message) && !e.message.includes("turbo-9000"));
  const missing = structuredClone(MODELS);
  delete missing.subagents.explorer;
  assert.throws(() => validateModels(missing), /subagents\.explorer is missing/);
  const spaced = structuredClone(MODELS);
  spaced.subagents.reviewer.model = "opus\neffort: max";
  assert.throws(() => validateModels(spaced), /subagents\.reviewer\.model/);
});

test("validateModels refuses a secret-like field at any depth, in any case", () => {
  for (const key of ["apiKey", "APIKEY", "api_key", "token", "Secret", "key"]) {
    const bad = structuredClone(MODELS);
    bad.judge[key] = SECRET;
    assert.throws(() => validateModels(bad), (e) => /must not hold secrets/.test(e.message) && !e.message.includes(SECRET), key);
  }
});

test("a missing local file means no overrides", () => {
  assert.equal(loadLocal(home()), null);
  const r = root();
  assert.deepEqual(resolveCodex({}, { home: home(), root: r }), { model: "default", reasoning: "default" });
  assert.equal(resolveJudgeModel({}, { home: home(), root: r }), "jev-latest");
  assert.equal(resolveApiKey({}, { home: home() }), null);
});

test("precedence: env > local > repo > default, for every layer", () => {
  const r = root({ ...MODELS, codex: { model: "repo-m", reasoning: "repo-r" }, judge: { model: "repo-j" } });
  const h = home({ codex: { model: "local-m", reasoning: "local-r" }, judge: { model: "local-j" }, typesafe: { apiKey: SECRET } });
  assert.deepEqual(resolveCodex({}, { home: h, root: r }), { model: "local-m", reasoning: "local-r" });
  assert.deepEqual(
    resolveCodex({ REVIEWER_CODEX_MODEL: "env-m", REVIEWER_CODEX_REASONING: "env-r" }, { home: h, root: r }),
    { model: "env-m", reasoning: "env-r" },
  );
  assert.deepEqual(resolveCodex({}, { home: home(), root: r }), { model: "repo-m", reasoning: "repo-r" });
  assert.equal(resolveJudgeModel({}, { home: h, root: r }), "local-j");
  assert.equal(resolveJudgeModel({ TYPESAFE_DEFAULT_MODEL: "env-j" }, { home: h, root: r }), "env-j");
  assert.equal(resolveApiKey({}, { home: h }), SECRET);
  assert.equal(resolveApiKey({ TYPESAFE_API_KEY: "ts_env" }, { home: h }), "ts_env");
});

test("model and effort resolve independently", () => {
  const r = root({ ...MODELS, codex: { model: "repo-m", reasoning: "default" } });
  assert.deepEqual(resolveCodex({ REVIEWER_CODEX_REASONING: "low" }, { home: home(), root: r }), { model: "repo-m", reasoning: "low" });
});

test("loadLocal reports group- or world-readable files as insecure", () => {
  assert.equal(loadLocal(home({ typesafe: { apiKey: SECRET } }, 0o600)).insecure, false);
  assert.equal(loadLocal(home({ typesafe: { apiKey: SECRET } }, 0o644)).insecure, true);
});

test("broken local JSON is reported by file name only — the secret never leaks", () => {
  const h = home(`{"typesafe": {"apiKey": ${SECRET}}}`); // unquoted: Node would quote it in its message
  assert.throws(() => loadLocal(h), (e) => e.message === "invalid JSON in ~/.verus-skills/config.json" && e.cause === undefined);
});

test("valid JSON with the wrong shape is a field-only error", () => {
  const cases = [
    [{ typesafe: SECRET }, /typesafe in ~\/\.verus-skills\/config\.json must be an object/],
    [{ typesafe: { apiKey: 42 } }, /typesafe\.apiKey/],
    [{ codex: "gpt-x" }, /codex in ~\/\.verus-skills\/config\.json must be an object/],
    [{ typesafe: { apiKey: SECRET }, codex: { model: 7 } }, /codex\.model/],
  ];
  for (const [local, re] of cases) {
    assert.throws(() => loadLocal(home(local)), (e) => re.test(e.message) && !e.message.includes(SECRET) && !e.message.includes("gpt-x"));
  }
});

test("the CLI prints exactly model and effort, and never the key", () => {
  const r = root({ ...MODELS, codex: { model: "cli-m", reasoning: "cli-r" } });
  const ok = cli(r, home({ typesafe: { apiKey: SECRET } }));
  assert.equal(ok.status, 0, ok.stderr);
  assert.equal(ok.stdout, "cli-m\ncli-r\n");
  assert.ok(!ok.stdout.includes(SECRET) && !ok.stderr.includes(SECRET));
});

test("the CLI fails without leaking the secret on a broken local file or a bad field", () => {
  const r = root();
  for (const local of [`{"typesafe": {"apiKey": ${SECRET}}}`, { typesafe: { apiKey: SECRET }, codex: { model: 7 } }, { typesafe: SECRET }]) {
    const res = cli(r, home(local));
    assert.equal(res.status, 1);
    assert.match(res.stderr, /^config: /);
    assert.ok(!res.stdout.includes(SECRET) && !res.stderr.includes(SECRET), JSON.stringify(res.stderr));
  }
});

test("the CLI fails on a broken or missing config/models.json", () => {
  assert.equal(cli(root("{not json"), home()).status, 1);
  const r = root();
  rmSync(path.join(r, "config", "models.json"));
  const res = cli(r, home());
  assert.equal(res.status, 1);
  assert.match(res.stderr, /config\/models\.json/);
});

test("the CLI rejects an unknown section", () => {
  const r = root();
  const res = spawnSync(process.execPath, [path.join(r, "scripts", "config.mjs"), "typesafe"], { encoding: "utf8", env: { PATH: process.env.PATH, HOME: home() } });
  assert.equal(res.status, 1);
  assert.match(res.stderr, /usage: config\.mjs codex/);
});

test("redact replaces every occurrence of the secret", () => {
  assert.equal(redact(`a ${SECRET} b ${SECRET}`, SECRET), "a [redacted] b [redacted]");
  assert.equal(redact("nothing here", null), "nothing here");
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `node --test tests/config.test.mjs`
Expected: FAIL — cannot resolve `../scripts/config.mjs`.

- [ ] **Step 3: Write `config/models.json`**

```json
{
  "subagents": {
    "worker": { "model": "opus", "effort": "high" },
    "reviewer": { "model": "opus", "effort": "xhigh" },
    "explorer": { "model": "opus", "effort": "medium" }
  },
  "codex": { "model": "default", "reasoning": "default" },
  "judge": { "model": "jev-latest" }
}
```

- [ ] **Step 4: Write `scripts/config.mjs`**

```js
#!/usr/bin/env node
// Two configuration layers: config/models.json (committed defaults) and
// ~/.verus-skills/config.json (local, never committed, holds the TypeSafe key).
// Every error names a file or a field, never a value: the local file holds a secret,
// and Node's JSON.parse quotes its input in the error message.
import { readFileSync, realpathSync, statSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
export const TIERS = ["worker", "reviewer", "explorer"];
export const EFFORTS = ["low", "medium", "high", "xhigh", "max"];
export const LOCAL_DISPLAY = "~/.verus-skills/config.json";
const SECRET_KEY = /api[-_]?key|^key$|token|secret/i;
// One token: it is written verbatim into YAML frontmatter by `make models`.
const MODEL_TOKEN = /^[\w.:[\]-]+$/;

const isObj = (v) => v !== null && typeof v === "object" && !Array.isArray(v);
const nonEmpty = (v) => typeof v === "string" && v.trim().length > 0;
const pick = (...vals) => vals.find(nonEmpty);

export function localPath(home = homedir()) {
  return path.join(home, ".verus-skills", "config.json");
}

function findSecretKey(obj, prefix = "") {
  if (!isObj(obj)) return null;
  for (const [k, v] of Object.entries(obj)) {
    const p = prefix ? `${prefix}.${k}` : k;
    if (SECRET_KEY.test(k)) return p;
    const inner = findSecretKey(v, p);
    if (inner) return inner;
  }
  return null;
}

export function validateModels(cfg) {
  if (!isObj(cfg)) throw new Error("config/models.json must be a JSON object");
  const secret = findSecretKey(cfg);
  if (secret) throw new Error(`config/models.json must not hold secrets: remove ${secret} (keys go in ${LOCAL_DISPLAY})`);
  if (!isObj(cfg.subagents)) throw new Error("subagents must be an object");
  for (const tier of TIERS) {
    const t = cfg.subagents[tier];
    if (!isObj(t)) throw new Error(`subagents.${tier} is missing`);
    if (!nonEmpty(t.model) || !MODEL_TOKEN.test(t.model)) throw new Error(`subagents.${tier}.model must be a single non-empty token`);
    if (!EFFORTS.includes(t.effort)) throw new Error(`subagents.${tier}.effort must be one of ${EFFORTS.join("|")}`);
  }
  if (!isObj(cfg.codex)) throw new Error("codex must be an object");
  if (!nonEmpty(cfg.codex.model)) throw new Error("codex.model must be a non-empty string");
  if (!nonEmpty(cfg.codex.reasoning)) throw new Error("codex.reasoning must be a non-empty string");
  if (!isObj(cfg.judge)) throw new Error("judge must be an object");
  if (!nonEmpty(cfg.judge.model)) throw new Error("judge.model must be a non-empty string");
  return cfg;
}

export function loadModels(root = REPO_ROOT) {
  let raw;
  try {
    raw = readFileSync(path.join(root, "config", "models.json"), "utf8");
  } catch {
    throw new Error("cannot read config/models.json");
  }
  let cfg;
  try {
    cfg = JSON.parse(raw);
  } catch {
    throw new Error("invalid JSON in config/models.json");
  }
  return validateModels(cfg);
}

const LOCAL_FIELDS = [["typesafe", ["apiKey"]], ["codex", ["model", "reasoning"]], ["judge", ["model"]]];

export function validateLocal(obj) {
  if (!isObj(obj)) throw new Error(`${LOCAL_DISPLAY} must be a JSON object`);
  for (const [section, fields] of LOCAL_FIELDS) {
    if (obj[section] === undefined) continue;
    if (!isObj(obj[section])) throw new Error(`${section} in ${LOCAL_DISPLAY} must be an object`);
    for (const f of fields) {
      const v = obj[section][f];
      if (v !== undefined && !nonEmpty(v)) throw new Error(`${section}.${f} in ${LOCAL_DISPLAY} must be a non-empty string`);
    }
  }
  return obj;
}

// null when the file does not exist — most machines have none.
export function loadLocal(home = homedir()) {
  const file = localPath(home);
  let raw;
  try {
    raw = readFileSync(file, "utf8");
  } catch (err) {
    if (err.code === "ENOENT") return null;
    throw new Error(`cannot read ${LOCAL_DISPLAY}`);
  }
  let data;
  try {
    data = JSON.parse(raw);
  } catch {
    // Never pass the parser's message on: it quotes the input, which holds the key.
    throw new Error(`invalid JSON in ${LOCAL_DISPLAY}`);
  }
  validateLocal(data);
  let insecure = false;
  try {
    insecure = (statSync(file).mode & 0o077) !== 0;
  } catch {}
  return { data, insecure };
}

export function resolveCodex(env = process.env, { home = homedir(), root = REPO_ROOT } = {}) {
  const repo = loadModels(root);
  const local = loadLocal(home)?.data ?? {};
  return {
    model: pick(env.REVIEWER_CODEX_MODEL, local.codex?.model, repo.codex.model) ?? "default",
    reasoning: pick(env.REVIEWER_CODEX_REASONING, local.codex?.reasoning, repo.codex.reasoning) ?? "default",
  };
}

export function resolveJudgeModel(env = process.env, { home = homedir(), root = REPO_ROOT } = {}) {
  const repo = loadModels(root);
  const local = loadLocal(home)?.data ?? {};
  return pick(env.TYPESAFE_DEFAULT_MODEL, local.judge?.model, repo.judge.model) ?? "jev-latest";
}

export function resolveApiKey(env = process.env, { home = homedir() } = {}) {
  if (nonEmpty(env.TYPESAFE_API_KEY)) return env.TYPESAFE_API_KEY;
  return pick(loadLocal(home)?.data.typesafe?.apiKey) ?? null;
}

export function redact(text, secret) {
  const s = String(text);
  return secret ? s.split(secret).join("[redacted]") : s;
}

function main(argv) {
  if (argv[0] !== "codex" || argv.length !== 1) {
    console.error("usage: config.mjs codex");
    return 1;
  }
  try {
    const { model, reasoning } = resolveCodex();
    process.stdout.write(`${model}\n${reasoning}\n`);
    return 0;
  } catch (err) {
    console.error(`config: ${err.message}`);
    return 1;
  }
}

if (process.argv[1]) {
  let isMain = false;
  try {
    isMain = realpathSync(process.argv[1]) === fileURLToPath(import.meta.url);
  } catch {}
  if (isMain) process.exitCode = main(process.argv.slice(2));
}
```

- [ ] **Step 5: Run the test to verify it passes**

Run: `node --test tests/config.test.mjs`
Expected: PASS, 14 tests.

- [ ] **Step 6: Run the whole suite**

Run: `npm test`
Expected: PASS (181 existing + 14 new).

- [ ] **Step 7: Commit**

```bash
git add config/models.json scripts/config.mjs tests/config.test.mjs
git commit -m "feat(config): two-layer models config with secret-safe errors"
```

---

### Task 2: Agent definitions and `make models`

**Files:**
- Create: `agents/verus-worker.md`, `agents/verus-reviewer.md`, `agents/verus-explorer.md`
- Create: `scripts/models.mjs`
- Create: `tests/models.test.mjs`
- Modify: `Makefile` (`.PHONY` line 1, new `models` target after `vendor-sdk`)
- Modify: `package.json` (`scripts`)
- Modify: `tests/plugin.test.mjs` (append one test)

**Interfaces:**
- Consumes: `loadModels(root)`, `TIERS`, `REPO_ROOT` from `scripts/config.mjs` (Task 1).
- Produces: `agentFile(root: string, tier: string): string`, `renderAgent(text: string, { model, effort }, label: string): string`, `syncAgents(root?: string): { written: string[] }` exported from `scripts/models.mjs`; the three agent files with `name: verus-<tier>` and `model:`/`effort:` lines matching `config/models.json`.

- [ ] **Step 1: Write the failing test**

Create `tests/models.test.mjs`:

```js
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { REPO_ROOT, TIERS, loadModels } from "../scripts/config.mjs";
import { agentFile, renderAgent } from "../scripts/models.mjs";

const TEMP_DIRS = [];
function tmp(prefix) {
  const d = realpathSync(mkdtempSync(path.join(tmpdir(), prefix)));
  TEMP_DIRS.push(d);
  return d;
}
after(() => { for (const d of TEMP_DIRS) rmSync(d, { recursive: true, force: true }); });

function frontmatter(text) {
  const m = text.match(/^---\n([\s\S]*?)\n---\n/);
  assert.ok(m, "no frontmatter");
  return Object.fromEntries(m[1].split("\n").map((l) => l.match(/^(\w+): (.*)$/)).filter(Boolean).map((x) => [x[1], x[2]]));
}
function sandbox() {
  const r = tmp("models-");
  for (const d of ["config", "scripts", "agents"]) mkdirSync(path.join(r, d), { recursive: true });
  copyFileSync(path.join(REPO_ROOT, "config/models.json"), path.join(r, "config/models.json"));
  for (const f of ["config.mjs", "models.mjs"]) copyFileSync(path.join(REPO_ROOT, "scripts", f), path.join(r, "scripts", f));
  for (const t of TIERS) copyFileSync(agentFile(REPO_ROOT, t), agentFile(r, t));
  return r;
}
const run = (r) => spawnSync(process.execPath, [path.join(r, "scripts/models.mjs")], { encoding: "utf8" });

test("the committed agents match config/models.json and carry the verus- ids", () => {
  const cfg = loadModels(REPO_ROOT);
  for (const t of TIERS) {
    const fm = frontmatter(readFileSync(agentFile(REPO_ROOT, t), "utf8"));
    assert.equal(fm.name, `verus-${t}`);
    assert.equal(fm.model, cfg.subagents[t].model, `${t} model drifted — run make models`);
    assert.equal(fm.effort, cfg.subagents[t].effort, `${t} effort drifted — run make models`);
    assert.ok(fm.description?.length > 20);
    assert.equal(fm.tools, undefined, "no tools restriction (spec decision 10)");
  }
});

test("make models rewrites only the model and effort lines", () => {
  const r = sandbox();
  const cfg = JSON.parse(readFileSync(path.join(r, "config/models.json"), "utf8"));
  cfg.subagents.reviewer = { model: "claude-opus-5-6", effort: "max" };
  writeFileSync(path.join(r, "config/models.json"), JSON.stringify(cfg));
  const before = readFileSync(agentFile(r, "reviewer"), "utf8");
  const res = run(r);
  assert.equal(res.status, 0, res.stderr);
  const after = readFileSync(agentFile(r, "reviewer"), "utf8");
  const fm = frontmatter(after);
  assert.equal(fm.model, "claude-opus-5-6");
  assert.equal(fm.effort, "max");
  const strip = (s) => s.replace(/^(model|effort): .*$/gm, "");
  assert.equal(strip(after), strip(before), "anything besides model/effort changed");
  assert.equal(readFileSync(agentFile(r, "worker"), "utf8"), readFileSync(agentFile(REPO_ROOT, "worker"), "utf8"));
});

test("make models writes nothing when the config is invalid", () => {
  for (const mutate of [
    (c) => { c.subagents.worker.effort = "turbo"; },
    (c) => { delete c.subagents.explorer; },
    (c) => { c.judge.apiKey = "ts_DUMMY"; },
  ]) {
    const r = sandbox();
    const cfg = JSON.parse(readFileSync(path.join(r, "config/models.json"), "utf8"));
    cfg.subagents.reviewer.effort = "low"; // a valid change that must NOT land either
    mutate(cfg);
    writeFileSync(path.join(r, "config/models.json"), JSON.stringify(cfg));
    const res = run(r);
    assert.equal(res.status, 1);
    assert.match(res.stderr, /^models: /);
    assert.ok(!res.stderr.includes("ts_DUMMY"));
    for (const t of TIERS) assert.equal(readFileSync(agentFile(r, t), "utf8"), readFileSync(agentFile(REPO_ROOT, t), "utf8"), t);
  }
});

test("make models refuses a hand-edited agent that lost its model or effort line", () => {
  const r = sandbox();
  const f = agentFile(r, "explorer");
  writeFileSync(f, readFileSync(f, "utf8").replace(/^effort: .*\n/m, ""));
  const res = run(r);
  assert.equal(res.status, 1);
  assert.match(res.stderr, /agents\/verus-explorer\.md: frontmatter has no effort: line/);
  assert.equal(readFileSync(agentFile(r, "worker"), "utf8"), readFileSync(agentFile(REPO_ROOT, "worker"), "utf8"));
});

test("renderAgent leaves the body untouched even if it mentions model:", () => {
  const text = "---\nname: verus-x\ndescription: d\nmodel: opus\neffort: high\n---\n\nmodel: this line is body text\n";
  const out = renderAgent(text, { model: "sonnet", effort: "low" }, "x");
  assert.match(out, /^---\nname: verus-x\ndescription: d\nmodel: sonnet\neffort: low\n---\n/);
  assert.match(out, /\nmodel: this line is body text\n$/);
});
```

Append to `tests/plugin.test.mjs`:

```js
test("the plugin ships the three verus agents", () => {
  for (const t of ["worker", "reviewer", "explorer"]) {
    const text = readFileSync(path.join(ROOT, "agents", `verus-${t}.md`), "utf8");
    assert.match(text, new RegExp(`^---\\nname: verus-${t}\\n`));
  }
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `node --test tests/models.test.mjs tests/plugin.test.mjs`
Expected: FAIL — cannot resolve `../scripts/models.mjs`; the plugin test fails with ENOENT on `agents/verus-worker.md`.

- [ ] **Step 3: Write the three agent files**

`agents/verus-worker.md`:

```markdown
---
name: verus-worker
description: Implementer and fix subagent of the verus-skills distro — writes, runs and commits code for one planned task or one review fix wave, exactly as its task prompt says.
model: opus
effort: high
---

You are a worker subagent dispatched by a verus-skills skill (subagent-driven-development or review).
Follow the task prompt exactly. Do not dispatch subagents. Report back in the format the prompt asks for.
```

`agents/verus-reviewer.md`:

```markdown
---
name: verus-reviewer
description: Reviewer subagent of the verus-skills distro — task reviews, scoped re-reviews, plan-document reviews and the fallback external review, exactly as its prompt says.
model: opus
effort: xhigh
---

You are a reviewer subagent dispatched by a verus-skills skill (subagent-driven-development, writing-plans, plan-review or review).
Follow the review prompt exactly. Do not dispatch subagents. Do not modify files other than the report the prompt names.
```

`agents/verus-explorer.md`:

```markdown
---
name: verus-explorer
description: Read-only explorer subagent of the verus-skills distro — broad repository lookups for kickoff, answering with facts, file paths and short excerpts.
model: opus
effort: medium
---

You are an explorer subagent dispatched by the verus-skills kickoff skill.
Answer the lookup with facts, file paths and short excerpts. Do not modify files. Do not dispatch subagents.
```

- [ ] **Step 4: Write `scripts/models.mjs`**

```js
#!/usr/bin/env node
// `make models`: copies model and effort from config/models.json into the
// frontmatter of agents/verus-<tier>.md. Validates everything first and writes
// nothing on any error.
import { readFileSync, realpathSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { REPO_ROOT, TIERS, loadModels } from "./config.mjs";

export const agentFile = (root, tier) => path.join(root, "agents", `verus-${tier}.md`);

export function renderAgent(text, { model, effort }, label) {
  const m = text.match(/^---\n([\s\S]*?)\n---\n/);
  if (!m) throw new Error(`${label}: no frontmatter`);
  const fm = m[1];
  if (!/^model: .*$/m.test(fm)) throw new Error(`${label}: frontmatter has no model: line`);
  if (!/^effort: .*$/m.test(fm)) throw new Error(`${label}: frontmatter has no effort: line`);
  const next = fm.replace(/^model: .*$/m, `model: ${model}`).replace(/^effort: .*$/m, `effort: ${effort}`);
  return `---\n${next}\n---\n${text.slice(m[0].length)}`;
}

export function syncAgents(root = REPO_ROOT) {
  const cfg = loadModels(root);
  const planned = TIERS.map((tier) => {
    const file = agentFile(root, tier);
    const label = `agents/verus-${tier}.md`;
    let before;
    try {
      before = readFileSync(file, "utf8");
    } catch {
      throw new Error(`${label} is missing`);
    }
    return { file, label, before, after: renderAgent(before, cfg.subagents[tier], label) };
  });
  const written = [];
  for (const p of planned) {
    if (p.after !== p.before) {
      writeFileSync(p.file, p.after);
      written.push(p.label);
    }
  }
  return { written };
}

function main() {
  try {
    const { written } = syncAgents();
    console.log(written.length ? `updated ${written.join(", ")}` : "agents already match config/models.json");
    return 0;
  } catch (err) {
    console.error(`models: ${err.message}`);
    return 1;
  }
}

if (process.argv[1]) {
  let isMain = false;
  try {
    isMain = realpathSync(process.argv[1]) === fileURLToPath(import.meta.url);
  } catch {}
  if (isMain) process.exitCode = main();
}
```

- [ ] **Step 5: Wire it into make and npm**

In `Makefile`, add `models` to the `.PHONY` list on line 1 and add after the `vendor-sdk` target:

```make
models:
	node scripts/models.mjs
```

In `package.json` `scripts`, add:

```json
    "models": "node scripts/models.mjs",
```

- [ ] **Step 6: Run the tests to verify they pass**

Run: `node --test tests/models.test.mjs tests/plugin.test.mjs`
Expected: PASS (5 new model tests, plugin tests including the new one).

Run: `make models`
Expected: `agents already match config/models.json`.

- [ ] **Step 7: Run the whole suite, then commit**

Run: `npm test` → PASS.

```bash
git add agents scripts/models.mjs tests/models.test.mjs tests/plugin.test.mjs Makefile package.json
git commit -m "feat(agents): verus agent types with model and effort generated by make models"
```

---

### Task 3: `reviewer.sh` — config through `config.mjs`, `default` flags, one terminal per review

**Files:**
- Modify: `scripts/reviewer.sh` (argument parsing lines 7-19; config lines 40-69; session default line 97; Orca success path lines 174-177; codex exec line 193)
- Delete: `config/reviewer.json`
- Modify: `tests/reviewer.test.mjs` (helpers `run` and `cfgTree`; tests listed below)

**Interfaces:**
- Consumes: `node scripts/config.mjs codex` (Task 1) — two lines, model then effort; exit 1 with a `config: …` line on error.
- Produces:
  - `reviewer.sh --close-session <file>`: closes the Orca terminal whose handle the file holds (`orca terminal close --terminal <handle> --json`), deletes the file, exits 0; a missing file or an already-closed terminal is also exit 0. No other argument is required in this mode.
  - Without `--session-file` a run never reuses a terminal, and closes the one it created once the report is written.
  - With `--session-file <file>` a successful run writes the handle to the file and leaves the terminal open.
  - Without `node`: stderr line `node not found; Orca path disabled, config ignored (env or default only)`.

- [ ] **Step 1: Update the test helpers**

In `tests/reviewer.test.mjs`, give `run` an `opts.extraArgs` array appended after the fixed arguments:

```js
  const args = [opts.script ?? SCRIPT, "--prompt-file", prompt, "--output", opts.output ?? "docs/reviews/out.md",
    "--title", "t", "--repo", opts.repo ?? dir, "--timeout-min", opts.timeoutMin ?? "1", ...(opts.extraArgs ?? [])];
```

Add, below `run`:

```js
function closeSession(dir, file, bins = ["orca"]) {
  const bin = tmp("bin-");
  for (const b of bins) { copyFileSync(path.join(FIX, b), path.join(bin, b)); chmodSync(path.join(bin, b), 0o755); }
  const log = path.join(dir, "calls.log");
  const r = spawnSync("bash", [SCRIPT, "--close-session", file], {
    cwd: dir, encoding: "utf8",
    env: { PATH: `${bin}:/usr/bin:/bin`, HOME: dir, FAKE_LOG: log, NODE: process.execPath },
  });
  return { ...r, log: existsSync(log) ? readFileSync(log, "utf8") : "" };
}
const count = (text, re) => (text.match(new RegExp(re, "gm")) ?? []).length;
```

Replace `cfgTree` so a standalone launcher tree carries `config.mjs` and `config/models.json`:

```js
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
```

(`run` already sets `HOME: dir`, so `localConfig(dir, …)` is what the launcher sees.)

- [ ] **Step 2: Replace the config tests**

Delete the tests `config/reviewer.json holds a non-empty model and reasoning effort`, `codex exec is pinned to the configured model and reasoning effort`, `the Orca codex terminal is pinned to the configured model and reasoning effort`, `falls back to the built-in defaults when config/reviewer.json is missing`, `codex exec uses the model and reasoning effort from config/reviewer.json`, `the Orca terminal uses the model and reasoning effort from config/reviewer.json`, `finds config/reviewer.json when launched through a symlink`, `codex exec stays pinned when node is unavailable`. Add in their place:

```js
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
```

- [ ] **Step 3: Replace the session tests**

Replace `reuses an existing Orca session` and `a reused Orca session terminal is never closed` with explicit-session versions, and add the new cases:

```js
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

test("a terminal loaded from --session-file is never closed on fallback", () => {
  const dir = repo();
  const session = path.join(dir, ".context/review-x-session");
  mkdirSync(path.dirname(session), { recursive: true });
  writeFileSync(session, "term-1\n");
  const r = run(dir, ["orca", "codex"], { env: { FAKE_ORCA_STUCK_PROMPT: "1" }, extraArgs: ["--session-file", session] });
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /reviewer: codex-exec/);
  assert.doesNotMatch(r.log, /terminal close/);
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
```

In `prefers Orca when available`, add at the end:

```js
  assert.match(r.log, /terminal close --terminal term-1/); // no --session-file: closed after the report
```

- [ ] **Step 4: Run the tests to verify they fail**

Run: `node --test tests/reviewer.test.mjs`
Expected: FAIL — among others, the default-flags tests (`-m gpt-6-astra` still passed), the session tests (`terminal close` missing), and `--close-session` (`unknown arg`).

- [ ] **Step 5: Add `--close-session` to argument parsing**

In `scripts/reviewer.sh`, extend the variable line and the `case`:

```bash
PROMPT_FILE=""; OUTPUT=""; TITLE=""; TIMEOUT_MIN=15; SESSION_FILE=""; REPO=""; CLOSE_SESSION=""
```

```bash
    --close-session) need_value $# "$1"; CLOSE_SESSION="$2"; shift 2;;
```

Right after the `while … done` argument loop, before the usage check, add:

```bash
# --close-session <file>: end one review's Orca session. Closes only the terminal
# named in the file, removes the file, and never fails the caller.
if [ -n "$CLOSE_SESSION" ]; then
  if [ -f "$CLOSE_SESSION" ]; then
    H="$(cat "$CLOSE_SESSION" 2>/dev/null)"
    if [ -n "$H" ] && command -v orca >/dev/null 2>&1; then
      orca terminal close --terminal "$H" --json >/dev/null 2>&1 || true
    fi
    rm -f "$CLOSE_SESSION"
  fi
  exit 0
fi
```

Update both usage strings to `usage: reviewer.sh --prompt-file F --output REL_OUT --title T [--timeout-min N] [--session-file S] [--repo DIR] | --close-session S`.

- [ ] **Step 6: Replace the config block**

Replace line 42 (`command -v "$NODE_BIN" …`) with:

```bash
command -v "$NODE_BIN" >/dev/null 2>&1 || { echo "node not found; Orca path disabled, config ignored (env or default only)" >&2; ORCA_DISABLED=1; NODE_OK=""; }
```

Replace the comment on lines 44-46 with:

```bash
# Codex model / reasoning effort come from scripts/config.mjs (env > local
# ~/.verus-skills/config.json > config/models.json > default). Without node the
# config cannot be read, so only env counts; "default" passes no flag at all.
```

Replace lines 60-69 (`CFG=…` through `CODEX_REASONING=…`) with:

```bash
if [ -n "$NODE_OK" ]; then
  # config.mjs prints its own field-only error ("config: …"); never echo config values here.
  CFG_OUT="$("$NODE_BIN" "${SELF_DIR:-.}/config.mjs" codex)" || exit 1
  CODEX_MODEL="$(printf '%s\n' "$CFG_OUT" | sed -n 1p)"
  CODEX_REASONING="$(printf '%s\n' "$CFG_OUT" | sed -n 2p)"
else
  CODEX_MODEL="${REVIEWER_CODEX_MODEL:-default}"
  CODEX_REASONING="${REVIEWER_CODEX_REASONING:-default}"
fi
CODEX_FLAGS=""
[ "$CODEX_MODEL" != "default" ] && CODEX_FLAGS="$CODEX_FLAGS -m $CODEX_MODEL"
[ "$CODEX_REASONING" != "default" ] && CODEX_FLAGS="$CODEX_FLAGS -c model_reasoning_effort=$CODEX_REASONING"
```

- [ ] **Step 7: Remove the default session file and close session-less terminals**

Delete line 97 (`[ -z "$SESSION_FILE" ] && SESSION_FILE="$REPO/.context/${TITLE}-session"`).

Change the reuse check (line 140) to:

```bash
  if [ -n "$SESSION_FILE" ] && [ -f "$SESSION_FILE" ]; then
```

Change the Orca `terminal create` (line 145) to:

```bash
    CREATED_HANDLE="$(orca terminal create --worktree active --command "codex$CODEX_FLAGS" --title "$TITLE" --json 2>/dev/null | find_handle || true)"
```

Replace the success branch (lines 174-178):

```bash
        if wait_for_output "$REMAIN"; then
          if [ -n "$SESSION_FILE" ]; then
            echo "$HANDLE" > "$SESSION_FILE"   # kept for this review's round 2
          elif [ -n "$CREATED_HANDLE" ]; then
            orca terminal close --terminal "$CREATED_HANDLE" --json >/dev/null 2>&1 || true
          fi
          echo "reviewer: orca"
          exit 0
        fi
```

- [ ] **Step 8: Build the codex exec arguments conditionally**

Replace line 193 with:

```bash
  EXEC_ARGS=(exec -C "$REPO")
  [ "$CODEX_MODEL" != "default" ] && EXEC_ARGS+=(-m "$CODEX_MODEL")
  EXEC_ARGS+=(-s workspace-write --enable web_search_cached)
  [ "$CODEX_REASONING" != "default" ] && EXEC_ARGS+=(-c "model_reasoning_effort=$CODEX_REASONING")
  EXEC_ARGS+=(-)
  ( cd "$REPO" && codex "${EXEC_ARGS[@]}" < "$REPO/$PROMPT_REL" > "$LOG" 2>&1 ) &
```

- [ ] **Step 9: Delete the old config file**

Run: `git rm config/reviewer.json`

- [ ] **Step 10: Run the tests to verify they pass**

Run: `node --test tests/reviewer.test.mjs`
Expected: PASS.

- [ ] **Step 11: Run the whole suite, then commit**

Run: `npm test` → PASS. Run `grep -rn "reviewer.json" scripts tests` → no match (README is updated in Task 9).

```bash
git add scripts/reviewer.sh tests/reviewer.test.mjs config/reviewer.json
git commit -m "feat(reviewer): models config, default flags, one Orca terminal per review, --close-session"
```

---

### Task 4: The judge — model and key from the config, redacted errors

**Files:**
- Modify: `scripts/typesafe-judge.mjs` (imports; `judge()`; `main()`)
- Modify: `tests/judge.test.mjs` (append)
- Modify: `tests/vendor-sdk.test.mjs` (the three tests that copy the judge into a temp root)

**Interfaces:**
- Consumes: `resolveJudgeModel`, `resolveApiKey`, `loadLocal`, `redact` from `scripts/config.mjs` (Task 1).
- Produces: `judge(input, { client, choice, noul, threshold, sufficiencyThreshold, model })` — when `model` is a non-empty string, `client.systemOne` receives `{ state, questions, model }`; otherwise `{ state, questions }` as today. `failureMessage(err: Error, apiKey: string | null): string` — `judge failed: <message with the key replaced by [redacted]>`.

- [ ] **Step 1: Write the failing tests**

Append to `tests/judge.test.mjs` (it already imports `judge`, `spawnSync`, `mkdtempSync`, `realpathSync`, `rmSync`, `copyFileSync`, `mkdirSync`, `tmpdir`, `path`):

```js
import { writeFileSync, chmodSync } from "node:fs";

const JUDGE_SECRET = "ts_DUMMY_SECRET_123";
const ROOT_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const J_TEMP = [];
function jtmp(prefix) { const d = realpathSync(mkdtempSync(path.join(tmpdir(), prefix))); J_TEMP.push(d); return d; }
import { after as afterAll } from "node:test";
afterAll(() => { for (const d of J_TEMP) rmSync(d, { recursive: true, force: true }); });

const JUDGE_INPUT = JSON.stringify({ question: "q", options: [{ id: "A", label: "a" }, { id: "B", label: "b" }], context: "c", recommended: "A" });
function judgeHome(local, mode = 0o600) {
  const h = jtmp("judge-home-");
  if (local !== undefined) {
    mkdirSync(path.join(h, ".verus-skills"), { recursive: true });
    const f = path.join(h, ".verus-skills/config.json");
    writeFileSync(f, typeof local === "string" ? local : JSON.stringify(local));
    chmodSync(f, mode);
  }
  return h;
}
function runJudge(h, env = {}) {
  return spawnSync(process.execPath, [path.join(ROOT_DIR, "scripts/typesafe-judge.mjs")], {
    encoding: "utf8", input: JUDGE_INPUT,
    env: { PATH: process.env.PATH, HOME: h, ...env },
  });
}

test("judge passes the resolved model to systemOne", async () => {
  let seen;
  const client = { systemOne: async (req) => { seen = req; return { answers: { answer: { A: 0.9, B: 0.1 }, sufficiency: { yes: 0.9, no: 0.1 } } }; } };
  const fakeChoice = (q, criteria) => ({ type: "choice", q, criteria });
  const fakeNoul = (q) => ({ type: "noul", q });
  await judge(JSON.parse(JUDGE_INPUT), { client, choice: fakeChoice, noul: fakeNoul, threshold: 0.7, sufficiencyThreshold: 0.6, model: "jev-test" });
  assert.equal(seen.model, "jev-test");
  await judge(JSON.parse(JUDGE_INPUT), { client, choice: fakeChoice, noul: fakeNoul, threshold: 0.7, sufficiencyThreshold: 0.6 });
  assert.equal("model" in seen, false);
});

test("with no key anywhere the guard fires and names both places", () => {
  const r = runJudge(judgeHome());
  assert.equal(r.status, 2);
  assert.match(r.stderr, /TYPESAFE_API_KEY or ~\/\.verus-skills\/config\.json/);
});

test("a key from the local file passes the guard", () => {
  // Past the guard the SDK fails offline; what matters is that it got that far.
  const r = runJudge(judgeHome({ typesafe: { apiKey: JUDGE_SECRET } }), { TYPESAFE_BASE_URL: "http://127.0.0.1:9" });
  assert.equal(r.status, 2);
  assert.doesNotMatch(r.stderr, /API key not found/);
  assert.ok(!r.stderr.includes(JUDGE_SECRET) && !r.stdout.includes(JUDGE_SECRET));
});

test("a broken local file exits 2, names the file, and never leaks the secret", () => {
  const r = runJudge(judgeHome(`{"typesafe": {"apiKey": ${JUDGE_SECRET}}}`));
  assert.equal(r.status, 2);
  assert.match(r.stderr, /invalid JSON in ~\/\.verus-skills\/config\.json/);
  assert.ok(!r.stderr.includes(JUDGE_SECRET) && !r.stdout.includes(JUDGE_SECRET));
});

test("an insecure local key file draws a warning", () => {
  const r = runJudge(judgeHome({ typesafe: { apiKey: JUDGE_SECRET } }, 0o644), { TYPESAFE_BASE_URL: "http://127.0.0.1:9" });
  assert.match(r.stderr, /readable by group or others; chmod 600/);
});

test("a client error that contains the key is printed redacted", () => {
  const msg = failureMessage(new Error(`401 for key ${JUDGE_SECRET} (retry with ${JUDGE_SECRET})`), JUDGE_SECRET);
  assert.equal(msg, "judge failed: 401 for key [redacted] (retry with [redacted])");
  assert.equal(failureMessage(new Error("boom"), null), "judge failed: boom");
});
```

Also add `failureMessage` to the existing import from `../scripts/typesafe-judge.mjs`. (Place the new `import` lines at the top of the file with the existing imports instead of mid-file; they are shown here only to name what the new tests need.)

- [ ] **Step 2: Run the tests to verify they fail**

Run: `node --test tests/judge.test.mjs`
Expected: FAIL — `failureMessage` is not exported; `seen.model` undefined; the guard message still says only `TYPESAFE_API_KEY is not set`.

- [ ] **Step 3: Pass `model` through `judge()`**

In `scripts/typesafe-judge.mjs`, change the `judge` signature and the `systemOne` call:

```js
export async function judge(input, { client, choice, noul, threshold, sufficiencyThreshold, model }) {
  validate(input);
  const response = await client.systemOne({
    state: buildState(input),
    questions: buildQuestions(input, choice, noul),
    ...(typeof model === "string" && model.trim() ? { model } : {}),
  });
```

- [ ] **Step 4: Resolve key and model in `main()`**

Add to the imports:

```js
import { loadLocal, redact, resolveApiKey, resolveJudgeModel } from "./config.mjs";
```

Replace the `if (!process.env.TYPESAFE_API_KEY) { … }` block with:

```js
  let apiKey;
  let model;
  try {
    const local = loadLocal();
    if (local?.insecure && local.data.typesafe?.apiKey) {
      console.error("warning: ~/.verus-skills/config.json is readable by group or others; chmod 600 it");
    }
    apiKey = resolveApiKey(process.env);
    model = resolveJudgeModel(process.env);
  } catch (err) {
    console.error(`judge failed: ${err.message}`); // config.mjs errors never carry values
    process.exit(2);
  }
  if (!apiKey) {
    console.error("TypeSafe API key not found (TYPESAFE_API_KEY or ~/.verus-skills/config.json); judge unavailable");
    process.exit(2);
  }
```

Add, next to `judge`:

```js
export function failureMessage(err, apiKey) {
  return `judge failed: ${redact(err.message, apiKey)}`;
}
```

Replace the final `try { … } catch` in `main()`:

```js
  try {
    const { TypeSafeClient, choice, noul } = await loadSdk();
    const client = new TypeSafeClient({ apiKey });
    const result = await judge(input, { client, choice, noul, threshold, sufficiencyThreshold, model });
    process.stdout.write(JSON.stringify(result) + "\n");
  } catch (err) {
    console.error(failureMessage(err, apiKey));
    process.exit(2);
  }
```

- [ ] **Step 5: Make the copied judges in `tests/vendor-sdk.test.mjs` carry their config**

The judge now imports `./config.mjs` and reads `config/models.json`. In each test that copies `scripts/typesafe-judge.mjs` into a temp root (today: `loadSdk resolves the vendored copy when node_modules is absent` and `the judge exits 2 with a judge failed: line when no SDK can be loaded at all`), also copy the two files next to it:

```js
  cpSync(path.join(REPO_ROOT, "scripts", "config.mjs"), path.join(root, "scripts", "config.mjs"));
  mkdirSync(path.join(root, "config"), { recursive: true });
  cpSync(path.join(REPO_ROOT, "config", "models.json"), path.join(root, "config", "models.json"));
```

and give the exit-2 test a temp `HOME` so it never reads the real `~/.verus-skills`:

```js
    env: { ...process.env, TYPESAFE_API_KEY: "dummy", HOME: tmp("vendor-home-") },
```

- [ ] **Step 6: Run the tests to verify they pass**

Run: `node --test tests/judge.test.mjs tests/vendor-sdk.test.mjs`
Expected: PASS.

- [ ] **Step 7: Run the whole suite, then commit**

Run: `npm test` → PASS.

```bash
git add scripts/typesafe-judge.mjs tests/judge.test.mjs tests/vendor-sdk.test.mjs
git commit -m "feat(judge): model and key from the config, redacted errors"
```

---

### Task 5: Installer — link agents, refuse foreign agent names, key check

**Files:**
- Modify: `scripts/install.mjs` (new agent functions; `main()`)
- Modify: `tests/install.test.mjs` (append)

**Interfaces:**
- Consumes: the `agents/verus-*.md` files (Task 2); `resolveApiKey` from `scripts/config.mjs` (Task 1).
- Produces, exported from `scripts/install.mjs`: `agentNames(repoRoot): string[]` (file names like `verus-worker.md`), `agentCollisions(repoRoot, targetDir): string[]` (absolute paths of foreign entries), `linkAgents(repoRoot, targetDir): { linked: string[], repointed: { name, from }[] }`, `unlinkAgents(repoRoot, targetDir): { removed: string[] }`.

- [ ] **Step 1: Write the failing tests**

Append to `tests/install.test.mjs` (merge the new names into the existing import from `../scripts/install.mjs`):

```js
import { agentNames, agentCollisions, linkAgents, unlinkAgents } from "../scripts/install.mjs";

test("agentNames lists the three verus agents", () => {
  assert.deepEqual(agentNames(REPO_ROOT), ["verus-explorer.md", "verus-reviewer.md", "verus-worker.md"]);
});

test("linkAgents links, is idempotent, and unlinkAgents removes only ours", () => {
  const target = tmp("agents-");
  writeFileSync(path.join(target, "someone-else.md"), "x");
  assert.deepEqual(linkAgents(REPO_ROOT, target).linked, agentNames(REPO_ROOT));
  assert.deepEqual(linkAgents(REPO_ROOT, target).linked, agentNames(REPO_ROOT));
  assert.equal(readlinkSync(path.join(target, "verus-worker.md")), path.join(REPO_ROOT, "agents", "verus-worker.md"));
  assert.deepEqual(unlinkAgents(REPO_ROOT, target).removed, agentNames(REPO_ROOT));
  assert.ok(existsSync(path.join(target, "someone-else.md")));
});

test("a link into another distro checkout is re-pointed, not a collision", () => {
  const target = tmp("agents-");
  const other = distroRepo(); // existing helper: a checkout with sources.yaml + scripts/install.mjs
  mkdirSync(path.join(other, "agents"), { recursive: true });
  writeFileSync(path.join(other, "agents", "verus-worker.md"), "---\nname: verus-worker\n---\n");
  symlinkSync(path.join(other, "agents", "verus-worker.md"), path.join(target, "verus-worker.md"));
  assert.deepEqual(agentCollisions(REPO_ROOT, target), []);
  const r = linkAgents(REPO_ROOT, target);
  assert.deepEqual(r.repointed.map((x) => x.name), ["verus-worker.md"]);
});

test("a foreign file or a foreign symlink on an agent name refuses the whole install", () => {
  for (const plant of [
    (f) => writeFileSync(f, "---\nname: verus-worker\n---\nnot ours\n"),
    (f) => symlinkSync("/somewhere/else/verus-worker.md", f),
  ]) {
    const home = tmp("home-");
    mkdirSync(path.join(home, ".claude", "agents"), { recursive: true });
    const foreign = path.join(home, ".claude", "agents", "verus-worker.md");
    plant(foreign);
    for (const extra of [[], ["--force"]]) {
      const r = runInstaller(["--home", home, ...extra]);
      assert.equal(r.status, 1, `${extra}: ${r.stdout}`);
      assert.match(r.stderr, /verus-worker\.md is not ours; move it away and re-run/);
      assert.ok(!existsSync(path.join(home, ".claude", "skills", "kickoff")));
      assert.ok(!existsSync(path.join(home, ".claude", "agents", "verus-reviewer.md")));
      assert.ok(!existsSync(path.join(home, ".claude", "settings.json")));
    }
    assert.equal(runInstaller(["--home", home, "--uninstall"]).status, 0);
    assert.ok(existsSync(foreign) || readlinkSync(foreign), "uninstall must not remove a foreign entry");
  }
});

test("install links the agents into ~/.claude/agents and uninstall removes them", () => {
  const home = tmp("home-");
  assert.equal(runInstaller(["--home", home]).status, 0);
  for (const f of agentNames(REPO_ROOT)) assert.equal(readlinkSync(path.join(home, ".claude", "agents", f)), path.join(REPO_ROOT, "agents", f));
  assert.equal(runInstaller(["--home", home, "--uninstall"]).status, 0);
  for (const f of agentNames(REPO_ROOT)) assert.ok(!existsSync(path.join(home, ".claude", "agents", f)));
});

test("the key check sees ~/.verus-skills/config.json and never prints the key", () => {
  const home = tmp("home-");
  mkdirSync(path.join(home, ".verus-skills"), { recursive: true });
  writeFileSync(path.join(home, ".verus-skills", "config.json"), JSON.stringify({ typesafe: { apiKey: "ts_DUMMY_SECRET_123" } }));
  const r = runInstaller(["--home", home], { TYPESAFE_API_KEY: "" });
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /ok +TypeSafe API key/);
  assert.ok(!r.stdout.includes("ts_DUMMY_SECRET_123") && !r.stderr.includes("ts_DUMMY_SECRET_123"));
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `node --test tests/install.test.mjs`
Expected: FAIL — `agentNames` is not exported.

- [ ] **Step 3: Add the agent functions to `scripts/install.mjs`**

Add next to `linkSkills`/`unlinkSkills`:

```js
export function agentNames(repoRoot) {
  const base = path.join(repoRoot, "agents");
  if (!existsSync(base)) return [];
  return readdirSync(base).filter((f) => /^verus-[a-z]+\.md$/.test(f)).sort();
}

function distroRootOfAgentLink(target, file) {
  const tail = path.sep + path.join("agents", file);
  if (typeof target !== "string" || !target.endsWith(tail)) return null;
  return target.slice(0, -tail.length) || null;
}

// An agent name someone else already owns is an error, not a skip: the skills
// would dispatch to that foreign agent instead of ours.
export function agentCollisions(repoRoot, targetDir) {
  const foreign = [];
  for (const file of agentNames(repoRoot)) {
    const dst = path.join(targetDir, file);
    if (isSymlink(dst)) {
      const target = readlinkSync(dst);
      if (isUnder(target, repoRoot)) continue;
      const from = distroRootOfAgentLink(target, file);
      if (from && isDistroCheckout(from)) continue;
      foreign.push(dst);
    } else if (existsSync(dst)) {
      foreign.push(dst);
    }
  }
  return foreign;
}

export function linkAgents(repoRoot, targetDir) {
  mkdirSync(targetDir, { recursive: true });
  const linked = [], repointed = [];
  for (const file of agentNames(repoRoot)) {
    const src = path.join(repoRoot, "agents", file);
    const dst = path.join(targetDir, file);
    if (isSymlink(dst)) {
      const target = readlinkSync(dst);
      if (target === src) { linked.push(file); continue; }
      if (!isUnder(target, repoRoot)) {
        const from = distroRootOfAgentLink(target, file);
        if (from) repointed.push({ name: file, from });
      }
      unlinkSync(dst);
    }
    symlinkSync(src, dst);
    linked.push(file);
  }
  return { linked, repointed };
}

export function unlinkAgents(repoRoot, targetDir) {
  const removed = [];
  const own = path.join(repoRoot, "agents");
  for (const file of agentNames(repoRoot)) {
    const p = path.join(targetDir, file);
    if (isSymlink(p) && isUnder(readlinkSync(p), own)) { unlinkSync(p); removed.push(file); }
  }
  return { removed };
}
```

(`linkAgents` is only called after `agentCollisions` returned nothing, so every existing entry it meets is ours or another distro checkout's.)

Add to the imports from `./config.mjs`:

```js
import { resolveApiKey } from "./config.mjs";
```

- [ ] **Step 4: Wire them into `main()`**

After the `const agents = …` line add:

```js
  const claudeAgents = path.join(home, ".claude", "agents");
```

Right after the plugin-installed check (before `if (opts.uninstall)`), add — `--force` does not bypass it:

```js
  if (!opts.uninstall) {
    const foreign = agentCollisions(REPO_ROOT, claudeAgents);
    if (foreign.length) {
      for (const f of foreign) console.error(`${f} is not ours; move it away and re-run`);
      process.exitCode = 1;
      return;
    }
  }
```

In the uninstall branch, after the codex skills line:

```js
    console.log("claude agents removed:", unlinkAgents(REPO_ROOT, claudeAgents).removed.join(", ") || "none");
```

After the skills-linking loop:

```js
  const ag = linkAgents(REPO_ROOT, claudeAgents);
  console.log(`claude agents: linked ${ag.linked.join(", ")}`);
  for (const r of ag.repointed) console.log(`claude agents: re-pointed from ${r.from}: ${r.name}`);
```

Replace the `TYPESAFE_API_KEY` entry of `checks`:

```js
  let haveKey = false;
  try { haveKey = Boolean(resolveApiKey(process.env, { home })); } catch {}
  const checks = [
    ["TypeSafe API key", haveKey, "put it in ~/.verus-skills/config.json as typesafe.apiKey (chmod 600), or set TYPESAFE_API_KEY"],
```

(keep the `codex` and `orca` entries as they are).

- [ ] **Step 5: Run the tests to verify they pass**

Run: `node --test tests/install.test.mjs`
Expected: PASS. Existing tests that asserted `ok TYPESAFE_API_KEY` wording, if any, are updated to `TypeSafe API key`.

- [ ] **Step 6: Run the whole suite, then commit**

Run: `npm test` → PASS.

```bash
git add scripts/install.mjs tests/install.test.mjs
git commit -m "feat(install): link verus agents, refuse foreign agent names, local key check"
```

---

### Task 6: Dispatch sites for both hosts

**Files:**
- Modify: `skills/subagent-driven-development/implementer-prompt.md`, `task-reviewer-prompt.md`, `re-review-prompt.md` (patched skill)
- Modify: `skills/subagent-driven-development/SKILL.md` (`## Model Selection`; the `review` hand-off item near line 417) (patched skill)
- Modify: `skills/writing-plans/plan-document-reviewer-prompt.md` (patched skill)
- Modify: `skills/kickoff/SKILL.md:34`, `skills/plan-review/SKILL.md` (frontmatter `description`; exit-3 bullet), `skills/review/SKILL.md` (frontmatter `description`; exit-3 bullet; fix-wave sentence)
- Modify: `USING.md:12,31`, `CLAUDE.md:18`
- Modify: `patches/subagent-driven-development.patch`, `patches/writing-plans.patch` (via `make repatch`)
- Modify: `tests/patched-skills.test.mjs`

**Interfaces:**
- Consumes: agent ids `verus-worker`, `verus-reviewer`, `verus-explorer` (Task 2).
- Produces: every dispatch site carries a Claude Code line of the form `` `subagent_type` = `verus-<tier>` (`verus-skills:verus-<tier>` when installed as a plugin) `` and the Codex line `In a Codex session: dispatch the same prompt with spawn_agent, unnamed, in the background; pass no model.`

The canonical Claude Code sentence (used verbatim with the tier substituted) is:
`Claude Code: \`subagent_type\` = \`verus-<tier>\` (\`verus-skills:verus-<tier>\` when installed as a plugin), unnamed, in the background, no \`model\` parameter.`

- [ ] **Step 1: Write the failing test**

In `tests/patched-skills.test.mjs`, replace the test `SDD final review routes to review and every prompt pins opus` with one that keeps its routing assertions but drops `model: opus`:

```js
test("SDD final review routes to review and keeps the SDD rules", () => {
  const sdd = readFileSync(path.join(root, "subagent-driven-development/SKILL.md"), "utf8");
  assert.match(sdd, /Invoke review <MERGE_BASE>/);
  assert.doesNotMatch(sdd, /using-git-worktrees/);
  assert.doesNotMatch(sdd, /executing-plans/);
  assert.doesNotMatch(sdd, /requesting-code-review/);
  assert.doesNotMatch(sdd, /more capable model/);
  assert.match(sdd, /unnamed/);
});
```

Append:

```js
const CODEX_LINE = "In a Codex session: dispatch the same prompt with spawn_agent, unnamed, in the background; pass no model.";
const claudeLine = (tier) =>
  `Claude Code: \`subagent_type\` = \`verus-${tier}\` (\`verus-skills:verus-${tier}\` when installed as a plugin), unnamed, in the background, no \`model\` parameter.`;
// file (relative to skills/) → the tiers of its dispatch sites, one entry per site
const DISPATCH_SITES = {
  "subagent-driven-development/implementer-prompt.md": ["worker"],
  "subagent-driven-development/task-reviewer-prompt.md": ["reviewer"],
  "subagent-driven-development/re-review-prompt.md": ["reviewer"],
  "writing-plans/plan-document-reviewer-prompt.md": ["reviewer"],
  "plan-review/SKILL.md": ["reviewer"],
  "review/SKILL.md": ["reviewer", "worker"],
  "kickoff/SKILL.md": ["explorer"],
};

test("every dispatch site names the agent type for Claude Code and spawn_agent for Codex", () => {
  let sites = 0;
  for (const [file, tiers] of Object.entries(DISPATCH_SITES)) {
    const body = readFileSync(path.join(root, file), "utf8");
    for (const tier of new Set(tiers)) {
      const n = body.split(claudeLine(tier)).length - 1;
      assert.equal(n, tiers.filter((t) => t === tier).length, `${file}: Claude Code line for verus-${tier}`);
    }
    assert.equal(body.split(CODEX_LINE).length - 1, tiers.length, `${file}: Codex line count`);
    assert.doesNotMatch(body, /general-purpose/, file);
    assert.doesNotMatch(body, /model: opus/, file);
    // a `name:` parameter in a dispatch opens a window; the file's own frontmatter `name:` is not a dispatch
    assert.doesNotMatch(body.replace(/^---\n[\s\S]*?\n---\n/, ""), /^\s*name:/m, file);
    assert.doesNotMatch(body, /e\.g\. a Codex session/, file);
    sites += tiers.length;
  }
  assert.equal(sites, 8);
});

test("the SDD model rule and the routing docs describe both hosts", () => {
  const sdd = readFileSync(path.join(root, "subagent-driven-development/SKILL.md"), "utf8");
  assert.match(sdd, /config\/models\.json/);
  assert.doesNotMatch(sdd, /Always pass the model explicitly/);
  for (const doc of ["../USING.md", "../CLAUDE.md"]) {
    const body = readFileSync(new URL(doc, import.meta.url), "utf8");
    assert.doesNotMatch(body, /model: opus/, doc);
    assert.match(body, /verus-worker/, doc);
  }
  const using = readFileSync(new URL("../USING.md", import.meta.url), "utf8");
  assert.match(using, /spawn_agent/);
  assert.match(using, /subagent_type/);
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `node --test tests/patched-skills.test.mjs`
Expected: FAIL — the Claude Code line count is 0 for every site.

- [ ] **Step 3: Rewrite the four prompt templates**

In each of the four templates, insert a **Dispatch** paragraph directly above the opening fence and change the pseudo-YAML header. For `skills/subagent-driven-development/implementer-prompt.md`, replace:

````markdown
```
Subagent (general-purpose):
  description: "Implement Task N: [task name]"
  model: opus
  prompt: |
````

with:

````markdown
**Dispatch.** Claude Code: `subagent_type` = `verus-worker` (`verus-skills:verus-worker` when installed as a plugin), unnamed, in the background, no `model` parameter. In a Codex session: dispatch the same prompt with spawn_agent, unnamed, in the background; pass no model.

```
Subagent (verus-worker):
  description: "Implement Task N: [task name]"
  prompt: |
````

`task-reviewer-prompt.md`: same change with `verus-reviewer`, header `Subagent (verus-reviewer):`, description `"Review Task N (spec + quality)"`, and the `model: opus` line removed. In its placeholder list at the bottom, delete the `[MODEL]` bullet.

`re-review-prompt.md`: same with `verus-reviewer`, description `"Re-review Task N fix round R"`, `model: opus` removed; delete the `[MODEL]` placeholder bullet.

`skills/writing-plans/plan-document-reviewer-prompt.md`: same with `verus-reviewer`, header `Subagent (verus-reviewer):`, description `"Review plan document"` (it has no `model:` line today).

- [ ] **Step 4: Rewrite the SDD model section and hand-off wording**

In `skills/subagent-driven-development/SKILL.md`, replace the first paragraph of `## Model Selection` (the one starting "Every subagent dispatched by this skill uses `model: opus`") with:

```markdown
Subagents run on the distro's agent types, whose model and effort come from
`config/models.json` (regenerated into the agent files by `make models`), never
from the dispatch:

- Claude Code: implementers use `verus-worker` (`verus-skills:verus-worker` when installed as a plugin); task reviewers and re-reviewers use `verus-reviewer` (`verus-skills:verus-reviewer` when installed as a plugin), each as `subagent_type`. Never pass a `model` parameter: it would override the agent's configured model.
- In a Codex session: dispatch with spawn_agent and pass no model.
```

Keep the following paragraph ("Dispatch subagents unnamed and in the background: …") unchanged.

In the numbered item that invokes `review` (near line 417), replace `(via Orca, then \`codex exec\`, then a Claude agent on opus as fallback)` with `(via Orca, then \`codex exec\`, then a fallback reviewer agent)`.

- [ ] **Step 5: Rewrite the inline dispatch sites**

`skills/kickoff/SKILL.md` line 34 — replace `dispatch an unnamed Explore subagent (\`model: opus\`, background) for broad lookups and keep asking` with:

```markdown
dispatch an explorer subagent for broad lookups — Claude Code: `subagent_type` = `verus-explorer` (`verus-skills:verus-explorer` when installed as a plugin), unnamed, in the background, no `model` parameter. In a Codex session: dispatch the same prompt with spawn_agent, unnamed, in the background; pass no model. Keep asking
```

`skills/plan-review/SKILL.md` exit-3 bullet — replace it entirely with:

```markdown
- `3`: dispatch the fallback reviewer with the same prompt file content as its prompt and the instruction to write `REPORT`, and wait for it. Claude Code: `subagent_type` = `verus-reviewer` (`verus-skills:verus-reviewer` when installed as a plugin), unnamed, in the background, no `model` parameter. In a Codex session: dispatch the same prompt with spawn_agent, unnamed, in the background; pass no model. On a host with no subagent tool at all, do not stop: perform the review yourself in this session following `reviewer.md` exactly, write `REPORT`, and state in the report header that it was produced by the fallback reviewer, not an independent second voice.
```

`skills/review/SKILL.md` exit-3 bullet — the same replacement text.

`skills/review/SKILL.md` fix wave — replace `dispatch ONE unnamed background fix subagent (\`general-purpose\`, \`model: opus\`): give it` with:

```markdown
dispatch ONE fix subagent — Claude Code: `subagent_type` = `verus-worker` (`verus-skills:verus-worker` when installed as a plugin), unnamed, in the background, no `model` parameter. In a Codex session: dispatch the same prompt with spawn_agent, unnamed, in the background; pass no model. Give it
```

In the frontmatter `description` of both `skills/plan-review/SKILL.md` and `skills/review/SKILL.md`, replace `then a Claude agent on opus` with `then a fallback reviewer agent`.

- [ ] **Step 6: Rewrite the routing docs**

`USING.md` line 12 — replace `with fresh \`opus\` subagents and per-task reviews.` with `with fresh subagents (the \`verus-worker\` and \`verus-reviewer\` agent types) and per-task reviews.`

`USING.md` line 31 — replace the bullet with:

```markdown
- Subagents are dispatched unnamed and in the background, never as named teammates with their own windows. In Claude Code they run as the distro's agent types via `subagent_type` — `verus-worker`, `verus-reviewer`, `verus-explorer` (prefixed `verus-skills:` under the plugin install) — whose model and effort come from `config/models.json`; never pass a `model` parameter. In a Codex session they are dispatched with spawn_agent, with no model. The user reads your summary, not the subagents.
```

`CLAUDE.md` line 18 — replace with:

```markdown
- Subagents dispatched by skills here run as the distro's agent types (`verus-worker`, `verus-reviewer`, `verus-explorer`); their model and effort live in `config/models.json` — run `make models` after editing it.
```

- [ ] **Step 7: Run the test to verify it passes**

Run: `node --test tests/patched-skills.test.mjs`
Expected: PASS.

- [ ] **Step 8: Re-record the patches**

Run: `make repatch`
Expected: `patches/subagent-driven-development.patch` and `patches/writing-plans.patch` change. If `git status` shows other `patches/*.patch` changed, inspect them with `git diff`; when the only change is the `---`/`+++` timestamp headers, revert them with `git checkout -- <file>`.

- [ ] **Step 9: Run the whole suite, then commit**

Run: `npm test` → PASS.

```bash
git add skills USING.md CLAUDE.md patches tests/patched-skills.test.mjs
git commit -m "feat(skills): dispatch the verus agent types in Claude Code and spawn_agent in Codex"
```

---

### Task 7: One reviewer session per review in `plan-review` and `review`

**Files:**
- Modify: `skills/plan-review/SKILL.md` (section 2 launch block; section 5; section 6; Rules)
- Modify: `skills/review/SKILL.md` (section 2 launch block; section 4 early stops; section 5; section 6; Rules)
- Modify: `tests/patched-skills.test.mjs` (append)

**Interfaces:**
- Consumes: `reviewer.sh --session-file <file>` and `reviewer.sh --close-session <file>` (Task 3).
- Produces: a `SESSION` value derived from the round-1 report (`<repo>/.context/<title>-<basename of the round-1 REPORT without .md>-session`), closed before round 1, passed to both rounds, closed when the review ends.

- [ ] **Step 1: Write the failing test**

Append to `tests/patched-skills.test.mjs`:

```js
test("plan-review and review keep one reviewer session per review", () => {
  for (const [file, title] of [["plan-review/SKILL.md", "plan-review"], ["review/SKILL.md", "review"]]) {
    const body = readFileSync(path.join(root, file), "utf8");
    const launch = body.slice(body.indexOf("## 2. Launch the external reviewer"), body.indexOf("## 3."));
    assert.match(launch, new RegExp(`SESSION="\\$\\(git rev-parse --show-toplevel\\)/\\.context/${title}-\\$\\(basename "\\$ROUND1_REPORT" \\.md\\)-session"`), file);
    assert.match(launch, /\[ "\$ROUND" = 1 \] && bash "\$SKILLS_REPO\/scripts\/reviewer\.sh" --close-session "\$SESSION"/, file);
    assert.match(launch, /--session-file "\$SESSION"/, file);
    const handOff = body.slice(body.indexOf("## 6. Hand off"));
    assert.match(handOff, /--close-session "\$SESSION"/, `${file}: closes the session at the end`);
    assert.match(body, /Whenever this skill stops[^\n]*--close-session/, `${file}: rule for every exit`);
  }
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `node --test tests/patched-skills.test.mjs`
Expected: FAIL — no `SESSION=` in the launch block.

- [ ] **Step 3: Rewrite the launch block in both skills**

In `skills/plan-review/SKILL.md` section 2, replace the lines between the locator and `echo "reviewer_exit=$?"` so the block reads:

```bash
SKILLS_REPO=""
for c in "$(cat "$HOME/.verus-skills/root" 2>/dev/null)" \
         "$HOME/.claude/skills/plan-review/../.." \
         "$HOME/.codex/skills/plan-review/../.."; do
  [ -n "$c" ] && [ -f "$c/scripts/typesafe-judge.mjs" ] && SKILLS_REPO="$(cd -P "$c" && pwd -P)" && break
done
[ -f "$SKILLS_REPO/scripts/reviewer.sh" ] || echo "reviewer not found: SKILLS_REPO=$SKILLS_REPO"

PROMPT="<the temp prompt file from section 1>"
REPORT="<REPORT, repo-relative>"
ROUND="<1 or 2>"
ROUND1_REPORT="<the round-1 REPORT; in round 2 the same value as in round 1>"
SESSION="$(git rev-parse --show-toplevel)/.context/plan-review-$(basename "$ROUND1_REPORT" .md)-session"
# Round 1 starts fresh: close an orphan left by an interrupted earlier review of this plan.
[ "$ROUND" = 1 ] && bash "$SKILLS_REPO/scripts/reviewer.sh" --close-session "$SESSION"
bash "$SKILLS_REPO/scripts/reviewer.sh" --prompt-file "$PROMPT" --output "$REPORT" --title plan-review --timeout-min 15 --session-file "$SESSION"
echo "reviewer_exit=$?"
```

Change the sentence above the block to: `Substitute the real values for the four placeholders before running:`.

In `skills/review/SKILL.md` section 2, make the same change with `review` in place of `plan-review` in the locator and in `SESSION`, `--title review --timeout-min 20`.

- [ ] **Step 4: Close the session wherever the skill ends**

In both skills, add at the start of section 6 (`## 6. Hand off`):

````markdown
First close this review's reviewer session:

```bash
SKILLS_REPO=""
for c in "$(cat "$HOME/.verus-skills/root" 2>/dev/null)" \
         "$HOME/.claude/skills/<skill>/../.." \
         "$HOME/.codex/skills/<skill>/../.."; do
  [ -n "$c" ] && [ -f "$c/scripts/typesafe-judge.mjs" ] && SKILLS_REPO="$(cd -P "$c" && pwd -P)" && break
done
SESSION="<the SESSION value from section 2>"
bash "$SKILLS_REPO/scripts/reviewer.sh" --close-session "$SESSION"
```
````

with `<skill>` written out as `plan-review` / `review` in the respective file.

Append to each skill's `## Rules`:

```markdown
- Whenever this skill stops — hand-off, a stop after round 1 or 2, report-only mode, a red suite — first run `reviewer.sh --close-session "$SESSION"` (section 6), so review terminals never pile up.
```

In section 5 of both skills, replace `in Orca the same terminal session is reused via the session file, so the reviewer sees its own earlier context` with `pass the same SESSION as round 1 — in Orca that reuses round 1's terminal, so the reviewer sees its own earlier context`. In `review`, also note that `ROUND1_REPORT` keeps the round-1 path although round 2 writes a new `-N` report.

- [ ] **Step 5: Run the test to verify it passes**

Run: `node --test tests/patched-skills.test.mjs`
Expected: PASS.

- [ ] **Step 6: Run the whole suite, then commit**

Run: `npm test` → PASS.

```bash
git add skills/plan-review/SKILL.md skills/review/SKILL.md tests/patched-skills.test.mjs
git commit -m "feat(skills): one reviewer session per review, closed at start and end"
```

---

### Task 8: Side fixes — ledger marker and judge triage

**Files:**
- Modify: `skills/review/SKILL.md` (section 0 `Ledger lines`; section 3; section 4 decisions sentence)
- Modify: `skills/plan-review/SKILL.md` (section 3; section 4 decisions sentence)
- Modify: `skills/kickoff/judge.md` (`## Rules`)
- Create: `tests/triage.test.mjs`

**Interfaces:**
- Consumes: the SDD ledger template `Task <N>: minor (deferred): <one-liner>` (unchanged, upstream wording).
- Produces: review's ledger collection `grep -iE 'minor \(deferred\)|ruling|parked'`; triage sections that ask how to fix, and the chat line `accepted without the judge: <finding> — <evidence>`.

- [ ] **Step 1: Write the failing test**

Create `tests/triage.test.mjs`:

```js
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

const skills = new URL("../skills/", import.meta.url).pathname;
const read = (f) => readFileSync(path.join(skills, f), "utf8");
const TEMP = [];
after(() => { for (const d of TEMP) rmSync(d, { recursive: true, force: true }); });

function reviewGrepPattern() {
  const m = read("review/SKILL.md").match(/grep -iE '([^']+)' "\$LEDGER"/);
  assert.ok(m, "review's ledger collection must be a case-insensitive grep -iE on $LEDGER");
  return m[1];
}

test("review's ledger pattern catches the line SDD tells the controller to write", () => {
  const sdd = read("subagent-driven-development/SKILL.md");
  const t = sdd.match(/`Task <N>: ([^`:]+): <one-liner>`/);
  assert.ok(t, "SDD ledger template not found");
  const sample = `Task 3: ${t[1]}: something small`;
  assert.ok(new RegExp(reviewGrepPattern(), "i").test(sample), `pattern misses: ${sample}`);
});

test("the collection block prints deferred minors, rulings and parked lines", () => {
  const dir = realpathSync(mkdtempSync(path.join(tmpdir(), "ledger-")));
  TEMP.push(dir);
  const ledger = path.join(dir, "progress.md");
  writeFileSync(ledger, [
    "# SDD ledger — plan: docs/plans/x.md",
    "Task 1: minor (deferred): a small thing",
    "- Ruling: kept X — because Y — cost Z",
    "Task 2: parked — finding — Ruling: why",
    "Task 3: complete (commits a..b, review clean)",
  ].join("\n") + "\n");
  const r = spawnSync("grep", ["-iE", reviewGrepPattern(), ledger], { encoding: "utf8" });
  assert.equal(r.stdout.trim().split("\n").length, 3, r.stdout);
});

test("review and plan-review triage asks how to fix, not whether to accept", () => {
  for (const f of ["review/SKILL.md", "plan-review/SKILL.md"]) {
    const body = read(f);
    const s3 = body.slice(body.indexOf("## 3. Triage findings"), body.indexOf("## 4."));
    assert.match(s3, /How should .* be fixed\?/, f);
    assert.match(s3, /2–4 concrete ways to fix it/, f);
    assert.match(s3, /accepted without the judge: <finding one-liner> — <the evidence/, f);
    assert.match(s3, /"leave it as is" option is allowed only when its `description` states the strongest argument/, f);
    assert.doesNotMatch(s3, /Fix as proposed|Accept: revise the plan as the reviewer proposes|Reject: the finding is wrong/, f);
  }
});

test("judge.md forbids padding a question with an unargued option", () => {
  const rules = read("kickoff/judge.md").split("## Rules")[1] ?? "";
  assert.match(rules, /reasonable engineer could pick/);
  assert.match(rules, /only one real option is not judge-able/);
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `node --test tests/triage.test.mjs`
Expected: FAIL — `review's ledger collection must be a case-insensitive grep -iE`.

- [ ] **Step 3: Fix the ledger collection in `skills/review/SKILL.md`**

In the `Ledger lines` bullet, replace `the lines of \`LEDGER\` containing \`Minor (deferred)\`, \`Ruling\` or \`parked\`` with `the lines of \`LEDGER\` containing \`minor (deferred)\` (as subagent-driven-development writes it), \`Ruling\` or \`parked\`, matched case-insensitively`. In its bash block, replace `grep -E 'Minor \(deferred\)|Ruling|parked' "$LEDGER"` with `grep -iE 'minor \(deferred\)|ruling|parked' "$LEDGER"`.

- [ ] **Step 4: Rewrite section 3 of `skills/review/SKILL.md`**

Replace everything from `Build a judge question:` down to (not including) `` `## Ledger triage` lines marked BLOCKS MERGE`` with:

```markdown
First decide whether the finding is a real choice.

**One reasonable fix** — for example a reproduced bug with an obvious remedy, or a factual error in a document: do not call the judge. Accept it and print, in place of a decision block:

`accepted without the judge: <finding one-liner> — <the evidence: reproduction, file:line, command output>`

Record that line with the decisions (section 4).

**Otherwise build a judge question about how to fix it:**
- `question`: "How should <the finding, in a few words> be fixed?"
- options: 2–4 concrete ways to fix it, each one a reasonable engineer could pick, each with its concrete consequence in `description`. The reviewer's proposal may be one of them. A "leave it as is" option is allowed only when its `description` states the strongest argument for leaving it; never add a bare "reject". Map each option to the judge's JSON fields: `label` is a short name, `description` the consequence.
- `context`: a structured object — `goal` (what the branch delivers, one sentence), `decisions` (findings already triaged in this round), `facts` (the summary from step 1.2, the finding verbatim, the relevant spec or plan constraint, and the code excerpt the finding points at), `constraints` (the user's rules and the spec's hard limits), `consequences` (one entry per option id, each naming what concretely happens or breaks — file, behaviour, test — if that option is chosen; equal specificity and length for every id, no comparative or preference language). Facts only — a stranger reading `facts` alone must be able to pick.
- `recommended`: your pick. It is shown to the user and never sent to the judge.

Run the judge exactly as `judge.md` says. Accepted → record the decision; unaccepted or any non-zero judge exit → ask the user with the decision block. Print every decision block in chat as it happens.
```

In section 4, change `<one decision block per finding, plus "Rejected: <finding> — <reason>" lines>` to `<one decision block per judged finding, one "accepted without the judge: …" line per finding decided without it, and a "Left as is: <finding> — <argument>" line for each finding the judge or the user chose to leave>`.

- [ ] **Step 5: Rewrite section 3 of `skills/plan-review/SKILL.md`**

The same replacement as Step 4, with these wording changes: `goal` is "what the plan delivers"; `facts` are "the plan's Goal and Architecture lines, the spec's relevant constraint, the finding verbatim, and the relevant plan excerpt"; `constraints` are "the user's rules and the plan's hard limits"; and after the judge: "Accepted → apply the decision; unaccepted or any non-zero judge exit → ask the user with the decision block." Apply the same section-4 change to its `## Plan review decisions (round N)` template.

- [ ] **Step 6: Add the rule to `skills/kickoff/judge.md`**

Append to `## Rules`:

```markdown
- Every option must be one a reasonable engineer could pick. Never pad a question with an unargued "reject" or "do nothing": a "leave it as is" option carries its strongest argument in `description`, or it is left out. A question left with only one real option is not judge-able — decide it yourself and state the evidence.
```

- [ ] **Step 7: Run the test to verify it passes**

Run: `node --test tests/triage.test.mjs`
Expected: PASS, 4 tests.

- [ ] **Step 8: Run the whole suite, then commit**

Run: `npm test` → PASS.

```bash
git add skills/review/SKILL.md skills/plan-review/SKILL.md skills/kickoff/judge.md tests/triage.test.mjs
git commit -m "fix(skills): case-insensitive ledger collection; triage asks how to fix"
```

---

### Task 9: Documentation and acceptance checklist

**Files:**
- Modify: `README.md` (new `## Models and effort` section; the TypeSafe key paragraph; every `config/reviewer.json` mention; `rm -rf ~/.verus-skills`; legacy session files note)
- Modify: `docs/plugin-acceptance.md`

**Interfaces:**
- Consumes: everything from Tasks 1–8.
- Produces: no code.

- [ ] **Step 1: Add `## Models and effort` to the README**

Insert before `## Install`:

````markdown
## Models and effort

Every model and effort setting lives in `config/models.json`:

```json
{
  "subagents": {
    "worker":   { "model": "opus", "effort": "high" },
    "reviewer": { "model": "opus", "effort": "xhigh" },
    "explorer": { "model": "opus", "effort": "medium" }
  },
  "codex": { "model": "default", "reasoning": "default" },
  "judge": { "model": "jev-latest" }
}
```

- **Claude subagents** run as the agent types `verus-worker` (implementers, fix waves), `verus-reviewer` (task reviews, re-reviews, plan reviews, the fallback external reviewer) and `verus-explorer` (kickoff lookups). After editing `subagents`, run `make models` — it rewrites the `model:`/`effort:` lines of `agents/verus-*.md`; a test fails if they drift. The symlink install sees the change at once; the plugin after a release. Effort: `low|medium|high|xhigh|max`.
- **The `opus` alias** follows the newest Opus only when the main session is not itself pinned to an older Opus: a session on an older Opus keeps its subagents on that exact version. To pin, write a full model id (e.g. `claude-opus-5-6`) and run `make models`.
- **Codex reviewer:** `default` passes no `-m`/`model_reasoning_effort`, so Codex uses `~/.codex/config.toml`. Override per run with `REVIEWER_CODEX_MODEL` / `REVIEWER_CODEX_REASONING`. Each review starts a fresh Codex terminal, so a change applies from the next review.
- **Judge:** `jev-latest` by default; override per run with `TYPESAFE_DEFAULT_MODEL`.
- **Per machine**, without a commit: `~/.verus-skills/config.json` may set `codex.model`, `codex.reasoning` and `judge.model`; it wins over `config/models.json`, env wins over both. A Claude subagent's model cannot be overridden per run — agent definitions are static.
````

- [ ] **Step 2: Replace the TypeSafe key instructions**

Replace the paragraph that tells the user to put `TYPESAFE_API_KEY` into `~/.claude/settings.json` (and `~/.zshenv` for Codex) with:

````markdown
Put the TypeSafe key in `~/.verus-skills/config.json` — one place for Claude Code and Codex, outside every repo, kept across plugin updates:

```bash
mkdir -p ~/.verus-skills
printf '{ "typesafe": { "apiKey": "ts_..." } }\n' > ~/.verus-skills/config.json
chmod 600 ~/.verus-skills/config.json
```

`TYPESAFE_API_KEY` in the environment still works and wins over the file. The judge warns when the file is readable by group or others. `config/models.json` refuses any secret-like field, so a key can never be committed.
````

Remove or rewrite every remaining mention of `config/reviewer.json` to point at `config/models.json` (`grep -n "reviewer.json" README.md` must return nothing).

- [ ] **Step 3: Fix the uninstall commands and note old sessions**

In `README.md` `## Uninstall`, replace `rm -rf ~/.verus-skills` with `rm -f ~/.verus-skills/root   # keeps config.json and its key`. Add below the Codex uninstall block:

```markdown
Older versions kept one Orca terminal per repo in `.context/plan-review-session` / `.context/review-session`. They are no longer used; close those terminals in Orca and delete the files if they are still there.
```

- [ ] **Step 4: Update the acceptance checklist**

In `docs/plugin-acceptance.md`: in step 2 and step 16 replace `rm -rf ~/.verus-skills` with `rm -f ~/.verus-skills/root`. Insert after step 13 (renumber the later steps and every cross-reference):

```markdown
14. `claude plugin details verus-skills@verus-skills` shows `Agents (3)`: `verus-worker`, `verus-reviewer`, `verus-explorer`.
15. Dispatch `verus-skills:verus-worker` without a `name` (e.g. run a one-task plan through subagent-driven-development): no window opens, and the `--debug` log shows the model and effort from `config/models.json`.
16. Pinned parent: start a session on the full id of an older Opus; the debug log shows `verus-worker` (model `opus`) on that same older version. Pin a full id in `config/models.json`, run `make models`, reinstall; the agent then runs on the pinned id.
17. Collision: with a foreign `~/.claude/agents/verus-worker.md` in place, `make install` exits non-zero, names the file, and creates no link.
18. With `TYPESAFE_API_KEY` unset and the key only in `~/.verus-skills/config.json`, the judge answers `judge_exit=0`.
```

And in the Codex section, add a check that a subagent dispatch runs through `spawn_agent` without a `name` or separate window.

- [ ] **Step 5: Run the whole suite, then commit**

Run: `npm test` → PASS. Run `grep -rn "rm -rf ~/.verus-skills\|reviewer.json" README.md docs/plugin-acceptance.md` → no match.

```bash
git add README.md docs/plugin-acceptance.md
git commit -m "docs: models and effort, the local TypeSafe key, acceptance steps for agents"
```
