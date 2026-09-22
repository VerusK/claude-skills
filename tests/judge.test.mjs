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

const fakeChoice = (q, criteria) => ({ type: "choice", q, criteria });

function fakeClient(answer) {
  return { systemOne: async () => ({ answers: { answer } }) };
}

test("validate rejects missing options", () => {
  assert.throws(() => validate({ question: "x", options: [{ id: "A", label: "a" }] }), /2\.\.6 options/);
});

test("buildQuestions maps option ids to descriptions", () => {
  const q = buildQuestions(input, fakeChoice);
  assert.equal(q.answer.q, input.question);
  assert.deepEqual(Object.keys(q.answer.criteria), ["A", "B"]);
  assert.match(q.answer.criteria.A, /settings\.json env: global Claude settings/);
});

test("buildState carries context and recommendation", () => {
  const s = buildState(input);
  assert.equal(s.recommended, "A");
  assert.match(s.options, /A\. settings\.json env/);
});

test("judge accepts above threshold", async () => {
  const r = await judge(input, {
    client: fakeClient({ type: "choice", choice: "A", confidence: 0.82, probabilities: { A: 0.9, B: 0.1 } }),
    choice: fakeChoice,
    threshold: 0.7,
  });
  assert.equal(r.choice, "A");
  assert.equal(r.accepted, true);
  assert.equal(r.threshold, 0.7);
  assert.match(r.block, /Выбрано: A/);
  assert.match(r.block, /принято автоматически/);
});

test("judge rejects below threshold", async () => {
  const r = await judge(input, {
    client: fakeClient({ type: "choice", choice: "B", confidence: 0.3, probabilities: { A: 0.4, B: 0.6 } }),
    choice: fakeChoice,
    threshold: 0.7,
  });
  assert.equal(r.accepted, false);
  assert.match(r.block, /спросить пользователя/);
});

test("formatDecision lists every option with percent", () => {
  const block = formatDecision(input, { choice: "A", probabilities: { A: 0.82, B: 0.18 }, confidence: 0.64, threshold: 0.7, accepted: false });
  assert.match(block, /A\. settings\.json env\s+82%/);
  assert.match(block, /B\. ~\/\.zshenv\s+18%/);
});

test("judge throws when the SDK picks an id that is not an option", async () => {
  await assert.rejects(
    judge(input, {
      client: fakeClient({ type: "choice", choice: "Z", confidence: 0.9, probabilities: { A: 0.5, B: 0.5 } }),
      choice: fakeChoice,
      threshold: 0.7,
    }),
    /unknown choice/,
  );
});

test("judge throws on non-finite confidence", async () => {
  for (const confidence of [Number.NaN, Number.POSITIVE_INFINITY, "0.9"]) {
    await assert.rejects(
      judge(input, {
        client: fakeClient({ type: "choice", choice: "A", confidence, probabilities: { A: 0.9, B: 0.1 } }),
        choice: fakeChoice,
        threshold: 0.7,
      }),
      /unexpected SDK response shape/,
    );
  }
});

test("judge throws when probabilities is not an object", async () => {
  for (const probabilities of [null, "A=0.9", 0.9]) {
    await assert.rejects(
      judge(input, {
        client: fakeClient({ type: "choice", choice: "A", confidence: 0.9, probabilities }),
        choice: fakeChoice,
        threshold: 0.7,
      }),
      /unexpected SDK response shape/,
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
