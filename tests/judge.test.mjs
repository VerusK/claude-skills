import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { copyFileSync, mkdirSync, mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { judge, validate, buildState, buildQuestions, formatDecision } from "../scripts/typesafe-judge.mjs";

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
  sufficiencyThreshold: 0.6,
  ...over,
});

test("validate rejects missing options", () => {
  assert.throws(() => validate({ question: "x", options: [{ id: "A", label: "a" }] }), /2\.\.6 options/);
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

test("judge accepts above both thresholds", async () => {
  const r = await judge(
    input,
    deps(fakeClient({ type: "choice", choice: "A", confidence: 0.82, probabilities: { A: 0.9, B: 0.1 } }, { type: "noul", noul: 0.71 })),
  );
  assert.equal(r.choice, "A");
  assert.equal(r.accepted, true);
  assert.equal(r.threshold, 0.7);
  assert.equal(r.sufficiency, 0.71);
  assert.equal(r.sufficiencyThreshold, 0.6);
  assert.match(r.block, /Выбрано: A, confidence 0\.82, данных 0\.71, порог 0\.7\/0\.6 → принято автоматически/);
});

test("judge rejects below threshold", async () => {
  const r = await judge(
    input,
    deps(fakeClient({ type: "choice", choice: "B", confidence: 0.3, probabilities: { A: 0.4, B: 0.6 } })),
  );
  assert.equal(r.accepted, false);
  assert.match(r.block, /спросить пользователя/);
  assert.doesNotMatch(r.block, /мало данных/);
});

test("judge rejects a confident answer built on too little data", async () => {
  const r = await judge(
    input,
    deps(fakeClient({ type: "choice", choice: "A", confidence: 0.99, probabilities: { A: 0.99, B: 0.01 } }, { type: "noul", noul: 0.2 })),
  );
  assert.equal(r.accepted, false);
  assert.equal(r.sufficiency, 0.2);
  assert.match(r.block, /спросить пользователя \(мало данных\)/);
});

test("formatDecision lists every option with percent", () => {
  const block = formatDecision(input, {
    choice: "A",
    probabilities: { A: 0.82, B: 0.18 },
    confidence: 0.64,
    threshold: 0.7,
    sufficiency: 0.71,
    sufficiencyThreshold: 0.6,
    accepted: false,
  });
  assert.match(block, /A\. settings\.json env\s+82%/);
  assert.match(block, /B\. ~\/\.zshenv\s+18%/);
  assert.match(block, /Рекомендация Claude: A/);
  assert.match(block, /Данных достаточно: 71%/);
});

test("formatDecision prints a dash when Claude has no recommendation", () => {
  const block = formatDecision({ ...input, recommended: undefined }, {
    choice: "A",
    probabilities: { A: 0.82, B: 0.18 },
    confidence: 0.64,
    threshold: 0.7,
    sufficiency: 0.71,
    sufficiencyThreshold: 0.6,
    accepted: false,
  });
  assert.match(block, /Рекомендация Claude: —/);
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

// --- CLI: every run below is offline. Either TYPESAFE_API_KEY is absent (the script
// exits before importing the SDK) or stdin is invalid (judge() validates before it
// calls the client), so no test can reach the TypeSafe API.
const SCRIPT = fileURLToPath(new URL("../scripts/typesafe-judge.mjs", import.meta.url));

function runCli({ args = [], stdin = "{}", env = {}, cwd } = {}) {
  // Strip the real key from the inherited env so a test can never authenticate.
  const { TYPESAFE_API_KEY, ...clean } = process.env;
  return spawnSync(process.execPath, [cwd ? path.join(cwd, "scripts", "typesafe-judge.mjs") : SCRIPT, ...args], {
    input: stdin,
    encoding: "utf8",
    timeout: 20000,
    env: { ...clean, ...env },
  });
}

test("CLI exits 2 when TYPESAFE_API_KEY is missing", () => {
  const r = runCli({});
  assert.equal(r.status, 2);
  assert.match(r.stderr, /TYPESAFE_API_KEY is not set/);
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
    assert.match(r.stderr, /invalid threshold/, `args=${args.join(" ")}`);
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

test("CLI exits 2 on a sufficiency outside (0,1]", () => {
  for (const args of [["--sufficiency", "0"], ["--sufficiency", "1.5"], ["--sufficiency=-1"]]) {
    const r = runCli({ args, env: { TYPESAFE_API_KEY: "dummy" } });
    assert.equal(r.status, 2, `args=${args.join(" ")}`);
    assert.match(r.stderr, /sufficiency must be in \(0,1\]/, `args=${args.join(" ")}`);
  }
});

test("CLI reads both --sufficiency spellings", () => {
  // config/judge.json holds a valid sufficiencyThreshold, so an error about the
  // flag's own value proves the flag was parsed rather than silently ignored.
  for (const args of [["--sufficiency=0.9"], ["--sufficiency", "0.9"]]) {
    const ok = runCli({ args, env: { TYPESAFE_API_KEY: "dummy" } });
    assert.equal(ok.status, 2, `args=${args.join(" ")}`);
    assert.doesNotMatch(ok.stderr, /sufficiency/, `args=${args.join(" ")}`);
    assert.match(ok.stderr, /judge failed: input\.question/, `args=${args.join(" ")}`);
  }
});

test("CLI exits 2 on an unparsable sufficiency", () => {
  for (const args of [["--sufficiency", "abc"], ["--sufficiency"], ["--sufficiency="], ["--sufficiency=abc"]]) {
    const r = runCli({ args, env: { TYPESAFE_API_KEY: "dummy" } });
    assert.equal(r.status, 2, `args=${args.join(" ")}`);
    assert.match(r.stderr, /invalid sufficiency/, `args=${args.join(" ")}`);
  }
});

test("CLI exits 2 on an unknown --sufficiency* flag", () => {
  for (const args of [["--sufficiencys=0.9"], ["--sufficiency-value", "0.9"]]) {
    const r = runCli({ args, env: { TYPESAFE_API_KEY: "dummy" } });
    assert.equal(r.status, 2, `args=${args.join(" ")}`);
    assert.match(r.stderr, /unknown option/, `args=${args.join(" ")}`);
    assert.doesNotMatch(r.stderr, /^\s+at /m);
  }
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
  copyFileSync(SCRIPT, path.join(dir, "scripts", "typesafe-judge.mjs"));
  const r = runCli({ cwd: dir, env: { TYPESAFE_API_KEY: "dummy" } });
  assert.equal(r.status, 2);
  assert.match(r.stderr, /judge failed:/);
  assert.doesNotMatch(r.stderr, /^\s+at /m);
});
