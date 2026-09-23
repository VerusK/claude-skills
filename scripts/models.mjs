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
