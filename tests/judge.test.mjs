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

const input = {
  question: "Where to store the API key?",
  options: [
    { id: "A", label: "settings.json env", description: "global Claude settings" },
    { id: "B", label: "~/.zshenv" },
  ],
  context: "macOS, Claude Code + Codex",
  recommended: "A",
};

const structuredInput = {
  question: "Where to store the API key?",
  options: input.options,
  context: {
    goal: "Ship a judge that reads repo facts",
    decisions: ["The judge runs from a shell block"],
    facts: ["config/judge.json: threshold 0.7"],
    constraints: ["no new deps"],
    consequences: { A: "wrong when the key must stay per-shell", B: "wrong when Codex must see it" },
  },
  recommended: "A",
};

const fakeChoice = (q, criteria) => ({ type: "choice", q, criteria });
const fakeNoul = (q, criteria) => ({ type: "noul", q, criteria });

// Defaults keep sufficiency out of the way so a test that says nothing about it
// exercises the confidence path alone.
function fakeClient(answer, sufficiency = { type: "noul", noul: 0.95 }) {
  return { systemOne: async () => ({ answers: { answer, sufficiency } }) };
}

const deps = (client, over = {}) => ({
  client,
  choice: fakeChoice,
  noul: fakeNoul,
  threshold: 0.7,
  ...over,
});

test("validate rejects missing options", () => {
  assert.throws(() => validate({ question: "x", options: [{ id: "A", label: "a" }] }), /2\.\.6 options/);
});

test("validate rejects a recommendation that is missing or not an option id", () => {
  // Acceptance compares Jev's pick with this id, so without a real one no answer can be accepted.
  for (const recommended of [undefined, "", "Z", "a", 1]) {
    assert.throws(
      () => validate({ ...input, recommended }),
      /recommended must be one of the option ids/,
      `recommended=${JSON.stringify(recommended)}`,
    );
  }
});

test("validate accepts a string or an object context", () => {
  assert.doesNotThrow(() => validate(input));
  assert.doesNotThrow(() => validate(structuredInput));
  assert.doesNotThrow(() => validate({ ...input, context: undefined }));
});

test("validate rejects a context that is neither a string nor a plain object", () => {
  for (const context of [42, ["a", "b"], true]) {
    assert.throws(() => validate({ ...input, context }), /context must be a string or an object/);
  }
});

test("validate rejects an oversized context", () => {
  assert.throws(() => validate({ ...input, context: "x".repeat(8193) }), /context too large/);
  assert.throws(
    () => validate({ ...input, context: { facts: ["y".repeat(9000)] } }),
    /context too large/,
  );
  assert.doesNotThrow(() => validate({ ...input, context: "x".repeat(8192) }));
});

test("buildQuestions maps option ids to descriptions", () => {
  const q = buildQuestions(input, fakeChoice, fakeNoul);
  assert.equal(q.answer.q, input.question);
  assert.deepEqual(Object.keys(q.answer.criteria), ["A", "B"]);
  assert.match(q.answer.criteria.A, /settings\.json env: global Claude settings/);
});

