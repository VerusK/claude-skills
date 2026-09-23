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
