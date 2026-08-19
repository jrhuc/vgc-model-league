import { canonicalJsonDigest } from '../serialization.js';

export const REFERENCE_SUITE_PROTOCOL = {
  version: 1,
  drawJoin: 'exact-action-arm-draw-cluster-rectangle-v1',
  expectedUtility: 'declared-arm-weighted-mean-v1',
  robustUtility: 'weighted-lower-tail-arm-mean-v1',
  regret: 'absolute-utility-units-v1',
} as const;

export type StrategicUtilityUnit =
  | 'game-win-probability'
  | 'material-differential'
  | 'series-win-probability'
  | 'series-return';

export interface ReferenceArm {
  id: string;
  hiddenStatePrior: string;
  opponentPolicy: string;
  continuationPolicy: string;
  horizon: string;
  utilityUnit: StrategicUtilityUnit;
  weight: number;
}

export interface ReferenceUtilitySample {
  armId: string;
  actionId: string;
  drawId: string;
  clusterId: string;
  utility: number;
}

export interface ArmActionEstimate {
  armId: string;
  utility: number;
  standardError: number | null;
  opportunityLoss: number;
  best: boolean;
}

export interface ReferenceActionScore {
  actionId: string;
  expectedUtility: number;
  expectedRegret: number;
  robustUtility: number;
  robustRegret: number;
  worstArmUtility: number;
  worstArmRegret: number;
  referenceBestWeight: number;
  referenceDisagreement: number;
  arms: ArmActionEstimate[];
}

export interface ReferenceSuiteResult {
  protocolVersion: typeof REFERENCE_SUITE_PROTOCOL.version;
  utilityUnit: StrategicUtilityUnit;
  cvarAlpha: number;
  commonDrawDigest: string;
  arms: Array<ReferenceArm & { normalizedWeight: number }>;
  actions: ReferenceActionScore[];
  expectedBestActionIds: string[];
  robustBestActionIds: string[];
}

interface Estimate {
  value: number;
  standardError: number | null;
}

function mean(values: readonly number[]): number {
  return values.reduce((sum, value) => sum + value, 0) / values.length;
}

function estimate(samples: readonly ReferenceUtilitySample[]): Estimate {
  const clusters = new Map<string, number[]>();
  for (const sample of samples)
    clusters.set(sample.clusterId, [...(clusters.get(sample.clusterId) ?? []), sample.utility]);
  const clusterMeans = [...clusters.values()].map(mean);
  const value = mean(clusterMeans);
  if (clusterMeans.length < 2) return { value, standardError: null };
  const variance = clusterMeans.reduce((sum, entry) => sum + (entry - value) ** 2, 0) / (clusterMeans.length - 1);
  return { value, standardError: Math.sqrt(variance / clusterMeans.length) };
}

function weightedTailMean(values: readonly { value: number; weight: number }[], alpha: number): number {
  const ordered = [...values].sort((left, right) => left.value - right.value);
  let remaining = alpha;
  let total = 0;
  for (const entry of ordered) {
    if (remaining <= 0) break;
    const taken = Math.min(entry.weight, remaining);
    total += entry.value * taken;
    remaining -= taken;
  }
  if (remaining > 1e-12) throw new Error('reference weights do not cover the requested lower tail');
  return total / alpha;
}

function assertArm(arm: ReferenceArm): void {
  for (const [name, value] of Object.entries(arm)) {
    if (name === 'weight') continue;
    if (typeof value !== 'string' || !value) throw new Error(`reference arm ${name} must be a non-empty string`);
  }
  if (!Number.isFinite(arm.weight) || arm.weight <= 0)
    throw new Error('reference arm weight must be positive and finite');
}

function sampleKey(sample: ReferenceUtilitySample): string {
  return canonicalJsonDigest([sample.drawId, sample.clusterId]);
}

function exactDrawRectangle(
  arms: readonly ReferenceArm[],
  actions: readonly string[],
  samples: readonly ReferenceUtilitySample[],
): string {
  const shape: Array<{ armId: string; draws: string[] }> = [];
  for (const arm of arms) {
    let expected: string[] | null = null;
    for (const actionId of actions) {
      const entries = samples.filter((sample) => sample.armId === arm.id && sample.actionId === actionId);
      if (!entries.length)
        throw new Error(
          `reference arm ${JSON.stringify(arm.id)} has no samples for action ${JSON.stringify(actionId)}`,
        );
      const keys = entries.map(sampleKey).sort();
      if (new Set(keys).size !== keys.length) {
        throw new Error(
          `reference arm ${JSON.stringify(arm.id)} repeats a draw for action ${JSON.stringify(actionId)}`,
        );
      }
      if (expected === null) expected = keys;
      else if (expected.length !== keys.length || expected.some((key, index) => key !== keys[index])) {
        throw new Error(`reference arm ${JSON.stringify(arm.id)} does not use common draws for every action`);
      }
    }
    shape.push({ armId: arm.id, draws: expected as string[] });
  }
  return canonicalJsonDigest(shape);
}

function bestIds(values: readonly { actionId: string; value: number }[]): string[] {
  const best = Math.max(...values.map((entry) => entry.value));
  return values.filter((entry) => Math.abs(entry.value - best) <= 1e-12).map((entry) => entry.actionId);
}

