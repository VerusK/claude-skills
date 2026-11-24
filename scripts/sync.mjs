#!/usr/bin/env node
// Sync external skills from GitHub into vendor/ and three-way merge into skills/.
import { execFileSync, spawnSync } from "node:child_process";
import {
  existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync, rmSync, cpSync,
  readdirSync, statSync, lstatSync, renameSync, unlinkSync,
} from "node:fs";
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import YAML from "yaml";

const HERE = path.dirname(fileURLToPath(import.meta.url));
export const REPO_ROOT = path.resolve(HERE, "..");

export function parseSources(text) {
  const doc = YAML.parse(text);
  if (!doc || !Array.isArray(doc.sources)) throw new Error("sources.yaml must contain a 'sources' list");
  return doc.sources.map((s) => {
    for (const k of ["name", "repo", "path"]) {
      if (typeof s[k] !== "string" || !s[k]) throw new Error(`source is missing '${k}'`);
    }
    return {
      name: s.name, repo: s.repo,
      ref: typeof s.ref === "string" ? s.ref : null,
      license: typeof s.license === "string" ? s.license : null,
      path: s.path, mode: s.mode === "watch" ? "watch" : "merge", patch: s.patch === true,
    };
  });
}

const SHA_RE = /^[0-9a-f]{40}$/;
// SPDX license identifiers this distro accepts. Not the whole SPDX list: add the id here
// when a new source needs one, after checking it against https://spdx.org/licenses/.
export const SPDX_IDS = new Set([
  "0BSD", "AGPL-3.0-only", "AGPL-3.0-or-later", "Apache-2.0", "Artistic-2.0", "BlueOak-1.0.0",
  "BSD-2-Clause", "BSD-3-Clause", "BSL-1.0", "CC-BY-4.0", "CC-BY-SA-4.0", "CC0-1.0", "EPL-2.0",
  "GPL-2.0-only", "GPL-2.0-or-later", "GPL-3.0-only", "GPL-3.0-or-later", "ISC",
  "LGPL-2.1-only", "LGPL-2.1-or-later", "LGPL-3.0-only", "LGPL-3.0-or-later", "MIT", "MIT-0",
  "MPL-2.0", "Unlicense", "Zlib",
]);

// Parse an SPDX license expression: `idstring [WITH exception]`, combined with AND / OR
// (AND binds tighter), parentheses nesting. Returns an error string, or null when valid.
// Every id must be in SPDX_IDS; an exception after WITH only needs the SPDX id shape.
export function spdxError(expr) {
  const tokens = String(expr).match(/\(|\)|[^\s()]+/g) ?? [];
  let i = 0;
  const fail = (m) => { throw new Error(m); };
  const simple = () => {
    const t = tokens[i++];
    if (t === "(") {
      or();
      if (tokens[i++] !== ")") fail("unbalanced parentheses");
      return;
    }
    if (t === undefined || t === ")" || /^(AND|OR|WITH)$/.test(t)) fail(`unexpected ${t === undefined ? "end of expression" : `'${t}'`}`);
    if (!SPDX_IDS.has(t)) fail(`unknown license id '${t}'`);
    if (tokens[i] === "WITH") {
      i++;
      const ex = tokens[i++];
      if (!ex || !/^[A-Za-z0-9.+-]+$/.test(ex) || /^(AND|OR|WITH)$/.test(ex)) fail("WITH needs an exception id");
    }
  };
  const and = () => { simple(); while (tokens[i] === "AND") { i++; simple(); } };
  const or = () => { and(); while (tokens[i] === "OR") { i++; and(); } };
  try {
    or();
    if (i < tokens.length) fail(`unexpected '${tokens[i]}'`);
    return null;
  } catch (e) {
    return e.message;
  }
}

