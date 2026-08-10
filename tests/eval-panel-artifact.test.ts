import assert from 'node:assert/strict';
import test from 'node:test';

import {
  type ExhaustiveDraw,
  type ExhaustivePanel,
  exhaustivePanelDrawPlan,
  exhaustivePanelMatrixDigest,
  twoStageClusterEstimate,
} from '../src/eval/counterfactual.js';
import { requestActionCandidates } from '../src/eval/fork.js';
import {
  exactPublicPositionFingerprint,
  POSITION_PANEL_ARTIFACT_SCHEMA_VERSION,
  validatePositionPanelArtifacts,
} from '../src/eval/panel-artifact.js';
import { canonicalJson, canonicalJsonDigest, canonicalJsonl } from '../src/eval/serialization.js';
import type { BattleRequest, JsonObject } from '../src/types.js';
import { minimalPanelBattle } from './fixtures/position-panel.js';

function artifacts(): { tasks: JsonObject[]; scores: JsonObject[]; sealed: JsonObject[] } {
  const position = minimalPanelBattle();
  const actions = [
    { number: 0, canonical_action: 'move 1', label: 'Protect' },
    { number: 1, canonical_action: 'move 2', label: 'Tailwind' },
  ];
  const tasks: JsonObject[] = [
    {
      schema_version: POSITION_PANEL_ARTIFACT_SCHEMA_VERSION,
      task_id: 'task-a',
      format: 'gen9customgame',
      phase: 'turn',
      turn: 1,
      prompt: [
        'Choose one listed joint action for this controlled Pokemon VGC position.',
        'Select the number for the complete joint action, not one part of it.',
        '',
        'Turn 1 visible state',
        '',
        'LEGAL JOINT ACTIONS:',
        '0. Protect',
        '1. Tailwind',
        '',
        'Return exactly one JSON object {"choice":N}, where N is a zero-based action number above. Include no other keys or prose.',
      ].join('\n'),
      response_schema: {
        type: 'object',
        required: ['choice'],
        properties: { choice: { type: 'integer', minimum: 0, maximum: 1 } },
        additionalProperties: false,
      },
      actions,
    },
  ];
  const scores: JsonObject[] = [
    {
      schema_version: POSITION_PANEL_ARTIFACT_SCHEMA_VERSION,
      task_id: 'task-a',
      structural_pass: true,
      structural_reasons: [],
      measurement_ready: true,
      diagnostic_flags: [],
      eligibility_metrics: {
        version: 1,
        legalActions: 2,
        qualificationDrawsPerPanel: [2, 2],
        qualificationOpponentPopulation: [1, 1],
        qualificationOpponentSlots: [1, 1],
        qualificationLuckReplications: [2, 2],
        heldOutSpanValue: 1,
        heldOutSpanStandardError: 0,
        heldOutSpanNormalApproxLower95: 1,
        bestAnchorAgreement: true,
        extremaSetAgreement: true,
        stabilityRankCorrelation: 1,
        maxNormalizedRewardDrift: 0,
        maxQualificationNormalizedStandardError: 0,
      },
      measurement_panel: { id: 'measurement', n: 2, matrix_digest: 'measurement-digest' },
      min_value: 0,
      max_value: 1,
      span: 1,
      actions: actions.map((action) => ({
        number: action.number,
        canonical_action: action.canonical_action,
        mean_value: action.number,
        standard_error: 0,
        n: 2,
        normalized_reward: action.number,
      })),
      stability: {
        matrix_digests: ['stability-a-digest', 'stability-b-digest'],
        spans: [1, 1],
        best_anchor_agreement: true,
        extrema_set_agreement: true,
        max_normalized_reward_drift: 0,
        held_out_span: {
          selectedAction: 'move 2',
          alternativeAction: 'move 1',
          value: 1,
          standardError: 0,
          normalApproxLower95: 1,
        },
      },
    },
  ];
  const panel = (id: ExhaustivePanel['id']): JsonObject => {
    const plan = exhaustivePanelDrawPlan({
      panelSeed: 'seed',
      id,
      opponentLegalActions: position.actions.p2,
      opponentSlots: 1,
      luckReplications: 2,
    });
    const { seedNamespace, draws } = plan;
    const actionNames = ['move 1', 'move 2'];
    const matrix = [
      [0, 1],
      [0, 1],
    ];
    return {
      id,
      seedNamespace,
      opponentPopulation: plan.opponentPopulation,
      opponentSlots: plan.opponentSlots,
      luckReplications: plan.luckReplications,
      draws,
      actions: [
        { action: 'move 1', value: 0, standardError: 0, samples: 2, reward: 0 },
        { action: 'move 2', value: 1, standardError: 0, samples: 2, reward: 1 },
      ],
      matrix,
      matrixDigest: exhaustivePanelMatrixDigest({
        id,
        seedNamespace,
        opponentPopulation: plan.opponentPopulation,
        opponentSlots: plan.opponentSlots,
        luckReplications: plan.luckReplications,
        draws,
        actions: actionNames,
        matrix,
      }),
      span: 1,
    };
  };
  const sealed: JsonObject[] = [
    {
      schema_version: POSITION_PANEL_ARTIFACT_SCHEMA_VERSION,
      task_id: 'task-a',
      source_id: 'source-a',
      exact_public_fingerprint: 'pending',
      source: {
        run_id: 'run',
        series_id: 'series',
        game_number: 1,
        position_index: 2,
        pid: 'p1',
        scaffold: 'revision',
        generating_models: {
          p1: 'p1-openrouter:model-a',
          p2: 'p2-anthropic:model-b',
        },
        played: 'move 2',
      },
      snapshot: position.snapshot,
      opponent_request: position.requests.p2 as unknown as JsonObject,
      panel_seed: 'seed',
      table: {
        pid: 'p1',
        turn: 1,
        legal: 2,
        horizon: 'end',
        stateValue: 0,
        selectionBest: 'move 2',
        measurementBest: 'move 2',
        rankingStable: true,
        valueSpan: 1,
        heldOutGap: {
          selectedAction: 'move 2',
          alternativeAction: 'move 1',
          value: 1,
          standardError: 0,
          normalApproxLower95: 1,
        },
        heldOutSpan: {
          selectedAction: 'move 2',
          alternativeAction: 'move 1',
          value: 1,
          standardError: 0,
          normalApproxLower95: 1,
        },
        stability: [panel('stability-a'), panel('stability-b')],
        measurement: panel('measurement'),
        anchorAgreement: true,
        maxNormalizedRewardDrift: 0,
      },
    },
  ];
  const table = sealed[0]!.table as JsonObject;
  const stabilityPanels = table.stability as JsonObject[];
  (scores[0]!.stability as JsonObject).matrix_digests = stabilityPanels.map((entry) => entry.matrixDigest);
  (scores[0]!.measurement_panel as JsonObject).matrix_digest = (table.measurement as JsonObject).matrixDigest;
  sealed[0]!.exact_public_fingerprint = exactPublicPositionFingerprint(tasks[0] as JsonObject);
  return { tasks, scores, sealed };
}

