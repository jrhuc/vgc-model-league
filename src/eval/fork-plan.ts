import {
  assertControllerParity,
  controllerSetDigest,
  type StrategicControllerSet,
  type StrategicControllerStage,
} from './controllers.js';
import type { DecisionNode } from './experiment-kernel.js';
import type { StrategicUtilityUnit } from './reference-suite.js';
import { canonicalJsonDigest } from './serialization.js';

export const MATCHED_FORK_PLAN_PROTOCOL = {
  version: 1,
  arms: 'replacement-treatment-controller-set-v1',
  draws: 'hidden-opponent-battle-continuation-schedule-v1',
  parity: 'controller-equality-except-declared-stages-v1',
} as const;

export interface CommonForkDraw {
  id: string;
  hiddenStateSeed: string;
  opponentPolicySeed: string;
  battleSeed: [number, number, number, number];
  continuationSeed: string;
  scheduleSeed: string;
}

export interface MatchedForkArm {
  id: string;
  label: string;
  replacementActionDigest: string;
  treatmentDigest: string;
  controllers: StrategicControllerSet;
}

export interface MatchedForkPlan {
  protocolVersion: typeof MATCHED_FORK_PLAN_PROTOCOL.version;
  id: string;
  decisionNode: DecisionNode;
  utilityUnit: StrategicUtilityUnit;
  allowedControllerDifferences: StrategicControllerStage[];
  arms: Array<MatchedForkArm & { controllerSetDigest: string }>;
  draws: CommonForkDraw[];
  planDigest: string;
}

function assertDigest(value: string, label: string): void {
  if (!/^[0-9a-f]{64}$/u.test(value)) throw new Error(`${label} must be a SHA-256 digest`);
}

function assertDraw(draw: CommonForkDraw): void {
  if (!draw.id || !draw.hiddenStateSeed || !draw.opponentPolicySeed || !draw.continuationSeed || !draw.scheduleSeed) {
    throw new Error('common fork draw needs non-empty identity and seed fields');
  }
  if (
    draw.battleSeed.length !== 4 ||
    draw.battleSeed.some((part) => !Number.isInteger(part) || part < 0 || part > 0xffff)
  ) {
    throw new Error('common fork battleSeed must contain four unsigned 16-bit integers');
  }
}

export function buildMatchedForkPlan(input: {
  id: string;
  decisionNode: DecisionNode;
  utilityUnit: StrategicUtilityUnit;
  arms: readonly MatchedForkArm[];
  draws: readonly CommonForkDraw[];
  allowedControllerDifferences?: readonly StrategicControllerStage[];
}): MatchedForkPlan {
  if (!input.id) throw new Error('matched fork plan id must be non-empty');
  if (input.arms.length < 2) throw new Error('matched fork plan needs at least two arms');
  if (!input.draws.length) throw new Error('matched fork plan needs common draws');
  const armIds = new Set<string>();
  const arms = input.arms.map((arm) => {
    if (!arm.id || !arm.label) throw new Error('matched fork arm needs non-empty id and label');
    if (armIds.has(arm.id)) throw new Error(`matched fork plan repeats arm ${JSON.stringify(arm.id)}`);
    armIds.add(arm.id);
    assertDigest(arm.replacementActionDigest, `${arm.id} replacementActionDigest`);
    assertDigest(arm.treatmentDigest, `${arm.id} treatmentDigest`);
    return { ...structuredClone(arm), controllerSetDigest: controllerSetDigest(arm.controllers) };
  });
  const allowedControllerDifferences = [...new Set(input.allowedControllerDifferences ?? [])].sort();
  const baseline = arms[0] as (typeof arms)[number];
  for (const arm of arms.slice(1)) {
    assertControllerParity(baseline.controllers, arm.controllers, allowedControllerDifferences);
  }
  const draws = input.draws.map((draw) => {
    assertDraw(draw);
    return structuredClone(draw);
  });
  if (new Set(draws.map((draw) => draw.id)).size !== draws.length) {
    throw new Error('matched fork plan repeats a common draw id');
  }
  const base = {
    protocolVersion: MATCHED_FORK_PLAN_PROTOCOL.version,
    id: input.id,
    decisionNode: structuredClone(input.decisionNode),
    utilityUnit: input.utilityUnit,
    allowedControllerDifferences,
    arms,
    draws,
  };
  return { ...base, planDigest: canonicalJsonDigest(base) };
}
