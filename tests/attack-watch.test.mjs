import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
test('attack-watch offline observer boundaries', () => {
  const r = spawnSync('python3', ['-m', 'unittest', 'discover', '-s', 'tests/attack_watch', '-p', 'test_*.py'], { encoding: 'utf8', timeout: 120000, env: {...process.env, PYTHONDONTWRITEBYTECODE:'1'} });
  assert.equal(r.status, 0, r.stdout + r.stderr);
});
