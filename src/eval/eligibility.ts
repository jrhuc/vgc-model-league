import type { ExhaustiveActionTable, ExhaustivePanel } from './counterfactual.js';

export const POSITION_ELIGIBILITY_METRICS_VERSION = 1;

export interface PositionEligibilityMetrics {
  version: 1;
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
