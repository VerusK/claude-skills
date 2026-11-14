import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
test('attack-watch offline observer boundaries', () => {
  const r = spawnSync('python3', ['-m', 'unittest', 'discover', '-s', 'tests/attack_watch', '-p', 'test_*.py'], { encoding: 'utf8', timeout: 120000, env: {...process.env, PYTHONDONTWRITEBYTECODE:'1'} });
  assert.equal(r.status, 0, r.stdout + r.stderr);
});

import { readFileSync, existsSync, mkdtempSync, realpathSync, rmSync } from 'node:fs';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import YAML from 'yaml';
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SKILL = path.join(ROOT, 'skills', 'attack-watch');

test('attack-watch is discoverable and every relative resource link ships inside the skill', () => {
  const text = readFileSync(path.join(SKILL, 'SKILL.md'), 'utf8');
  const frontmatter = text.match(/^---\n([\s\S]*?)\n---\n/);
  assert.ok(frontmatter, 'loadable frontmatter required');
  const meta = YAML.parse(frontmatter[1]);
  assert.equal(meta.name, 'attack-watch');
  assert.equal(typeof meta.description, 'string');
  assert.ok(meta.description.length > 0);
  assert.notEqual(meta['disable-model-invocation'], true);
  const resources = [...text.matchAll(/\]\(([^)]+)\)/g)].map(m => m[1]).filter(p => !p.includes('://'));
  assert.ok(resources.length > 0, 'progressive references required');
  for (const resource of resources) {
    const resolved = path.resolve(SKILL, resource);
    assert.ok(resolved.startsWith(SKILL + path.sep), `external runtime resource: ${resource}`);
    assert.ok(existsSync(resolved), `missing packaged resource: ${resource}`);
  }
});

test('isolated installer discovers attack-watch for Claude and Codex with executable resources', () => {
  const home = realpathSync(mkdtempSync(path.join(tmpdir(), 'attack-watch-install-')));
  try {
    const r = spawnSync(process.execPath, [path.join(ROOT, 'scripts/install.mjs'), '--home', home, '--skip-plugin'], {
      encoding: 'utf8', timeout: 10000,
      env: {...process.env, HOME: home, CODEX_HOME: '', TYPESAFE_API_KEY: '',
        PATH: path.join(ROOT, 'tests/fixtures/fake-bin') + path.delimiter + process.env.PATH, FAKE_CLAUDE_PLUGINS: ''},
    });
    assert.equal(r.status, 0, r.stdout + r.stderr);
    for (const agent of ['.claude', '.agents']) {
      const installed = path.join(home, agent, 'skills/attack-watch');
      assert.equal(realpathSync(installed), realpathSync(SKILL));
      assert.ok(existsSync(path.join(installed, 'references/actions.md')));
      const help = spawnSync('python3', [path.join(installed, 'scripts/cf_block.py'), '--help'], {
        encoding: 'utf8', timeout: 10000, env: {...process.env, PYTHONDONTWRITEBYTECODE:'1'},
      });
      assert.equal(help.status, 0, help.stdout + help.stderr);
      assert.match(help.stdout, /--rollback/);
    }
  } finally { rmSync(home, {recursive:true, force:true}); }
});
