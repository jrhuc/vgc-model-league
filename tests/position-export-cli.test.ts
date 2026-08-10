import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const exporter = fileURLToPath(new URL('../tools/export-position-panels.js', import.meta.url));

test('candidate export refuses target and source-game-cap overrides', () => {
  for (const flag of ['--size', '--per-game']) {
    const result = spawnSync(process.execPath, [exporter, flag, '1'], { encoding: 'utf8' });
    assert.equal(result.status, 1);
    assert.match(result.stderr, new RegExp(`unknown option or missing value: ${flag}`, 'u'));
  }
});
