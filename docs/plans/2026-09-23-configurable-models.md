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
- `config/models.json` never holds a secret-like field (`apiKey`, `key`, `token`, `secret`, any case, any depth, inside objects and arrays alike).
- Every resolved Codex model and effort value — from `config/models.json`, `~/.verus-skills/config.json` or `REVIEWER_CODEX_MODEL`/`REVIEWER_CODEX_REASONING` alike — is a single token matching `/^[\w.:[\]-]+$/`, the rule subagent models already follow. A mismatch is a field-only error naming the source, never the value: `REVIEWER_CODEX_MODEL must be a single token`, `codex.model in ~/.verus-skills/config.json must be a single token`, `codex.reasoning in config/models.json must be a single token`. The Orca command builder and the two-line CLI output stay as they are.
- Both reviewer prompts (`skills/plan-review/reviewer.md`, `skills/review/reviewer.md`) end every report with the exact last line `<!-- end of review -->`. On the Orca path `reviewer.sh` accepts a report, and closes a session-less terminal, only once the file contains that line; without it inside the budget it falls back to `codex exec`. The `codex exec` path keeps "process exited + report non-empty".
- An agent link whose target does not exist is never a collision: the installer replaces it and reports `replaced dangling link`. A collision (refused, even with `--force`) is only a regular file, or a link to an existing target that is neither under this checkout nor inside another existing distro checkout.
- Every subagent dispatch: unnamed (never a `name` parameter), in the background, never a `model` parameter (it would override the agent's configured model).
- Repository, `package.json` name, `HOOK_MARKER` and `<!-- claude-skills-using -->` keep the name `claude-skills`.
- After editing `skills/subagent-driven-development/` or `skills/writing-plans/` run `make repatch`; revert header-only timestamp churn in other `patches/*.patch` with `git checkout -- <file>`.
- Tests: `npm test` (`node --test tests/*.test.mjs`), offline, without the `claude` binary; temp dirs via `mkdtempSync`, removed in `after()`; never read or write the real `~/.verus-skills`, `~/.claude` or `~/.codex` — set `HOME` to a temp dir.
- Every commit ends with `Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>`.
- Work in the current checkout; never create git worktrees.

## Review Focus

1. **Copied scripts in tests** — `tests/vendor-sdk.test.mjs` and the missing-`config/judge.json` test in `tests/judge.test.mjs` copy `scripts/typesafe-judge.mjs` alone into temp roots, and `distroRepo()` in `tests/install.test.mjs` copies `scripts/install.mjs` alone; once they import `./config.mjs`, every copy must carry it (the judge copies also `config/models.json`) or those tests break for the wrong reason. Tests in Tasks 4 and 5.
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
  - `validateModels(cfg: object): object` (throws field-only `Error`; walks objects and arrays for secret-like keys; `codex.model`/`codex.reasoning` must be single tokens)
  - `loadModels(root?: string): object`
  - `validateLocal(obj: object): object` (`codex.model`/`codex.reasoning` must be single tokens)
  - `loadLocal(home?: string): { data: object, insecure: boolean } | null` (null when the file does not exist)
  - `resolveCodex(env?: object, opts?: { home?: string, root?: string }): { model: string, reasoning: string }` (throws `REVIEWER_CODEX_MODEL must be a single token` / `REVIEWER_CODEX_REASONING must be a single token` for a non-token env value)
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

test("validateModels refuses a secret-like field inside nested arrays", () => {
  for (const extra of [[{ APIKey: SECRET }], [[{ token: SECRET }]], [{ deep: [{ Secret: SECRET }] }]]) {
    const bad = structuredClone(MODELS);
    bad.extra = extra;
    assert.throws(
      () => validateModels(bad),
      (e) => /must not hold secrets: remove extra\[0\]/.test(e.message) && !e.message.includes(SECRET),
      JSON.stringify(extra),
    );
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

test("an unreadable local path, arrays and empty fields are file- or field-only errors", () => {
  // A directory where the file should be: readFileSync fails with EISDIR, not ENOENT.
  const dirHome = tmp("cfg-home-");
  mkdirSync(path.join(dirHome, ".verus-skills", "config.json"), { recursive: true });
  assert.throws(() => loadLocal(dirHome), (e) => e.message === "cannot read ~/.verus-skills/config.json" && e.cause === undefined);
  const res = cli(root(), dirHome);
  assert.equal(res.status, 1);
  assert.equal(res.stderr, "config: cannot read ~/.verus-skills/config.json\n");
  const L = "in ~\\/\\.verus-skills\\/config\\.json";
  const cases = [
    [[{ typesafe: { apiKey: SECRET } }], new RegExp(`^~\\/\\.verus-skills\\/config\\.json must be a JSON object$`)],
    [{ typesafe: [SECRET] }, new RegExp(`^typesafe ${L} must be an object$`)],
    [{ codex: ["gpt-x"] }, new RegExp(`^codex ${L} must be an object$`)],
    [{ judge: [] }, new RegExp(`^judge ${L} must be an object$`)],
    [{ typesafe: { apiKey: "" } }, new RegExp(`^typesafe\\.apiKey ${L} must be a non-empty string$`)],
    [{ codex: { model: "" } }, new RegExp(`^codex\\.model ${L} must be a non-empty string$`)],
    [{ codex: { reasoning: "   " } }, new RegExp(`^codex\\.reasoning ${L} must be a non-empty string$`)],
    [{ judge: { model: "" } }, new RegExp(`^judge\\.model ${L} must be a non-empty string$`)],
  ];
  for (const [local, re] of cases) {
    assert.throws(
      () => loadLocal(home(local)),
      (e) => re.test(e.message) && !e.message.includes(SECRET) && !e.message.includes("gpt-x"),
      JSON.stringify(local),
    );
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

test("the CLI refuses a Codex value that is not a single token, from every source, without echoing it", () => {
  // A newline would forge the second output line; a space would add arguments to the Orca --command.
  // Trailing LF/CR/CRLF are pinned too: JS `$` without the m flag matches only at the very end,
  // so they are already rejected — the cases catch a future regex change (plan-review round 2).
  for (const bad of ["gpt-x\nlow", "gpt-x -c evil=1", "gpt-test\n", "gpt-test\r", "gpt-test\r\n"]) {
    const cases = [
      [cli(root({ ...MODELS, codex: { model: bad, reasoning: "default" } }), home()), /^config: codex\.model in config\/models\.json must be a single token$/],
      [cli(root({ ...MODELS, codex: { model: "default", reasoning: bad } }), home()), /^config: codex\.reasoning in config\/models\.json must be a single token$/],
      [cli(root(), home({ codex: { model: bad } })), /^config: codex\.model in ~\/\.verus-skills\/config\.json must be a single token$/],
      [cli(root(), home({ codex: { reasoning: bad } })), /^config: codex\.reasoning in ~\/\.verus-skills\/config\.json must be a single token$/],
      [cli(root(), home(), { REVIEWER_CODEX_MODEL: bad }), /^config: REVIEWER_CODEX_MODEL must be a single token$/],
      [cli(root(), home(), { REVIEWER_CODEX_REASONING: bad }), /^config: REVIEWER_CODEX_REASONING must be a single token$/],
    ];
    for (const [res, re] of cases) {
      assert.equal(res.status, 1, JSON.stringify(bad));
      assert.match(res.stderr.trimEnd(), re);
      assert.equal(res.stdout, "");
      assert.ok(!res.stderr.includes("gpt-x") && !res.stderr.includes("evil"), JSON.stringify(res.stderr));
    }
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
// One token: a subagent model is written verbatim into YAML frontmatter by
// `make models`; a Codex model or effort travels as one line of the CLI output
// and is interpolated into the Orca `--command` string by reviewer.sh.
const MODEL_TOKEN = /^[\w.:[\]-]+$/;

const isObj = (v) => v !== null && typeof v === "object" && !Array.isArray(v);
const nonEmpty = (v) => typeof v === "string" && v.trim().length > 0;
const pick = (...vals) => vals.find(nonEmpty);

export function localPath(home = homedir()) {
  return path.join(home, ".verus-skills", "config.json");
}

// Walks objects and arrays alike: `extra: [{ apiKey: … }]` is as much a secret as `judge.apiKey`.
function findSecretKey(obj, prefix = "") {
  if (Array.isArray(obj)) {
    for (let i = 0; i < obj.length; i++) {
      const inner = findSecretKey(obj[i], `${prefix}[${i}]`);
      if (inner) return inner;
    }
    return null;
  }
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
  for (const f of ["model", "reasoning"]) {
    const v = cfg.codex[f];
    if (!nonEmpty(v) || !MODEL_TOKEN.test(v)) throw new Error(`codex.${f} in config/models.json must be a single token`);
  }
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
      if (v === undefined) continue;
      if (!nonEmpty(v)) throw new Error(`${section}.${f} in ${LOCAL_DISPLAY} must be a non-empty string`);
      if (section === "codex" && !MODEL_TOKEN.test(v)) throw new Error(`${section}.${f} in ${LOCAL_DISPLAY} must be a single token`);
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

// An env override gets the same single-token rule as the two files; the error
// names the variable, never its value.
function codexEnv(env, name) {
  const v = env[name];
  if (!nonEmpty(v)) return undefined;
  if (!MODEL_TOKEN.test(v)) throw new Error(`${name} must be a single token`);
  return v;
}

export function resolveCodex(env = process.env, { home = homedir(), root = REPO_ROOT } = {}) {
  const repo = loadModels(root);
  const local = loadLocal(home)?.data ?? {};
  return {
    model: pick(codexEnv(env, "REVIEWER_CODEX_MODEL"), local.codex?.model, repo.codex.model) ?? "default",
    reasoning: pick(codexEnv(env, "REVIEWER_CODEX_REASONING"), local.codex?.reasoning, repo.codex.reasoning) ?? "default",
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
Expected: PASS, 17 tests.

- [ ] **Step 6: Run the whole suite**

Run: `npm test`
Expected: PASS (181 existing + 17 new).

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
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
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

test("make models writes nothing when an agent file is missing or malformed, even with a valid change pending", () => {
  const cases = [
    ["worker", (f) => rmSync(f), /agents\/verus-worker\.md is missing/],
    ["reviewer", (f) => writeFileSync(f, readFileSync(f, "utf8").replace(/^---\n[\s\S]*?\n---\n/, "")), /agents\/verus-reviewer\.md: no frontmatter/],
    ["explorer", (f) => writeFileSync(f, readFileSync(f, "utf8").replace(/^model: .*\n/m, "")), /agents\/verus-explorer\.md: frontmatter has no model: line/],
  ];
  const snapshot = (r) => TIERS.map((t) => (existsSync(agentFile(r, t)) ? readFileSync(agentFile(r, t), "utf8") : null));
  for (const [tier, damage, re] of cases) {
    const r = sandbox();
    const cfg = JSON.parse(readFileSync(path.join(r, "config/models.json"), "utf8"));
    for (const t of TIERS) cfg.subagents[t].effort = "low"; // a valid change pending for every tier
    writeFileSync(path.join(r, "config/models.json"), JSON.stringify(cfg));
    damage(agentFile(r, tier));
    const before = snapshot(r);
    const res = run(r);
    assert.equal(res.status, 1, tier);
    assert.match(res.stderr, re);
    assert.deepEqual(snapshot(r), before, `${tier}: an agent file changed`);
  }
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
// frontmatter of agents/verus-<tier>.md. Validates the config and renders every
// agent first, and writes nothing on any validation error.
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
Expected: PASS (6 new model tests, plugin tests including the new one).

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
- Modify: `scripts/reviewer.sh` (argument parsing lines 7-19; config lines 40-69; session default line 97; report-completion helpers lines 106-124; Orca success path lines 174-179; codex exec line 193)
- Delete: `config/reviewer.json`
- Modify: `tests/reviewer.test.mjs` (helpers `run`, `closeSession` and `cfgTree`; the report-content assertions; tests listed below)
- Modify: `tests/fixtures/fake-bin/orca` (end marker; knobs `FAKE_ORCA_REPORT_CHUNKS`, `FAKE_ORCA_NO_MARKER`, `FAKE_ORCA_CLOSE_FAIL`)
- Modify: `skills/plan-review/reviewer.md`, `skills/review/reviewer.md` (the end-marker instruction; this repo's own skills, so no `make repatch`)

**Interfaces:**
- Consumes: `node scripts/config.mjs codex` (Task 1) — two lines, model then effort; exit 1 with a `config: …` line on error, including a Codex value that is not a single token.
- Produces:
  - `reviewer.sh --close-session <file>`: closes the Orca terminal whose handle the file holds (`orca terminal close --terminal <handle> --json`), deletes the file, exits 0; a missing file or an already-closed terminal (`terminal close` failing) is also exit 0. No other argument is required in this mode.
  - Without `--session-file` a run never reuses a terminal, and closes the one it created once the report is complete.
  - With `--session-file <file>` a successful run writes the handle to the file and leaves the terminal open.
  - The Orca path counts a report as complete only once the file contains the line `<!-- end of review -->` (`END_MARKER`); a report without it inside the budget falls back to `codex exec`, and the unfinished report is deleted first. The `codex exec` path keeps "process exited + report non-empty".
  - Both `reviewer.md` prompts end the report template with `<!-- end of review -->` and say: ``End the report with this exact last line: `<!-- end of review -->` ``.
  - A Codex value that is not a single token exits 1 before any reviewer starts — through `config.mjs` with node, through the same check in bash without it (`config: REVIEWER_CODEX_MODEL must be a single token`).
  - Without `node`: stderr line `node not found; Orca path disabled, config ignored (env or default only)`.

- [ ] **Step 1: Update the test helpers**

In `tests/reviewer.test.mjs`, give `run` an `opts.extraArgs` array appended after the fixed arguments:

```js
  const args = [opts.script ?? SCRIPT, "--prompt-file", prompt, "--output", opts.output ?? "docs/reviews/out.md",
    "--title", "t", "--repo", opts.repo ?? dir, "--timeout-min", opts.timeoutMin ?? "1", ...(opts.extraArgs ?? [])];
```

Add, below `run`:

```js
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
```

In `prefers Orca when available`, `answers the Codex directory-trust prompt and stays on the Orca path` and `waits the full budget for a report that arrives late`, replace the report-content assertion

```js
  assert.equal(readFileSync(path.join(dir, "docs/reviews/out.md"), "utf8").trim(), "orca report");
```

with

```js
  assert.equal(readFileSync(path.join(dir, "docs/reviews/out.md"), "utf8"), ORCA_REPORT);
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

test("--close-session exits 0 and removes the file when the terminal is already gone", () => {
  const dir = repo();
  const session = path.join(dir, "s3");
  writeFileSync(session, "term-dead\n");
  const r = closeSession(dir, session, ["orca"], { FAKE_ORCA_CLOSE_FAIL: "1" });
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.log, /terminal close --terminal term-dead --json/);
  assert.ok(!existsSync(session));
});
```

Add the end-marker tests:

```js
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

test("both reviewer prompts end the report with the marker reviewer.sh waits for", () => {
  assert.match(readFileSync(SCRIPT, "utf8"), /^END_MARKER='<!-- end of review -->'$/m);
  for (const skill of ["plan-review", "review"]) {
    const body = readFileSync(fileURLToPath(new URL(`../skills/${skill}/reviewer.md`, import.meta.url)), "utf8");
    assert.match(body, /End the report with this exact last line: `<!-- end of review -->`/, skill);
    assert.match(body, /\n<!-- end of review -->\n```\n/, `${skill}: the report template ends with the marker`);
  }
});
```

In `prefers Orca when available`, add at the end:

```js
  assert.match(r.log, /terminal close --terminal term-1/); // no --session-file: closed after the report
```

- [ ] **Step 4: Run the tests to verify they fail**

Run: `node --test tests/reviewer.test.mjs`
Expected: FAIL — among others, the default-flags tests (`-m gpt-6-astra` still passed), the session tests (`terminal close` missing), `--close-session` (`unknown arg`), the report-content assertions (no end marker yet), the single-token test (exit 0), and the end-marker prompt test.

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
  # The single-token rule config.mjs applies (/^[\w.:[\]-]+$/); the value is never echoed.
  TOKEN_RE='^[][A-Za-z0-9_.:-]+$'
  [[ "$CODEX_MODEL" =~ $TOKEN_RE ]] || { echo "config: REVIEWER_CODEX_MODEL must be a single token" >&2; exit 1; }
  [[ "$CODEX_REASONING" =~ $TOKEN_RE ]] || { echo "config: REVIEWER_CODEX_REASONING must be a single token" >&2; exit 1; }
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

Replace the success branch and its fallback message (lines 174-179):

```bash
        if wait_for_report_end "$REMAIN"; then
          if [ -n "$SESSION_FILE" ]; then
            echo "$HANDLE" > "$SESSION_FILE"   # kept for this review's round 2
          elif [ -n "$CREATED_HANDLE" ]; then
            orca terminal close --terminal "$CREATED_HANDLE" --json >/dev/null 2>&1 || true
          fi
          echo "reviewer: orca"
          exit 0
        fi
        echo "orca: no report produced (end marker missing), falling back" >&2
```

- [ ] **Step 8: Accept an Orca report only once it carries the end marker**

In `scripts/reviewer.sh`, replace lines 106-124 (the stable-size comment, `output_size` and `wait_for_output`) with:

```bash
# The reviewer streams the report and can pause between writes long enough for
# the TUI to look idle, so neither "the file exists" nor "its size held still"
# means "finished". reviewer.md makes every reviewer end the report with
# END_MARKER as its last line; the Orca path accepts the report — and only then
# closes a session-less terminal — once that line is in the file.
END_MARKER='<!-- end of review -->'
report_complete() { grep -qxF "$END_MARKER" "$REPO/$OUTPUT" 2>/dev/null; }
wait_for_report_end() { # poll for the end marker for N seconds
  local deadline=$(( $(date +%s) + $1 ))
  while [ "$(date +%s)" -lt "$deadline" ]; do
    report_complete && return 0
    sleep 5
  done
  report_complete
}
```

Replace `tests/fixtures/fake-bin/orca` with:

```bash
#!/usr/bin/env bash
# Fake Orca CLI: records calls, writes the report when a prompt is sent. A complete
# report ends with the line reviewer.sh waits for, <!-- end of review -->.
# Env knobs:
#   FAKE_ORCA_REACHABLE=false    -> `status --json` reports runtime.reachable=false
#   FAKE_ORCA_TRUST_PROMPT=1     -> `terminal read` shows Codex's directory-trust
#                                   prompt until a `--text 1 --enter` send happened
#   FAKE_ORCA_STUCK_PROMPT=1     -> `terminal show` keeps reporting
#                                   agentWait.reason=agent-interactive-prompt
#   FAKE_ORCA_REPORT_DELAY=<sec> -> the report is written <sec> seconds after the
#                                   send, by a backgrounded subshell
#   FAKE_ORCA_REPORT_CHUNKS=1    -> the report is written in two chunks: the first,
#                                   without the end marker, at once; the rest, ending
#                                   with the marker, 7 seconds later (longer than one
#                                   poll). Each chunk logs "report chunk <n> written".
#   FAKE_ORCA_NO_MARKER=1        -> the report is written at once, without the marker
#   FAKE_ORCA_CLOSE_FAIL=1       -> `terminal close` exits 1 (the terminal is gone)
END_MARKER='<!-- end of review -->'
echo "orca $*" >> "${FAKE_LOG:?}"
case "$1 $2" in
  "status "*)
    if [ "${FAKE_ORCA_REACHABLE:-true}" = "false" ]; then
      echo '{"ok":true,"result":{"runtime":{"reachable":false}}}'
    else
      echo '{"ok":true,"result":{"runtime":{"reachable":true}}}'
    fi;;
  "terminal create") echo '{"ok":true,"result":{"terminal":{"handle":"term-1"}}}';;
  "terminal show")
    if [ "${FAKE_ORCA_STUCK_PROMPT:-}" = "1" ]; then
      echo '{"ok":true,"result":{"terminal":{"handle":"term-1","agentWait":{"source":"prompt-text","reason":"agent-interactive-prompt"}}}}'
    else
      echo '{"ok":true,"result":{"terminal":{"handle":"term-1"}}}'
    fi;;
  "terminal read")
    if [ "${FAKE_ORCA_TRUST_PROMPT:-}" = "1" ] && ! grep -q -- '--text 1 --enter' "$FAKE_LOG"; then
      echo '{"ok":true,"result":{"screen":{"text":"Do you trust the contents of this directory? 1. Yes, continue  2. No, quit"}}}'
    else
      echo '{"ok":true,"result":{"screen":{"text":"codex ready"}}}'
    fi;;
  "terminal wait") echo '{"ok":true,"result":{"wait":{"satisfied":true}}}';;
  "terminal close")
    if [ "${FAKE_ORCA_CLOSE_FAIL:-}" = "1" ]; then
      echo '{"ok":false,"error":{"message":"terminal not found"}}'
      exit 1
    fi
    echo '{"ok":true}';;
  "terminal send")
    # extract the report path from the prompt text and create it
    out=$(printf '%s\n' "$@" | grep -o 'Write the report to [^ ]*' | awk '{print $5}')
    if [ -n "$out" ]; then
      mkdir -p "$(dirname "$out")"
      if [ "${FAKE_ORCA_REPORT_CHUNKS:-}" = "1" ]; then
        printf 'orca report, part 1\n' > "$out"
        echo "report chunk 1 written" >> "$FAKE_LOG"
        ( sleep 7; printf 'part 2\n%s\n' "$END_MARKER" >> "$out"; echo "report chunk 2 written" >> "$FAKE_LOG" ) >/dev/null 2>&1 &
      elif [ "${FAKE_ORCA_NO_MARKER:-}" = "1" ]; then
        printf 'orca report\n' > "$out"
      else
        case "${FAKE_ORCA_REPORT_DELAY:-0}" in
          ''|0|*[!0-9]*) printf 'orca report\n%s\n' "$END_MARKER" > "$out";;
          *) ( sleep "$FAKE_ORCA_REPORT_DELAY"; printf 'orca report\n%s\n' "$END_MARKER" > "$out" ) >/dev/null 2>&1 &;;
        esac
      fi
    fi
    echo '{"ok":true,"result":{"accepted":true}}';;
  *) echo '{"ok":true}';;
esac
exit 0
```

In `skills/plan-review/reviewer.md`, add `<!-- end of review -->` as the last line inside the report template fence, after `<one short paragraph each, "No issues found" when clean>`, and replace the final line `Do not edit the plan or any other file. Do not run tests or builds. Do not print the report to stdout; write the file and stop.` with:

```markdown
End the report with this exact last line: `<!-- end of review -->` — write it once, after everything else. The launcher treats the report as finished only when that line is in the file, so a report without it is discarded.

Do not edit the plan or any other file. Do not run tests or builds. Do not print the report to stdout; write the file and stop.
```

In `skills/review/reviewer.md`, add `<!-- end of review -->` as the last line inside the report template fence, after `<for each deferred/parked line: BLOCKS MERGE or OK, one clause why; "None" if no ledger lines were given>`, and replace the final line `Do not edit any file except the report. Do not print the report to stdout; write the file and stop.` with:

```markdown
End the report with this exact last line: `<!-- end of review -->` — write it once, after everything else. The launcher treats the report as finished only when that line is in the file, so a report without it is discarded.

Do not edit any file except the report. Do not print the report to stdout; write the file and stop.
```

- [ ] **Step 9: Build the codex exec arguments conditionally**

Replace line 193 with:

```bash
  rm -f "$REPO/$OUTPUT"   # an unfinished Orca report must never pass as codex's
  EXEC_ARGS=(exec -C "$REPO")
  [ "$CODEX_MODEL" != "default" ] && EXEC_ARGS+=(-m "$CODEX_MODEL")
  EXEC_ARGS+=(-s workspace-write --enable web_search_cached)
  [ "$CODEX_REASONING" != "default" ] && EXEC_ARGS+=(-c "model_reasoning_effort=$CODEX_REASONING")
  EXEC_ARGS+=(-)
  ( cd "$REPO" && codex "${EXEC_ARGS[@]}" < "$REPO/$PROMPT_REL" > "$LOG" 2>&1 ) &
```

- [ ] **Step 10: Delete the old config file**

Run: `git rm config/reviewer.json`

- [ ] **Step 11: Run the tests to verify they pass**

Run: `node --test tests/reviewer.test.mjs`
Expected: PASS.

- [ ] **Step 12: Run the whole suite, then commit**

Run: `npm test` → PASS. Run `grep -rn "reviewer.json" scripts tests` → no match (README is updated in Task 9). Run `grep -n "wait_for_output\|output_size" scripts/reviewer.sh` → no match.

```bash
git add scripts/reviewer.sh tests/reviewer.test.mjs tests/fixtures/fake-bin/orca skills/plan-review/reviewer.md skills/review/reviewer.md config/reviewer.json
git commit -m "feat(reviewer): models config, default flags, end marker, one Orca terminal per review, --close-session"
```

---

### Task 4: The judge — model and key from the config, redacted errors

**Files:**
- Modify: `scripts/typesafe-judge.mjs` (imports; `judge()`; `main()`)
- Modify: `tests/judge.test.mjs` (imports; the `runCli` helper; the missing-key test; the missing-`config/judge.json` test; append)
- Modify: `tests/vendor-sdk.test.mjs` (the three tests that copy the judge into a temp root)

**Interfaces:**
- Consumes: `resolveJudgeModel`, `resolveApiKey`, `loadLocal`, `redact` from `scripts/config.mjs` (Task 1).
- Produces: `judge(input, { client, choice, noul, threshold, sufficiencyThreshold, model })` — when `model` is a non-empty string, `client.systemOne` receives `{ state, questions, model }`; otherwise `{ state, questions }` as today. `failureMessage(err: Error, apiKey: string | null): string` — `judge failed: <message with the key replaced by [redacted]>`. `redactingLogger(apiKey: string, write?: (line: string) => void): { debug, info, warn, error }` — every method formats its arguments into one line, replaces the key with `[redacted]` and writes it to stderr (or `write`). The CLI builds `new TypeSafeClient({ apiKey, logLevel, logger: redactingLogger(apiKey) })` with `logLevel` = `TYPESAFE_LOG_LEVEL` if set, else `"off"`, the resolved key and sends the resolved model in every `POST /v1/systemone` body; the SDK still takes its endpoint from `TYPESAFE_BASE_URL`, which the CLI tests point at a local `node:http` server.

- [ ] **Step 1: Write the failing tests**

In `tests/judge.test.mjs`, replace the import block at the top (lines 1-8) with:

```js
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { chmodSync, copyFileSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { judge, validate, buildState, buildQuestions, formatDecision, failureMessage, redactingLogger } from "../scripts/typesafe-judge.mjs";

const TEMP_DIRS = [];
function tmp(prefix) {
  const d = realpathSync(mkdtempSync(path.join(tmpdir(), prefix)));
  TEMP_DIRS.push(d);
  return d;
}
after(() => { for (const d of TEMP_DIRS) rmSync(d, { recursive: true, force: true }); });
```

Replace the CLI comment and the `runCli` helper (lines 305-319) with:

```js
// --- CLI: every run gets a throwaway HOME, so ~/.verus-skills is never the user's,
// and an env stripped of the user's TypeSafe key, model, endpoint and log level.
// A run that gets past the key guard talks only to the local fake server below;
// no test can reach the TypeSafe API.
const SCRIPT = fileURLToPath(new URL("../scripts/typesafe-judge.mjs", import.meta.url));

function cliEnv(env = {}, home) {
  const { TYPESAFE_API_KEY, TYPESAFE_DEFAULT_MODEL, TYPESAFE_BASE_URL, TYPESAFE_LOG_LEVEL, ...clean } = process.env;
  return { ...clean, HOME: home ?? tmp("judge-home-"), ...env };
}

function runCli({ args = [], stdin = "{}", env = {}, cwd, home } = {}) {
  return spawnSync(process.execPath, [cwd ? path.join(cwd, "scripts", "typesafe-judge.mjs") : SCRIPT, ...args], {
    input: stdin,
    encoding: "utf8",
    timeout: 20000,
    env: cliEnv(env, home),
  });
}
```

Replace the test `CLI exits 2 when TYPESAFE_API_KEY is missing` (lines 321-325) with:

```js
test("CLI exits 2 when no key is set anywhere, naming both places", () => {
  const r = runCli({});
  assert.equal(r.status, 2);
  assert.match(r.stderr, /TypeSafe API key not found \(TYPESAFE_API_KEY or ~\/\.verus-skills\/config\.json\); judge unavailable/);
});
```

In the test `CLI exits 2 when config/judge.json is missing`, replace the two copy lines

```js
  mkdirSync(path.join(dir, "scripts"), { recursive: true });
  copyFileSync(SCRIPT, path.join(dir, "scripts", "typesafe-judge.mjs"));
```

with the judge's dependencies — `config/judge.json` stays absent on purpose — and pin the failure to that file:

```js
  mkdirSync(path.join(dir, "scripts"), { recursive: true });
  mkdirSync(path.join(dir, "config"), { recursive: true });
  copyFileSync(SCRIPT, path.join(dir, "scripts", "typesafe-judge.mjs"));
  // The judge imports ./config.mjs and reads config/models.json; without them it would
  // fail at module loading, before the judge.json read this test is about.
  copyFileSync(path.join(path.dirname(SCRIPT), "config.mjs"), path.join(dir, "scripts", "config.mjs"));
  copyFileSync(path.join(path.dirname(SCRIPT), "..", "config", "models.json"), path.join(dir, "config", "models.json"));
```

and add, after its `assert.match(r.stderr, /judge failed:/);` line:

```js
  assert.match(r.stderr, /judge\.json/);
  assert.doesNotMatch(r.stderr, /config\.mjs|ERR_MODULE_NOT_FOUND/);
```

Append:

```js
const JUDGE_SECRET = "ts_DUMMY_SECRET_123";
const JUDGE_INPUT = JSON.stringify({ question: "q", options: [{ id: "A", label: "a" }, { id: "B", label: "b" }], context: "c", recommended: "A" });
// The body POST /v1/systemone answers with (vendor-node/@typesafe-ai/sdk: systemOne returns it as parsed).
const OK_REPLY = {
  status: 200,
  json: {
    answers: {
      answer: { type: "choice", choice: "A", confidence: 0.9, probabilities: { A: 0.9, B: 0.1 } },
      sufficiency: { type: "noul", noul: 0.9 },
    },
  },
};

function judgeHome(local, mode = 0o600) {
  const h = tmp("judge-home-");
  if (local !== undefined) {
    mkdirSync(path.join(h, ".verus-skills"), { recursive: true });
    const f = path.join(h, ".verus-skills/config.json");
    writeFileSync(f, typeof local === "string" ? local : JSON.stringify(local));
    chmodSync(f, mode);
  }
  return h;
}

// A local stand-in for the TypeSafe API on 127.0.0.1: records every request and
// answers each one with `reply` ({ status, json }).
async function fakeTypeSafe(reply) {
  const seen = [];
  const server = createServer((req, res) => {
    let body = "";
    req.on("data", (d) => { body += d; });
    req.on("end", () => {
      seen.push({ method: req.method, url: req.url, authorization: req.headers.authorization, body: JSON.parse(body) });
      res.writeHead(reply.status, { "content-type": "application/json" });
      res.end(JSON.stringify(reply.json));
    });
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  return {
    url: `http://127.0.0.1:${server.address().port}`,
    seen,
    close: () => new Promise((resolve) => server.close(resolve)),
  };
}

// Asynchronous on purpose: spawnSync would block this process, and with it the fake server.
function runCliAsync({ stdin = JUDGE_INPUT, env = {}, home } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [SCRIPT], { env: cliEnv(env, home) });
    let stdout = "";
    let stderr = "";
    const timer = setTimeout(() => child.kill(), 20000);
    child.stdout.on("data", (d) => { stdout += d; });
    child.stderr.on("data", (d) => { stderr += d; });
    child.on("error", reject);
    child.on("close", (status) => { clearTimeout(timer); resolve({ status, stdout, stderr }); });
    child.stdin.end(stdin);
  });
}

test("judge passes an explicit model to systemOne and omits it otherwise", async () => {
  const seen = [];
  const client = {
    systemOne: async (req) => {
      seen.push(req);
      return {
        answers: {
          answer: { type: "choice", choice: "A", confidence: 0.82, probabilities: { A: 0.9, B: 0.1 } },
          sufficiency: { type: "noul", noul: 0.71 },
        },
      };
    },
  };
  const withModel = await judge(input, deps(client, { model: "jev-test" }));
  const without = await judge(input, deps(client));
  assert.equal(withModel.choice, "A");
  assert.equal(without.choice, "A");
  assert.equal(seen[0].model, "jev-test");
  assert.equal("model" in seen[1], false);
});

test("CLI sends the local key and the resolved model to TypeSafe and prints the result", async (t) => {
  const api = await fakeTypeSafe(OK_REPLY);
  t.after(api.close);
  // Only the local file holds a key; the environment has none.
  const home = judgeHome({ typesafe: { apiKey: JUDGE_SECRET }, judge: { model: "jev-local" } });
  const r = await runCliAsync({ home, env: { TYPESAFE_BASE_URL: api.url } });
  assert.equal(r.status, 0, r.stderr);
  assert.equal(api.seen.length, 1);
  assert.equal(api.seen[0].method, "POST");
  assert.equal(api.seen[0].url, "/v1/systemone");
  assert.equal(api.seen[0].authorization, `Bearer ${JUDGE_SECRET}`);
  assert.equal(api.seen[0].body.model, "jev-local");
  const out = JSON.parse(r.stdout);
  assert.equal(out.choice, "A");
  assert.equal(out.accepted, true);
  assert.ok(!r.stdout.includes(JUDGE_SECRET) && !r.stderr.includes(JUDGE_SECRET));
});

test("CLI: env key and env model win over the local file in the real request", async (t) => {
  const api = await fakeTypeSafe(OK_REPLY);
  t.after(api.close);
  const home = judgeHome({ typesafe: { apiKey: JUDGE_SECRET }, judge: { model: "jev-local" } });
  const r = await runCliAsync({
    home,
    env: { TYPESAFE_BASE_URL: api.url, TYPESAFE_API_KEY: "ts_ENV_KEY_456", TYPESAFE_DEFAULT_MODEL: "jev-env" },
  });
  assert.equal(r.status, 0, r.stderr);
  assert.equal(api.seen[0].authorization, "Bearer ts_ENV_KEY_456");
  assert.equal(api.seen[0].body.model, "jev-env");
  assert.equal(JSON.parse(r.stdout).choice, "A");
});

test("CLI: a TypeSafe error that echoes the key exits 2, and real stderr carries it redacted", async (t) => {
  // 400 is not retried by the SDK, so the run makes exactly one request.
  const api = await fakeTypeSafe({ status: 400, json: { error: `invalid key ${JUDGE_SECRET}` } });
  t.after(api.close);
  const r = await runCliAsync({ home: judgeHome({ typesafe: { apiKey: JUDGE_SECRET } }), env: { TYPESAFE_BASE_URL: api.url } });
  assert.equal(r.status, 2);
  assert.equal(api.seen.length, 1);
  assert.match(r.stderr, /judge failed: 400 invalid key \[redacted\]/);
  assert.ok(!r.stderr.includes(JUDGE_SECRET) && !r.stdout.includes(JUDGE_SECRET), r.stderr);
});

test("CLI: a broken local file exits 2, names the file, and never leaks the secret", () => {
  const r = runCli({ stdin: JUDGE_INPUT, home: judgeHome(`{"typesafe": {"apiKey": ${JUDGE_SECRET}}}`) });
  assert.equal(r.status, 2);
  assert.match(r.stderr, /invalid JSON in ~\/\.verus-skills\/config\.json/);
  assert.ok(!r.stderr.includes(JUDGE_SECRET) && !r.stdout.includes(JUDGE_SECRET));
});

test("CLI: an insecure local key file draws a warning and still works", async (t) => {
  const api = await fakeTypeSafe(OK_REPLY);
  t.after(api.close);
  const r = await runCliAsync({ home: judgeHome({ typesafe: { apiKey: JUDGE_SECRET } }, 0o644), env: { TYPESAFE_BASE_URL: api.url } });
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stderr, /readable by group or others; chmod 600/);
  assert.ok(!r.stderr.includes(JUDGE_SECRET));
});

test("failureMessage replaces every occurrence of the key", () => {
  const msg = failureMessage(new Error(`401 for key ${JUDGE_SECRET} (retry with ${JUDGE_SECRET})`), JUDGE_SECRET);
  assert.equal(msg, "judge failed: 401 for key [redacted] (retry with [redacted])");
  assert.equal(failureMessage(new Error("boom"), null), "judge failed: boom");
});

test("redactingLogger writes one redacted line per call, for every level and argument type", () => {
  const lines = [];
  const log = redactingLogger(JUDGE_SECRET, (line) => lines.push(line));
  log.debug("request", { headers: { authorization: `Bearer ${JUDGE_SECRET}` } });
  log.info(`key=${JUDGE_SECRET}`);
  log.warn("retrying", 2);
  log.error(new Error(`401 for ${JUDGE_SECRET}`));
  const circular = {};
  circular.self = circular;
  log.debug("cycle", circular);
  assert.equal(lines.length, 5);
  assert.ok(lines.every((l) => !l.includes(JUDGE_SECRET) && !l.includes("\n")), lines.join("\n"));
  assert.match(lines[0], /^\[typesafe-sdk debug\] request .*Bearer \[redacted\]/);
  assert.match(lines[2], /^\[typesafe-sdk warn\] retrying 2$/);
  assert.match(lines[3], /401 for \[redacted\]/);
});

test("CLI: with TYPESAFE_LOG_LEVEL=debug an error body holding the key reaches neither stream", async (t) => {
  const api = await fakeTypeSafe({ status: 400, json: { error: `invalid key ${JUDGE_SECRET}` } });
  t.after(api.close);
  const r = await runCliAsync({
    home: judgeHome({ typesafe: { apiKey: JUDGE_SECRET } }),
    env: { TYPESAFE_BASE_URL: api.url, TYPESAFE_LOG_LEVEL: "debug" },
  });
  assert.equal(r.status, 2);
  assert.equal(r.stdout, "");
  assert.ok(!r.stderr.includes(JUDGE_SECRET), r.stderr);
});

test("CLI: with TYPESAFE_LOG_LEVEL=debug a success still prints exactly one JSON line on stdout", async (t) => {
  const api = await fakeTypeSafe(OK_REPLY);
  t.after(api.close);
  const r = await runCliAsync({
    home: judgeHome({ typesafe: { apiKey: JUDGE_SECRET } }),
    env: { TYPESAFE_BASE_URL: api.url, TYPESAFE_LOG_LEVEL: "debug" },
  });
  assert.equal(r.status, 0, r.stderr);
  const out = r.stdout.trimEnd().split("\n");
  assert.equal(out.length, 1, r.stdout);
  assert.equal(JSON.parse(out[0]).choice, "A");
  assert.ok(!r.stderr.includes(JUDGE_SECRET) && !r.stdout.includes(JUDGE_SECRET));
});

test("CLI: without TYPESAFE_LOG_LEVEL the SDK logs nothing", async (t) => {
  const api = await fakeTypeSafe(OK_REPLY);
  t.after(api.close);
  const r = await runCliAsync({ home: judgeHome({ typesafe: { apiKey: JUDGE_SECRET } }), env: { TYPESAFE_BASE_URL: api.url } });
  assert.equal(r.status, 0, r.stderr);
  assert.equal(r.stderr, "");
});
```

`cliEnv` already drops an inherited `TYPESAFE_LOG_LEVEL`, so the last test does not depend on the developer's shell.

`input` and `deps` are the fixtures already defined at the top of `tests/judge.test.mjs`.

- [ ] **Step 2: Run the tests to verify they fail**

Run: `node --test tests/judge.test.mjs`
Expected: FAIL — the module fails to load because `failureMessage` and `redactingLogger` are not exported. Once it is, before Steps 3-4: `seen[0].model` is undefined; the guard message still says only `TYPESAFE_API_KEY is not set`; the local-key HTTP tests exit 2 at that guard without sending a request.

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

// The SDK's own logger prints info/debug to stdout (breaking the one-line JSON contract)
// and debug-logs request/response data; this one keeps every line on stderr, key redacted.
function logArg(a) {
  if (typeof a === "string") return a;
  if (a instanceof Error) return a.message;
  try {
    return JSON.stringify(a) ?? String(a);
  } catch {
    return String(a);
  }
}

export function redactingLogger(apiKey, write = (line) => process.stderr.write(line + "\n")) {
  const at = (level) => (...args) =>
    write(`[typesafe-sdk ${level}] ${redact(args.map(logArg).join(" "), apiKey).replace(/[\r\n]+/g, " ")}`);
  return { debug: at("debug"), info: at("info"), warn: at("warn"), error: at("error") };
}
```

Replace the final `try { … } catch` in `main()`:

```js
  try {
    const { TypeSafeClient, choice, noul } = await loadSdk();
    // SDK logging is off unless TYPESAFE_LOG_LEVEL asks for it; then it goes to stderr, redacted.
    // Its default logger would write info/debug to stdout (breaking the JSON) and debug-logs error bodies.
    const logLevel = process.env.TYPESAFE_LOG_LEVEL?.trim() || "off";
    const client = new TypeSafeClient({ apiKey, logLevel, logger: redactingLogger(apiKey) });
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
- Modify: `tests/install.test.mjs` (imports; `distroRepo()`; `assertSingleInstallOf()`; the two re-install tests; append)

**Interfaces:**
- Consumes: the `agents/verus-*.md` files (Task 2); `resolveApiKey` from `scripts/config.mjs` (Task 1).
- Produces, exported from `scripts/install.mjs`: `agentNames(repoRoot): string[]` (file names like `verus-worker.md`), `agentCollisions(repoRoot, targetDir): string[]` (absolute paths of foreign entries: a regular file, or a link to an existing target that is neither under `repoRoot` nor inside another existing distro checkout; a dangling link is never one), `linkAgents(repoRoot, targetDir): { linked: string[], repointed: { name, from }[], replaced: string[] }` (`replaced`: names whose dangling link was replaced), `unlinkAgents(repoRoot, targetDir): { removed: string[] }`.
- `make install` prints `claude agents: replaced dangling link: <name>` for each replaced dangling link.

- [ ] **Step 1: Write the failing tests**

In `tests/install.test.mjs`, extend the `node:fs` import with `lstatSync` and `readdirSync`, and merge `agentNames, agentCollisions, linkAgents, unlinkAgents` into the existing import from `../scripts/install.mjs`:

```js
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, readlinkSync, symlinkSync, rmSync, copyFileSync, realpathSync, lstatSync, readdirSync } from "node:fs";
import { linkSkills, unlinkSkills, ensureHook, removeHook, ensureAgentsLine, removeAgentsLine, HOOK_MARKER, REPO_ROOT, pluginInstalled, parseArgs, agentNames, agentCollisions, linkAgents, unlinkAgents } from "../scripts/install.mjs";
```

Replace `distroRepo()` so a copied checkout carries the installer's import and its own agents:

```js
const AGENT_FILES = ["verus-explorer.md", "verus-reviewer.md", "verus-worker.md"];

