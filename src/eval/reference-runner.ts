import type { InformationSetDraw } from './information-set.js';
import {
  evaluateReferenceSuite,
  type ReferenceArm,
  type ReferenceSuiteResult,
  type ReferenceUtilitySample,
} from './reference-suite.js';

export const REFERENCE_RUNNER_PROTOCOL = {
  version: 1,
  execution: 'arm-draw-action-rectangular-v1',
  failure: 'reject-complete-table-on-any-cell-failure-v1',
} as const;

export interface ReferenceRunnerAction {
  actionId: string;
  canonicalAction: string;
}

export interface ReferenceRunnerArm {
  reference: ReferenceArm;
  draws: readonly InformationSetDraw[];
}

export interface ReferenceEvaluationCell {
  reference: ReferenceArm;
  draw: InformationSetDraw;
  action: ReferenceRunnerAction;
}

export interface ReferenceRunnerResult {
  protocolVersion: typeof REFERENCE_RUNNER_PROTOCOL.version;
  samples: ReferenceUtilitySample[];
  suite: ReferenceSuiteResult;
}

export async function runReferenceSuite(input: {
  actions: readonly ReferenceRunnerAction[];
  arms: readonly ReferenceRunnerArm[];
  evaluate(cell: ReferenceEvaluationCell): number | null | Promise<number | null>;
  cvarAlpha?: number;
  clusterId?(arm: ReferenceArm, draw: InformationSetDraw): string;
}): Promise<ReferenceRunnerResult> {
  if (input.actions.length < 2) throw new Error('reference runner needs at least two actions');
  if (!input.arms.length) throw new Error('reference runner needs at least one arm');
  const actionIds = new Set<string>();
  for (const action of input.actions) {
    if (!action.actionId || !action.canonicalAction)
      throw new Error('reference runner actions need id and canonical command');
    if (actionIds.has(action.actionId))
      throw new Error(`reference runner repeats action ${JSON.stringify(action.actionId)}`);
    actionIds.add(action.actionId);
  }
  const samples: ReferenceUtilitySample[] = [];
  for (const arm of input.arms) {
    if (!arm.draws.length)
      throw new Error(`reference arm ${JSON.stringify(arm.reference.id)} has no information-set draws`);
    if (new Set(arm.draws.map((draw) => draw.id)).size !== arm.draws.length) {
      throw new Error(`reference arm ${JSON.stringify(arm.reference.id)} repeats an information-set draw`);
    }
    for (const draw of arm.draws) {
      const clusterId = input.clusterId?.(arm.reference, draw) ?? draw.completionId;
      if (!clusterId) throw new Error('reference runner cluster id must be non-empty');
      for (const action of input.actions) {
        const utility = await input.evaluate({ reference: arm.reference, draw, action });
        if (utility === null || !Number.isFinite(utility)) {
          throw new Error(
            `reference table cell failed for arm ${JSON.stringify(arm.reference.id)}, draw ${JSON.stringify(draw.id)}, action ${JSON.stringify(action.actionId)}`,
          );
        }
        samples.push({
          armId: arm.reference.id,
          actionId: action.actionId,
          drawId: draw.id,
          clusterId,
          utility,
        });
      }
    }
  }
  return {
    protocolVersion: REFERENCE_RUNNER_PROTOCOL.version,
    samples,
    suite: evaluateReferenceSuite({
      arms: input.arms.map((arm) => arm.reference),
      samples,
      ...(input.cvarAlpha === undefined ? {} : { cvarAlpha: input.cvarAlpha }),
    }),
  };
}