export function evaluateReferenceSuite(input: {
  arms: readonly ReferenceArm[];
  samples: readonly ReferenceUtilitySample[];
  cvarAlpha?: number;
}): ReferenceSuiteResult {
  if (!input.arms.length) throw new Error('reference suite needs at least one arm');
  const ids = new Set<string>();
  for (const arm of input.arms) {
    assertArm(arm);
    if (ids.has(arm.id)) throw new Error(`reference suite repeats arm ${JSON.stringify(arm.id)}`);
    ids.add(arm.id);
  }
  const utilityUnit = input.arms[0]!.utilityUnit;
  if (input.arms.some((arm) => arm.utilityUnit !== utilityUnit)) {
    throw new Error('reference arms with different utility units cannot be aggregated');
  }
  const cvarAlpha = input.cvarAlpha ?? 0.25;
  if (!Number.isFinite(cvarAlpha) || cvarAlpha <= 0 || cvarAlpha > 1) {
    throw new Error('cvarAlpha must be in (0, 1]');
  }
  for (const sample of input.samples) {
    if (!ids.has(sample.armId)) throw new Error(`sample names unknown reference arm ${JSON.stringify(sample.armId)}`);
    if (!sample.actionId || !sample.drawId || !sample.clusterId) {
      throw new Error('reference samples need non-empty action, draw, and cluster ids');
    }
    if (!Number.isFinite(sample.utility)) throw new Error('reference sample utility must be finite');
  }
  const actions = [...new Set(input.samples.map((sample) => sample.actionId))].sort();
  if (actions.length < 2) throw new Error('reference suite needs at least two candidate actions');
  const commonDrawDigest = exactDrawRectangle(input.arms, actions, input.samples);
  const weightTotal = input.arms.reduce((sum, arm) => sum + arm.weight, 0);
  const arms = input.arms.map((arm) => ({ ...arm, normalizedWeight: arm.weight / weightTotal }));
  const estimates = new Map<string, Map<string, Estimate>>();
  const bestForArm = new Map<string, number>();
  for (const arm of arms) {
    const byAction = new Map<string, Estimate>();
    for (const actionId of actions) {
      const samples = input.samples.filter((sample) => sample.armId === arm.id && sample.actionId === actionId);
      byAction.set(actionId, estimate(samples));
    }
    estimates.set(arm.id, byAction);
    bestForArm.set(arm.id, Math.max(...[...byAction.values()].map((entry) => entry.value)));
  }
  const preliminary = actions.map((actionId) => {
    const armValues = arms.map((arm) => ({
      arm,
      estimate: estimates.get(arm.id)!.get(actionId)!,
      best: bestForArm.get(arm.id)!,
    }));
    const expectedUtility = armValues.reduce(
      (sum, entry) => sum + entry.estimate.value * entry.arm.normalizedWeight,
      0,
    );
    const robustUtility = weightedTailMean(
      armValues.map((entry) => ({ value: entry.estimate.value, weight: entry.arm.normalizedWeight })),
      cvarAlpha,
    );
    return { actionId, armValues, expectedUtility, robustUtility };
  });
  const expectedBest = Math.max(...preliminary.map((entry) => entry.expectedUtility));
  const robustBest = Math.max(...preliminary.map((entry) => entry.robustUtility));
  const scored: ReferenceActionScore[] = preliminary.map((entry) => {
    const armScores: ArmActionEstimate[] = entry.armValues.map(({ arm, estimate: armEstimate, best }) => ({
      armId: arm.id,
      utility: armEstimate.value,
      standardError: armEstimate.standardError,
      opportunityLoss: best - armEstimate.value,
      best: Math.abs(best - armEstimate.value) <= 1e-12,
    }));
    const values = armScores.map((arm) => arm.utility);
    return {
      actionId: entry.actionId,
      expectedUtility: entry.expectedUtility,
      expectedRegret: expectedBest - entry.expectedUtility,
      robustUtility: entry.robustUtility,
      robustRegret: robustBest - entry.robustUtility,
      worstArmUtility: Math.min(...values),
      worstArmRegret: Math.max(...armScores.map((arm) => arm.opportunityLoss)),
      referenceBestWeight: entry.armValues.reduce(
        (sum, item) => sum + (Math.abs(item.best - item.estimate.value) <= 1e-12 ? item.arm.normalizedWeight : 0),
        0,
      ),
      referenceDisagreement: Math.max(...values) - Math.min(...values),
      arms: armScores,
    };
  });
  return {
    protocolVersion: REFERENCE_SUITE_PROTOCOL.version,
    utilityUnit,
    cvarAlpha,
    commonDrawDigest,
    arms,
    actions: scored,
    expectedBestActionIds: bestIds(scored.map((entry) => ({ actionId: entry.actionId, value: entry.expectedUtility }))),
    robustBestActionIds: bestIds(scored.map((entry) => ({ actionId: entry.actionId, value: entry.robustUtility }))),
  };
}

export function scoreReferenceAction(result: ReferenceSuiteResult, actionId: string): ReferenceActionScore {
  const score = result.actions.find((entry) => entry.actionId === actionId);
  if (!score) throw new Error(`reference suite does not contain action ${JSON.stringify(actionId)}`);
  return structuredClone(score);
}