// Problems that make a sources.yaml unfit to sync from: every source must be pinned
// to a full commit sha (`ref`) and carry an SPDX `license`. An update run resolves
// the pin itself, so it passes `requirePinned: false`.
export function validateSources(list, { requirePinned = true } = {}) {
  const problems = [];
  const seen = new Set();
  for (const s of list) {
    if (seen.has(s.name)) problems.push(`${s.name}: duplicate source name`);
    seen.add(s.name);
    if (requirePinned && !SHA_RE.test(s.ref ?? "")) {
      problems.push(`${s.name}: ref must be a full 40-hex commit sha, got ${JSON.stringify(s.ref)} — pin it with 'make sync-update ARGS="--only ${s.name}"'`);
    }
    if (!s.license) problems.push(`${s.name}: license is missing (SPDX id from the upstream LICENSE)`);
    else {
      const err = spdxError(s.license);
      if (err) problems.push(`${s.name}: license ${JSON.stringify(s.license)} is not a valid SPDX expression (${err})`);
    }
  }
  return problems;
}

// Rewrite `ref` of the named sources in sources.yaml text, keeping comments and every
// other field. `pins` maps source name -> commit sha.
export function pinSources(text, pins) {
  const doc = YAML.parseDocument(text);
  const items = doc.get("sources");
  const names = new Set();
  for (const item of items.items) {
    const name = item.get("name");
    names.add(name);
    if (name in pins) item.set("ref", pins[name]);
  }
  for (const name of Object.keys(pins)) {
    if (!names.has(name)) throw new Error(`unknown source '${name}'`);
  }
  return doc.toString();
}

function gitLsRemote(source, ref) {
  return execFileSync("git", ["ls-remote", `https://github.com/${source.repo}.git`, ref, `${ref}^{}`], {
    encoding: "utf8",
    env: { ...process.env, GIT_TERMINAL_PROMPT: "0" },
  });
}

// Turn a branch, tag or sha into a commit sha. `lsRemote(source, ref)` is injectable for tests.
// An annotated tag resolves to the commit it points at (the peeled `^{}` line), not the tag object.
export async function resolveRef(source, ref, { lsRemote = gitLsRemote } = {}) {
  if (SHA_RE.test(ref)) return ref;
  const lines = (await lsRemote(source, ref)).trim().split("\n").filter(Boolean);
  const peeled = lines.find((l) => l.endsWith("^{}"));
  const sha = (peeled ?? lines[0] ?? "").split(/\s+/)[0];
  if (!SHA_RE.test(sha)) throw new Error(`${source.name}: cannot resolve '${ref}' in ${source.repo}`);
  return sha;
}

export function readLock(root) {
  const p = path.join(root, "sources.lock.json");
  return existsSync(p) ? JSON.parse(readFileSync(p, "utf8")) : {};
}

export function writeLock(root, lock) {
  writeFileSync(path.join(root, "sources.lock.json"), JSON.stringify(lock, null, 2) + "\n");
}

// Regular files only. `lstatSync` keeps a dangling symlink from throwing, and
// symlinks/sockets/fifos/devices are not distro content, so they are skipped.
function listFiles(dir, base = dir) {
  if (!existsSync(dir)) return [];
  const out = [];
  for (const entry of readdirSync(dir)) {
    const full = path.join(dir, entry);
    let st;
    try {
      st = lstatSync(full);
    } catch {
      continue; // vanished between readdir and lstat
    }
    if (st.isDirectory()) out.push(...listFiles(full, base));
    else if (st.isFile()) out.push(path.relative(base, full));
  }
  return out.sort();
}

export function hashTree(dir) {
  const h = createHash("sha256");
  for (const rel of listFiles(dir)) {
    h.update(rel + "\0");
    h.update(readFileSync(path.join(dir, rel)));
    h.update("\0");
  }
  return h.digest("hex");
}

function sameContent(a, b) {
  return existsSync(a) && existsSync(b) && readFileSync(a).equals(readFileSync(b));
}

function copyFile(from, to) {
  mkdirSync(path.dirname(to), { recursive: true });
  cpSync(from, to);
}

// Returns the number of conflicts (0 = clean merge) and writes the result into `ours`.
// Throws when git could not merge at all — e.g. `error: Cannot merge binary files` exits
// 255. Those are errors, not conflicts: nothing was written and no markers exist.
function mergeFile(ours, base, theirs) {
  const r = spawnSync("git", ["merge-file", "-L", "ours", "-L", "base", "-L", "upstream", ours, base, theirs], { encoding: "utf8" });
  if (r.error) throw new Error(`git merge-file could not run: ${r.error.message}`);
  const stderr = (r.stderr ?? "").trim();
  const failed = r.status === null || r.status < 0 || r.status >= 128 || (r.status !== 0 && stderr.startsWith("error:"));
  if (failed) throw new Error(stderr.replace(/^error:\s*/, "") || `git merge-file exited with status ${r.status}`);
  return r.status; // git returns the number of conflicts
}

