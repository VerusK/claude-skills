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
    return { name: s.name, repo: s.repo, ref: s.ref ?? "main", path: s.path, mode: s.mode === "watch" ? "watch" : "merge", patch: s.patch === true };
  });
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
    const r = spawnSync("git", ["diff", "--no-index", "--", "vendor", "upstream"], { cwd: parent, encoding: "utf8" });
    return r.stdout ?? "";
  } finally {
    rmSync(parent, { recursive: true, force: true });
  }
}

// Default fetcher: resolve ref to a commit, download tarball, extract.
// Returns { dir, commit, cleanup } — `cleanup` removes the extracted tree, and
// `syncSource` calls it once it is done with `dir`.
export async function fetchFromGitHub(source) {
  const ls = execFileSync("git", ["ls-remote", `https://github.com/${source.repo}.git`, source.ref], {
    encoding: "utf8",
    env: { ...process.env, GIT_TERMINAL_PROMPT: "0" },
  });
  const commit = ls.trim().split(/\s+/)[0] || source.ref;
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
            result.mergeErrors.push(`${rel} — ${err.message}`);
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
    const tmpVendor = path.join(root, "vendor", `${source.name}.tmp-${process.pid}`);
    mkdirSync(path.dirname(vendorDir), { recursive: true });
    rmSync(tmpVendor, { recursive: true, force: true });
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

export function summarize(results) {
  const lines = ["# Sync report", ""];
  for (const r of results) {
    const state = r.conflicts.length ? "CONFLICTS" : r.changed ? "updated" : "unchanged";
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

async function main() {
  const args = process.argv.slice(2);
  const only = args.includes("--only") ? args[args.indexOf("--only") + 1] : null;
  const sources = parseSources(readFileSync(path.join(REPO_ROOT, "sources.yaml"), "utf8")).filter((s) => !only || s.name === only);

  if (args.includes("--repatch")) {
    for (const s of sources.filter((s) => s.patch)) {
      const p = repatch(s, { root: REPO_ROOT });
      console.log(`${s.name}: ${p ? path.relative(REPO_ROOT, p) : "no local changes"}`);
    }
    return;
  }

  const results = [];
  for (const s of sources) {
    try {
      const r = await syncSource(s, { root: REPO_ROOT });
      results.push(r);
      if (s.patch) repatch(s, { root: REPO_ROOT });
    } catch (err) {
      results.push({ name: s.name, commit: "-", changed: false, conflicts: [`sync error: ${err.message}`], mergeErrors: [], added: [], removed: [], kept: [] });
    }
  }
  const report = summarize(results);
  writeFileSync(path.join(REPO_ROOT, ".sync-report.md"), report);
  console.log(report);
  process.exitCode = results.some((r) => r.conflicts.length) ? 1 : 0;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((e) => {
    console.error(`sync failed: ${e.message}`);
    process.exit(1);
  });
}
