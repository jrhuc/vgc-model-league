import assert from 'node:assert/strict';
import test from 'node:test';

import {
  controllerSetDigest,
  type StrategicControllerIdentity,
  type StrategicControllerSet,
  type StrategicControllerStage,
} from '../src/eval/controllers.js';
import type { DecisionNode } from '../src/eval/experiment-kernel.js';
import { buildMatchedForkPlan } from '../src/eval/fork-plan.js';
import { canonicalJsonDigest } from '../src/serialization.js';

function controller(stage: StrategicControllerStage, suffix = 'base'): StrategicControllerIdentity {
  return {
    id: `${stage}-${suffix}`,
    stage,
    kind: 'recorded',
    revision: 'v1',
    configDigest: canonicalJsonDigest({ stage, suffix }),
  };
}

function controllers(suffix = 'base'): StrategicControllerSet {
  return {
    draft: controller('draft', suffix),
    construction: controller('construction', suffix),
    trade: controller('trade', suffix),
    preview: controller('preview', suffix),
    battle: controller('battle', suffix),
    notebook: controller('notebook', suffix),
  };
}

const decisionNode: DecisionNode = {
  id: 'node',
  opportunityKey: 'opportunity',
  stage: 'notebook',
  actor: 'seat-1',
  parentNodeId: null,
  sourceEpisodeDigest: 'source',
  publicStateDigest: 'public',
  privateStateDigest: 'private',
  promptDigest: 'prompt',
  legalActionDigest: 'legal',
};

function arm(id: string, set: StrategicControllerSet) {
  return {
    id,
    label: id,
    replacementActionDigest: canonicalJsonDigest({ id, action: 'same' }),
    treatmentDigest: canonicalJsonDigest({ id, treatment: id }),
    controllers: set,
  };
}

const draws = [
  {
    id: 'draw-1',
    hiddenStateSeed: 'hidden',
    opponentPolicySeed: 'opponent',
    battleSeed: [1, 2, 3, 4] as [number, number, number, number],
    continuationSeed: 'continuation',
    scheduleSeed: 'schedule',
  },
];

test('matched fork plans bind treatments, downstream controllers, and common draws', () => {
  const set = controllers();
  const plan = buildMatchedForkPlan({
    id: 'memory-plan',
    decisionNode,
    utilityUnit: 'series-win-probability',
    arms: [arm('withheld', set), arm('authentic', set)],
    draws,
  });
  assert.ok(/^[0-9a-f]{64}$/u.test(plan.planDigest));
  assert.equal(plan.arms[0]!.controllerSetDigest, controllerSetDigest(set));
  assert.deepEqual(plan.allowedControllerDifferences, []);
});

test('matched fork plans reject undeclared downstream controller changes', () => {
  const baseline = controllers();
  const changed = structuredClone(baseline);
  changed.battle = controller('battle', 'alternative');
  assert.throws(
    () =>
      buildMatchedForkPlan({
        id: 'bad-plan',
        decisionNode,
        utilityUnit: 'series-win-probability',
        arms: [arm('control', baseline), arm('treatment', changed)],
        draws,
      }),
    /undeclared controllers/u,
  );
  const allowed = buildMatchedForkPlan({
    id: 'policy-substitution',
    decisionNode,
    utilityUnit: 'series-win-probability',
    arms: [arm('control', baseline), arm('treatment', changed)],
    draws,
    allowedControllerDifferences: ['battle'],
  });
  assert.deepEqual(allowed.allowedControllerDifferences, ['battle']);
});

test('matched fork plans reject repeated common draws', () => {
  const set = controllers();
  assert.throws(
    () =>
      buildMatchedForkPlan({
        id: 'duplicates',
        decisionNode,
        utilityUnit: 'series-win-probability',
        arms: [arm('one', set), arm('two', set)],
        draws: [draws[0]!, draws[0]!],
      }),
    /repeats a common draw/u,
  );
});
