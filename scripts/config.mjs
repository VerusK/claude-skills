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