function tableOf(artifact: ReturnType<typeof artifacts>): JsonObject {
  return artifact.sealed[0]!.table as JsonObject;
}

function panelsOf(artifact: ReturnType<typeof artifacts>): JsonObject[] {
  const table = tableOf(artifact);
  return [...(table.stability as JsonObject[]), table.measurement as JsonObject];
}

function refreshPanelDigest(panel: JsonObject): void {
  panel.matrixDigest = exhaustivePanelMatrixDigest({
    id: panel.id as ExhaustivePanel['id'],
    seedNamespace: String(panel.seedNamespace),
    opponentPopulation: Number(panel.opponentPopulation),
    opponentSlots: Number(panel.opponentSlots),
    luckReplications: Number(panel.luckReplications),
    draws: panel.draws as unknown as ExhaustiveDraw[],
    actions: (panel.actions as JsonObject[]).map((action) => String(action.action)),
    matrix: panel.matrix as number[][],
  });
}

function refreshPanelEstimates(panel: JsonObject): void {
  const matrix = panel.matrix as number[][];
  const opponentSlots = Number(panel.opponentSlots);
  const luckReplications = Number(panel.luckReplications);
  const opponentPopulation = Number(panel.opponentPopulation);
  const actions = panel.actions as JsonObject[];
  const estimates = actions.map((_, actionIndex) =>
    twoStageClusterEstimate(
      Array.from({ length: opponentSlots }, (_, opponentIndex) =>
        matrix
          .slice(opponentIndex * luckReplications, (opponentIndex + 1) * luckReplications)
          .map((row) => row[actionIndex] as number),
      ),
      opponentPopulation,
    ),
  );
  const values = estimates.map((estimate) => estimate.value);
  const minimum = Math.min(...values);
  const maximum = Math.max(...values);
  const span = maximum - minimum;
  panel.span = span;
  for (const [actionIndex, action] of actions.entries()) {
    const estimate = estimates[actionIndex]!;
    action.value = estimate.value;
    action.standardError = estimate.standardError;
    action.samples = matrix.length;
    action.reward = span > 0 ? (estimate.value - minimum) / span : null;
  }
  refreshPanelDigest(panel);
}

