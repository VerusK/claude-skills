#!/usr/bin/env node
// Re-vendor @typesafe-ai/sdk into vendor-node/ at the version package-lock.json resolves.
// The plugin cache has no node_modules, so the judge falls back to this copy.
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const PKG = "@typesafe-ai/sdk";
const DEST = path.join(ROOT, "vendor-node", "@typesafe-ai", "sdk");

export function lockedEntry(root = ROOT) {
  const lock = JSON.parse(readFileSync(path.join(root, "package-lock.json"), "utf8"));
  const entry = lock.packages?.[`node_modules/${PKG}`];
  if (!entry?.version) throw new Error(`${PKG} is not resolved in package-lock.json`);
  if (!entry.integrity) throw new Error(`${PKG} has no integrity in package-lock.json`);
  return { version: entry.version, integrity: entry.integrity };
}

// This code runs in every session of every install, so it is never vendored on
// the registry's word alone: the tarball must match the hash the lock recorded.
export function integrityOf(buffer, algorithm = "sha512") {
  return `${algorithm}-${createHash(algorithm).update(buffer).digest("base64")}`;
}

export function assertIntegrity(buffer, expected) {
  const algorithm = expected.split("-", 1)[0];
  const actual = integrityOf(buffer, algorithm);
  if (actual !== expected) throw new Error(`integrity mismatch for ${PKG}: expected ${expected}, got ${actual}`);
  return actual;
}

function main() {
  const { version, integrity } = lockedEntry();
  const work = mkdtempSync(path.join(tmpdir(), "vendor-sdk-"));
  try {
    const out = execFileSync("npm", ["pack", `${PKG}@${version}`, "--pack-destination", work, "--json"], {
      encoding: "utf8",
    });
    const tarball = path.join(work, JSON.parse(out)[0].filename);
    assertIntegrity(readFileSync(tarball), integrity);
    execFileSync("tar", ["-xzf", tarball, "-C", work]);
    rmSync(DEST, { recursive: true, force: true });
    mkdirSync(path.dirname(DEST), { recursive: true });
    cpSync(path.join(work, "package"), DEST, { recursive: true });
    console.log(`vendored ${PKG}@${version} into ${path.relative(ROOT, DEST)} (integrity verified)`);
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main();
