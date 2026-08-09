import assert from 'node:assert/strict';
import test from 'node:test';

import type { ExhaustiveActionTable } from '../src/eval/counterfactual.js';
import { positionEligibilityMetrics, rankCorrelation } from '../src/eval/eligibility.js';

const panel = (values: number[], errors: Array<number | null> = values.map(() => 0.02)) => ({
  draws: Array.from({ length: 8 }, (_, index) => ({ index })),
  opponentPopulation: 5,
  opponentSlots: 4,
  luckReplications: 2,
  span: Math.max(...values) - Math.min(...values),
  actions: values.map((value, index) => ({ value, reward: index / (values.length - 1), standardError: errors[index] })),
});

function table(): ExhaustiveActionTable {
  return {
    legal: 3,
    heldOutSpan: { value: 0.5, standardError: 0.1, normalApproxLower95: 0.304 },
    rankingStable: true,
    anchorAgreement: true,
    maxNormalizedRewardDrift: 0.08,
    stability: [panel([0, 0.5, 1]), panel([0.1, 0.4, 0.9])],
    measurement: panel([0.2, 0.6, 1], [0.02, 0.03, 0.04]),
  } as unknown as ExhaustiveActionTable;
}

test('candidate diagnostics use qualification panels, not the untouched measurement panel', () => {
  assert.equal(rankCorrelation([1, 2, 3], [10, 20, 30]), 1);
  assert.equal(rankCorrelation([1, 2, 3], [30, 20, 10]), -1);
  assert.equal(rankCorrelation([1, 1], [2, 2]), null);
  const source = table();
  const metrics = positionEligibilityMetrics(source);
  assert.equal(metrics.version, 1);
  assert.equal(metrics.stabilityRankCorrelation, 1);
  assert.equal(metrics.heldOutSpanStandardError, 0.1);
  assert.ok(Math.abs((metrics.maxQualificationNormalizedStandardError ?? 0) - 0.025) < 1e-12);
  source.measurement.span = 0;
  source.measurement.actions.reverse();
  source.measurement.actions.forEach((action) => {
    action.standardError = null;
  });
  assert.deepEqual(positionEligibilityMetrics(source), metrics);
});

test('unidentified candidate uncertainty remains nullable', () => {
  const source = table();
  source.heldOutSpan.standardError = null;
  source.heldOutSpan.normalApproxLower95 = null;
  source.stability[0].actions[1]!.standardError = null;
  const metrics = positionEligibilityMetrics(source);
  assert.equal(metrics.heldOutSpanStandardError, null);
  assert.equal(metrics.heldOutSpanNormalApproxLower95, null);
  assert.equal(metrics.maxQualificationNormalizedStandardError, null);
  const zeroSpan = table();
  zeroSpan.stability[1].span = 0;
  assert.equal(positionEligibilityMetrics(zeroSpan).maxQualificationNormalizedStandardError, null);
});