function nullableUncertaintyArtifacts(): ReturnType<typeof artifacts> {
  const artifact = artifacts();
  const table = tableOf(artifact);
  for (const panel of panelsOf(artifact)) {
    panel.luckReplications = 1;
    panel.draws = (panel.draws as JsonObject[]).slice(0, 1);
    panel.matrix = (panel.matrix as number[][]).slice(0, 1);
    refreshPanelEstimates(panel);
  }
  for (const key of ['heldOutGap', 'heldOutSpan'] as const) {
    const heldOut = table[key] as JsonObject;
    heldOut.standardError = null;
    heldOut.normalApproxLower95 = null;
  }
  const score = artifact.scores[0] as JsonObject;
  const scoreStability = score.stability as JsonObject;
  const scoreHeldOut = scoreStability.held_out_span as JsonObject;
  scoreHeldOut.standardError = null;
  scoreHeldOut.normalApproxLower95 = null;
  scoreStability.matrix_digests = (table.stability as JsonObject[]).map((panel) => panel.matrixDigest);
  const measurement = table.measurement as JsonObject;
  const measurementPanel = score.measurement_panel as JsonObject;
  measurementPanel.n = 1;
  measurementPanel.matrix_digest = measurement.matrixDigest;
  for (const action of score.actions as JsonObject[]) {
    action.standard_error = null;
    action.n = 1;
  }
  const metrics = score.eligibility_metrics as JsonObject;
  metrics.qualificationDrawsPerPanel = [1, 1];
  metrics.qualificationLuckReplications = [1, 1];
  metrics.heldOutSpanStandardError = null;
  metrics.heldOutSpanNormalApproxLower95 = null;
  metrics.maxQualificationNormalizedStandardError = null;
  return artifact;
}

function measurementZeroSpanArtifacts(): ReturnType<typeof artifacts> {
  const artifact = artifacts();
  const table = tableOf(artifact);
  const measurement = table.measurement as JsonObject;
  measurement.matrix = [
    [0, 0],
    [0, 0],
  ];
  refreshPanelEstimates(measurement);
  table.measurementBest = 'move 1';
  table.valueSpan = 0;
  const score = artifact.scores[0] as JsonObject;
  score.measurement_ready = false;
  score.diagnostic_flags = [];
  score.min_value = 0;
  score.max_value = 0;
  score.span = 0;
  const measurementPanel = score.measurement_panel as JsonObject;
  measurementPanel.matrix_digest = measurement.matrixDigest;
  for (const action of score.actions as JsonObject[]) {
    action.mean_value = 0;
    action.standard_error = 0;
    action.normalized_reward = null;
  }
  return artifact;
}

function sampledOpponentPosition(): { request: BattleRequest; snapshot: string; actions: string[] } {
  const position = minimalPanelBattle(['Protect', 'Tailwind']);
  return { request: position.requests.p2, snapshot: position.snapshot, actions: position.actions.p2 };
}

function configurePanelForSampledOpponents(
  panel: JsonObject,
  panelSeed: string,
  opponentActions: readonly string[],
): void {
  const plan = exhaustivePanelDrawPlan({
    panelSeed,
    id: panel.id as ExhaustivePanel['id'],
    opponentLegalActions: opponentActions,
    opponentSlots: Math.min(2, opponentActions.length),
    luckReplications: 2,
  });
  panel.seedNamespace = plan.seedNamespace;
  panel.opponentPopulation = plan.opponentPopulation;
  panel.opponentSlots = plan.opponentSlots;
  panel.luckReplications = plan.luckReplications;
  panel.draws = plan.draws;
  panel.matrix = plan.draws.map(() => [0, 1]);
  refreshPanelEstimates(panel);
}

function configureAllSampledOpponentPanels(artifact: ReturnType<typeof artifacts>): string[] {
  const { request, snapshot, actions: opponentActions } = sampledOpponentPosition();
  if (opponentActions.length < 2) throw new Error('the opponent request fixture needs two legal actions');
  artifact.sealed[0]!.snapshot = snapshot;
  artifact.sealed[0]!.opponent_request = request as unknown as JsonObject;
  for (const panel of panelsOf(artifact))
    configurePanelForSampledOpponents(panel, String(artifact.sealed[0]!.panel_seed), opponentActions);
  return opponentActions;
}

test('canonical artifact JSON has recursive key order, finite numbers, and fixed JSONL newlines', () => {
  assert.equal(canonicalJson({ z: 1, a: { y: -0, b: 2 } }), '{"a":{"b":2,"y":0},"z":1}');
  assert.equal(canonicalJsonl([{ b: 1, a: 2 }]), '{"a":2,"b":1}\n');
  assert.equal(canonicalJsonDigest({ b: 1, a: 2 }), canonicalJsonDigest({ a: 2, b: 1 }));
  assert.equal(canonicalJson(JSON.parse('{"__proto__":1,"a":2}')), '{"__proto__":1,"a":2}');
  assert.throws(() => canonicalJson({ value: Number.NaN }), /non-finite/);
  assert.throws(() => canonicalJson({ value: undefined }), /undefined/);
  assert.throws(() => canonicalJson(new Date()), /plain JSON object/);
});

