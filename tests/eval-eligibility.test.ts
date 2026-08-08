import assert from 'node:assert/strict';
import test from 'node:test';

import type { ExhaustiveActionTable } from '../src/eval/counterfactual.js';
import {
  assessPositionEligibility,
  type PositionEligibilityMetrics,
  type PositionEligibilityPolicy,
  positionEligibilityMetrics,
  rankCorrelation,
} from '../src/eval/eligibility.js';

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

const policy: PositionEligibilityPolicy = {
  schema_version: 2,
  status: 'frozen',
  min_luck_replications: 2,
  min_sampled_opponent_slots: 4,
  min_held_out_span_value: 0.4,
  max_held_out_span_standard_error: 0.1,
  min_stability_rank_correlation: 0.9,
  max_normalized_reward_drift: 0.1,
  max_qualification_normalized_standard_error: 0.1,
  require_best_anchor_agreement: true,
  require_extrema_set_agreement: true,
};

test('eligibility uses only replicated qualification panels, not the untouched measurement panel', () => {
  assert.equal(rankCorrelation([1, 2, 3], [10, 20, 30]), 1);
  assert.equal(rankCorrelation([1, 2, 3], [30, 20, 10]), -1);
  assert.equal(rankCorrelation([1, 1], [2, 2]), null);
  const source = table();
  const metrics = positionEligibilityMetrics(source);
  assert.equal(metrics.stabilityRankCorrelation, 1);
  assert.equal(metrics.heldOutSpanStandardError, 0.1);
  assert.ok(Math.abs((metrics.maxQualificationNormalizedStandardError ?? 0) - 0.025) < 1e-12);
  assert.deepEqual(assessPositionEligibility(metrics, policy), { eligible: true, reasons: [] });
  source.measurement.span = 0;
  source.measurement.actions.reverse();
  source.measurement.actions.forEach((action) => {
    action.standardError = null;
  });
  const measurementUnreadyMetrics = positionEligibilityMetrics(source);
  assert.deepEqual(measurementUnreadyMetrics, metrics, 'measurement data cannot change qualification');
  assert.deepEqual(assessPositionEligibility(measurementUnreadyMetrics, policy), { eligible: true, reasons: [] });
});

test('a frozen policy rejects unreplicated or unstable qualification evidence', () => {
  const metrics = positionEligibilityMetrics(table());
  const result = assessPositionEligibility(
    {
      ...metrics,
      qualificationLuckReplications: [1, 2],
      qualificationOpponentSlots: [3, 4],
      heldOutSpanValue: 0,
      heldOutSpanStandardError: null,
      stabilityRankCorrelation: null,
      maxNormalizedRewardDrift: null,
      maxQualificationNormalizedStandardError: null,
      bestAnchorAgreement: false,
      extremaSetAgreement: false,
    },
    policy,
  );
  assert.deepEqual(result.reasons, [
    'insufficient_luck_replications',
    'insufficient_sampled_opponent_slots',
    'held_out_span_below_threshold',
    'held_out_span_uncertainty_above_threshold',
    'rank_stability_below_threshold',
    'normalized_reward_drift_above_threshold',
    'qualification_uncertainty_above_threshold',
    'best_anchor_unstable',
    'extrema_sets_unstable',
  ]);
  assert.equal(result.eligible, false);
});

test('unidentified qualification uncertainty remains nullable and fails closed', () => {
  const source = table();
  source.heldOutSpan.standardError = null;
  source.heldOutSpan.normalApproxLower95 = null;
  source.stability[0].actions[1]!.standardError = null;
  const metrics = positionEligibilityMetrics(source);
  assert.equal(metrics.heldOutSpanStandardError, null);
  assert.equal(metrics.heldOutSpanNormalApproxLower95, null);
  assert.equal(metrics.maxQualificationNormalizedStandardError, null);
  assert.deepEqual(assessPositionEligibility(metrics, policy), {
    eligible: false,
    reasons: ['held_out_span_uncertainty_above_threshold', 'qualification_uncertainty_above_threshold'],
  });

  const zeroSpan = table();
  zeroSpan.stability[1].span = 0;
  assert.equal(positionEligibilityMetrics(zeroSpan).maxQualificationNormalizedStandardError, null);
});

test('eligibility policy thresholds are inclusive and fail immediately outside their boundaries', () => {
  const exactBoundary: PositionEligibilityMetrics = {
    ...positionEligibilityMetrics(table()),
    qualificationLuckReplications: [policy.min_luck_replications, policy.min_luck_replications],
    qualificationOpponentPopulation: [5, 1],
    qualificationOpponentSlots: [policy.min_sampled_opponent_slots, 1],
    heldOutSpanValue: policy.min_held_out_span_value,
    heldOutSpanStandardError: policy.max_held_out_span_standard_error,
    stabilityRankCorrelation: policy.min_stability_rank_correlation,
    maxNormalizedRewardDrift: policy.max_normalized_reward_drift,
    maxQualificationNormalizedStandardError: policy.max_qualification_normalized_standard_error,
  };
  assert.deepEqual(assessPositionEligibility(exactBoundary, policy), { eligible: true, reasons: [] });

  const epsilon = 1e-12;
  const outside: Array<[PositionEligibilityMetrics, string]> = [
    [
      { ...exactBoundary, qualificationLuckReplications: [policy.min_luck_replications - 1, 2] },
      'insufficient_luck_replications',
    ],
    [
      {
        ...exactBoundary,
        qualificationOpponentPopulation: [5, 5],
        qualificationOpponentSlots: [policy.min_sampled_opponent_slots - 1, policy.min_sampled_opponent_slots],
      },
      'insufficient_sampled_opponent_slots',
    ],
    [{ ...exactBoundary, heldOutSpanValue: policy.min_held_out_span_value - epsilon }, 'held_out_span_below_threshold'],
    [
      { ...exactBoundary, heldOutSpanStandardError: policy.max_held_out_span_standard_error + epsilon },
      'held_out_span_uncertainty_above_threshold',
    ],
    [
      { ...exactBoundary, stabilityRankCorrelation: policy.min_stability_rank_correlation - epsilon },
      'rank_stability_below_threshold',
    ],
    [
      { ...exactBoundary, maxNormalizedRewardDrift: policy.max_normalized_reward_drift + epsilon },
      'normalized_reward_drift_above_threshold',
    ],
    [
      {
        ...exactBoundary,
        maxQualificationNormalizedStandardError: policy.max_qualification_normalized_standard_error + epsilon,
      },
      'qualification_uncertainty_above_threshold',
    ],
  ];
  for (const [metrics, reason] of outside) {
    assert.deepEqual(assessPositionEligibility(metrics, policy), { eligible: false, reasons: [reason] });
  }
});

test('the normal-approximation lower bound is diagnostic rather than an eligibility gate', () => {
  const metrics = positionEligibilityMetrics(table());
  assert.deepEqual(assessPositionEligibility({ ...metrics, heldOutSpanNormalApproxLower95: -1_000 }, policy), {
    eligible: true,
    reasons: [],
  });
  assert.deepEqual(
    assessPositionEligibility(
      {
        ...metrics,
        heldOutSpanValue: policy.min_held_out_span_value - 1e-12,
        heldOutSpanNormalApproxLower95: 1_000,
      },
      policy,
    ),
    { eligible: false, reasons: ['held_out_span_below_threshold'] },
  );
});
