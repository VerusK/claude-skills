#!/usr/bin/env node
// Probabilistic judge for multiple-choice questions via TypeSafe (Jev).
// stdin: {question, options:[{id,label,description?}], context?, recommended?}
// stdout: {choice, probabilities, confidence, threshold, accepted, block}
// exit 0 ok; exit 2 judge unavailable or invalid input (caller must ask the user).
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
export const REPO_ROOT = path.resolve(HERE, "..");

export function loadConfig(configPath = path.join(REPO_ROOT, "config", "judge.json")) {
  return JSON.parse(readFileSync(configPath, "utf8"));
}

export function validate(input) {
  if (!input || typeof input.question !== "string" || !input.question.trim()) {
    throw new Error("input.question must be a non-empty string");
  }
  if (!Array.isArray(input.options) || input.options.length < 2 || input.options.length > 6) {
    throw new Error("input.options must have 2..6 options");
  }
  for (const o of input.options) {
    if (!o || typeof o.id !== "string" || typeof o.label !== "string") {
      throw new Error("each option needs string id and label");
    }
  }
  const ids = new Set(input.options.map((o) => o.id));
  if (ids.size !== input.options.length) throw new Error("option ids must be unique");
}

function optionLine(o) {
  return `${o.id}. ${o.label}${o.description ? ` — ${o.description}` : ""}`;
}

// The decision table keeps labels bare so the percent column stays aligned;
// descriptions already reach the model through the state and the criteria.
function optionLabel(o) {
  return `${o.id}. ${o.label}`;
}

export function buildQuestions(input, choice) {
  const criteria = {};
  for (const o of input.options) {
    criteria[o.id] = o.description ? `${o.label}: ${o.description}` : o.label;
  }
  return { answer: choice(input.question, criteria) };
}

export function buildState(input) {
  return {
    question: input.question,
    options: input.options.map(optionLine).join("\n"),
    context: input.context ?? "",
    recommended: input.recommended ?? "",
  };
}

export function formatDecision(input, result) {
  const pct = (v) => `${Math.round((v ?? 0) * 100)}%`;
  const width = Math.max(...input.options.map((o) => optionLabel(o).length));
  const lines = input.options.map((o) => `  ${optionLabel(o).padEnd(width)}  ${pct(result.probabilities[o.id])}`);
  const verdict = result.accepted ? "принято автоматически" : "спросить пользователя";
  return [
    `Решение (Jev): ${input.question}`,
    ...lines,
    `  Выбрано: ${result.choice}, confidence ${result.confidence.toFixed(2)}, порог ${result.threshold} → ${verdict}`,
  ].join("\n");
}

export async function judge(input, { client, choice, threshold }) {
  validate(input);
  const response = await client.systemOne({
    state: buildState(input),
    questions: buildQuestions(input, choice),
  });
  const a = response?.answers?.answer;
  if (!a || typeof a.choice !== "string" || typeof a.confidence !== "number" || !a.probabilities) {
    throw new Error("unexpected SDK response shape");
  }
  const result = {
    choice: a.choice,
    probabilities: a.probabilities,
    confidence: a.confidence,
    threshold,
    accepted: a.confidence >= threshold,
  };
  result.block = formatDecision(input, result);
  return result;
}

async function main() {
  const args = process.argv.slice(2);
  const t = args.indexOf("--threshold");
  const threshold = t >= 0 ? Number(args[t + 1]) : loadConfig().threshold;
  if (!Number.isFinite(threshold)) {
    console.error("invalid threshold");
    process.exit(2);
  }
  if (!process.env.TYPESAFE_API_KEY) {
    console.error("TYPESAFE_API_KEY is not set; judge unavailable");
    process.exit(2);
  }
  let input;
  try {
    input = JSON.parse(readFileSync(0, "utf8"));
  } catch {
    console.error("stdin must be a JSON object");
    process.exit(2);
  }
  try {
    const { TypeSafeClient, choice } = await import("@typesafe-ai/sdk");
    const client = new TypeSafeClient();
    const result = await judge(input, { client, choice, threshold });
    process.stdout.write(JSON.stringify(result) + "\n");
  } catch (err) {
    console.error(`judge failed: ${err.message}`);
    process.exit(2);
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main();
}
