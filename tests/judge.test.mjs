import { test } from "node:test";
import assert from "node:assert/strict";
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
