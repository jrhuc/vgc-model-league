import type { ExhaustiveActionTable, ExhaustivePanel } from './counterfactual.js';

export const POSITION_ELIGIBILITY_METRICS_VERSION = 2;

export interface PositionEligibilityMetrics {
  version: 2;
  legalActions: number;
  qualificationDrawsPerPanel: [number, number];
  qualificationOpponentPopulation: [number, number];
  qualificationOpponentSlots: [number, number];
  qualificationLuckReplications: [number, number];
  heldOutSpanValue: number;
  heldOutSpanStandardError: number | null;
  heldOutSpanNormalApproxLower95: number | null;
  bestAnchorAgreement: boolean;
  extremaSetAgreement: boolean;
  stabilityRankCorrelation: number | null;
  maxNormalizedRewardDrift: number | null;
  maxQualificationNormalizedStandardError: number | null;
}

export interface PositionEligibilityPolicy {
  schema_version: 2;
  status: 'frozen';
  min_luck_replications: number;
  min_sampled_opponent_slots: number;
  min_held_out_span_value: number;
  max_held_out_span_standard_error: number;
  min_stability_rank_correlation: number;
  max_normalized_reward_drift: number;
  max_qualification_normalized_standard_error: number;
  require_best_anchor_agreement: boolean;
  require_extrema_set_agreement: boolean;
}

function averageRanks(values: readonly number[]): number[] {
  const ordered = values
    .map((value, index) => ({ value, index }))
    .sort((a, b) => a.value - b.value || a.index - b.index);
  const ranks = new Array<number>(values.length);
  for (let start = 0; start < ordered.length; ) {
    let end = start + 1;
    while (end < ordered.length && ordered[end]!.value === ordered[start]!.value) end += 1;
    const rank = (start + end - 1) / 2;
    for (let index = start; index < end; index += 1) ranks[ordered[index]!.index] = rank;
    start = end;
  }
  return ranks;
}

export function rankCorrelation(first: readonly number[], second: readonly number[]): number | null {
  if (
    first.length !== second.length ||
    first.length < 2 ||
    first.some((value) => !Number.isFinite(value)) ||
    second.some((value) => !Number.isFinite(value))
  )
    return null;
  const a = averageRanks(first);
  const b = averageRanks(second);
  const meanA = a.reduce((sum, value) => sum + value, 0) / a.length;
  const meanB = b.reduce((sum, value) => sum + value, 0) / b.length;
  let covariance = 0;
  let varianceA = 0;
  let varianceB = 0;
  for (let index = 0; index < a.length; index += 1) {
    const da = a[index]! - meanA;
    const db = b[index]! - meanB;
    covariance += da * db;
    varianceA += da * da;
    varianceB += db * db;
  }
  return varianceA > 0 && varianceB > 0 ? covariance / Math.sqrt(varianceA * varianceB) : null;
}

function normalizedQualificationUncertainty(panels: readonly ExhaustivePanel[]): number | null {
  const values: number[] = [];
  for (const panel of panels) {
    if (!(panel.span > 0)) return null;
    for (const action of panel.actions) {
      if (action.standardError === null) return null;
      values.push(action.standardError / panel.span);
    }
  }
  return values.length ? Math.max(...values) : null;
}

export function positionEligibilityMetrics(table: ExhaustiveActionTable): PositionEligibilityMetrics {
  const qualification = table.stability;
  return {
    version: POSITION_ELIGIBILITY_METRICS_VERSION,
    legalActions: table.legal,
    qualificationDrawsPerPanel: [qualification[0].draws.length, qualification[1].draws.length],
    qualificationOpponentPopulation: [qualification[0].opponentPopulation, qualification[1].opponentPopulation],
    qualificationOpponentSlots: [qualification[0].opponentSlots, qualification[1].opponentSlots],
    qualificationLuckReplications: [qualification[0].luckReplications, qualification[1].luckReplications],
    heldOutSpanValue: table.heldOutSpan.value,
    heldOutSpanStandardError: table.heldOutSpan.standardError,
    heldOutSpanNormalApproxLower95: table.heldOutSpan.normalApproxLower95,
    bestAnchorAgreement: table.rankingStable,
    extremaSetAgreement: table.anchorAgreement,
    stabilityRankCorrelation: rankCorrelation(
      qualification[0].actions.map((entry) => entry.value),
      qualification[1].actions.map((entry) => entry.value),
    ),
    maxNormalizedRewardDrift: table.maxNormalizedRewardDrift,
    maxQualificationNormalizedStandardError: normalizedQualificationUncertainty(qualification),
  };
}

