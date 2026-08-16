import assert from 'node:assert/strict';
import test from 'node:test';

import {
  type ExhaustiveActionTable,
  type ExhaustivePanel,
  exhaustivePanelMatrixDigest,
} from '../src/eval/counterfactual.js';
import { legacyPositionReference } from '../src/eval/legacy-position-reference.js';

function panel(id: ExhaustivePanel['id']): ExhaustivePanel {
  const draws = [
    {
      index: 0,
      opponentAction: 'opponent-a',
      battleSeed: [1, 2, 3, 4] as [number, number, number, number],
      continuationSeed: `${id}:continuation:0`,
    },
    {
      index: 1,
      opponentAction: 'opponent-a',
      battleSeed: [5, 6, 7, 8] as [number, number, number, number],
      continuationSeed: `${id}:continuation:1`,
    },
    {
      index: 2,
      opponentAction: 'opponent-b',
      battleSeed: [9, 10, 11, 12] as [number, number, number, number],
      continuationSeed: `${id}:continuation:2`,
    },
    {
      index: 3,
      opponentAction: 'opponent-b',
      battleSeed: [13, 14, 15, 16] as [number, number, number, number],
      continuationSeed: `${id}:continuation:3`,
    },
  ];
  const actions = [
    {
      action: 'move 1 1, move 2 2',
      value: 0.75,
      standardError: 0.25,
      samples: 4,
      reward: 0,
    },
    {
      action: 'switch 3, move 1 1',
      value: 0.5,
      standardError: 0.5,
      samples: 4,
      reward: 1,
    },
  ];
  const matrix = [
    [1, 0],
    [1, 0],
    [0.5, 1],
    [0.5, 1],
  ];
  const seedNamespace = `legacy-test:${id}`;
  return {
    id,
    seedNamespace,
    opponentPopulation: 2,
    opponentSlots: 2,
    luckReplications: 2,
    draws,
    actions,
    matrix,
    matrixDigest: exhaustivePanelMatrixDigest({
      id,
      seedNamespace,
      opponentPopulation: 2,
      opponentSlots: 2,
      luckReplications: 2,
      draws,
      actions: actions.map((entry) => entry.action),
      matrix,
    }),
    span: 0.25,
  };
}

function table(): ExhaustiveActionTable {
  const stabilityA = panel('stability-a');
  const stabilityB = panel('stability-b');
  const measurement = panel('measurement');
  return {
    pid: 'p1',
    turn: 4,
    legal: 2,
    horizon: 2,
    stateValue: 0,
    selectionBest: stabilityA.actions[0]!.action,
    measurementBest: measurement.actions[0]!.action,
    rankingStable: true,
    valueSpan: measurement.span,
    heldOutGap: {
      selectedAction: stabilityA.actions[0]!.action,
      alternativeAction: stabilityA.actions[1]!.action,
      value: 0.25,
      standardError: 0.1,
      normalApproxLower95: 0.054,
    },
    heldOutSpan: {
      selectedAction: stabilityA.actions[0]!.action,
      alternativeAction: stabilityA.actions[1]!.action,
      value: 0.25,
      standardError: 0.1,
      normalApproxLower95: 0.054,
    },
    stability: [stabilityA, stabilityB],
    measurement,
    anchorAgreement: true,
    maxNormalizedRewardDrift: 0,
  };
}

test('legacy position panels enter the suite in raw material units, not normalized rewards', () => {
  const result = legacyPositionReference({
    table: table(),
    actions: [
      { canonicalAction: 'move 1 1, move 2 2', actionId: 'a_attack' },
      { canonicalAction: 'switch 3, move 1 1', actionId: 'a_switch' },
    ],
  });
  assert.equal(result.suite.utilityUnit, 'material-differential');
  assert.deepEqual(result.suite.expectedBestActionIds, ['a_attack']);
  const attack = result.suite.actions.find((entry) => entry.actionId === 'a_attack')!;
  const switched = result.suite.actions.find((entry) => entry.actionId === 'a_switch')!;
  assert.equal(attack.expectedUtility, 0.75);
  assert.equal(switched.expectedUtility, 0.5);
  assert.equal(switched.expectedRegret, 0.25);
  assert.equal(attack.expectedRegret, 0);
});

test('legacy position bridge defaults to canonical actions as internal identities', () => {
  const result = legacyPositionReference({ table: table(), panelId: 'stability-a' });
  assert.deepEqual(
    result.actions.map((entry) => entry.actionId),
    table().stability[0].actions.map((entry) => entry.action),
  );
  assert.equal(result.panelId, 'stability-a');
});

test('legacy position bridge rejects tampered matrices and incomplete identity maps', () => {
  const tampered = table();
  tampered.measurement.matrix[0]![0] = 0;
  assert.throws(() => legacyPositionReference({ table: tampered }), /matrix digest does not match/u);
  assert.throws(
    () =>
      legacyPositionReference({
        table: table(),
        actions: [{ canonicalAction: 'move 1 1, move 2 2', actionId: 'only-one' }],
      }),
    /does not cover every panel action/u,
  );
});