// A self-contained distro checkout: what `isDistroCheckout` looks for
// (sources.yaml + scripts/install.mjs), a runnable installer with the
// scripts/config.mjs it imports, two skills and the three agent files.
function distroRepo() {
  const root = tmp("distro-");
  mkdirSync(path.join(root, "scripts"), { recursive: true });
  copyFileSync(INSTALLER, path.join(root, "scripts", "install.mjs"));
  copyFileSync(path.join(REPO_ROOT, "scripts", "config.mjs"), path.join(root, "scripts", "config.mjs"));
  writeFileSync(path.join(root, "sources.yaml"), "sources: []\n");
  writeFileSync(path.join(root, "USING.md"), "# using\n");
  for (const s of ["kickoff", "plan-review"]) {
    mkdirSync(path.join(root, "skills", s), { recursive: true });
    writeFileSync(path.join(root, "skills", s, "SKILL.md"), `---\nname: ${s}\n---\n`);
  }
  mkdirSync(path.join(root, "agents"), { recursive: true });
  for (const t of ["worker", "reviewer", "explorer"]) {
    writeFileSync(
      path.join(root, "agents", `verus-${t}.md`),
      `---\nname: verus-${t}\ndescription: fixture ${t} agent of a copied distro checkout\nmodel: opus\neffort: high\n---\n\nFixture.\n`,
    );
  }
  return root;
}
```

In `assertSingleInstallOf(home, root)`, add after the skills loop:

```js
  for (const f of AGENT_FILES) {
    assert.equal(readlinkSync(path.join(home, ".claude", "agents", f)), path.join(root, "agents", f));
  }
