import assert from 'node:assert/strict';
import test from 'node:test';

import type { ExhaustiveActionTable } from '../src/eval/counterfactual.js';
import {
  assessPositionEligibility,
  type PositionEligibilityPolicy,
  positionEligibilityMetrics,
  rankCorrelation,
} from '../src/eval/eligibility.js';

const panel = (values: number[], errors = values.map(() => 0.02)) => ({
  draws: Array.from({ length: 8 }, (_, index) => ({ index })),
  span: Math.max(...values) - Math.min(...values),
  actions: values.map((value, index) => ({ value, reward: index / (values.length - 1), standardError: errors[index] })),
});

function table(): ExhaustiveActionTable {
  return {
    legal: 3,
    heldOutSpan: { value: 0.5, standardError: 0.1, lower95: 0.304 },
    rankingStable: true,
    anchorAgreement: true,
    maxNormalizedRewardDrift: 0.08,
    stability: [panel([0, 0.5, 1]), panel([0.1, 0.4, 0.9])],
    measurement: panel([0.2, 0.6, 1], [0.02, 0.03, 0.04]),
  } as unknown as ExhaustiveActionTable;
}

const policy: PositionEligibilityPolicy = {
  schema_version: 1,
  status: 'frozen',
  min_panel_draws: 8,
  min_held_out_span_lower95: 0.2,
  min_stability_rank_correlation: 0.9,
  max_normalized_reward_drift: 0.1,
  max_measurement_normalized_standard_error: 0.1,
  require_best_anchor_agreement: true,
  require_extrema_set_agreement: true,
};

test('eligibility metrics report rank, reward drift, span uncertainty, and measurement uncertainty', () => {
  assert.equal(rankCorrelation([1, 2, 3], [10, 20, 30]), 1);
  assert.equal(rankCorrelation([1, 2, 3], [30, 20, 10]), -1);
  assert.equal(rankCorrelation([1, 1], [2, 2]), null);
  const metrics = positionEligibilityMetrics(table());
  assert.equal(metrics.stabilityRankCorrelation, 1);
  assert.equal(metrics.heldOutSpanSignalToNoise, 5);
  assert.ok(Math.abs((metrics.maxMeasurementNormalizedStandardError ?? 0) - 0.05) < 1e-12);
  assert.deepEqual(assessPositionEligibility(metrics, policy), { eligible: true, reasons: [] });
});

test('a frozen policy emits each failed gate instead of silently choosing thresholds', () => {
  const metrics = positionEligibilityMetrics(table());
  const result = assessPositionEligibility(
    {
      ...metrics,
      drawsPerPanel: [7, 8, 8],
      heldOutSpanLower95: 0,
      stabilityRankCorrelation: null,
      maxNormalizedRewardDrift: null,
      maxMeasurementNormalizedStandardError: null,
      bestAnchorAgreement: false,
      extremaSetAgreement: false,
    },
    policy,
  );
  assert.deepEqual(result.reasons, [
    'insufficient_panel_draws',
    'held_out_span_below_threshold',
    'rank_stability_below_threshold',
    'normalized_reward_drift_above_threshold',
    'measurement_uncertainty_above_threshold',
    'best_anchor_unstable',
    'extrema_sets_unstable',
  ]);
  assert.equal(result.eligible, false);
});
