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
