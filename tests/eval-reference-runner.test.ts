import assert from 'node:assert/strict';
import test from 'node:test';

import { buildInformationSetPrior, informationSetDrawPlan } from '../src/eval/information-set.js';
import { runReferenceSuite } from '../src/eval/reference-runner.js';
import type { ReferenceArm } from '../src/eval/reference-suite.js';
import { canonicalJsonDigest } from '../src/eval/serialization.js';

const reference: ReferenceArm = {
  id: 'arm',
  hiddenStatePrior: 'prior',
  opponentPolicy: 'opponent',
  continuationPolicy: 'continuation',
  horizon: 'series-end',
  utilityUnit: 'series-win-probability',
  weight: 1,
};

function draws() {
  const prior = buildInformationSetPrior({
    id: 'prior',
    revision: 'v1',
    publicInformationDigest: canonicalJsonDigest({ public: true }),
    completions: [
      {
        id: 'completion',
        hiddenStateDigest: canonicalJsonDigest({ hidden: true }),
        provenance: 'test',
        weight: 1,
      },
    ],
  });
  return informationSetDrawPlan(prior, 2, 'seed');
}

test('reference runner evaluates a complete common-draw rectangle', async () => {
  const result = await runReferenceSuite({
    actions: [
      { actionId: 'a', canonicalAction: 'move a' },
      { actionId: 'b', canonicalAction: 'move b' },
    ],
    arms: [{ reference, draws: draws() }],
    evaluate: ({ action, draw }) => (action.actionId === 'a' ? 0.6 : 0.4) + draw.index * 0.01,
    clusterId: (_arm, draw) => draw.id,
  });
  assert.equal(result.samples.length, 4);
  assert.deepEqual(result.suite.expectedBestActionIds, ['a']);
  assert.ok(Math.abs(result.suite.actions.find((action) => action.actionId === 'b')!.expectedRegret - 0.2) < 1e-12);
});

test('reference runner rejects the entire table when one cell fails', async () => {
  await assert.rejects(
    () =>
      runReferenceSuite({
        actions: [
          { actionId: 'a', canonicalAction: 'move a' },
          { actionId: 'b', canonicalAction: 'move b' },
        ],
        arms: [{ reference, draws: draws() }],
        evaluate: ({ action, draw }) => (action.actionId === 'b' && draw.index === 1 ? null : 0.5),
      }),
    /table cell failed/u,
  );
});