```

In `installing from a new checkout after the old one is gone re-points everything`, add after `assert.doesNotMatch(rb.stdout, /SKIPPED/);`:

```js
  for (const f of AGENT_FILES) assert.match(rb.stdout, new RegExp(`claude agents: replaced dangling link: ${f.replace(".", "\\.")}`));
```

In `installing from a second distro checkout re-points links, hook and AGENTS line`, add after `assert.doesNotMatch(rb.stdout, /SKIPPED/);`:

```js
  for (const f of AGENT_FILES) assert.match(rb.stdout, new RegExp(`claude agents: re-pointed from .*: ${f.replace(".", "\\.")}`));
```

Append:

```js
test("agentNames lists the three verus agents", () => {
  assert.deepEqual(agentNames(REPO_ROOT), AGENT_FILES);
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

test("a link into another existing distro checkout is re-pointed, not a collision", () => {
  const target = tmp("agents-");
  const other = distroRepo();
  symlinkSync(path.join(other, "agents", "verus-worker.md"), path.join(target, "verus-worker.md"));
  assert.deepEqual(agentCollisions(REPO_ROOT, target), []);
  const r = linkAgents(REPO_ROOT, target);
  assert.deepEqual(r.repointed, [{ name: "verus-worker.md", from: other }]);
  assert.deepEqual(r.replaced, []);
  assert.equal(readlinkSync(path.join(target, "verus-worker.md")), path.join(REPO_ROOT, "agents", "verus-worker.md"));
});

test("a dangling link on an agent name is replaced, whoever left it", () => {
  const home = tmp("home-");
  const claudeAgents = path.join(home, ".claude", "agents");
  mkdirSync(claudeAgents, { recursive: true });
  const link = path.join(claudeAgents, "verus-worker.md");
  symlinkSync("/missing/agents/verus-worker.md", link);
  assert.deepEqual(agentCollisions(REPO_ROOT, claudeAgents), []);
  const r = runInstaller(["--home", home]);
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /claude agents: replaced dangling link: verus-worker\.md/);
  assert.equal(readlinkSync(link), path.join(REPO_ROOT, "agents", "verus-worker.md"));
});

test("a foreign file, or a link to an existing foreign file, on an agent name refuses the whole install", () => {
  // Shaped like a checkout (<dir>/agents/verus-worker.md), but <dir> is not a distro checkout.
  const foreignDir = tmp("foreign-");
  mkdirSync(path.join(foreignDir, "agents"), { recursive: true });
  const foreignFile = path.join(foreignDir, "agents", "verus-worker.md");
  const FOREIGN = "---\nname: verus-worker\n---\nnot ours\n";
  writeFileSync(foreignFile, FOREIGN);
  for (const plant of [
    (f) => writeFileSync(f, FOREIGN),
    (f) => symlinkSync(foreignFile, f),
  ]) {
    const home = tmp("home-");
    mkdirSync(path.join(home, ".claude", "agents"), { recursive: true });
    const foreign = path.join(home, ".claude", "agents", "verus-worker.md");
    plant(foreign);
    const snapshot = () => (lstatSync(foreign).isSymbolicLink() ? `link:${readlinkSync(foreign)}` : `file:${readFileSync(foreign, "utf8")}`);
    const before = snapshot();
    for (const extra of [[], ["--force"]]) {
      const r = runInstaller(["--home", home, ...extra]);
      assert.equal(r.status, 1, `${extra}: ${r.stdout}`);
      assert.match(r.stderr, /verus-worker\.md is not ours; move it away and re-run/);
      assert.equal(snapshot(), before, "the foreign entry must stay as it was");
      assert.deepEqual(readdirSync(path.join(home, ".claude", "agents")), ["verus-worker.md"]);
      assert.ok(!existsSync(path.join(home, ".claude", "skills")));
      assert.ok(!existsSync(path.join(home, ".claude", "settings.json")));
      assert.ok(!existsSync(path.join(home, ".codex")));
    }
    assert.equal(runInstaller(["--home", home, "--uninstall"]).status, 0);
    assert.equal(snapshot(), before, "uninstall must not remove a foreign entry");
  }
  assert.equal(readFileSync(foreignFile, "utf8"), FOREIGN);
});

test("install links the agents into ~/.claude/agents and uninstall removes them", () => {
  const home = tmp("home-");
  assert.equal(runInstaller(["--home", home]).status, 0);
  for (const f of agentNames(REPO_ROOT)) assert.equal(readlinkSync(path.join(home, ".claude", "agents", f)), path.join(REPO_ROOT, "agents", f));
  assert.equal(runInstaller(["--home", home, "--uninstall"]).status, 0);
  for (const f of agentNames(REPO_ROOT)) assert.ok(!existsSync(path.join(home, ".claude", "agents", f)));
});

test("uninstall from one distro checkout never removes another checkout's agent links", () => {
  const home = tmp("home-");
  const a = distroRepo();
  const b = distroRepo();
  assert.equal(runInstallerFrom(a, ["--home", home, "--skip-plugin"]).status, 0);
  assert.equal(runInstallerFrom(b, ["--home", home, "--skip-plugin"]).status, 0);
  const ua = runInstallerFrom(a, ["--home", home, "--uninstall"]);
  assert.equal(ua.status, 0, ua.stderr);
  assert.match(ua.stdout, /claude agents removed: none/);
  for (const f of AGENT_FILES) assert.equal(readlinkSync(path.join(home, ".claude", "agents", f)), path.join(b, "agents", f));
  const ub = runInstallerFrom(b, ["--home", home, "--uninstall"]);
  assert.equal(ub.status, 0, ub.stderr);
  assert.match(ub.stdout, /claude agents removed: verus-explorer\.md, verus-reviewer\.md, verus-worker\.md/);
  for (const f of AGENT_FILES) assert.throws(() => lstatSync(path.join(home, ".claude", "agents", f)), { code: "ENOENT" });
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
// would dispatch to that foreign agent instead of ours. A dangling link owns
// nothing — it is replaced, never a collision. `existsSync` follows the link, so
// it is checked first; `isDistroCheckout()` treats a missing directory as ours,
// which must never decide an agent link.
export function agentCollisions(repoRoot, targetDir) {
  const foreign = [];
  for (const file of agentNames(repoRoot)) {
    const dst = path.join(targetDir, file);
    if (isSymlink(dst)) {
      if (!existsSync(dst)) continue; // dangling: linkAgents replaces it
      const target = path.resolve(targetDir, readlinkSync(dst));
      if (isUnder(target, repoRoot)) continue;
      const from = distroRootOfAgentLink(target, file);
      if (from && existsSync(from) && isDistroCheckout(from)) continue;
      foreign.push(dst);
    } else if (existsSync(dst)) {
      foreign.push(dst);
    }
  }
  return foreign;
}

export function linkAgents(repoRoot, targetDir) {
  mkdirSync(targetDir, { recursive: true });
  const linked = [], repointed = [], replaced = [];
  for (const file of agentNames(repoRoot)) {
    const src = path.join(repoRoot, "agents", file);
    const dst = path.join(targetDir, file);
    if (isSymlink(dst)) {
      const target = readlinkSync(dst);
      if (target === src) { linked.push(file); continue; }
      if (!existsSync(dst)) replaced.push(file);
      else if (!isUnder(target, repoRoot)) {
        const from = distroRootOfAgentLink(target, file);
        if (from) repointed.push({ name: file, from });
      }
      unlinkSync(dst);
    }
    symlinkSync(src, dst);
    linked.push(file);
  }
  return { linked, repointed, replaced };
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

(`linkAgents` is only called after `agentCollisions` returned nothing, so every existing entry it meets is ours, another existing distro checkout's, or a dangling link.)

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
  for (const name of ag.replaced) console.log(`claude agents: replaced dangling link: ${name}`);
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
- Modify: `skills/review/SKILL.md` (section 0 inputs block: print `SUFFIX`; section 2 launch block; section 4 early stops; section 5; section 6; Rules)
- Modify: `tests/patched-skills.test.mjs` (imports; append)

**Interfaces:**
- Consumes: `reviewer.sh --session-file <file>` and `reviewer.sh --close-session <file>` (Task 3).
- Produces: a `SESSION` value per review, closed before round 1, passed to both rounds, closed when the review ends:
  - `plan-review`: derived from the round-1 report, which is stable per plan — `<repo>/.context/plan-review-<basename of the round-1 REPORT without .md>-session`.
  - `review`: derived from the review scope, not the report — `<repo>/.context/review-<BRANCH with / replaced by -><SUFFIX>-session`, with no date and no `-N`; `SUFFIX` is the value section 0 computes (empty in branch scope, `-all` in codebase scope, `-<path slug>` in path scope). Every run writes a new `-N` report, but the next review of the same branch or paths computes the same SESSION, so its round-1 `--close-session` closes an interrupted review's orphan.

- [ ] **Step 1: Write the failing test**

In `tests/patched-skills.test.mjs`, extend the imports at the top to:

```js
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
```

Append:

```js
const launchBlock = (file) => {
  const body = readFileSync(path.join(root, file), "utf8");
  return body.slice(body.indexOf("## 2. Launch the external reviewer"), body.indexOf("## 3."));
};

test("plan-review and review keep one reviewer session per review", () => {
  const SESSION_RE = {
    "plan-review/SKILL.md": /SESSION="\$\(git rev-parse --show-toplevel\)\/\.context\/plan-review-\$\(basename "\$ROUND1_REPORT" \.md\)-session"/,
    "review/SKILL.md": /SESSION="\$\(git rev-parse --show-toplevel\)\/\.context\/review-\$\(printf '%s' "\$BRANCH" \| tr '\/' '-'\)\$SUFFIX-session"/,
  };
  for (const [file, re] of Object.entries(SESSION_RE)) {
    const body = readFileSync(path.join(root, file), "utf8");
    const launch = launchBlock(file);
    assert.match(launch, re, file);
    assert.match(launch, /\[ "\$ROUND" = 1 \] && bash "\$SKILLS_REPO\/scripts\/reviewer\.sh" --close-session "\$SESSION"/, file);
    assert.match(launch, /--session-file "\$SESSION"/, file);
    const handOff = body.slice(body.indexOf("## 6. Hand off"));
    assert.match(handOff, /--close-session "\$SESSION"/, `${file}: closes the session at the end`);
    assert.match(body, /Whenever this skill stops[^\n]*--close-session/, `${file}: rule for every exit`);
  }
  assert.doesNotMatch(launchBlock("review/SKILL.md"), /ROUND1_REPORT/, "review's session must not depend on a report");
  assert.match(readFileSync(path.join(root, "review/SKILL.md"), "utf8"), /^echo "SUFFIX=\$SUFFIX"$/m, "section 0 prints SUFFIX for section 2");
});

test("review keys its session by branch and scope, so the next review of the same scope finds an interrupted one", () => {
  const line = launchBlock("review/SKILL.md").split("\n").find((l) => l.startsWith("SESSION="));
  assert.ok(line, "no SESSION= line in review's launch block");
  assert.doesNotMatch(line, /REPORT|date/, "the session must not depend on the report name or the date");
  const repo = realpathSync(mkdtempSync(path.join(tmpdir(), "review-session-")));
  try {
    execFileSync("git", ["init", "-q"], { cwd: repo });
    execFileSync("git", ["checkout", "-q", "-b", "feat/x"], { cwd: repo });
    const session = (suffix) =>
      execFileSync("bash", ["-c", `BRANCH="$(git branch --show-current)"\nSUFFIX="${suffix}"\n${line}\nprintf '%s' "$SESSION"`], { cwd: repo, encoding: "utf8" });
    assert.equal(session(""), path.join(repo, ".context", "review-feat-x-session"));
    assert.equal(session("-all"), path.join(repo, ".context", "review-feat-x-all-session"));
    assert.equal(session("-scripts-reviewer-sh"), path.join(repo, ".context", "review-feat-x-scripts-reviewer-sh-session"));
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `node --test tests/patched-skills.test.mjs`
Expected: FAIL — no `SESSION=` in either launch block.

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

In `skills/review/SKILL.md` section 2, replace the block so it reads:

```bash
SKILLS_REPO=""
for c in "$(cat "$HOME/.verus-skills/root" 2>/dev/null)" \
         "$HOME/.claude/skills/review/../.." \
         "$HOME/.codex/skills/review/../.."; do
  [ -n "$c" ] && [ -f "$c/scripts/typesafe-judge.mjs" ] && SKILLS_REPO="$(cd -P "$c" && pwd -P)" && break
done
[ -f "$SKILLS_REPO/scripts/reviewer.sh" ] || echo "reviewer not found: SKILLS_REPO=$SKILLS_REPO"

PROMPT="<the temp prompt file from section 1>"
REPORT="<REPORT, repo-relative>"
ROUND="<1 or 2>"
SUFFIX="<SUFFIX printed by section 0: empty in branch scope, -all in codebase scope, -<path slug> in path scope>"
BRANCH="$(git branch --show-current)"
# Keyed by branch and scope, never by the report: every run writes a new -N report,
# and the next review of the same scope must still find an interrupted one's terminal.
SESSION="$(git rev-parse --show-toplevel)/.context/review-$(printf '%s' "$BRANCH" | tr '/' '-')$SUFFIX-session"
# Round 1 starts fresh: close an orphan left by an interrupted earlier review of this scope.
[ "$ROUND" = 1 ] && bash "$SKILLS_REPO/scripts/reviewer.sh" --close-session "$SESSION"
bash "$SKILLS_REPO/scripts/reviewer.sh" --prompt-file "$PROMPT" --output "$REPORT" --title review --timeout-min 20 --session-file "$SESSION"
echo "reviewer_exit=$?"
```

In both skills, change the sentence above the block to: `Substitute the real values for the four placeholders before running:`.

In `skills/review/SKILL.md` section 0, in the inputs block, add after `echo "REPORT=$REPORT"`:

```bash
echo "SUFFIX=$SUFFIX"
```

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

In section 5 of both skills, replace `in Orca the same terminal session is reused via the session file, so the reviewer sees its own earlier context` with `pass the same SESSION as round 1 — in Orca that reuses round 1's terminal, so the reviewer sees its own earlier context`. In `review`, also add: `SESSION depends only on BRANCH and SUFFIX, so round 2 computes the same value although it writes a new -N report.`

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
- Modify: `skills/review/SKILL.md` (section 0 `Ledger lines`; section 3; section 4: report-only sentence, fix-wave list, decisions template)
- Modify: `skills/plan-review/SKILL.md` (section 3; section 4: application rule, decisions template; section 5 round-2 condition)
- Modify: `skills/kickoff/judge.md` (`## Rules`)
- Create: `tests/triage.test.mjs`

**Interfaces:**
- Consumes: the SDD ledger template `Task <N>: minor (deferred): <one-liner>` (unchanged, upstream wording).
- Produces: review's ledger collection `grep -iE 'minor \(deferred\)|ruling|parked'`; triage sections that ask how to fix, and the chat line `accepted without the judge: <finding> — <evidence>`; a section-4 rule in both skills that applies the chosen action of every judged finding whatever its option letter, plus every finding accepted without the judge, while a "leave it as is" choice is recorded and changes nothing.

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

test("section 4 applies every chosen action whatever its option letter, and every finding accepted without the judge", () => {
  for (const f of ["review/SKILL.md", "plan-review/SKILL.md"]) {
    const body = read(f);
    const s4 = body.slice(body.indexOf("## 4."), body.indexOf("## 5."));
    assert.match(s4, /the chosen action of every judged finding, whatever its option letter and whether the judge accepted it or the user chose it/, f);
    assert.match(s4, /every finding accepted without the judge/, f);
    assert.match(s4, /A "leave it as is" choice is recorded with the decisions but changes nothing/, f);
    assert.doesNotMatch(s4, /accepted `A`\/`B`|Collect every accepted finding|print the accepted findings|"Rejected: <finding> — <reason>"/, f);
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

Also in section 4, replace `print the accepted findings as a checklist for the user to apply` with `print the fix list below as a checklist for the user to apply`, and replace `Collect every accepted finding into one list and dispatch ONE fix subagent` (the wording after Task 6) with:

```markdown
Collect into one fix list the chosen action of every judged finding, whatever its option letter and whether the judge accepted it or the user chose it, plus every finding accepted without the judge. A "leave it as is" choice is recorded with the decisions but changes nothing in the code and stays off the list. If the list is empty, skip the fix wave and go on to recording the decisions. Otherwise dispatch ONE fix subagent
```

- [ ] **Step 5: Rewrite section 3 of `skills/plan-review/SKILL.md`**

The same replacement as Step 4, with these wording changes: `goal` is "what the plan delivers"; `facts` are "the plan's Goal and Architecture lines, the spec's relevant constraint, the finding verbatim, and the relevant plan excerpt"; `constraints` are "the user's rules and the plan's hard limits"; and after the judge: "Accepted → apply the decision; unaccepted or any non-zero judge exit → ask the user with the decision block." Apply the same section-4 change to its `## Plan review decisions (round N)` template, and replace the first sentence of section 4, `Apply every accepted \`A\`/\`B\` decision to \`PLAN\` directly (edit tasks, add tests, add steps).`, with:

```markdown
Apply to `PLAN` directly (edit tasks, add tests, add steps) the chosen action of every judged finding, whatever its option letter and whether the judge accepted it or the user chose it, and every finding accepted without the judge. A "leave it as is" choice is recorded with the decisions but changes nothing in the plan.
```

In section 5, replace `at least one finding was accepted` with `at least one finding changed the plan`.

- [ ] **Step 6: Add the rule to `skills/kickoff/judge.md`**

Append to `## Rules`:

```markdown
- Every option must be one a reasonable engineer could pick. Never pad a question with an unargued "reject" or "do nothing": a "leave it as is" option carries its strongest argument in `description`, or it is left out. A question left with only one real option is not judge-able — decide it yourself and state the evidence.
```

- [ ] **Step 7: Run the test to verify it passes**

Run: `node --test tests/triage.test.mjs`
Expected: PASS, 5 tests.

- [ ] **Step 8: Run the whole suite, then commit**

Run: `npm test` → PASS.

```bash
git add skills/review/SKILL.md skills/plan-review/SKILL.md skills/kickoff/judge.md tests/triage.test.mjs
git commit -m "fix(skills): case-insensitive ledger collection; triage asks how to fix"
```

---

### Task 9: Documentation and acceptance checklist

**Files:**
- Modify: `README.md` (new `## Models and effort` section; the TypeSafe key paragraph; every `config/reviewer.json` mention; the existing Opus, key and install claims in `## Two ways to install`, `## The flow`, `### Decisions and reviewers`, `## Skills` and `### From a checkout`; `rm -rf ~/.verus-skills`; legacy session files note)
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

- **Claude subagents** run as the agent types `verus-worker` (implementers, fix waves), `verus-reviewer` (task reviews, re-reviews, plan reviews, the fallback external reviewer) and `verus-explorer` (kickoff lookups); `make install` links them into `~/.claude/agents/`, the plugin ships them. After editing `subagents`, run `make models` — it rewrites the `model:`/`effort:` lines of `agents/verus-*.md`; a test fails if they drift. The symlink install sees the change at once; the plugin after a release. Effort: `low|medium|high|xhigh|max`.
- **The `opus` alias** follows the newest Opus only when the main session is not itself pinned to an older Opus: a session on an older Opus keeps its subagents on that exact version. To pin, write a full model id (e.g. `claude-opus-5-6`) and run `make models`.
- **Codex reviewer:** `default` passes no `-m`/`model_reasoning_effort`, so Codex uses `~/.codex/config.toml`. Override per run with `REVIEWER_CODEX_MODEL` / `REVIEWER_CODEX_REASONING`. Every Codex value must be a single token (letters, digits, `_ . : [ ] -`); anything else stops the review with an error that names the setting, never its value. Each review starts a fresh Codex terminal, so a change applies from the next review.
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

Replace the paragraph `Codex model and reasoning effort used by \`plan-review\` / \`review\` live in \`config/reviewer.json\` …` with `Models and effort for every layer — Claude subagents, the Codex reviewer, the judge — are set as described in [Models and effort](#models-and-effort).` After this, `grep -n "reviewer.json" README.md` must return nothing.

- [ ] **Step 3: Bring the existing README claims in line with the agent tiers and the local key**

In `## Two ways to install`, replace `same ten skills and the same SessionStart hook.` with `same ten skills, the same three agents and the same SessionStart hook.`

In `## The flow`, replace the mermaid node

```
  PR --> SDD[subagent-driven-development<br/>opus subagents]
```

with

```
  PR --> SDD[subagent-driven-development<br/>verus-worker + verus-reviewer]
```

and the table row for step 4 with:

```markdown
| 4 | `subagent-driven-development` | Fresh `verus-worker` subagent per task, a `verus-reviewer` spec + quality review after each. |
```

In `### Decisions and reviewers`, replace the sentence `The acceptance threshold lives in \`config/judge.json\` (default \`0.7\`, overridable with \`--threshold\`) and the key is read from \`TYPESAFE_API_KEY\`.` with:

```markdown
The acceptance threshold lives in `config/judge.json` (default `0.7`, overridable with `--threshold`). The key comes from `TYPESAFE_API_KEY`, else from `typesafe.apiKey` in `~/.verus-skills/config.json`; the model is `judge.model` (see [Models and effort](#models-and-effort)).
```

and replace the reviewer bullet (`- The external reviewer is \`scripts/reviewer.sh\`: …`) with:

```markdown
- The external reviewer is `scripts/reviewer.sh`: Orca-managed Codex when `orca status` answers, otherwise `codex exec`, with the Codex model and effort from [Models and effort](#models-and-effort). On the Orca path a report counts as finished only once its last line is `<!-- end of review -->`, which both reviewer prompts require. If neither is available it exits `3` and the calling skill falls back to the `verus-reviewer` agent, dispatched unnamed and in the background.
```

In `## Skills`, in the `Patches:` paragraph, replace `all subagents on \`opus\`` with `every subagent dispatched as a \`verus-*\` agent type (see [Models and effort](#models-and-effort))`.

In `### From a checkout (development)`, replace the paragraph that starts `` `make install` symlinks every skill `` with:

```markdown
`make install` symlinks every skill into `~/.claude/skills/` and `~/.codex/skills/`, links the three agent types (`verus-worker.md`, `verus-reviewer.md`, `verus-explorer.md` from `agents/`) into `~/.claude/agents/`, adds a SessionStart hook to `~/.claude/settings.json` that runs `scripts/session-start.mjs` to inject `USING.md`, adds a pointer line to `~/.codex/AGENTS.md`, and uninstalls the `superpowers` plugin (its skills are vendored here). It then reports whether a TypeSafe API key (`TYPESAFE_API_KEY` or `~/.verus-skills/config.json`), `codex` and `orca` are present.

Skill names and agent names are treated differently when something else already holds them:

- A **skill name** taken in `~/.claude/skills/` or `~/.codex/skills/` by something that is not ours is skipped with a `SKIPPED` line and never overwritten; the rest of the install goes on.
- An **agent name** in `~/.claude/agents/` held by a regular file, or by a link to an existing file outside this checkout and outside every other checkout of the distro, stops the install before anything is written — even with `--force`, because the skills would dispatch to that foreign agent. Move it away and re-run. A dangling link on an agent name is replaced and reported as `replaced dangling link`.
```

In the flags block below it, replace `node scripts/install.mjs --force                # install the symlinks even though the plugin is installed` with `node scripts/install.mjs --force                # install even though the plugin is installed (never overrides an agent-name collision)`.

Replace `re-points the existing symlinks, SessionStart hook and \`AGENTS.md\` line` with `re-points the existing skill and agent symlinks, SessionStart hook and \`AGENTS.md\` line`.

- [ ] **Step 4: Fix the uninstall commands and note old sessions**

In `README.md` `## Uninstall`, replace `rm -rf ~/.verus-skills` with `rm -f ~/.verus-skills/root   # keeps config.json and its key`. Add below the Codex uninstall block:

```markdown
Older versions kept one Orca terminal per repo in `.context/plan-review-session` / `.context/review-session`. They are no longer used; close those terminals in Orca and delete the files if they are still there.
```

- [ ] **Step 5: Update the acceptance checklist**

In `docs/plugin-acceptance.md`: in step 2 and step 16 replace `rm -rf ~/.verus-skills` with `rm -f ~/.verus-skills/root`. Insert after step 13 (renumber the later steps and every cross-reference):

```markdown
14. `claude plugin details verus-skills@verus-skills` shows `Agents (3)`: `verus-worker`, `verus-reviewer`, `verus-explorer`.
15. Dispatch `verus-skills:verus-worker` without a `name` (e.g. run a one-task plan through subagent-driven-development): no window opens, and the `--debug` log shows the model and effort from `config/models.json`.
16. Pinned parent: start a session on the full id of an older Opus; the debug log shows `verus-worker` (model `opus`) on that same older version. Pin a full id in `config/models.json`, run `make models`, reinstall; the agent then runs on the pinned id.
17. Collision: with a foreign `~/.claude/agents/verus-worker.md` in place, `make install` exits non-zero, names the file, and creates no link.
18. With `TYPESAFE_API_KEY` unset and the key only in `~/.verus-skills/config.json`, the judge answers `judge_exit=0`.
```

And in the Codex section, add a check that a subagent dispatch runs through `spawn_agent` without a `name` or separate window.

- [ ] **Step 6: Run the whole suite, then commit**

Run: `npm test` → PASS. Run `grep -rn "rm -rf ~/.verus-skills\|reviewer.json" README.md docs/plugin-acceptance.md` → no match. Run `grep -nE 'opus subagent|Fresh .opus.|on .opus.|all subagents on|read from .TYPESAFE_API_KEY.\.|Names already taken' README.md` → no match. Run `grep -c 'verus-worker' README.md` → at least 4 (flow diagram, step-4 row, Models and effort, install text).

```bash
git add README.md docs/plugin-acceptance.md
git commit -m "docs: models and effort, the local TypeSafe key, acceptance steps for agents"
```

---

## Plan review decisions (round 1)

Reviewer: real Codex via Orca (`reviewer: orca`). Report: `docs/plans/2026-09-23-configurable-models.review.md`.

```
Решение (Jev): How should the plan stop a Codex model or effort value containing a newline or spaces from corrupting the config CLI output or the Orca launch command?
  A. Validate as a single token  75%
  B. Quote and delimit instead   1%
  C. Both                        24%
  Выбрано: A, confidence 0.62, данных 0.56 → спросить пользователя (мало данных)
  Ответ пользователя: A — проверять как один токен
```
Applied: Task 1 — `validateModels`, `validateLocal` and `resolveCodex` hold every Codex model and effort value, from `config/models.json`, `~/.verus-skills/config.json` and `REVIEWER_CODEX_MODEL`/`REVIEWER_CODEX_REASONING`, to `/^[\w.:[\]-]+$/`, with field-only errors naming the source; test `the CLI refuses a Codex value that is not a single token, from every source, without echoing it`. Task 3 — the no-node branch of `reviewer.sh` applies the same rule in bash; test `a Codex value that is not a single token stops the run before any reviewer starts, with or without node`. The Orca command builder and the CLI output format are unchanged. New Global Constraint.

accepted without the judge: `findSecretKey()` returns `null` for arrays, so `extra: [{ apiKey: … }]` passes validation — the planned Task 1 code starts with `if (!isObj(obj)) return null;`, and `isObj` is false for every array.
Applied: Task 1 — `findSecretKey` walks arrays as well as objects and reports paths like `extra[0].APIKey`; test `validateModels refuses a secret-like field inside nested arrays`.

```
Решение (Jev): How should the installer treat a symlink at ~/.claude/agents/verus-worker.md whose target is a nonexistent path ending in /agents/verus-worker.md?
  A. Foreign unless the root exists and is a distro  5%
  B. Replace any dangling link                       66%
  C. Keep isDistroCheckout as planned                29%
  Выбрано: B, confidence 0.49, данных 0.68 → спросить пользователя
  Ответ пользователя: B — заменять любую битую ссылку
```
Applied: Task 5 — `agentCollisions` skips a dangling link (checked with `existsSync` first) and requires an existing distro root for a foreign-looking link, never relying on `isDistroCheckout()` for a missing directory; `linkAgents` returns `replaced` and `main()` prints `claude agents: replaced dangling link: <name>`; tests `a dangling link on an agent name is replaced, whoever left it` (target `/missing/agents/verus-worker.md`) and `a foreign file, or a link to an existing foreign file, on an agent name refuses the whole install` (exit 1, link unchanged, nothing else written, with and without `--force`). New Global Constraint.

```
Решение (Jev): How should reviewer.sh know a report is complete before it closes a session-less Orca terminal?
  A. Explicit end marker                100%
  B. Stable size plus a later tui-idle  0%
  C. Leave session-less terminals open  0%
  Выбрано: A, confidence 1.00, данных 0.82 → принято автоматически
```
Applied: Task 3 — both `reviewer.md` prompts end the report with `<!-- end of review -->`; on the Orca path `reviewer.sh` replaces the stable-size rule with `wait_for_report_end` (`grep -qxF` on `END_MARKER`), closes a session-less terminal only after it, falls back to `codex exec` without it and deletes the unfinished report first; `codex exec` keeps "exited + non-empty". The fake `orca` writes the marker and gains `FAKE_ORCA_REPORT_CHUNKS`, `FAKE_ORCA_NO_MARKER` and `FAKE_ORCA_CLOSE_FAIL`; tests `a report written in chunks is accepted, and its terminal closed, only after the end marker` (log order), `an Orca report without the end marker is never accepted: the run falls back to codex exec` and `both reviewer prompts end the report with the marker reviewer.sh waits for`. The two `reviewer.md` files are listed in Task 3's Files. New Global Constraint.

accepted without the judge: standalone test fixtures copy scripts without their new `./config.mjs` import — `tests/judge.test.mjs:419` copies `scripts/typesafe-judge.mjs` alone and `distroRepo()` in `tests/install.test.mjs:335-346` copies `scripts/install.mjs` alone, so both fail at module loading.
Applied: Task 4 — the missing-`config/judge.json` test also copies `scripts/config.mjs` and `config/models.json`, keeps `config/judge.json` absent, and asserts the failure names `judge.json`. Task 5 — `distroRepo()` copies `scripts/config.mjs` and writes `agents/verus-*.md` with valid frontmatter; `assertSingleInstallOf` checks the agent links; the re-install tests assert re-pointed and replaced-dangling agent links; new test `uninstall from one distro checkout never removes another checkout's agent links`. Review Focus item 1 updated.

accepted without the judge: the planned model-forwarding test returns `answer: { A, B }` and `sufficiency: { yes, no }`, but `judge()` throws `unexpected SDK response shape` without `answer.choice`, `answer.confidence`, `answer.probabilities` and `sufficiency.noul` (`scripts/typesafe-judge.mjs:149-163`).
Applied: Task 4 — `judge passes an explicit model to systemOne and omits it otherwise` uses the `fakeClient` response shape and the file's `input`/`deps` fixtures.

accepted without the judge: the existing judge CLI tests inherit the real HOME and assert the old guard text — `runCli` in `tests/judge.test.mjs:310-319` spreads `process.env` without HOME, and line 324 expects `TYPESAFE_API_KEY is not set`.
Applied: Task 4 — `runCli` and the new `runCliAsync` share `cliEnv`, which sets a temp `HOME` and strips `TYPESAFE_API_KEY`, `TYPESAFE_DEFAULT_MODEL`, `TYPESAFE_BASE_URL` and `TYPESAFE_LOG_LEVEL` unless a test sets them; the missing-key test asserts the new guard message; `CLI sends the local key and the resolved model to TypeSafe and prints the result` is the case with only a temp local key and no env key.

accepted without the judge: section 4 of `plan-review` applies only accepted `A`/`B` decisions — `skills/plan-review/SKILL.md:70` — while the new triage produces 2–4 fix options and unjudged fixes.
Applied: Task 8 — `plan-review` §4 applies the chosen action of every judged finding whatever its option letter, plus every finding accepted without the judge; a "leave it as is" choice is recorded and changes nothing; `review` §4 builds its fix list by the same rule (empty list → no fix wave); `plan-review` §5 starts round 2 when a finding changed the plan; test `section 4 applies every chosen action whatever its option letter, and every finding accepted without the judge` rejects the old wording.

```
Решение (Jev): How should the review skill find and close the orphan terminal of an interrupted earlier code review, given each run writes a new -N report?
  A. Key the session by review scope  100%
  B. Active-session pointer file      0%
  C. Accept the leak for review       0%
  Выбрано: A, confidence 0.99, данных 0.62 → принято автоматически
```
Applied: Task 7 — `review` derives `SESSION="$(git rev-parse --show-toplevel)/.context/review-$(printf '%s' "$BRANCH" | tr '/' '-')$SUFFIX-session"` (no date, no `-N`), section 0 prints `SUFFIX`, and `ROUND1_REPORT` is gone from `review`'s block; `plan-review` keeps its report-derived SESSION. Tests: the launch-block regexes, and `review keys its session by branch and scope, so the next review of the same scope finds an interrupted one`, which runs the SESSION line for three scopes.

```
Решение (Jev): How should the plan prove that the judge CLI really sends the resolved key and model to TypeSafe and redacts the key in real stderr?
  A. Local HTTP fixture server   100%
  B. Dependency-injected main()  0%
  C. Unit level only             0%
  Выбрано: A, confidence 1.00, данных 0.78 → принято автоматически
```
Applied: Task 4 — `fakeTypeSafe()` starts a `node:http` server on `127.0.0.1:0`, `TYPESAFE_BASE_URL` points at it, and `runCliAsync()` runs the CLI with `spawn`. Tests: the server sees `POST /v1/systemone` with `Authorization: Bearer <local key>` and the resolved `model`, exit 0 with the result on stdout; env key and model win; a 400 whose body holds the key gives exit 2 and `judge failed: 400 invalid key [redacted]` on stderr; the insecure-file warning runs against the same server. The weak "a key from the local file passes the guard" test is removed.

accepted without the judge: several new failure branches have no test — the non-ENOENT branch of `loadLocal`, root and section arrays and empty strings in `validateLocal`, the missing-file, missing-frontmatter and missing-`model:` branches of `syncAgents`/`renderAgent`, and the `|| true` after `terminal close` in `--close-session`; the current fake `orca` always exits 0.
Applied: Task 1 — `an unreadable local path, arrays and empty fields are file- or field-only errors` (a directory at the local path → `cannot read ~/.verus-skills/config.json`, through `loadLocal` and the CLI). Task 2 — `make models writes nothing when an agent file is missing or malformed, even with a valid change pending` (every agent file byte-identical). Task 3 — `FAKE_ORCA_CLOSE_FAIL=1` and `--close-session exits 0 and removes the file when the terminal is already gone`. Test counts updated: Task 1 17, Task 2 6, Task 8 5.

accepted without the judge: the README keeps claims the plan contradicts — `README.md:33` (`opus subagents`), `:54` ("Fresh opus subagent per task"), `:74` (key read from `TYPESAFE_API_KEY` only), `:75` and `:92` (subagents on `opus`), `:148` (every occupied name skipped).
Applied: Task 9 Step 3 — the flow diagram, the step-4 row, `Decisions and reviewers`, the `Patches:` paragraph, `Two ways to install` and the install text now name the agent tiers and the local key; the install text separates skill-name skipping from agent-name refusal and the dangling-link replacement; Step 6 greps that none of the old claims remain.

## Plan review decisions (round 2)

Reviewer: real Codex via Orca (`reviewer: orca`), report `docs/plans/2026-09-23-configurable-models.review.md`; round-1 report kept as `docs/plans/2026-09-23-configurable-models.review.md.round1.md`.

Left as is (code): P1 "a trailing newline passes the single-token check because `$` matches before a final `\n`" — verified false: in JS, `/^[\w.:[\]-]+$/.test("gpt-test\n")` is `false` (also for `\r` and `\r\n`; `$` without the `m` flag matches only at the end of input), and the bash `TOKEN_RE` rejects them too. Pin tests added: `"gpt-test\n"`, `"gpt-test\r"`, `"gpt-test\r\n"` in the Task 1 token table and in the Task 3 reviewer test, with and without node.

```
Решение (Jev): How should the judge handle TypeSafe SDK logging, which by default writes info/debug to stdout and debug-logs request/response data that can hold the API key?
  A. Silence                                         21%
  B. Redacting stderr logger                         26%
  C. Off by default, redacting logger when asked     53%
  Рекомендация Claude: C
  Данных достаточно: 48%
  Выбрано: C, confidence 0.30, данных 0.48 → спросить пользователя
Ответ пользователя: C — «Выключены, по запросу — с редактированием».
```

Applied: Task 4 — the CLI passes `logLevel` = trimmed `TYPESAFE_LOG_LEVEL` or `"off"` and `logger: redactingLogger(apiKey)` (exported; one line per call on stderr, key → `[redacted]`, safe for errors and circular objects). Tests: a unit test of `redactingLogger`; with `TYPESAFE_LOG_LEVEL=debug`, a 400 whose body holds the key reaches neither stream (exit 2), and a success still prints exactly one JSON line on stdout; without the variable, stderr stays empty on success.


## Review decisions (round 1)

Reviewer: real Codex via Orca (`reviewer: orca`), report `docs/reviews/VerusK-configurable-models-2026-09-23.md` (NOT READY: 2 × P1, 2 × P2; ledger lines 6, 18, 23, 48 marked BLOCKS MERGE are the same four findings). Fixes: `1b4f7ba`, `ca4ea89`, `30c7d12`, `766e9a6`; `npm test` 254/254.

```
Решение (Jev): How should an API key with surrounding whitespace be handled so the judge never prints it unredacted?
  A. Trim the key                   88%
  B. Reject surrounding whitespace  4%
  C. Redact every variant           8%
  Рекомендация Claude: A
  Данных достаточно: 61%
  Выбрано: A, confidence 0.82, данных 0.61, порог 0.7/0.6 → принято автоматически
```
(first run of this question returned `(мало данных)`, sufficiency 0.57; re-judged once with the SDK's own env-trim and the header-trim facts added)

accepted without the judge: [P1] a terminal loaded from `--session-file` keeps running after the Orca path falls back to `codex exec` and can overwrite the fallback report — evidence: `scripts/reviewer.sh` closed only `CREATED_HANDLE` (Task 3 review minor 4, Codex reproduction); writing the fallback to a temp file and renaming does not stop the old reviewer writing afterwards, so closing the owned terminal is the only fix.

```
Решение (Jev): How should reviewer.sh keep a Codex model or effort value containing [ or ] intact in the Orca terminal command?
  A. Shell-quote the values           97%
  B. Forbid brackets in Codex values  3%
  Рекомендация Claude: A
  Данных достаточно: 86%
  Выбрано: A, confidence 0.95, данных 0.86, порог 0.7/0.6 → принято автоматически
```

```
Решение (Jev): How should the README tell users to store the TypeSafe key in ~/.verus-skills/config.json without destroying existing settings or exposing the key?
  A. Document a safe manual recipe  43%
  B. Add a set-key helper           57%
  Рекомендация Claude: A
  Данных достаточно: 70%
  Выбрано: B, confidence 0.14, данных 0.70, порог 0.7/0.6 → спросить пользователя
Ответ пользователя: A — «Безопасный ручной рецепт».
```
(first run returned `(мало данных)`, sufficiency 0.59; re-judged once with the plugin-cache path and the two-line CLI contract facts added)

## Review decisions (round 2)

Reviewer: real Codex via Orca, same terminal session as round 1; report `docs/reviews/VerusK-configurable-models-2026-09-23-2.md` (READY WITH FIXES). Resolved from round 1: the padded-key leak, unquoted Orca arguments, the destructive README recipe, and the fallback race when the close succeeds. One residual finding (P2; ledger line 18 BLOCKS MERGE, so triaged as P1): a failed `orca terminal close` still fell back to `codex exec` and discarded the handle.

```
Решение (Jev): How should reviewer.sh handle a failed 'orca terminal close' of its own reviewer terminal before falling back to codex exec?
  A. Stop on a failed close               92%
  B. Fall back to a separate output file  8%
  C. Leave as is                          0%
  Рекомендация Claude: A
  Данных достаточно: 77%
  Выбрано: A, confidence 0.88, данных 0.77, порог 0.7/0.6 → принято автоматически
```

Fix: `a2a84b3` — a failed close keeps the handle in the session file, prints `orca: could not close reviewer terminal <handle>; not falling back` and exits 1; `npm test` 256/256.

Deferred (not merge-blocking, per both reports' ledger triage): the Task 1–9 minors in the SDD ledger marked OK by the reviewer — among them end-marker strictness (last line, CRLF), positive log-level assertions in the judge tests, stale "fixed/rejected/asked" summary wording, and acceptance step 16 (a local model pin never reaches the GitHub-installed plugin; the step needs a local plugin source or a published revision before it can serve as acceptance evidence).
