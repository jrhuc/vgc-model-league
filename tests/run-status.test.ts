import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { main } from '../src/cli.js';
import { acquireLease, withRunStatus, writeRunStatus } from '../src/run-status.js';

function readStatus(runDir: string): Record<string, unknown> {
  return JSON.parse(fs.readFileSync(path.join(runDir, 'status.json'), 'utf8')) as Record<string, unknown>;
}

test('withRunStatus holds a run lease and writes lifecycle status', async (t) => {
  const runDir = fs.mkdtempSync(path.join(os.tmpdir(), 'vgc-status-'));
  t.after(() => fs.rmSync(runDir, { recursive: true, force: true }));
  const lease = path.join(runDir, '.run.lease');

  const result = await withRunStatus(runDir, async () => {
    assert.equal(readStatus(runDir).state, 'running');
    assert.equal(fs.existsSync(lease), true);
    await assert.rejects(
      withRunStatus(runDir, async () => 'second'),
      new RegExp(`owned by live pid ${process.pid}`),
    );
    return 'ok';
  });
  assert.equal(result, 'ok');
  assert.equal(fs.existsSync(lease), false);
  assert.deepEqual(
    { state: readStatus(runDir).state, error: readStatus(runDir).error },
    { state: 'done', error: null },
  );

  await assert.rejects(
    withRunStatus(runDir, async () => {
      throw new Error('provider exploded');
    }),
    /provider exploded/,
  );
  assert.deepEqual(
    { state: readStatus(runDir).state, error: readStatus(runDir).error },
    { state: 'failed', error: 'provider exploded' },
  );
  assert.equal(process.listeners('SIGINT').length, 0);
});

test('direct lifecycle status writers hold the same run lease', async (t) => {
  const runDir = fs.mkdtempSync(path.join(os.tmpdir(), 'vgc-direct-status-'));
  t.after(() => fs.rmSync(runDir, { recursive: true, force: true }));
  const start = new Date().toISOString();
  writeRunStatus(runDir, {
    state: 'running',
    error: null,
    notices: [],
    start_time: start,
    end_time: null,
    pid: process.pid,
  });
  assert.equal(fs.existsSync(path.join(runDir, '.run.lease')), true);
  await assert.rejects(
    withRunStatus(runDir, async () => undefined),
    /owned by live pid/,
  );
  writeRunStatus(runDir, { state: 'done', error: null, notices: [], start_time: start, end_time: start });
  assert.equal(fs.existsSync(path.join(runDir, '.run.lease')), false);
});

test('CLI resumes acquire the same atomic per-run lease', async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'vgc-cli-resume-live-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  for (const [command, config] of [
    ['tournament', { models: ['random', 'random'], seed: 1, pool: 'test' }],
    ['draft', { models: ['random', 'random'], seed: 1, board: 'regmb-202607' }],
  ] as const) {
    const runDir = path.join(root, command);
    fs.mkdirSync(runDir);
    fs.writeFileSync(path.join(runDir, 'config.json'), JSON.stringify(config));
    await withRunStatus(runDir, async () => {
      await assert.rejects(main([command, '--resume', runDir]), new RegExp(`owned by live pid ${process.pid}`));
    });
  }
});

test('interleaved lease acquisitions have exactly one owner', (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'vgc-lease-interleaved-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const lease = path.join(root, 'records.jsonl.lease');
  const originalWriteFileSync = fs.writeFileSync;
  let contenderRelease: (() => void) | undefined;
  let interleaved = false;
  try {
    fs.writeFileSync = ((...args: unknown[]) => {
      if (!interleaved) {
        interleaved = true;
        contenderRelease = acquireLease(lease);
      }
      return Reflect.apply(originalWriteFileSync, fs, args);
    }) as typeof fs.writeFileSync;
    assert.throws(() => acquireLease(lease), new RegExp(`owned by live pid ${process.pid}`));
  } finally {
    fs.writeFileSync = originalWriteFileSync;
  }

  assert.equal(interleaved, true);
  assert.ok(contenderRelease);
  assert.equal(JSON.parse(fs.readFileSync(lease, 'utf8')).pid, process.pid);
  contenderRelease();
  assert.deepEqual(fs.readdirSync(root), []);
});

test('a dead or malformed lease is replaced atomically', async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'vgc-run-stale-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  for (const [name, owner] of [
    ['dead', JSON.stringify({ id: 'dead-owner', pid: 999_999_999, acquired_at: new Date().toISOString() })],
    ['malformed', '{not json'],
  ]) {
    const runDir = path.join(root, name!);
    fs.mkdirSync(runDir);
    fs.writeFileSync(path.join(runDir, '.run.lease'), owner!);
    await withRunStatus(runDir, async () => {
      assert.equal(readStatus(runDir).state, 'running');
    });
    assert.equal(fs.existsSync(path.join(runDir, '.run.lease')), false);
  }
});