export function validatePositionEligibilityPolicy(policy: PositionEligibilityPolicy): void {
  const keys = Object.keys(policy).sort();
  const expected = [
    'max_held_out_span_standard_error',
    'max_normalized_reward_drift',
    'max_qualification_normalized_standard_error',
    'min_held_out_span_value',
    'min_luck_replications',
    'min_sampled_opponent_slots',
    'min_stability_rank_correlation',
    'require_best_anchor_agreement',
    'require_extrema_set_agreement',
    'schema_version',
    'status',
  ].sort();
  if (JSON.stringify(keys) !== JSON.stringify(expected))
    throw new Error('eligibility policy has unexpected or missing keys');
  if (policy.schema_version !== 2 || policy.status !== 'frozen')
    throw new Error('eligibility policy must be frozen schema version 2');
  if (!Number.isInteger(policy.min_luck_replications) || policy.min_luck_replications < 2)
    throw new Error('eligibility min_luck_replications must be an integer >= 2');
  if (!Number.isInteger(policy.min_sampled_opponent_slots) || policy.min_sampled_opponent_slots < 2)
    throw new Error('eligibility min_sampled_opponent_slots must be an integer >= 2');
  if (
    !Number.isFinite(policy.min_stability_rank_correlation) ||
    policy.min_stability_rank_correlation < -1 ||
    policy.min_stability_rank_correlation > 1
  )
    throw new Error('eligibility rank correlation must be in [-1, 1]');
  if (
    !Number.isFinite(policy.max_normalized_reward_drift) ||
    policy.max_normalized_reward_drift < 0 ||
    policy.max_normalized_reward_drift > 1
  )
    throw new Error('eligibility normalized reward drift must be in [0, 1]');
  for (const [name, value] of [
    ['min_held_out_span_value', policy.min_held_out_span_value],
    ['max_held_out_span_standard_error', policy.max_held_out_span_standard_error],
    ['max_qualification_normalized_standard_error', policy.max_qualification_normalized_standard_error],
  ] as const) {
    if (!Number.isFinite(value) || value < 0) throw new Error(`eligibility ${name} must be non-negative`);
  }
  if (
    typeof policy.require_best_anchor_agreement !== 'boolean' ||
    typeof policy.require_extrema_set_agreement !== 'boolean'
  )
    throw new Error('eligibility anchor requirements must be booleans');
}

export function assessPositionEligibility(
  metrics: PositionEligibilityMetrics,
  policy: PositionEligibilityPolicy,
): { eligible: boolean; reasons: string[] } {
  validatePositionEligibilityPolicy(policy);
  const reasons: string[] = [];
  if (Math.min(...metrics.qualificationLuckReplications) < policy.min_luck_replications)
    reasons.push('insufficient_luck_replications');
  if (
    metrics.qualificationOpponentSlots.some(
      (slots, index) =>
        (metrics.qualificationOpponentPopulation[index] as number) > 1 && slots < policy.min_sampled_opponent_slots,
    )
  )
    reasons.push('insufficient_sampled_opponent_slots');
  if (metrics.heldOutSpanValue < policy.min_held_out_span_value) reasons.push('held_out_span_below_threshold');
  if (
    metrics.heldOutSpanStandardError === null ||
    metrics.heldOutSpanStandardError > policy.max_held_out_span_standard_error
  )
    reasons.push('held_out_span_uncertainty_above_threshold');
  if (
    metrics.stabilityRankCorrelation === null ||
    metrics.stabilityRankCorrelation < policy.min_stability_rank_correlation
  )
    reasons.push('rank_stability_below_threshold');
  if (
    metrics.maxNormalizedRewardDrift === null ||
    metrics.maxNormalizedRewardDrift > policy.max_normalized_reward_drift
  )
    reasons.push('normalized_reward_drift_above_threshold');
  if (
    metrics.maxQualificationNormalizedStandardError === null ||
    metrics.maxQualificationNormalizedStandardError > policy.max_qualification_normalized_standard_error
  )
    reasons.push('qualification_uncertainty_above_threshold');
  if (policy.require_best_anchor_agreement && !metrics.bestAnchorAgreement) reasons.push('best_anchor_unstable');
  if (policy.require_extrema_set_agreement && !metrics.extremaSetAgreement) reasons.push('extrema_sets_unstable');
  return { eligible: reasons.length === 0, reasons };
}