test("buildQuestions adds a sufficiency question", () => {
  const q = buildQuestions(input, fakeChoice, fakeNoul);
  assert.deepEqual(Object.keys(q), ["answer", "sufficiency"]);
  assert.equal(q.sufficiency.type, "noul");
  assert.match(q.sufficiency.q, /enough concrete information to choose one option confidently/);
  assert.match(q.sufficiency.q, /without guessing the user's intent/);
});

test("buildQuestions anchors the sufficiency question to both outcomes", () => {
  const q = buildQuestions(input, fakeChoice, fakeNoul);
  // An unanchored noul lets Jev invent its own bar for "enough"; the two
  // descriptions pin what a yes and a no each mean.
  assert.deepEqual(Object.keys(q.sufficiency.criteria).sort(), ["false", "true"]);
  assert.match(q.sufficiency.criteria.true, /stranger who sees only this state/);
  assert.match(q.sufficiency.criteria.true, /point at the fact that decides it/);
  assert.match(q.sufficiency.criteria.false, /guessing the user's intent/);
  assert.match(q.sufficiency.criteria.false, /not in the state/);
});

test("buildState never leaks the recommendation to the judge", () => {
  const s = buildState(input);
  assert.equal("recommended" in s, false);
  assert.equal(JSON.stringify(s).includes("recommended"), false);
  assert.match(s.options, /A\. settings\.json env/);
});

test("buildState passes a structured context through untouched", () => {
  const s = buildState(structuredInput);
  assert.equal(s.context, structuredInput.context);
  assert.deepEqual(s.context, structuredInput.context);
});

test("buildState keeps a string context and defaults to an empty string", () => {
  assert.equal(buildState(input).context, "macOS, Claude Code + Codex");
  assert.equal(buildState({ ...input, context: undefined }).context, "");
});

test("judge accepts a confident pick that matches the recommendation", async () => {
  const r = await judge(
    input,
    deps(fakeClient({ type: "choice", choice: "A", confidence: 0.82, probabilities: { A: 0.9, B: 0.1 } }, { type: "noul", noul: 0.71 })),
  );
  assert.equal(r.choice, "A");
  assert.equal(r.recommended, "A");
  assert.equal(r.agreed, true);
  assert.equal(r.accepted, true);
  assert.equal(r.threshold, 0.7);
  assert.equal(r.sufficiency, 0.71);
  assert.match(r.block, /Выбрано: A, confidence 0\.82, данных 0\.71, порог 0\.7 → принято автоматически/);
});

test("judge accepts an agreed pick however low the sufficiency", async () => {
  // Sufficiency is reported, never gated: on 110 real decisions it blocked 22
  // agreed picks the user then confirmed, and caught nothing agreement misses.
  const r = await judge(
    input,
    deps(fakeClient({ type: "choice", choice: "A", confidence: 0.98, probabilities: { A: 0.99, B: 0.01 } }, { type: "noul", noul: 0.2 })),
  );
  assert.equal(r.sufficiency, 0.2);
  assert.equal(r.accepted, true);
  assert.match(r.block, /Данных достаточно: 20%/);
});

test("judge accepts when confidence exactly equals the threshold", async () => {
  // The gate is `>=`: a value sitting exactly on the boundary passes, and the
  // block prints three decimals so the reader can see it did not merely round there.
  const r = await judge(
    input,
    deps(fakeClient({ type: "choice", choice: "A", confidence: 0.7, probabilities: { A: 0.8, B: 0.2 } })),
  );
  assert.equal(r.accepted, true);
  assert.match(r.block, /confidence 0\.700, .*→ принято автоматически/);
});

test("judge asks when a confident pick differs from the recommendation", async () => {
  const r = await judge(
    input,
    deps(fakeClient({ type: "choice", choice: "B", confidence: 0.99, probabilities: { A: 0.01, B: 0.99 } })),
  );
  assert.equal(r.choice, "B");
  assert.equal(r.agreed, false);
  assert.equal(r.accepted, false);
  assert.match(r.block, /Выбрано: B, .*→ спросить пользователя \(Jev ≠ рекомендация\)$/m);
});

test("judge sends a state without the recommendation end to end", async () => {
  let seen;
  const client = {
    systemOne: async (req) => {
      seen = req.state;
      return {
        answers: {
          answer: { type: "choice", choice: "A", confidence: 0.82, probabilities: { A: 0.9, B: 0.1 } },
          sufficiency: { type: "noul", noul: 0.71 },
        },
      };
    },
  };
  const r = await judge(input, deps(client));
  assert.equal("recommended" in seen, false);
  assert.equal(JSON.stringify(seen).includes("recommended"), false);
  // The recommendation still reaches the user, just not the judge.
  assert.match(r.block, /Рекомендация Claude: A/);
});

test("judge asks without a disagreement tag when an agreed pick is below threshold", async () => {
  const r = await judge(
    input,
    deps(fakeClient({ type: "choice", choice: "A", confidence: 0.3, probabilities: { A: 0.6, B: 0.4 } })),
  );
  assert.equal(r.agreed, true);
  assert.equal(r.accepted, false);
  assert.match(r.block, /→ спросить пользователя$/m);
});

test("formatDecision lists every option with percent", () => {
  const block = formatDecision(input, {
    choice: "A",
    probabilities: { A: 0.82, B: 0.18 },
    confidence: 0.64,
    threshold: 0.7,
    sufficiency: 0.71,
    accepted: false,
  });
  assert.match(block, /A\. settings\.json env\s+82%/);
  assert.match(block, /B\. ~\/\.zshenv\s+18%/);
  assert.match(block, /Рекомендация Claude: A/);
  assert.match(block, /Данных достаточно: 71%/);
});

test("formatDecision prints three decimals within 0.005 of the threshold", () => {
  const block = formatDecision(input, {
    choice: "A",
    probabilities: { A: 0.82, B: 0.18 },
    confidence: 0.699,
    threshold: 0.7,
    sufficiency: 0.71,
    accepted: false,
  });
  // Two decimals would print "0.70" — a number that reads as accepted.
  assert.match(block, /confidence 0\.699, данных 0\.71/);
});

test("formatDecision keeps two decimals away from the threshold", () => {
  const block = formatDecision(input, {
    choice: "A",
    probabilities: { A: 0.82, B: 0.18 },
    confidence: 0.82,
    threshold: 0.7,
    sufficiency: 0.71,
    accepted: true,
  });
  assert.match(block, /confidence 0\.82, данных 0\.71, порог 0\.7 →/);
});

test("formatDecision survives a missing sufficiency", () => {
  const bare = formatDecision(input, {
    choice: "A",
    probabilities: { A: 0.82, B: 0.18 },
    confidence: 0.82,
    threshold: 0.7,
    accepted: true,
  });
  assert.match(bare, /Данных достаточно: —/);
  assert.match(bare, /данных —, порог 0\.7 → принято автоматически/);
});

test("judge throws when the SDK picks an id that is not an option", async () => {
  await assert.rejects(
    judge(input, deps(fakeClient({ type: "choice", choice: "Z", confidence: 0.9, probabilities: { A: 0.5, B: 0.5 } }))),
    /unknown choice/,
  );
});

test("judge throws on non-finite confidence", async () => {
  for (const confidence of [Number.NaN, Number.POSITIVE_INFINITY, "0.9"]) {
    await assert.rejects(
      judge(input, deps(fakeClient({ type: "choice", choice: "A", confidence, probabilities: { A: 0.9, B: 0.1 } }))),
      /unexpected SDK response shape/,
    );
  }
});

test("judge throws when probabilities is not an object", async () => {
  for (const probabilities of [null, "A=0.9", 0.9]) {
    await assert.rejects(
      judge(input, deps(fakeClient({ type: "choice", choice: "A", confidence: 0.9, probabilities }))),
      /unexpected SDK response shape/,
    );
  }
});

test("judge throws when sufficiency is missing or out of range", async () => {
  const answer = { type: "choice", choice: "A", confidence: 0.9, probabilities: { A: 0.9, B: 0.1 } };
  for (const sufficiency of [undefined, null, {}, { type: "noul", noul: Number.NaN }, { type: "noul", noul: "0.8" }, { type: "noul", noul: 1.2 }, { type: "noul", noul: -0.1 }]) {
    // Built inline: fakeClient's default would paper over the `undefined` case.
    const client = { systemOne: async () => ({ answers: { answer, sufficiency } }) };
    await assert.rejects(
      judge(input, deps(client)),
      /unexpected SDK response shape/,
      `sufficiency=${JSON.stringify(sufficiency) ?? "undefined"}`,
    );
  }
});

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

test("CLI exits 2 when no key is set anywhere, naming both places", () => {
  const r = runCli({});
  assert.equal(r.status, 2);
  assert.match(r.stderr, /TypeSafe API key not found \(TYPESAFE_API_KEY or ~\/\.verus-skills\/config\.json\); judge unavailable/);
});

test("CLI exits 2 on a threshold outside (0,1]", () => {
  for (const args of [["--threshold", "0"], ["--threshold", "1.5"], ["--threshold=-1"]]) {
    const r = runCli({ args, env: { TYPESAFE_API_KEY: "dummy" } });
    assert.equal(r.status, 2, `args=${args.join(" ")}`);
    assert.match(r.stderr, /threshold must be in \(0,1\]/);
  }
});

test("CLI reads the value from the --threshold=<n> equals form", () => {
  // config/judge.json holds a valid 0.7, so an error about the flag's own value
  // can only mean the equals form was parsed rather than silently ignored.
  const bad = runCli({ args: ["--threshold=0"], env: { TYPESAFE_API_KEY: "dummy" } });
  assert.equal(bad.status, 2);
  assert.match(bad.stderr, /threshold must be in \(0,1\]/);

  const ok = runCli({ args: ["--threshold=0.9"], env: { TYPESAFE_API_KEY: "dummy" } });
  assert.equal(ok.status, 2);
  assert.doesNotMatch(ok.stderr, /invalid threshold/);
  assert.doesNotMatch(ok.stderr, /threshold must be in/);
  assert.match(ok.stderr, /judge failed: input\.question/);
});

test("CLI exits 2 on an unparsable threshold", () => {
  for (const args of [["--threshold", "abc"], ["--threshold"], ["--threshold="], ["--threshold=abc"]]) {
    const r = runCli({ args, env: { TYPESAFE_API_KEY: "dummy" } });
    assert.equal(r.status, 2, `args=${args.join(" ")}`);
    // The message names both places the value could have come from.
    assert.match(r.stderr, /invalid threshold \(flag or config\/judge\.json\)/, `args=${args.join(" ")}`);
  }
});

test("CLI exits 2 on an unknown --threshold* flag", () => {
  for (const args of [["--thresholds=0.9"], ["--threshold-value", "0.9"]]) {
    const r = runCli({ args, env: { TYPESAFE_API_KEY: "dummy" } });
    assert.equal(r.status, 2, `args=${args.join(" ")}`);
    assert.match(r.stderr, /unknown option/, `args=${args.join(" ")}`);
    assert.doesNotMatch(r.stderr, /^\s+at /m);
  }
});

test("CLI exits 2 on any argument other than --threshold, before the key check", () => {
  // No API key is set, so naming the argument rather than the missing key shows it
  // was rejected first; the closed loopback port keeps any run that got further local.
  for (const [args, bad] of [
    [["--sufficiency", "0.6"], "--sufficiency"],
    [["--sufficiency=0.6"], "--sufficiency=0.6"],
    [["--threshold", "0.9", "extra"], "extra"],
  ]) {
    const r = runCli({ args, env: { TYPESAFE_BASE_URL: "http://127.0.0.1:9" } });
    assert.equal(r.status, 2, `args=${args.join(" ")}`);
    assert.equal(r.stderr.trim(), `judge failed: unknown option: ${bad}`, `args=${args.join(" ")}`);
  }
});

test("CLI exits 2 when the input has no recommendation", () => {
  const stdin = JSON.stringify({ question: "q", options: [{ id: "A", label: "a" }, { id: "B", label: "b" }], context: "c" });
  // Port 9 on loopback is closed: should validation ever let this input through,
  // the run fails locally instead of reaching the TypeSafe API.
  const r = runCli({ stdin, env: { TYPESAFE_API_KEY: "dummy", TYPESAFE_BASE_URL: "http://127.0.0.1:9" } });
  assert.equal(r.status, 2);
  assert.match(r.stderr, /judge failed: input\.recommended must be one of the option ids/);
});

test("CLI exits 2 when the context is too large", () => {
  const stdin = JSON.stringify({
    question: "Where to store the API key?",
    options: [{ id: "A", label: "a" }, { id: "B", label: "b" }],
    context: "x".repeat(8193),
  });
  const r = runCli({ stdin, env: { TYPESAFE_API_KEY: "dummy" } });
  assert.equal(r.status, 2);
  assert.match(r.stderr, /context too large/);
});

test("CLI exits 2 when config/judge.json is missing", (t) => {
  const dir = realpathSync(mkdtempSync(path.join(tmpdir(), "judge-noconfig-")));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  mkdirSync(path.join(dir, "scripts"), { recursive: true });
  mkdirSync(path.join(dir, "config"), { recursive: true });
  copyFileSync(SCRIPT, path.join(dir, "scripts", "typesafe-judge.mjs"));
  // The judge imports ./config.mjs and reads config/models.json; without them it would
  // fail at module loading, before the judge.json read this test is about.
  copyFileSync(path.join(path.dirname(SCRIPT), "config.mjs"), path.join(dir, "scripts", "config.mjs"));
  copyFileSync(path.join(path.dirname(SCRIPT), "..", "config", "models.json"), path.join(dir, "config", "models.json"));
  const r = runCli({ cwd: dir, env: { TYPESAFE_API_KEY: "dummy" } });
  assert.equal(r.status, 2);
  assert.match(r.stderr, /judge failed:/);
  assert.match(r.stderr, /judge\.json/);
  assert.doesNotMatch(r.stderr, /config\.mjs|ERR_MODULE_NOT_FOUND/);
  assert.doesNotMatch(r.stderr, /^\s+at /m);
});

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

// A key with surrounding whitespace: the HTTP layer sends it trimmed, so redaction must use the trimmed key too.
const PADDED_KEY_SOURCES = [
  ["a padded env key", () => ({ home: judgeHome(), env: { TYPESAFE_API_KEY: `${JUDGE_SECRET} ` } })],
  ["a padded local-file key", () => ({ home: judgeHome({ typesafe: { apiKey: `${JUDGE_SECRET}\n` } }), env: {} })],
];
for (const [label, source] of PADDED_KEY_SOURCES) {
  for (const logLevel of [undefined, "debug"]) {
    const mode = logLevel ? ` with TYPESAFE_LOG_LEVEL=${logLevel}` : "";
    test(`CLI: ${label}${mode} is sent trimmed and an error echoing it reaches neither stream`, async (t) => {
      const api = await fakeTypeSafe({ status: 400, json: { error: `invalid key ${JUDGE_SECRET}` } });
      t.after(api.close);
      const { home, env } = source();
      const r = await runCliAsync({
        home,
        env: { TYPESAFE_BASE_URL: api.url, ...env, ...(logLevel ? { TYPESAFE_LOG_LEVEL: logLevel } : {}) },
      });
      assert.equal(r.status, 2, r.stderr);
      assert.equal(api.seen.length, 1);
      assert.equal(api.seen[0].authorization, `Bearer ${JUDGE_SECRET}`);
      assert.match(r.stderr, /judge failed: 400 invalid key \[redacted\]/);
      assert.ok(!r.stderr.includes(JUDGE_SECRET) && !r.stdout.includes(JUDGE_SECRET), "the key leaked to stdout or stderr");
    });
  }
}

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