test('public, private-score, and sealed panel rows form one exact schema join', () => {
  const artifact = artifacts();
  assert.doesNotThrow(() => validatePositionPanelArtifacts(artifact.tasks, artifact.scores, artifact.sealed));

  const extraField = structuredClone(artifact);
  extraField.tasks[0]!.extra = true;
  assert.throws(
    () => validatePositionPanelArtifacts(extraField.tasks, extraField.scores, extraField.sealed),
    /task\[0\] keys differ/,
  );

  const brokenJoin = structuredClone(artifact);
  brokenJoin.sealed[0]!.task_id = 'other';
  assert.throws(
    () => validatePositionPanelArtifacts(brokenJoin.tasks, brokenJoin.scores, brokenJoin.sealed),
    /no exact private and sealed join/,
  );
});

test('public, score, and sealed rows require the current artifact schema', () => {
  for (const collection of ['tasks', 'scores', 'sealed'] as const) {
    const artifact = artifacts();
    artifact[collection][0]!.schema_version = POSITION_PANEL_ARTIFACT_SCHEMA_VERSION - 1;
    assert.throws(
      () => validatePositionPanelArtifacts(artifact.tasks, artifact.scores, artifact.sealed),
      /unsupported schema version/,
    );
  }
});

test('sealed generator provenance requires one exact configured model spec for each pid', () => {
  const accepted = artifacts();
  assert.doesNotThrow(() => validatePositionPanelArtifacts(accepted.tasks, accepted.scores, accepted.sealed));

  const missing = artifacts();
  const missingModels = (missing.sealed[0]!.source as JsonObject).generating_models as JsonObject;
  delete missingModels.p2;
  assert.throws(
    () => validatePositionPanelArtifacts(missing.tasks, missing.scores, missing.sealed),
    /source.generating_models keys differ/,
  );

  const extra = artifacts();
  const extraModels = (extra.sealed[0]!.source as JsonObject).generating_models as JsonObject;
  extraModels.p3 = 'p3-openrouter:model-c';
  assert.throws(
    () => validatePositionPanelArtifacts(extra.tasks, extra.scores, extra.sealed),
    /source.generating_models keys differ/,
  );

  const normalized = artifacts();
  const normalizedModels = (normalized.sealed[0]!.source as JsonObject).generating_models as JsonObject;
  normalizedModels.p1 = { provider: 'openrouter', model: 'model-a' };
  assert.throws(
    () => validatePositionPanelArtifacts(normalized.tasks, normalized.scores, normalized.sealed),
    /source.generating_models.p1 must be a non-empty string/,
  );

  const collapsed = artifacts();
  (collapsed.sealed[0]!.source as JsonObject).generating_models = 'openrouter:model-a';
  assert.throws(
    () => validatePositionPanelArtifacts(collapsed.tasks, collapsed.scores, collapsed.sealed),
    /source.generating_models must be an object/,
  );
});

test('frozen prompt, public fingerprint, played action, and panel seed are sealed joins', () => {
  const badHeader = artifacts();
  badHeader.tasks[0]!.prompt = String(badHeader.tasks[0]!.prompt).replace('Choose one listed', 'Pick one listed');
  assert.throws(
    () => validatePositionPanelArtifacts(badHeader.tasks, badHeader.scores, badHeader.sealed),
    /frozen position prompt protocol/,
  );

  const badActionLine = artifacts();
  ((badActionLine.tasks[0]!.actions as JsonObject[])[0] as JsonObject).label = 'Wait';
  assert.throws(
    () => validatePositionPanelArtifacts(badActionLine.tasks, badActionLine.scores, badActionLine.sealed),
    /frozen position prompt protocol/,
  );

  const duplicateCanonicalAction = artifacts();
  const duplicatedActions = duplicateCanonicalAction.tasks[0]!.actions as JsonObject[];
  duplicatedActions[1]!.canonical_action = duplicatedActions[0]!.canonical_action;
  assert.throws(
    () =>
      validatePositionPanelArtifacts(
        duplicateCanonicalAction.tasks,
        duplicateCanonicalAction.scores,
        duplicateCanonicalAction.sealed,
      ),
    /canonical_action strings must be unique/,
  );

  const changedVisibleState = artifacts();
  changedVisibleState.tasks[0]!.prompt = String(changedVisibleState.tasks[0]!.prompt).replace(
    'Turn 1 visible state',
    'Turn 1 changed visible state',
  );
  assert.throws(
    () =>
      validatePositionPanelArtifacts(changedVisibleState.tasks, changedVisibleState.scores, changedVisibleState.sealed),
    /sealed public fingerprint/,
  );

  const changedInvariant = artifacts();
  changedInvariant.tasks[0]!.format = 'gen9championsvgc2026regma';
  assert.throws(
    () => validatePositionPanelArtifacts(changedInvariant.tasks, changedInvariant.scores, changedInvariant.sealed),
    /sealed public fingerprint/,
  );

  const badPlayedAction = artifacts();
  (badPlayedAction.sealed[0]!.source as JsonObject).played = 'move 99';
  assert.throws(
    () => validatePositionPanelArtifacts(badPlayedAction.tasks, badPlayedAction.scores, badPlayedAction.sealed),
    /source.played is not one of its legal actions/,
  );

  const badPanelSeed = artifacts();
  ((tableOf(badPanelSeed).stability as JsonObject[])[0] as JsonObject).seedNamespace = 'unbound';
  assert.throws(
    () => validatePositionPanelArtifacts(badPanelSeed.tasks, badPanelSeed.scores, badPanelSeed.sealed),
    /seedNamespace does not match its sealed panel seed/,
  );
});

