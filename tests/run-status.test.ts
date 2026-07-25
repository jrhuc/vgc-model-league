import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { withRunStatus } from '../src/run-status.js';

function readStatus(runDir: string): Record<string, unknown> {
  return JSON.parse(fs.readFileSync(path.join(runDir, 'status.json'), 'utf8')) as Record<string, unknown>;
}

test('withRunStatus brackets a run with running and terminal markers', async () => {
  const runDir = fs.mkdtempSync(path.join(os.tmpdir(), 'vgc-status-'));
  const result = await withRunStatus(runDir, async () => {
    const during = readStatus(runDir);
    assert.equal(during.state, 'running');
    assert.equal(during.pid, process.pid);
    assert.equal(during.end_time, null);
    return 'ok';
  });
  assert.equal(result, 'ok');
  const done = readStatus(runDir);
  assert.equal(done.state, 'done');
  assert.equal(done.error, null);
  assert.equal(done.pid, undefined, 'terminal markers drop the pid');
  assert.ok(typeof done.end_time === 'string');

  await assert.rejects(
    withRunStatus(runDir, async () => {
      throw new Error('provider exploded');
    }),
    /provider exploded/,
  );
  const failed = readStatus(runDir);
  assert.equal(failed.state, 'failed');
  assert.equal(failed.error, 'provider exploded');
  assert.equal(process.listeners('SIGINT').length, 0, 'signal handlers are removed');
  fs.rmSync(runDir, { recursive: true, force: true });
});