// Diff two trees through a scratch parent holding `vendor/` and `upstream/`, so the
// headers read `a/vendor/<file>` / `b/upstream/<file>` instead of absolute temp paths.
function diffDirs(vendorDir, stagedDir) {
  const parent = mkdtempSync(path.join(tmpdir(), "sync-diff-"));
  try {
    cpSync(vendorDir, path.join(parent, "vendor"), { recursive: true });
    cpSync(stagedDir, path.join(parent, "upstream"), { recursive: true });
    // The -c flags pin the output shape against user git config (`diff.noprefix`,
    // `diff.mnemonicPrefix`), and --no-ext-diff keeps a configured external differ out.
    const r = spawnSync("git", [
      "-c", "diff.noprefix=false", "-c", "diff.mnemonicPrefix=false",
      "diff", "--no-index", "--no-ext-diff", "--", "vendor", "upstream",
    ], { cwd: parent, encoding: "utf8" });
    return r.stdout ?? "";
  } finally {
    rmSync(parent, { recursive: true, force: true });
  }
}

// Default fetcher: download the tarball of the pinned commit, extract.
// Never follows a moving branch: an unpinned ref is an error (see `--update`).
// Returns { dir, commit, cleanup } — `cleanup` removes the extracted tree, and
// `syncSource` calls it once it is done with `dir`.
export async function fetchFromGitHub(source) {
  if (!SHA_RE.test(source.ref ?? "")) {
    throw new Error(`${source.name}: ref ${JSON.stringify(source.ref)} is not pinned to a commit; run 'make sync-update ARGS="--only ${source.name}"'`);
  }
  const commit = source.ref;
  const work = mkdtempSync(path.join(tmpdir(), `skills-${source.name}-`));
  const cleanup = () => rmSync(work, { recursive: true, force: true });
  try {
    const tar = path.join(work, "src.tar.gz");
    const res = await fetch(`https://codeload.github.com/${source.repo}/tar.gz/${commit}`);
    if (!res.ok) throw new Error(`download failed for ${source.repo}@${commit}: ${res.status}`);
    writeFileSync(tar, Buffer.from(await res.arrayBuffer()));
    const dir = path.join(work, "tree");
    mkdirSync(dir);
    execFileSync("tar", ["-xzf", tar, "-C", dir, "--strip-components=1"]);
    return { dir, commit, cleanup };
  } catch (err) {
    cleanup();
    throw err;
  }
}

// Stage the upstream `path` into a fresh dir shaped like vendor/<name>.
function stageUpstream(source, fetched) {
  const src = path.join(fetched.dir, source.path);
  if (!existsSync(src)) throw new Error(`${source.name}: path '${source.path}' not found in ${source.repo}@${fetched.commit}`);
  const staged = mkdtempSync(path.join(tmpdir(), `stage-${source.name}-`));
  if (statSync(src).isDirectory()) cpSync(src, staged, { recursive: true });
  else copyFile(src, path.join(staged, path.basename(src)));
  return staged;
}