test('nullable clustered uncertainty is paired and bounded in score artifacts', () => {
  const nullable = nullableUncertaintyArtifacts();
  assert.doesNotThrow(() => validatePositionPanelArtifacts(nullable.tasks, nullable.scores, nullable.sealed));

  const unpairedScore = nullableUncertaintyArtifacts();
  const unpairedHeldOut = (unpairedScore.scores[0]!.stability as JsonObject).held_out_span as JsonObject;
  unpairedHeldOut.normalApproxLower95 = 0;
  assert.throws(
    () => validatePositionPanelArtifacts(unpairedScore.tasks, unpairedScore.scores, unpairedScore.sealed),
    /normalApproxLower95 is inconsistent with its standard error/,
  );

  const unpairedMetrics = nullableUncertaintyArtifacts();
  (unpairedMetrics.scores[0]!.eligibility_metrics as JsonObject).heldOutSpanNormalApproxLower95 = 0;
  assert.throws(
    () => validatePositionPanelArtifacts(unpairedMetrics.tasks, unpairedMetrics.scores, unpairedMetrics.sealed),
    /heldOutSpanNormalApproxLower95 is inconsistent with its standard error/,
  );

  const negativeStandardError = artifacts();
  const negativeHeldOut = (negativeStandardError.scores[0]!.stability as JsonObject).held_out_span as JsonObject;
  negativeHeldOut.standardError = -1;
  assert.throws(
    () =>
      validatePositionPanelArtifacts(
        negativeStandardError.tasks,
        negativeStandardError.scores,
        negativeStandardError.sealed,
      ),
    /standardError must be non-negative/,
  );

  const badDrift = artifacts();
  (badDrift.scores[0]!.eligibility_metrics as JsonObject).maxNormalizedRewardDrift = 2;
  assert.throws(
    () => validatePositionPanelArtifacts(badDrift.tasks, badDrift.scores, badDrift.sealed),
    /maxNormalizedRewardDrift must be in \[0, 1\]/,
  );

  const badRank = artifacts();
  (badRank.scores[0]!.eligibility_metrics as JsonObject).stabilityRankCorrelation = -2;
  assert.throws(
    () => validatePositionPanelArtifacts(badRank.tasks, badRank.scores, badRank.sealed),
    /stabilityRankCorrelation must be in \[-1, 1\]/,
  );
});

