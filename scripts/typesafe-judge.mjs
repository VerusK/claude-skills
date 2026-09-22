#!/usr/bin/env node
// Probabilistic judge for multiple-choice questions via TypeSafe (Jev).
// stdin: {question, options:[{id,label,description?}], context?, recommended?}
//   context is a string or a structured object {goal, decisions, facts, constraints, consequences}.
//   recommended is Claude's own pick: it is shown to the user and never sent to the judge,
//   so the judge cannot simply echo it back as agreement.
// stdout: {choice, probabilities, confidence, threshold, sufficiency, sufficiencyThreshold, accepted, block}
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
  validateContext(input.context);
}

export const CONTEXT_LIMIT = 8192;

// A structured context reaches Jev as a JSON object, so the budget is measured on the
// serialised form; a flat context is still allowed and measured in characters.
function validateContext(context) {
  if (context === undefined || context === null) return;
  if (typeof context === "string") {
    if (context.length > CONTEXT_LIMIT) throw new Error(`context too large: ${context.length} chars > ${CONTEXT_LIMIT}`);
    return;
  }
  if (typeof context !== "object" || Array.isArray(context)) {
    throw new Error("input.context must be a string or an object");
  }
  const size = Buffer.byteLength(JSON.stringify(context), "utf8");
  if (size > CONTEXT_LIMIT) throw new Error(`context too large: ${size} bytes > ${CONTEXT_LIMIT}`);
}

function optionLine(o) {
  return `${o.id}. ${o.label}${o.description ? ` — ${o.description}` : ""}`;
}

// The decision table keeps labels bare so the percent column stays aligned;
// descriptions already reach the model through the state and the criteria.
function optionLabel(o) {
  return `${o.id}. ${o.label}`;
}

// A confident pick made from a thin state is the failure mode this gate catches:
// Jev reports how well the state supports *any* choice, separately from how strongly
// it prefers one option over the others.
export const SUFFICIENCY_QUESTION =
  "Does the state contain enough concrete information to choose one option confidently, without guessing the user's intent?";

export function buildQuestions(input, choice, noul) {
  const criteria = {};
  for (const o of input.options) {
    criteria[o.id] = o.description ? `${o.label}: ${o.description}` : o.label;
  }
  return { answer: choice(input.question, criteria), sufficiency: noul(SUFFICIENCY_QUESTION) };
}

// `recommended` is deliberately absent: telling Jev what Claude already picked turns
// the judge into a rubber stamp. It survives only in the block the user reads.
export function buildState(input) {
  return {
    question: input.question,
    options: input.options.map(optionLine).join("\n"),
    context: input.context ?? "",
  };
}

export function formatDecision(input, result) {
  const pct = (v) => `${Math.round((v ?? 0) * 100)}%`;
  const width = Math.max(...input.options.map((o) => optionLabel(o).length));
  const lines = input.options.map((o) => `  ${optionLabel(o).padEnd(width)}  ${pct(result.probabilities[o.id])}`);
  // "мало данных" names the reason a confident-looking pick was still not accepted.
  const thin = result.sufficiency < result.sufficiencyThreshold;
  const verdict = result.accepted ? "принято автоматически" : `спросить пользователя${thin ? " (мало данных)" : ""}`;
  return [
    `Решение (Jev): ${input.question}`,
    ...lines,
    `  Рекомендация Claude: ${input.recommended || "—"}`,
    `  Данных достаточно: ${pct(result.sufficiency)}`,
    `  Выбрано: ${result.choice}, confidence ${result.confidence.toFixed(2)}, данных ${result.sufficiency.toFixed(2)}, порог ${result.threshold}/${result.sufficiencyThreshold} → ${verdict}`,
  ].join("\n");
}

export async function judge(input, { client, choice, noul, threshold, sufficiencyThreshold }) {
  validate(input);
  const response = await client.systemOne({
    state: buildState(input),
    questions: buildQuestions(input, choice, noul),
  });
  const a = response?.answers?.answer;
  const s = response?.answers?.sufficiency;
  if (
    !a ||
    typeof a.choice !== "string" ||
    !Number.isFinite(a.confidence) ||
    typeof a.probabilities !== "object" ||
    a.probabilities === null ||
    !s ||
    !Number.isFinite(s.noul) ||
    s.noul < 0 ||
    s.noul > 1
  ) {
    throw new Error("unexpected SDK response shape");
  }
  if (!input.options.some((o) => o.id === a.choice)) {
    throw new Error(`SDK returned an unknown choice: ${a.choice}`);
  }
  const result = {
    choice: a.choice,
    probabilities: a.probabilities,
    confidence: a.confidence,
    threshold,
    sufficiency: s.noul,
    sufficiencyThreshold,
    accepted: a.confidence >= threshold && s.noul >= sufficiencyThreshold,
  };
  result.block = formatDecision(input, result);
  return result;
}

// Reads --<name> <n> and --<name>=<n>; returns null when the flag is absent
// (the caller then falls back to config/judge.json). Any other --<name>* spelling
// is a typo, not a silent no-op.
export function parseNumberArg(args, name) {
  const flag = `--${name}`;
  let raw;
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === flag) {
      // A trailing flag with no value stays "" so it is reported as an invalid
      // value rather than falling back to the config file.
      raw = args[i + 1] ?? "";
      i++;
    } else if (a.startsWith(`${flag}=`)) {
      raw = a.slice(flag.length + 1);
    } else if (a.startsWith(flag)) {
      throw new Error(`unknown option: ${a}`);
    }
  }
  return raw === undefined ? null : raw;
}

export const parseThresholdArg = (args) => parseNumberArg(args, "threshold");
export const parseSufficiencyArg = (args) => parseNumberArg(args, "sufficiency");

async function main() {
  let threshold;
  let sufficiencyThreshold;
  try {
    const args = process.argv.slice(2);
    const rawThreshold = parseNumberArg(args, "threshold");
    const rawSufficiency = parseNumberArg(args, "sufficiency");
    const cfg = rawThreshold === null || rawSufficiency === null ? loadConfig() : {};
    threshold = rawThreshold === null ? cfg.threshold : rawThreshold.trim() === "" ? Number.NaN : Number(rawThreshold);
    sufficiencyThreshold =
      rawSufficiency === null ? cfg.sufficiencyThreshold : rawSufficiency.trim() === "" ? Number.NaN : Number(rawSufficiency);
  } catch (err) {
    console.error(`judge failed: ${err.message}`);
    process.exit(2);
  }
  if (!Number.isFinite(threshold)) {
    console.error("invalid threshold");
    process.exit(2);
  }
  if (!(threshold > 0 && threshold <= 1)) {
    console.error("threshold must be in (0,1]");
    process.exit(2);
  }
  if (!Number.isFinite(sufficiencyThreshold)) {
    console.error("invalid sufficiency");
    process.exit(2);
  }
  if (!(sufficiencyThreshold > 0 && sufficiencyThreshold <= 1)) {
    console.error("sufficiency must be in (0,1]");
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
    const { TypeSafeClient, choice, noul } = await import("@typesafe-ai/sdk");
    const client = new TypeSafeClient();
    const result = await judge(input, { client, choice, noul, threshold, sufficiencyThreshold });
    process.stdout.write(JSON.stringify(result) + "\n");
  } catch (err) {
    console.error(`judge failed: ${err.message}`);
    process.exit(2);
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((err) => {
    console.error(`judge failed: ${err.message}`);
    process.exit(2);
  });
}
