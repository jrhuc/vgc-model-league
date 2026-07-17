import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import type { RotationEvent } from '../src/rotation.js';
import { makePlans, ROTATION_PROTOCOL_VERSION, runRotation } from '../src/rotation.js';

test('even series counts reuse team matchups while swapping model sides', () => {
  const plans = makePlans(
    ['model-a', 'model-b'],
    2,
    [
      { id: 'team-a', packed: 'a' },
      { id: 'team-b', packed: 'b' },
      { id: 'team-c', packed: 'c' },
    ],
    () => 0,
  );
  assert.equal(plans.length, 2);
  assert.deepEqual(
    plans.map((plan) => plan.players),
    [
      { p1: 'model-a', p2: 'model-b' },
      { p1: 'model-b', p2: 'model-a' },
    ],
  );
  assert.deepEqual(
    plans.map((plan) => ({ p1: plan.teams.p1.id, p2: plan.teams.p2.id })),
    [
      { p1: 'team-a', p2: 'team-b' },
      { p1: 'team-a', p2: 'team-b' },
    ],
  );
});

test('Rotation emits ordered events and protocol identity', async (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'vgc-model-league-rotation-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const events: RotationEvent[] = [];
  const rows = await runRotation(['random', 'random'], 1, directory, {
    seed: 1,
    concurrency: 1,
    recordsPath: path.join(directory, 'results.jsonl'),
    onEvent: (event) => events.push(event),
  });
  const config = JSON.parse(fs.readFileSync(path.join(directory, 'config.json'), 'utf8')) as Record<string, unknown>;
  assert.equal(config.mode, 'rotation');
  assert.equal(config.protocol_version, ROTATION_PROTOCOL_VERSION);
  const planned = events[0];
  assert.equal(planned?.type, 'plans');
  if (planned?.type === 'plans') {
    assert.equal(planned.mode, 'rotation');
    assert.equal(planned.protocolVersion, ROTATION_PROTOCOL_VERSION);
  }
  assert.equal(events[1]?.type, 'series-start');
  assert.equal(events.at(-1)?.type, 'series-end');
  const gameEnds = events.filter((event) => event.type === 'game-end');
  assert.ok(gameEnds.length >= 2);
  const updates = events.filter((event) => event.type === 'game-update');
  assert.ok(updates.length > 0);
  assert.ok(updates.every((event) => event.lines.length > 0 && event.game >= 1));
  const last = events.at(-1) as Extract<RotationEvent, { type: 'series-end' }>;
  assert.equal(last.record.mode, 'rotation');
  assert.equal(last.record.protocol_version, ROTATION_PROTOCOL_VERSION);
  assert.deepEqual(last.record.score, rows[0]?.score);
  assert.deepEqual(gameEnds.at(-1)?.score, rows[0]?.score);
});

test('an aborted signal stops Rotation without recording', async (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'vgc-model-league-abort-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const recordsPath = path.join(directory, 'results.jsonl');
  const controller = new AbortController();
  controller.abort();
  const rows = await runRotation(['random', 'random', 'random'], 2, directory, {
    seed: 1,
    concurrency: 2,
    recordsPath,
    signal: controller.signal,
  });
  assert.deepEqual(rows, []);
  assert.equal(fs.existsSync(recordsPath), false);
});