export async function syncSource(source, { root = REPO_ROOT, fetchSource = fetchFromGitHub } = {}) {
  const fetched = await fetchSource(source);
  let staged = null;
  try {
    staged = stageUpstream(source, fetched);
    const vendorDir = path.join(root, "vendor", source.name);
    const skillDir = path.join(root, "skills", source.name);
    const result = {
      name: source.name, commit: fetched.commit, mode: source.mode, changed: false,
      conflicts: [], mergeErrors: [], added: [], removed: [], kept: [],
    };

    const oldHash = existsSync(vendorDir) ? hashTree(vendorDir) : null;
    const newHash = hashTree(staged);
    result.changed = oldHash !== newHash;

    if (source.mode === "watch") {
      if (result.changed && oldHash) result.diff = diffDirs(vendorDir, staged);
    } else {
      const newFiles = listFiles(staged);
      const oldFiles = listFiles(vendorDir);
      for (const rel of newFiles) {
        const theirs = path.join(staged, rel);
        const base = path.join(vendorDir, rel);
        const ours = path.join(skillDir, rel);
        if (!existsSync(ours)) {
          copyFile(theirs, ours);
          result.added.push(rel);
        } else if (!existsSync(base)) {
          result.kept.push(rel); // local file with no upstream history: keep ours
        } else if (sameContent(base, theirs)) {
          // upstream unchanged
        } else if (sameContent(base, ours)) {
          copyFile(theirs, ours); // we never modified it
        } else {
          try {
            if (mergeFile(ours, base, theirs) > 0) result.conflicts.push(rel);
          } catch (err) {
            // git could not merge this file at all: leave our copy exactly as it is.
            // git's stderr names `ours` by its absolute path; report it repo-relative.
            const msg = err.message.split(ours).join(path.relative(root, ours));
            result.mergeErrors.push(`${rel} — ${msg}`);
            result.kept.push(rel);
          }
        }
      }
      for (const rel of oldFiles) {
        if (newFiles.includes(rel)) continue;
        const ours = path.join(skillDir, rel);
        if (!existsSync(ours)) continue;
        if (sameContent(path.join(vendorDir, rel), ours)) {
          unlinkSync(ours);
          result.removed.push(rel);
        } else {
          result.kept.push(rel);
        }
      }
    }

    // Swap vendor in one rename so an interrupted run never leaves a half-copied tree.
    const tmpPrefix = `${source.name}.tmp-`;
    const tmpVendor = path.join(root, "vendor", `${tmpPrefix}${process.pid}`);
    mkdirSync(path.dirname(vendorDir), { recursive: true });
    // Drop leftovers from any interrupted run, not just this pid's.
    for (const entry of readdirSync(path.dirname(vendorDir))) {
      if (entry.startsWith(tmpPrefix)) rmSync(path.join(root, "vendor", entry), { recursive: true, force: true });
    }
    try {
      cpSync(staged, tmpVendor, { recursive: true });
      rmSync(vendorDir, { recursive: true, force: true });
      renameSync(tmpVendor, vendorDir);
    } catch (err) {
      rmSync(tmpVendor, { recursive: true, force: true });
      throw err;
    }

    // Only once vendor really is the new tree does the lock get to claim it.
    const lock = readLock(root);
    lock[source.name] = { repo: source.repo, ref: source.ref, path: source.path, commit: fetched.commit, hash: newHash, syncedAt: new Date().toISOString() };
    writeLock(root, lock);
    return result;
  } finally {
    if (staged) rmSync(staged, { recursive: true, force: true });
    await fetched?.cleanup?.();
  }
}

export function repatch(source, { root = REPO_ROOT } = {}) {
  const vendorDir = path.join(root, "vendor", source.name);
  const skillDir = path.join(root, "skills", source.name);
  const out = path.join(root, "patches", `${source.name}.patch`);
  mkdirSync(path.dirname(out), { recursive: true });
  const r = spawnSync("diff", ["-ruN", path.relative(root, vendorDir), path.relative(root, skillDir)], { cwd: root, encoding: "utf8" });
  if (r.status === 0) {
    if (existsSync(out)) unlinkSync(out);
    return null;
  }
  if (r.status !== 1) throw new Error(`diff failed for ${source.name}: ${r.stderr}`);
  writeFileSync(out, r.stdout);
  return out;
}

// A run is blocking when any source left conflict markers or could not merge a file.
export function hasBlockingResults(results) {
  return results.some((r) => r.conflicts.length || (r.mergeErrors?.length ?? 0));
}