test('panel estimates, rewards, spans, digests, and table formulas are recomputed', () => {
  const staleEstimate = artifacts();
  const estimatePanel = (tableOf(staleEstimate).stability as JsonObject[])[0] as JsonObject;
  (estimatePanel.matrix as number[][])[0]![0] = 0.5;
  estimatePanel.span = 0.75;
  refreshPanelDigest(estimatePanel);
  assert.throws(
    () => validatePositionPanelArtifacts(staleEstimate.tasks, staleEstimate.scores, staleEstimate.sealed),
    /does not match its matrix estimate/,
  );

  const staleReward = artifacts();
  (((tableOf(staleReward).stability as JsonObject[])[0]!.actions as JsonObject[])[0] as JsonObject).reward = 0.25;
  assert.throws(
    () => validatePositionPanelArtifacts(staleReward.tasks, staleReward.scores, staleReward.sealed),
    /does not match its matrix estimate/,
  );

  const staleSpan = artifacts();
  ((tableOf(staleSpan).stability as JsonObject[])[0] as JsonObject).span = 2;
  assert.throws(
    () => validatePositionPanelArtifacts(staleSpan.tasks, staleSpan.scores, staleSpan.sealed),
    /span does not match its matrix/,
  );

  const staleDigest = artifacts();
  ((tableOf(staleDigest).stability as JsonObject[])[0] as JsonObject).matrixDigest = '0'.repeat(64);
  assert.throws(
    () => validatePositionPanelArtifacts(staleDigest.tasks, staleDigest.scores, staleDigest.sealed),
    /matrixDigest does not match its panel/,
  );

  const staleHeldOut = artifacts();
  const heldOutGap = tableOf(staleHeldOut).heldOutGap as JsonObject;
  heldOutGap.value = 0.5;
  heldOutGap.normalApproxLower95 = 0.5;
  assert.throws(
    () => validatePositionPanelArtifacts(staleHeldOut.tasks, staleHeldOut.scores, staleHeldOut.sealed),
    /heldOutGap does not match its paired panel estimate/,
  );

  const staleRanking = artifacts();
  tableOf(staleRanking).rankingStable = false;
  assert.throws(
    () => validatePositionPanelArtifacts(staleRanking.tasks, staleRanking.scores, staleRanking.sealed),
    /rankingStable is inconsistent/,
  );

  const staleDrift = artifacts();
  tableOf(staleDrift).maxNormalizedRewardDrift = 0.25;
  assert.throws(
    () => validatePositionPanelArtifacts(staleDrift.tasks, staleDrift.scores, staleDrift.sealed),
    /maxNormalizedRewardDrift is inconsistent/,
  );

  const staleValueSpan = artifacts();
  tableOf(staleValueSpan).valueSpan = 0.5;
  assert.throws(
    () => validatePositionPanelArtifacts(staleValueSpan.tasks, staleValueSpan.scores, staleValueSpan.sealed),
    /valueSpan differs from measurement/,
  );
});

