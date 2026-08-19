import { canonicalJsonDigest } from '../serialization.js';
import {
  type ExhaustiveActionTable,
  type ExhaustivePanel,
  exhaustivePanelMatrixDigest,
  REFERENCE,
} from './counterfactual.js';
import {
  evaluateReferenceSuite,
  type ReferenceArm,
  type ReferenceSuiteResult,
  type ReferenceUtilitySample,
} from './reference-suite.js';

export const LEGACY_POSITION_REFERENCE_PROTOCOL = {
  version: 1,
  source: 'counterfactual-v5-exhaustive-panel',
  reference: 'realized-state-uniform-random-material-diagnostic',
  utility: 'raw-material-differential',
  normalization: 'ignored-not-a-primary-score',
} as const;

export type LegacyPositionPanelId = ExhaustivePanel['id'];

export interface LegacyPositionActionIdentity {
  actionId: string;
  canonicalAction: string;
}

export interface LegacyPositionReferenceResult {
  protocolVersion: typeof LEGACY_POSITION_REFERENCE_PROTOCOL.version;
  panelId: LegacyPositionPanelId;
  matrixDigest: string;
  actionMapDigest: string;
  actions: LegacyPositionActionIdentity[];
  suite: ReferenceSuiteResult;
}

function selectedPanel(table: ExhaustiveActionTable, panelId: LegacyPositionPanelId): ExhaustivePanel {
  if (panelId === 'measurement') return table.measurement;
  const panel = table.stability.find((entry) => entry.id === panelId);
  if (!panel) throw new Error(`legacy action table has no ${panelId} panel`);
  return panel;
}

function assertPanel(panel: ExhaustivePanel): void {
  if (panel.actions.length < 2) throw new Error('legacy material panel needs at least two actions');
  if (
    !Number.isSafeInteger(panel.opponentSlots) ||
    panel.opponentSlots < 1 ||
    !Number.isSafeInteger(panel.luckReplications) ||
    panel.luckReplications < 1 ||
    panel.draws.length !== panel.opponentSlots * panel.luckReplications
  ) {
    throw new Error('legacy material panel has an inconsistent clustered draw shape');
  }
  const canonicalActions = panel.actions.map((entry) => entry.action);
  if (canonicalActions.some((action) => !action) || new Set(canonicalActions).size !== canonicalActions.length) {
    throw new Error('legacy material panel actions must be non-empty and unique');
  }
  if (
    panel.matrix.length !== panel.draws.length ||
    panel.matrix.some((row) => row.length !== panel.actions.length || row.some((utility) => !Number.isFinite(utility)))
  ) {
    throw new Error('legacy material panel matrix is not a complete finite rectangle');
  }
  if (panel.actions.some((entry) => entry.samples !== panel.draws.length || !Number.isFinite(entry.value))) {
    throw new Error('legacy material panel estimates do not cover the complete draw rectangle');
  }
  const matrixDigest = exhaustivePanelMatrixDigest({
    id: panel.id,
    seedNamespace: panel.seedNamespace,
    opponentPopulation: panel.opponentPopulation,
    opponentSlots: panel.opponentSlots,
    luckReplications: panel.luckReplications,
    draws: panel.draws,
    actions: canonicalActions,
    matrix: panel.matrix,
  });
  if (matrixDigest !== panel.matrixDigest) throw new Error('legacy material panel matrix digest does not match');
  const values = panel.actions.map((entry) => entry.value);
  const span = Math.max(...values) - Math.min(...values);
  if (!Number.isFinite(panel.span) || panel.span < 0 || Math.abs(span - panel.span) > 1e-12) {
    throw new Error('legacy material panel span does not match its raw action values');
  }
}

function actionMap(
  panel: ExhaustivePanel,
  identities: readonly LegacyPositionActionIdentity[] | undefined,
): LegacyPositionActionIdentity[] {
  const canonicalActions = panel.actions.map((entry) => entry.action);
  if (identities === undefined) {
    return canonicalActions.map((canonicalAction) => ({ actionId: canonicalAction, canonicalAction }));
  }
  if (identities.length !== canonicalActions.length) {
    throw new Error('legacy material action identity map does not cover every panel action');
  }
  const byCanonical = new Map(identities.map((entry) => [entry.canonicalAction, entry]));
  if (
    byCanonical.size !== identities.length ||
    new Set(identities.map((entry) => entry.actionId)).size !== identities.length ||
    identities.some((entry) => !entry.actionId || !entry.canonicalAction) ||
    canonicalActions.some((action) => !byCanonical.has(action))
  ) {
    throw new Error('legacy material action identity map is not an exact one-to-one join');
  }
  return canonicalActions.map((canonicalAction) => structuredClone(byCanonical.get(canonicalAction)!));
}

function referenceArm(table: ExhaustiveActionTable, panel: ExhaustivePanel): ReferenceArm {
  if (table.horizon !== Number.POSITIVE_INFINITY && (!Number.isSafeInteger(table.horizon) || table.horizon < 0)) {
    throw new Error('legacy material table horizon must be non-negative or battle-end');
  }
  return {
    id: `legacy-material-${panel.id}-v1`,
    hiddenStatePrior: REFERENCE.hiddenState,
    opponentPolicy: REFERENCE.opponent,
    continuationPolicy: REFERENCE.continuation,
    horizon: table.horizon === Number.POSITIVE_INFINITY ? 'battle-end' : `${table.horizon}-turns`,
    utilityUnit: 'material-differential',
    weight: 1,
  };
}

function samples(
  panel: ExhaustivePanel,
  arm: ReferenceArm,
  identities: readonly LegacyPositionActionIdentity[],
): ReferenceUtilitySample[] {
  return panel.draws.flatMap((draw, rowIndex) => {
    const opponentSlot = Math.floor(rowIndex / panel.luckReplications);
    const drawId = canonicalJsonDigest(['legacy-material-draw-v1', panel.id, panel.seedNamespace, draw]);
    const clusterId = canonicalJsonDigest([
      'legacy-material-opponent-slot-v1',
      panel.id,
      panel.seedNamespace,
      opponentSlot,
      draw.opponentAction,
    ]);
    return identities.map((identity, actionIndex) => ({
      armId: arm.id,
      actionId: identity.actionId,
      drawId,
      clusterId,
      utility: panel.matrix[rowIndex]![actionIndex]!,
    }));
  });
}

export function legacyPositionReference(input: {
  table: ExhaustiveActionTable;
  panelId?: LegacyPositionPanelId;
  actions?: readonly LegacyPositionActionIdentity[];
}): LegacyPositionReferenceResult {
  const panelId = input.panelId ?? 'measurement';
  const panel = selectedPanel(input.table, panelId);
  assertPanel(panel);
  const actions = actionMap(panel, input.actions);
  const arm = referenceArm(input.table, panel);
  const suite = evaluateReferenceSuite({ arms: [arm], samples: samples(panel, arm, actions), cvarAlpha: 1 });
  for (const [index, identity] of actions.entries()) {
    const score = suite.actions.find((entry) => entry.actionId === identity.actionId);
    const expected = panel.actions[index]!.value;
    if (!score || Math.abs(score.expectedUtility - expected) > 1e-12) {
      throw new Error('legacy material suite does not reproduce the raw panel action values');
    }
  }
  return {
    protocolVersion: LEGACY_POSITION_REFERENCE_PROTOCOL.version,
    panelId,
    matrixDigest: panel.matrixDigest,
    actionMapDigest: canonicalJsonDigest(actions),
    actions,
    suite,
  };
}