export function summarize(results) {
  const lines = ["# Sync report", ""];
  for (const r of results) {
    // CONFLICTS > MERGE ERRORS > updated > unchanged: both states fail the run,
    // but markers in skills/ are the louder problem.
    const state = r.conflicts.length ? "CONFLICTS"
      : (r.mergeErrors?.length ?? 0) ? "MERGE ERRORS"
      : r.changed ? "updated" : "unchanged";
    lines.push(`## ${r.name} — ${state} (${r.commit.slice(0, 7)})`);
    if (r.added.length) lines.push(`- added: ${r.added.join(", ")}`);
    if (r.removed.length) lines.push(`- removed: ${r.removed.join(", ")}`);
    if (r.kept.length) lines.push(`- kept local (upstream deleted or unknown): ${r.kept.join(", ")}`);
    if (r.conflicts.length) lines.push(`- conflicts (markers left in skills/${r.name}): ${r.conflicts.join(", ")}`);
    for (const e of r.mergeErrors ?? []) lines.push(`- merge error, local copy kept: ${e}`);
    if (r.diff) lines.push("", "```diff", r.diff.trim(), "```");
    lines.push("");
  }
  return lines.join("\n");
}

function flagValue(args, flag) {
  const i = args.indexOf(flag);
  if (i === -1) return null;
  const v = args[i + 1];
  if (!v || v.startsWith("--")) throw new Error(`${flag} needs a value`);
  return v;
}

async function main() {
  const args = process.argv.slice(2);
  const only = flagValue(args, "--only");
  const to = flagValue(args, "--to");
  const update = args.includes("--update");
  const yamlPath = path.join(REPO_ROOT, "sources.yaml");
  const all = parseSources(readFileSync(yamlPath, "utf8"));
  if (only && !all.some((s) => s.name === only)) throw new Error(`unknown source '${only}'`);
  if (to && !(update && only)) throw new Error("--to needs --update and --only <source>");
  const problems = validateSources(all, { requirePinned: !update && !args.includes("--repatch") });
  if (problems.length) throw new Error(`sources.yaml is not valid:\n- ${problems.join("\n- ")}`);
  const sources = all.filter((s) => !only || s.name === only);

  if (args.includes("--repatch")) {
    for (const s of sources.filter((s) => s.patch)) {
      const p = repatch(s, { root: REPO_ROOT });
      console.log(`${s.name}: ${p ? path.relative(REPO_ROOT, p) : "no local changes"}`);
    }
    return;
  }

  const { results } = await runSync(sources, { root: REPO_ROOT, update, to });
  const report = summarize(results);
  writeFileSync(path.join(REPO_ROOT, ".sync-report.md"), report);
  console.log(report);
  process.exitCode = hasBlockingResults(results) ? 1 : 0;
}

// Sync every source, each inside its own error boundary: one unreachable repository or
// failed merge is reported and the rest still run. With `update`, each source first
// resolves its new pin (upstream head, or `to`); the pin is written to sources.yaml as
// soon as that source's sync has succeeded, so sources.yaml and sources.lock.json agree
// even when the patch record for it cannot be regenerated afterwards.
export async function runSync(sources, { root = REPO_ROOT, update = false, to = null, fetchSource, lsRemote } = {}) {
  const yamlPath = path.join(root, "sources.yaml");
  const results = [];
  const failure = (name, msg) => ({ name, commit: "-", changed: false, conflicts: [msg], mergeErrors: [], added: [], removed: [], kept: [] });
  for (const original of sources) {
    let s = original;
    if (update) {
      try {
        s = { ...s, ref: await resolveRef(s, to ?? "HEAD", { lsRemote }) };
      } catch (err) {
        results.push(failure(s.name, `sync error: ${err.message}`)); // keeps the old pin
        continue;
      }
    }
    let r;
    try {
      r = await syncSource(s, { root, ...(fetchSource ? { fetchSource } : {}) });
    } catch (err) {
      results.push(failure(s.name, `sync error: ${err.message}`));
      continue;
    }
    results.push(r);
    if (update && s.ref !== original.ref) {
      writeFileSync(yamlPath, pinSources(readFileSync(yamlPath, "utf8"), { [s.name]: s.ref }));
    }
    if (s.patch) {
      try {
        repatch(s, { root });
      } catch (err) {
        r.mergeErrors.push(`patch record not regenerated — run make repatch: ${err.message}`);
      }
    }
  }
  return { results };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((e) => {
    console.error(`sync failed: ${e.message}`);
    process.exit(1);
  });
}