test('opponent draws preserve clustered replication blocks and the sealed request design', () => {
  const emptyRequest = artifacts();
  const waitRequest = { wait: true } as BattleRequest;
  const emptyOpponentActions = requestActionCandidates(waitRequest);
  assert.deepEqual(emptyOpponentActions, []);
  emptyRequest.sealed[0]!.opponent_request = waitRequest as unknown as JsonObject;
  for (const panel of panelsOf(emptyRequest)) {
    const plan = exhaustivePanelDrawPlan({
      panelSeed: String(emptyRequest.sealed[0]!.panel_seed),
      id: panel.id as ExhaustivePanel['id'],
      opponentLegalActions: emptyOpponentActions,
      opponentSlots: 1,
      luckReplications: Number(panel.luckReplications),
    });
    panel.seedNamespace = plan.seedNamespace;
    panel.opponentPopulation = plan.opponentPopulation;
    panel.opponentSlots = plan.opponentSlots;
    panel.draws = plan.draws;
    refreshPanelEstimates(panel);
  }
  assert.throws(
    () => validatePositionPanelArtifacts(emptyRequest.tasks, emptyRequest.scores, emptyRequest.sealed),
    /cannot validate its action sets against the snapshot/,
  );

  const changedBattleWord = artifacts();
  const battleWordPanel = (tableOf(changedBattleWord).stability as JsonObject[])[0] as JsonObject;
  const battleWordDraw = (battleWordPanel.draws as JsonObject[])[0] as JsonObject;
  const battleSeed = [...(battleWordDraw.battleSeed as number[])];
  battleSeed[0] = (battleSeed[0] as number) === 0xffff ? 0xfffe : (battleSeed[0] as number) + 1;
  battleWordDraw.battleSeed = battleSeed;
  refreshPanelDigest(battleWordPanel);
  assert.throws(
    () => validatePositionPanelArtifacts(changedBattleWord.tasks, changedBattleWord.scores, changedBattleWord.sealed),
    /deterministic panel draw plan/,
  );

  const reorderedOpponents = artifacts();
  configureAllSampledOpponentPanels(reorderedOpponents);
  const reorderedPanel = (tableOf(reorderedOpponents).stability as JsonObject[])[0] as JsonObject;
  const reorderedDraws = reorderedPanel.draws as JsonObject[];
  const firstOpponent = reorderedDraws[0]!.opponentAction;
  const secondOpponent = reorderedDraws[2]!.opponentAction;
  for (const draw of reorderedDraws.slice(0, 2)) draw.opponentAction = secondOpponent;
  for (const draw of reorderedDraws.slice(2)) draw.opponentAction = firstOpponent;
  refreshPanelDigest(reorderedPanel);
  assert.throws(
    () =>
      validatePositionPanelArtifacts(reorderedOpponents.tasks, reorderedOpponents.scores, reorderedOpponents.sealed),
    /deterministic panel draw plan/,
  );

  const mixedBlock = artifacts();
  const mixedActions = configureAllSampledOpponentPanels(mixedBlock);
  const mixedPanel = (tableOf(mixedBlock).stability as JsonObject[])[0] as JsonObject;
  const mixedDraws = mixedPanel.draws as JsonObject[];
  const otherMixedAction = mixedActions.find((action) => action !== mixedDraws[0]!.opponentAction);
  assert.ok(otherMixedAction);
  mixedDraws[1]!.opponentAction = otherMixedAction;
  assert.throws(
    () => validatePositionPanelArtifacts(mixedBlock.tasks, mixedBlock.scores, mixedBlock.sealed),
    /opponentAction must be constant within each replication block/,
  );

  const duplicateOpponent = artifacts();
  configureAllSampledOpponentPanels(duplicateOpponent);
  const duplicatePanel = (tableOf(duplicateOpponent).stability as JsonObject[])[0] as JsonObject;
  const duplicateDraws = duplicatePanel.draws as JsonObject[];
  for (const draw of duplicateDraws.slice(2)) draw.opponentAction = duplicateDraws[0]!.opponentAction;
  assert.throws(
    () => validatePositionPanelArtifacts(duplicateOpponent.tasks, duplicateOpponent.scores, duplicateOpponent.sealed),
    /sampled opponent actions must be distinct/,
  );

  const illegalOpponent = artifacts();
  configureAllSampledOpponentPanels(illegalOpponent);
  const illegalPanel = (tableOf(illegalOpponent).stability as JsonObject[])[0] as JsonObject;
  for (const draw of (illegalPanel.draws as JsonObject[]).slice(0, 2)) draw.opponentAction = 'move 99';
  assert.throws(
    () => validatePositionPanelArtifacts(illegalOpponent.tasks, illegalOpponent.scores, illegalOpponent.sealed),
    /draws do not match the snapshot-accepted opponent action set/,
  );

  const sameRowsDifferentDesign = artifacts();
  const designActions = configureAllSampledOpponentPanels(sameRowsDifferentDesign);
  const secondPanel = (tableOf(sameRowsDifferentDesign).stability as JsonObject[])[1] as JsonObject;
  const changedPlan = exhaustivePanelDrawPlan({
    panelSeed: String(sameRowsDifferentDesign.sealed[0]!.panel_seed),
    id: secondPanel.id as ExhaustivePanel['id'],
    opponentLegalActions: designActions,
    opponentSlots: 1,
    luckReplications: 4,
  });
  secondPanel.opponentSlots = changedPlan.opponentSlots;
  secondPanel.luckReplications = changedPlan.luckReplications;
  secondPanel.draws = changedPlan.draws;
  refreshPanelEstimates(secondPanel);
  assert.throws(
    () =>
      validatePositionPanelArtifacts(
        sameRowsDifferentDesign.tasks,
        sameRowsDifferentDesign.scores,
        sameRowsDifferentDesign.sealed,
      ),
    /panels differ in their matrix dimensions or sampling design/,
  );
});

test('score duplicates and unusable measurement panels fail closed', () => {
  const zeroMeasurement = measurementZeroSpanArtifacts();
  assert.equal(zeroMeasurement.scores[0]!.structural_pass, true);
  assert.equal(zeroMeasurement.scores[0]!.measurement_ready, false);
  assert.throws(
    () => validatePositionPanelArtifacts(zeroMeasurement.tasks, zeroMeasurement.scores, zeroMeasurement.sealed),
    /measurement panel has no usable reward span/,
  );

  const staleScoreAction = artifacts();
  const score = staleScoreAction.scores[0] as JsonObject;
  const scoreAction = (score.actions as JsonObject[])[0] as JsonObject;
  scoreAction.standard_error = null;
  assert.throws(
    () => validatePositionPanelArtifacts(staleScoreAction.tasks, staleScoreAction.scores, staleScoreAction.sealed),
    /action 0 differs from its sealed measurement/,
  );

  const staleScoreDigest = artifacts();
  (staleScoreDigest.scores[0]!.measurement_panel as JsonObject).matrix_digest = '0'.repeat(64);
  assert.throws(
    () => validatePositionPanelArtifacts(staleScoreDigest.tasks, staleScoreDigest.scores, staleScoreDigest.sealed),
    /measurement identity differs from its sealed panel/,
  );

  const staleEligibility = artifacts();
  const eligibility = staleEligibility.scores[0]!.eligibility_metrics as JsonObject;
  eligibility.heldOutSpanValue = 0.5;
  eligibility.heldOutSpanNormalApproxLower95 = 0.5;
  assert.throws(
    () => validatePositionPanelArtifacts(staleEligibility.tasks, staleEligibility.scores, staleEligibility.sealed),
    /eligibility_metrics differ from duplicated score diagnostics/,
  );

  const staleReadiness = artifacts();
  staleReadiness.scores[0]!.measurement_ready = false;
  assert.throws(
    () => validatePositionPanelArtifacts(staleReadiness.tasks, staleReadiness.scores, staleReadiness.sealed),
    /measurement_ready is inconsistent/,
  );

  const staleStructure = artifacts();
  staleStructure.scores[0]!.structural_pass = false;
  assert.throws(
    () => validatePositionPanelArtifacts(staleStructure.tasks, staleStructure.scores, staleStructure.sealed),
    /inconsistent qualification structure/,
  );
});

