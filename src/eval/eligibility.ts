import type { ExhaustiveActionTable } from './counterfactual.js';

export const POSITION_ELIGIBILITY_METRICS_VERSION = 1;

export interface PositionEligibilityMetrics {
  version: 1;
  legalActions: number;
  drawsPerPanel: [number, number, number];
  heldOutSpanValue: number;
  heldOutSpanStandardError: number;
  heldOutSpanLower95: number;
  heldOutSpanSignalToNoise: number | null;
  bestAnchorAgreement: boolean;
  extremaSetAgreement: boolean;
  stabilityRankCorrelation: number | null;
  maxNormalizedRewardDrift: number | null;
  maxMeasurementNormalizedStandardError: number | null;
}

export interface PositionEligibilityPolicy {
  schema_version: 1;
  status: 'frozen';
  min_panel_draws: number;
  min_held_out_span_lower95: number;
  min_stability_rank_correlation: number;
  max_normalized_reward_drift: number;
  max_measurement_normalized_standard_error: number;
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

export function positionEligibilityMetrics(table: ExhaustiveActionTable): PositionEligibilityMetrics {
  const span = table.measurement.span;
  const spanSe = table.heldOutSpan.standardError;
  return {
    version: POSITION_ELIGIBILITY_METRICS_VERSION,
    legalActions: table.legal,
    drawsPerPanel: [table.stability[0].draws.length, table.stability[1].draws.length, table.measurement.draws.length],
    heldOutSpanValue: table.heldOutSpan.value,
    heldOutSpanStandardError: spanSe,
    heldOutSpanLower95: table.heldOutSpan.lower95,
    heldOutSpanSignalToNoise: spanSe > 0 ? table.heldOutSpan.value / spanSe : null,
    bestAnchorAgreement: table.rankingStable,
    extremaSetAgreement: table.anchorAgreement,
    stabilityRankCorrelation: rankCorrelation(
      table.stability[0].actions.map((entry) => entry.value),
      table.stability[1].actions.map((entry) => entry.value),
    ),
    maxNormalizedRewardDrift: table.maxNormalizedRewardDrift,
    maxMeasurementNormalizedStandardError:
      span > 0 ? Math.max(...table.measurement.actions.map((entry) => entry.standardError / span)) : null,
  };
}

export function validatePositionEligibilityPolicy(policy: PositionEligibilityPolicy): void {
  const keys = Object.keys(policy).sort();
  const expected = [
    'max_measurement_normalized_standard_error',
    'max_normalized_reward_drift',
    'min_held_out_span_lower95',
    'min_panel_draws',
    'min_stability_rank_correlation',
    'require_best_anchor_agreement',
    'require_extrema_set_agreement',
    'schema_version',
    'status',
  ].sort();
  if (JSON.stringify(keys) !== JSON.stringify(expected))
    throw new Error('eligibility policy has unexpected or missing keys');
  if (policy.schema_version !== 1 || policy.status !== 'frozen')
    throw new Error('eligibility policy must be frozen schema version 1');
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
  if (
    !Number.isFinite(policy.max_measurement_normalized_standard_error) ||
    policy.max_measurement_normalized_standard_error < 0
  )
    throw new Error('eligibility measurement uncertainty must be non-negative');
  if (!Number.isInteger(policy.min_panel_draws) || policy.min_panel_draws < 1)
    throw new Error('eligibility min_panel_draws must be a positive integer');
  if (!Number.isFinite(policy.min_held_out_span_lower95) || policy.min_held_out_span_lower95 < 0)
    throw new Error('eligibility min_held_out_span_lower95 must be non-negative');
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
  if (Math.min(...metrics.drawsPerPanel) < policy.min_panel_draws) reasons.push('insufficient_panel_draws');
  if (metrics.heldOutSpanLower95 < policy.min_held_out_span_lower95) reasons.push('held_out_span_below_threshold');
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
    metrics.maxMeasurementNormalizedStandardError === null ||
    metrics.maxMeasurementNormalizedStandardError > policy.max_measurement_normalized_standard_error
  )
    reasons.push('measurement_uncertainty_above_threshold');
  if (policy.require_best_anchor_agreement && !metrics.bestAnchorAgreement) reasons.push('best_anchor_unstable');
  if (policy.require_extrema_set_agreement && !metrics.extremaSetAgreement) reasons.push('extrema_sets_unstable');
  return { eligible: reasons.length === 0, reasons };
}
