import assert from 'node:assert/strict';
import test from 'node:test';

import { evaluateReferenceSuite } from '../src/eval/reference-suite.js';
import {
  binaryBrierScore,
  buildStrategicChoiceTask,
  multiclassBrierScore,
  parseStrategicChoice,
  scoreStrategicChoice,
} from '../src/eval/strategic-task.js';

const actions = [
  { canonicalAction: 'move 1 1, move 2 2', label: 'Double target the left foe' },
  { canonicalAction: 'switch 3, move 1 1', label: 'Switch the left slot and attack' },
  { canonicalAction: 'move 2 2, switch 4', label: 'Attack and preserve the right slot' },
  { canonicalAction: 'move 1 2, move 1 1', label: 'Split pressure across both foes' },
];

function build(seed: string, mode: 'action-only' | 'binary-forecast' | 'opponent-mode-forecast' = 'action-only') {
  return buildStrategicChoiceTask({
    id: 'task-1',
    format: 'format',
    phase: 'turn',
    state: 'Authoritative state',
    actions,
    presentationSeed: seed,
    actionIdentitySalt: 'private-salt',
    forecastMode: mode,
  });
}

test('strategic task randomizes presentation without changing opaque action identity', () => {
  const first = build('one');
  const second = build('two');
  assert.deepEqual(
    first.private.actions.map((action) => action.actionId).sort(),
    second.private.actions.map((action) => action.actionId).sort(),
  );
  assert.ok(first.public.presentationDigest !== second.public.presentationDigest);
  assert.ok(first.public.prompt.includes('Action identifiers are opaque'));
});

test('strategic parser keeps invalid output separate from legal action utility', () => {
  const task = build('one', 'binary-forecast').public;
  const actionId = task.actions[0]!.actionId;
  const valid = parseStrategicChoice(
    JSON.stringify({ action_id: actionId, p_game_win: 0.55, p_series_win: 0.62, confidence: 0.7 }),
    task,
  );
  assert.equal(valid.status, 'valid');
  const invalid = parseStrategicChoice(
    JSON.stringify({ action_id: actionId, p_game_win: 0.55, p_series_win: 0.62, confidence: 0.7, rationale: 'extra' }),
    task,
  );
  assert.equal(invalid.status, 'invalid');
});

test('strategic choice joins opaque action ids to an absolute reference score', () => {
  const task = build('one').public;
  const selected = task.actions[0]!.actionId;
  const other = task.actions[1]!.actionId;
  const reference = evaluateReferenceSuite({
    arms: [
      {
        id: 'arm',
        hiddenStatePrior: 'prior',
        opponentPolicy: 'opponent',
        continuationPolicy: 'continuation',
        horizon: 'series-end',
        utilityUnit: 'series-win-probability',
        weight: 1,
      },
    ],
    samples: [
      { armId: 'arm', actionId: selected, drawId: 'd1', clusterId: 'c1', utility: 0.7 },
      { armId: 'arm', actionId: selected, drawId: 'd2', clusterId: 'c2', utility: 0.7 },
      { armId: 'arm', actionId: other, drawId: 'd1', clusterId: 'c1', utility: 0.5 },
      { armId: 'arm', actionId: other, drawId: 'd2', clusterId: 'c2', utility: 0.5 },
    ],
  });
  const parsed = parseStrategicChoice(JSON.stringify({ action_id: selected }), task);
  const score = scoreStrategicChoice(parsed, reference);
  assert.equal(score.status, 'valid');
  if (score.status === 'valid') assert.ok(Math.abs(score.reference.expectedRegret) < 1e-12);
  const invalid = scoreStrategicChoice({ status: 'invalid', reason: 'bad JSON' }, reference);
  assert.deepEqual(invalid, { status: 'invalid', reason: 'bad JSON' });
});

test('forecast diagnostics use proper scoring rules', () => {
  assert.equal(binaryBrierScore(0.8, 1), 0.03999999999999998);
  const score = multiclassBrierScore(
    [
      { id: 'mode-a', p: 0.7 },
      { id: 'mode-b', p: 0.3 },
    ],
    'mode-a',
  );
  assert.ok(Math.abs(score - 0.18) < 1e-12);
});
