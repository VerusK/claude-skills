#!/usr/bin/env node
// One version across package.json and the three plugin manifests; `claude plugin
// tag` refuses a release when plugin.json and the marketplace entry disagree.
import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const USAGE = "usage: bump-version.mjs <patch|minor|major|X.Y.Z>";

export const VERSIONED = [
  "package.json",
  ".claude-plugin/plugin.json",
  ".codex-plugin/plugin.json",
  ".claude-plugin/marketplace.json",
];

const isMarketplace = (rel) => rel.endsWith("marketplace.json");

export function readVersions(root = ROOT) {
  const out = {};
  for (const rel of VERSIONED) {
    const json = JSON.parse(readFileSync(path.join(root, rel), "utf8"));
    out[rel] = isMarketplace(rel) ? json.plugins[0].version : json.version;
  }
  return out;
}

export function nextVersion(current, bump) {
  if (/^\d+\.\d+\.\d+$/.test(bump)) return bump;
  const [major, minor, patch] = current.split(".").map(Number);
  if (bump === "patch") return `${major}.${minor}.${patch + 1}`;
  if (bump === "minor") return `${major}.${minor + 1}.0`;
  if (bump === "major") return `${major + 1}.0.0`;
  throw new Error(`unknown bump "${bump}" — expected patch|minor|major|X.Y.Z`);
}

export function setVersion(version, root = ROOT) {
  for (const rel of VERSIONED) {
    const p = path.join(root, rel);
    const json = JSON.parse(readFileSync(p, "utf8"));
    if (isMarketplace(rel)) json.plugins[0].version = version;
    else json.version = version;
    writeFileSync(p, JSON.stringify(json, null, 2) + "\n");
  }
}

function main() {
  const bump = process.argv[2];
  if (!bump) {
    console.error(USAGE);
    process.exitCode = 1;
    return;
  }
  const versions = readVersions();
  const distinct = new Set(Object.values(versions));
  if (distinct.size !== 1) {
    console.error(`versions disagree before the bump: ${JSON.stringify(versions, null, 2)}`);
    process.exitCode = 1;
    return;
  }
  let version;
  try {
    version = nextVersion([...distinct][0], bump);
  } catch (err) {
    console.error(err.message);
    console.error(USAGE);
    process.exitCode = 1;
    return;
  }
  setVersion(version);
  console.log(`version ${version} written to ${VERSIONED.join(", ")}`);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main();