test('sealed rows validate provenance, snapshots, and exhaustive panel internals', () => {
  const badSource = artifacts();
  (badSource.sealed[0]!.source as JsonObject).extra = true;
  assert.throws(
    () => validatePositionPanelArtifacts(badSource.tasks, badSource.scores, badSource.sealed),
    /sealed\[0\]\.source keys differ/,
  );

  const badSnapshot = artifacts();
  badSnapshot.sealed[0]!.snapshot = '[]';
  assert.throws(
    () => validatePositionPanelArtifacts(badSnapshot.tasks, badSnapshot.scores, badSnapshot.sealed),
    /snapshot must contain a JSON object/,
  );

  const changedSnapshot = artifacts();
  changedSnapshot.sealed[0]!.snapshot = minimalPanelBattle(['Protect'], ['Protect']).snapshot;
  assert.throws(
    () => validatePositionPanelArtifacts(changedSnapshot.tasks, changedSnapshot.scores, changedSnapshot.sealed),
    /snapshot source has fewer than two Showdown-accepted/,
  );

  const missingOpponent = artifacts();
  missingOpponent.sealed[0]!.opponent_request = null;
  assert.throws(
    () => validatePositionPanelArtifacts(missingOpponent.tasks, missingOpponent.scores, missingOpponent.sealed),
    /opponent_request presence does not match the snapshot decision boundary/,
  );

  const badDraw = artifacts();
  const badDrawTable = badDraw.sealed[0]!.table as JsonObject;
  const badDrawPanels = badDrawTable.stability as JsonObject[];
  const badDraws = badDrawPanels[0]!.draws as JsonObject[];
  badDraws[0]!.battleSeed = [1, 2, 3];
  assert.throws(
    () => validatePositionPanelArtifacts(badDraw.tasks, badDraw.scores, badDraw.sealed),
    /battleSeed must contain four words/,
  );

  const mismatchedActions = artifacts();
  const mismatchedTable = mismatchedActions.sealed[0]!.table as JsonObject;
  const mismatchedPanels = mismatchedTable.stability as JsonObject[];
  const panelActions = mismatchedPanels[1]!.actions as JsonObject[];
  panelActions[1]!.action = 'move 3';
  refreshPanelDigest(mismatchedPanels[1] as JsonObject);
  assert.throws(
    () => validatePositionPanelArtifacts(mismatchedActions.tasks, mismatchedActions.scores, mismatchedActions.sealed),
    /panels differ in their legal actions/,
  );

  const mismatchedDimensions = artifacts();
  const dimensionsTable = mismatchedDimensions.sealed[0]!.table as JsonObject;
  const dimensionsPanels = dimensionsTable.stability as JsonObject[];
  const secondPanel = dimensionsPanels[1] as JsonObject;
  const changedPlan = exhaustivePanelDrawPlan({
    panelSeed: String(mismatchedDimensions.sealed[0]!.panel_seed),
    id: secondPanel.id as ExhaustivePanel['id'],
    opponentLegalActions: ['move 1'],
    opponentSlots: 1,
    luckReplications: 3,
  });
  secondPanel.luckReplications = changedPlan.luckReplications;
  secondPanel.draws = changedPlan.draws;
  (secondPanel.matrix as unknown[][]).push([0, 1]);
  refreshPanelEstimates(secondPanel);
  assert.throws(
    () =>
      validatePositionPanelArtifacts(
        mismatchedDimensions.tasks,
        mismatchedDimensions.scores,
        mismatchedDimensions.sealed,
      ),
    /panels differ in their matrix dimensions/,
  );

  const nonRectangular = artifacts();
  const nonRectangularTable = nonRectangular.sealed[0]!.table as JsonObject;
  (nonRectangularTable.measurement as JsonObject).matrix = [[0], [0, 1]];
  assert.throws(
    () => validatePositionPanelArtifacts(nonRectangular.tasks, nonRectangular.scores, nonRectangular.sealed),
    /matrix\[0\] must contain 2 action values/,
  );
});
