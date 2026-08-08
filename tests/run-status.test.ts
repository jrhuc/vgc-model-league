import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { main } from '../src/cli.js';
import { assertRunCanResume, liveRunPid, withRunStatus } from '../src/run-status.js';

function readStatus(runDir: string): Record<string, unknown> {
  return JSON.parse(fs.readFileSync(path.join(runDir, 'status.json'), 'utf8')) as Record<string, unknown>;
}

function writeRunningStatus(runDir: string, pid: number): void {
  fs.writeFileSync(
    path.join(runDir, 'status.json'),
    JSON.stringify({
      state: 'running',
      error: null,
      notices: [],
      start_time: '2026-03-16T12:00:00.000Z',
      end_time: null,
      pid,
    }),
  );
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

test('a running status with the current pid rejects a second resume owner', () => {
  const runDir = fs.mkdtempSync(path.join(os.tmpdir(), 'vgc-resume-live-'));
  try {
    writeRunningStatus(runDir, process.pid);
    assert.equal(liveRunPid(runDir), process.pid);
    assert.throws(
      () => assertRunCanResume(runDir),
      new RegExp(`pid ${process.pid} is still live; only one resume owner is allowed`),
    );
  } finally {
    fs.rmSync(runDir, { recursive: true, force: true });
  }
});

test('CLI draft and tournament resumes reject their own live status before overwriting it', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'vgc-cli-resume-live-'));
  try {
    for (const [command, config] of [
      ['tournament', { models: ['random', 'random'], seed: 1, pool: 'test' }],
      ['draft', { models: ['random', 'random'], seed: 1, board: 'regmb-202607' }],
    ] as const) {
      const runDir = path.join(root, command);
      fs.mkdirSync(runDir);
      fs.writeFileSync(path.join(runDir, 'config.json'), JSON.stringify(config));
      writeRunningStatus(runDir, process.pid);
      const runningStatus = readStatus(runDir);

      await assert.rejects(
        main([command, '--resume', runDir]),
        new RegExp(`pid ${process.pid} is still live; only one resume owner is allowed`),
      );
      assert.deepEqual(readStatus(runDir), runningStatus, 'the live marker survives the rejected resume');
    }
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('dead, missing, and malformed statuses leave recovery available', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'vgc-resume-stale-'));
  const dead = path.join(root, 'dead');
  const missing = path.join(root, 'missing');
  const malformed = path.join(root, 'malformed');
  const invalidShape = path.join(root, 'invalid-shape');
  fs.mkdirSync(dead);
  fs.mkdirSync(missing);
  fs.mkdirSync(malformed);
  fs.mkdirSync(invalidShape);
  try {
    writeRunningStatus(dead, 999_999_999);
    fs.writeFileSync(path.join(malformed, 'status.json'), '{not json');
    fs.writeFileSync(path.join(invalidShape, 'status.json'), JSON.stringify({ state: 'running', pid: process.pid }));

    for (const runDir of [dead, missing, malformed, invalidShape]) {
      assert.equal(liveRunPid(runDir), null);
      assert.doesNotThrow(() => assertRunCanResume(runDir));
    }
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('a live status for another run cannot block this resume', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'vgc-resume-bound-'));
  const target = path.join(root, 'target');
  const other = path.join(root, 'other');
  fs.mkdirSync(target);
  fs.mkdirSync(other);
  try {
    writeRunningStatus(other, process.pid);
    assert.equal(liveRunPid(other), process.pid);
    assert.equal(liveRunPid(target), null);
    assert.doesNotThrow(() => assertRunCanResume(target));
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
