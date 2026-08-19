import { canonicalJsonDigest } from '../serialization.js';

export const CONTROLLER_IDENTITY_PROTOCOL = {
  version: 1,
  identity: 'stage-kind-revision-config-digest-v1',
  parity: 'exact-bytes-except-declared-stages-v1',
} as const;

export const STRATEGIC_CONTROLLER_STAGES = ['draft', 'construction', 'trade', 'preview', 'battle', 'notebook'] as const;

export type StrategicControllerStage = (typeof STRATEGIC_CONTROLLER_STAGES)[number];
export type StrategicControllerKind = 'model' | 'heuristic' | 'search' | 'recorded' | 'population';

export interface StrategicControllerIdentity {
  id: string;
  stage: StrategicControllerStage;
  kind: StrategicControllerKind;
  revision: string;
  configDigest: string;
}

export type StrategicControllerSet = Record<StrategicControllerStage, StrategicControllerIdentity>;

function assertController(controller: StrategicControllerIdentity, stage: StrategicControllerStage): void {
  if (controller.stage !== stage)
    throw new Error(`controller ${JSON.stringify(controller.id)} is bound to ${controller.stage}, not ${stage}`);
  if (!controller.id || !controller.revision) throw new Error(`${stage} controller needs non-empty id and revision`);
  if (!/^[0-9a-f]{64}$/u.test(controller.configDigest)) {
    throw new Error(`${stage} controller configDigest must be a SHA-256 digest`);
  }
}

export function controllerSetDigest(controllers: StrategicControllerSet): string {
  for (const stage of STRATEGIC_CONTROLLER_STAGES) assertController(controllers[stage], stage);
  return canonicalJsonDigest([
    CONTROLLER_IDENTITY_PROTOCOL.identity,
    STRATEGIC_CONTROLLER_STAGES.map((stage) => controllers[stage]),
  ]);
}

export function controllerDifferences(
  left: StrategicControllerSet,
  right: StrategicControllerSet,
): StrategicControllerStage[] {
  controllerSetDigest(left);
  controllerSetDigest(right);
  return STRATEGIC_CONTROLLER_STAGES.filter(
    (stage) => canonicalJsonDigest(left[stage]) !== canonicalJsonDigest(right[stage]),
  );
}

export function assertControllerParity(
  left: StrategicControllerSet,
  right: StrategicControllerSet,
  allowedDifferences: readonly StrategicControllerStage[] = [],
): void {
  const allowed = new Set(allowedDifferences);
  const unexpected = controllerDifferences(left, right).filter((stage) => !allowed.has(stage));
  if (unexpected.length) {
    throw new Error(`matched fork arms change undeclared controllers at: ${unexpected.join(', ')}`);
  }
}
