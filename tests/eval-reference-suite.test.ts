import assert from 'node:assert/strict';
import test from 'node:test';

import {
  evaluateReferenceSuite,
  scoreReferenceAction,
  type ReferenceArm,
  type ReferenceUtilitySample,
} from '../src/eval/reference-suite.js';

const arms: ReferenceArm[] = [
  {
    id: 'conservative',
    hiddenStatePrior: 'prior-a',
    opponentPolicy: 'policy-a',
    continuationPolicy: 'continuation-a',
    horizon: 'series-end',
    utilityUnit: 'series-win-probability',
    weight: 3,
  },
  {
    id: 'aggressive',
    hiddenStatePrior: 'prior-b',
    opponentPolicy: 'policy-b',
    continuationPolicy: 'continuation-b',
    horizon: 'series-end',
    utilityUnit: 'series-win-probability',
    weight: 1,
  },
];

function samples(): ReferenceUtilitySample[] {
  const values: Record<string, Record<string, number>> = {
    conservative: { a: 0.6, b: 0.4 },
    aggressive: { a: 0.3, b: 0.8 },
  };
  return arms.flatMap((arm) =>
    ['a', 'b'].flatMap((actionId) =>
      ['d1', 'd2'].map((drawId, index) => ({
        armId: arm.id,
        actionId,
        drawId,
        clusterId: `c${index + 1}`,
        utility: values[arm.id]![actionId]!,
      })),
    ),
  );
}

test('reference suite keeps expected and robust utility in absolute units', () => {
  const result = evaluateReferenceSuite({ arms, samples: samples(), cvarAlpha: 0.25 });
  assert.deepEqual(result.expectedBestActionIds, ['a']);
  assert.deepEqual(result.robustBestActionIds, ['b']);
  const a = scoreReferenceAction(result, 'a');
  const b = scoreReferenceAction(result, 'b');
  assert.ok(Math.abs(a.expectedUtility - 0.525) < 1e-12);
  assert.ok(Math.abs(b.expectedUtility - 0.5) < 1e-12);
  assert.ok(Math.abs(b.expectedRegret - 0.025) < 1e-12);
  assert.equal(a.robustUtility, 0.3);
  assert.equal(b.robustUtility, 0.4);
  assert.equal(a.worstArmRegret, 0.5);
  assert.equal(b.referenceDisagreement, 0.4);
});

test('reference suite rejects unequal action draw plans', () => {
  const broken = samples().filter(
    (sample) => !(sample.armId === 'aggressive' && sample.actionId === 'b' && sample.drawId === 'd2'),
  );
  assert.throws(() => evaluateReferenceSuite({ arms, samples: broken }), /common draws/u);
});

test('reference suite refuses to aggregate different utility units', () => {
  const mixed = structuredClone(arms);
  mixed[1]!.utilityUnit = 'series-return';
  assert.throws(() => evaluateReferenceSuite({ arms: mixed, samples: samples() }), /different utility units/u);
});
