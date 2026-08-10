import { defaultPsDir } from '../paths.js';
import { loadShowdown } from '../showdown.js';
import type { BattleRequest, JsonObject, Pid } from '../types.js';
import {
  type ExhaustiveActionTable,
  type ExhaustiveDraw,
  exhaustivePanelDrawPlan,
  exhaustivePanelMatrixDigest,
  twoStageClusterEstimate,
} from './counterfactual.js';
import { POSITION_ELIGIBILITY_METRICS_VERSION, positionEligibilityMetrics } from './eligibility.js';
import { acceptedBattleActionEntries, pendingSides } from './fork.js';
import { canonicalJson, canonicalJsonDigest } from './serialization.js';
import { validateTaskScoreJoin } from './task.js';

const TASK_KEYS = ['actions', 'format', 'phase', 'prompt', 'response_schema', 'schema_version', 'task_id', 'turn'];
const SCORE_KEYS = [
  'actions',
  'diagnostic_flags',
  'eligibility_metrics',
  'max_value',
  'measurement_panel',
  'measurement_ready',
  'min_value',
  'schema_version',
  'span',
  'stability',
  'structural_pass',
  'structural_reasons',
  'task_id',
];
const SEALED_KEYS = [
  'exact_public_fingerprint',
  'opponent_request',
  'panel_seed',
  'schema_version',
  'snapshot',
  'source',
  'source_id',
  'table',
  'task_id',
];
const SOURCE_KEYS = ['game_number', 'pid', 'played', 'played_by', 'position_index', 'run_id', 'scaffold', 'series_id'];
const TABLE_KEYS = [
  'anchorAgreement',
  'heldOutGap',
  'heldOutSpan',
  'horizon',
  'legal',
  'maxNormalizedRewardDrift',
  'measurement',
  'measurementBest',
  'pid',
  'rankingStable',
  'selectionBest',
  'stability',
  'stateValue',
  'turn',
  'valueSpan',
];
const PANEL_KEYS = [
  'actions',
  'draws',
  'id',
  'luckReplications',
  'matrix',
  'matrixDigest',
  'opponentPopulation',
  'opponentSlots',
  'seedNamespace',
  'span',
];
const DRAW_KEYS = ['battleSeed', 'continuationSeed', 'index', 'opponentAction'];
const ACTION_VALUE_KEYS = ['action', 'reward', 'samples', 'standardError', 'value'];
const HELD_OUT_KEYS = ['alternativeAction', 'normalApproxLower95', 'selectedAction', 'standardError', 'value'];
const POSITION_PROMPT_PREFIX =
  'Choose one listed joint action for this controlled Pokemon VGC position.\nSelect the number for the complete joint action, not one part of it.\n\n';
const POSITION_PROMPT_RESPONSE =
  'Return exactly one JSON object {"choice":N}, where N is a zero-based action number above. Include no other keys or prose.';
export const POSITION_PANEL_ARTIFACT_SCHEMA_VERSION = 1;

export function exactPublicPositionFingerprint(task: JsonObject): string {
  const actions = Array.isArray(task.actions)
    ? task.actions.map((raw) => {
        const action = raw as JsonObject;
        return {
          number: action.number,
          canonicalAction: action.canonical_action,
          label: action.label,
        };
      })
    : [];
  return canonicalJsonDigest([
    'exact-public-task-v2',
    {
      schemaVersion: task.schema_version,
      taskId: task.task_id,
      format: task.format,
      phase: task.phase,
      turn: task.turn,
      prompt: task.prompt,
      responseSchema: task.response_schema,
      actions,
    },
  ]);
}

function object(value: unknown, location: string): JsonObject {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(`${location} must be an object`);
  return value as JsonObject;
}

function exactKeys(value: JsonObject, expected: readonly string[], location: string): void {
  const actual = Object.keys(value).sort();
  const wanted = [...expected].sort();
  if (canonicalJson(actual) !== canonicalJson(wanted))
    throw new Error(`${location} keys differ: expected ${wanted.join(',')}; got ${actual.join(',')}`);
}

function string(value: unknown, location: string): string {
  if (typeof value !== 'string' || !value) throw new Error(`${location} must be a non-empty string`);
  return value;
}

function finite(value: unknown, location: string): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) throw new Error(`${location} must be finite`);
  return value;
}

function integer(value: unknown, location: string, minimum = 0): number {
  const result = finite(value, location);
  if (!Number.isInteger(result) || result < minimum) throw new Error(`${location} must be an integer >= ${minimum}`);
  return result;
}

function strings(value: unknown, location: string): string[] {
  if (!Array.isArray(value) || value.some((entry) => typeof entry !== 'string'))
    throw new Error(`${location} must be a string array`);
  return value as string[];
}

function nullableFinite(value: unknown, location: string): number | null {
  return value === null ? null : finite(value, location);
}

function validatePublicPositionTask(row: JsonObject, index = 0): void {
  const location = `task[${index}]`;
  exactKeys(row, TASK_KEYS, location);
  if (row.schema_version !== POSITION_PANEL_ARTIFACT_SCHEMA_VERSION)
    throw new Error(`${location} has unsupported schema version`);
  string(row.task_id, `${location}.task_id`);
  string(row.format, `${location}.format`);
  if (!['team_preview', 'forced_switch', 'turn'].includes(String(row.phase)))
    throw new Error(`${location}.phase is invalid`);
  integer(row.turn, `${location}.turn`);
  string(row.prompt, `${location}.prompt`);
  if (!Array.isArray(row.actions) || !row.actions.length) throw new Error(`${location}.actions must be non-empty`);
  for (const [actionIndex, raw] of row.actions.entries()) {
    const action = object(raw, `${location}.actions[${actionIndex}]`);
    exactKeys(action, ['canonical_action', 'label', 'number'], `${location}.actions[${actionIndex}]`);
    if (integer(action.number, `${location}.actions[${actionIndex}].number`) !== actionIndex)
      throw new Error(`${location}.actions must use contiguous zero-based numbers`);
    string(action.canonical_action, `${location}.actions[${actionIndex}].canonical_action`);
    const label = string(action.label, `${location}.actions[${actionIndex}].label`);
    if (/[\r\n]/u.test(label)) throw new Error(`${location}.actions[${actionIndex}].label must occupy one line`);
  }
  const canonicalActions = (row.actions as JsonObject[]).map((action) => String(action.canonical_action));
  if (new Set(canonicalActions).size !== canonicalActions.length)
    throw new Error(`${location}.actions canonical_action strings must be unique`);
  const actionLines = (row.actions as JsonObject[]).map((action) => `${action.number}. ${action.label}`);
  const actionBlock = `\n\nLEGAL JOINT ACTIONS:\n${actionLines.join('\n')}\n\n${POSITION_PROMPT_RESPONSE}`;
  const prompt = String(row.prompt);
  const stateEnd = prompt.length - actionBlock.length;
  const visibleState = prompt.slice(POSITION_PROMPT_PREFIX.length, stateEnd);
  if (
    /\r/u.test(prompt) ||
    !prompt.startsWith(POSITION_PROMPT_PREFIX) ||
    !prompt.endsWith(actionBlock) ||
    !visibleState ||
    visibleState.startsWith('\n') ||
    visibleState.endsWith('\n') ||
    visibleState.includes('\n\nLEGAL JOINT ACTIONS:')
  )
    throw new Error(`${location}.prompt does not match the frozen position prompt protocol`);
  const response = object(row.response_schema, `${location}.response_schema`);
  const expected = {
    type: 'object',
    required: ['choice'],
    properties: { choice: { type: 'integer', minimum: 0, maximum: row.actions.length - 1 } },
    additionalProperties: false,
  };
  if (canonicalJson(response) !== canonicalJson(expected))
    throw new Error(`${location}.response_schema differs from its action map`);
}

function validateEligibilityMetrics(value: unknown, location: string): JsonObject {
  const metrics = object(value, location);
  exactKeys(
    metrics,
    [
      'bestAnchorAgreement',
      'extremaSetAgreement',
      'heldOutSpanNormalApproxLower95',
      'heldOutSpanStandardError',
      'heldOutSpanValue',
      'legalActions',
      'maxNormalizedRewardDrift',
      'maxQualificationNormalizedStandardError',
      'qualificationDrawsPerPanel',
      'qualificationLuckReplications',
      'qualificationOpponentPopulation',
      'qualificationOpponentSlots',
      'stabilityRankCorrelation',
      'version',
    ],
    location,
  );
  if (metrics.version !== POSITION_ELIGIBILITY_METRICS_VERSION) throw new Error(`${location}.version is unsupported`);
  integer(metrics.legalActions, `${location}.legalActions`, 1);
  for (const key of [
    'qualificationDrawsPerPanel',
    'qualificationLuckReplications',
    'qualificationOpponentPopulation',
    'qualificationOpponentSlots',
  ] as const) {
    const values = metrics[key];
    if (!Array.isArray(values) || values.length !== 2) throw new Error(`${location}.${key} must contain two panels`);
    values.forEach((entry, index) => {
      integer(entry, `${location}.${key}[${index}]`, 1);
    });
  }
  const draws = metrics.qualificationDrawsPerPanel as number[];
  const populations = metrics.qualificationOpponentPopulation as number[];
  const slots = metrics.qualificationOpponentSlots as number[];
  const replications = metrics.qualificationLuckReplications as number[];
  for (let panelIndex = 0; panelIndex < 2; panelIndex += 1) {
    if ((slots[panelIndex] as number) > (populations[panelIndex] as number))
      throw new Error(`${location}.qualificationOpponentSlots[${panelIndex}] exceeds its population`);
    if ((draws[panelIndex] as number) !== (slots[panelIndex] as number) * (replications[panelIndex] as number))
      throw new Error(`${location}.qualificationDrawsPerPanel[${panelIndex}] is inconsistent`);
  }
  const heldOutValue = finite(metrics.heldOutSpanValue, `${location}.heldOutSpanValue`);
  const heldOutStandardError = nullableFinite(metrics.heldOutSpanStandardError, `${location}.heldOutSpanStandardError`);
  if (heldOutStandardError !== null && heldOutStandardError < 0)
    throw new Error(`${location}.heldOutSpanStandardError must be non-negative`);
  const heldOutLower = nullableFinite(
    metrics.heldOutSpanNormalApproxLower95,
    `${location}.heldOutSpanNormalApproxLower95`,
  );
  const expectedLower = heldOutStandardError === null ? null : heldOutValue - 1.96 * heldOutStandardError;
  if (heldOutLower !== expectedLower)
    throw new Error(`${location}.heldOutSpanNormalApproxLower95 is inconsistent with its standard error`);
  const correlation = nullableFinite(metrics.stabilityRankCorrelation, `${location}.stabilityRankCorrelation`);
  if (correlation !== null && (correlation < -1 || correlation > 1))
    throw new Error(`${location}.stabilityRankCorrelation must be in [-1, 1]`);
  const drift = nullableFinite(metrics.maxNormalizedRewardDrift, `${location}.maxNormalizedRewardDrift`);
  if (drift !== null && (drift < 0 || drift > 1))
    throw new Error(`${location}.maxNormalizedRewardDrift must be in [0, 1]`);
  const normalizedStandardError = nullableFinite(
    metrics.maxQualificationNormalizedStandardError,
    `${location}.maxQualificationNormalizedStandardError`,
  );
  if (normalizedStandardError !== null && normalizedStandardError < 0)
    throw new Error(`${location}.maxQualificationNormalizedStandardError must be non-negative`);
  if (typeof metrics.bestAnchorAgreement !== 'boolean' || typeof metrics.extremaSetAgreement !== 'boolean')
    throw new Error(`${location} anchor fields must be booleans`);
  return metrics;
}

function validatePrivatePositionScore(row: JsonObject, index = 0): void {
  const location = `score[${index}]`;
  exactKeys(row, SCORE_KEYS, location);
  if (row.schema_version !== POSITION_PANEL_ARTIFACT_SCHEMA_VERSION)
    throw new Error(`${location} has unsupported schema version`);
  string(row.task_id, `${location}.task_id`);
  if (typeof row.structural_pass !== 'boolean') throw new Error(`${location}.structural_pass must be boolean`);
  if (typeof row.measurement_ready !== 'boolean') throw new Error(`${location}.measurement_ready must be boolean`);
  const structuralReasons = strings(row.structural_reasons, `${location}.structural_reasons`);
  const diagnosticFlags = strings(row.diagnostic_flags, `${location}.diagnostic_flags`);
  const metrics = validateEligibilityMetrics(row.eligibility_metrics, `${location}.eligibility_metrics`);
  const panel = object(row.measurement_panel, `${location}.measurement_panel`);
  exactKeys(panel, ['id', 'matrix_digest', 'n'], `${location}.measurement_panel`);
  if (string(panel.id, `${location}.measurement_panel.id`) !== 'measurement')
    throw new Error(`${location}.measurement_panel.id must be measurement`);
  const panelSamples = integer(panel.n, `${location}.measurement_panel.n`, 1);
  string(panel.matrix_digest, `${location}.measurement_panel.matrix_digest`);
  const recordedMinimum = finite(row.min_value, `${location}.min_value`);
  const recordedMaximum = finite(row.max_value, `${location}.max_value`);
  const recordedSpan = finite(row.span, `${location}.span`);
  if (recordedSpan < 0) throw new Error(`${location}.span must be non-negative`);
  if (!Array.isArray(row.actions) || !row.actions.length) throw new Error(`${location}.actions must be non-empty`);
  const actions = row.actions.map((raw, actionIndex) => {
    const action = object(raw, `${location}.actions[${actionIndex}]`);
    exactKeys(
      action,
      ['canonical_action', 'mean_value', 'n', 'normalized_reward', 'number', 'standard_error'],
      `${location}.actions[${actionIndex}]`,
    );
    if (integer(action.number, `${location}.actions[${actionIndex}].number`) !== actionIndex)
      throw new Error(`${location}.actions must use contiguous zero-based numbers`);
    const canonicalAction = string(action.canonical_action, `${location}.actions[${actionIndex}].canonical_action`);
    const meanValue = finite(action.mean_value, `${location}.actions[${actionIndex}].mean_value`);
    const standardError = nullableFinite(action.standard_error, `${location}.actions[${actionIndex}].standard_error`);
    if (standardError !== null && standardError < 0)
      throw new Error(`${location}.actions[${actionIndex}].standard_error must be non-negative`);
    if (integer(action.n, `${location}.actions[${actionIndex}].n`, 1) !== panelSamples)
      throw new Error(`${location}.actions[${actionIndex}].n must match its measurement panel`);
    const reward = nullableFinite(action.normalized_reward, `${location}.actions[${actionIndex}].normalized_reward`);
    if (reward !== null && (reward < 0 || reward > 1))
      throw new Error(`${location}.actions[${actionIndex}] reward is outside [0, 1]`);
    return { canonicalAction, meanValue, reward };
  });
  if (new Set(actions.map((action) => action.canonicalAction)).size !== actions.length)
    throw new Error(`${location}.actions canonical actions must be unique`);
  const values = actions.map((action) => action.meanValue);
  const minimum = Math.min(...values);
  const maximum = Math.max(...values);
  const span = maximum - minimum;
  if (recordedMinimum !== minimum || recordedMaximum !== maximum || recordedSpan !== span)
    throw new Error(`${location} measurement extrema and span are inconsistent`);
  for (const [actionIndex, action] of actions.entries()) {
    const expectedReward = span > 0 ? (action.meanValue - minimum) / span : null;
    if (action.reward !== expectedReward)
      throw new Error(`${location}.actions[${actionIndex}].normalized_reward is inconsistent`);
  }
  if (row.measurement_ready !== span > 0) throw new Error(`${location}.measurement_ready is inconsistent`);
  if (!row.measurement_ready) throw new Error(`${location} measurement panel has no usable reward span`);

  const stability = object(row.stability, `${location}.stability`);
  exactKeys(
    stability,
    [
      'best_anchor_agreement',
      'extrema_set_agreement',
      'held_out_span',
      'matrix_digests',
      'max_normalized_reward_drift',
      'spans',
    ],
    `${location}.stability`,
  );
  if (typeof stability.best_anchor_agreement !== 'boolean' || typeof stability.extrema_set_agreement !== 'boolean')
    throw new Error(`${location}.stability agreement fields must be booleans`);
  if (!Array.isArray(stability.matrix_digests) || stability.matrix_digests.length !== 2)
    throw new Error(`${location}.stability.matrix_digests must contain two panels`);
  stability.matrix_digests.forEach((entry, panelIndex) => {
    string(entry, `${location}.stability.matrix_digests[${panelIndex}]`);
  });
  if (!Array.isArray(stability.spans) || stability.spans.length !== 2)
    throw new Error(`${location}.stability.spans must contain two panels`);
  stability.spans.forEach((entry, panelIndex) => {
    if (finite(entry, `${location}.stability.spans[${panelIndex}]`) < 0)
      throw new Error(`${location}.stability.spans[${panelIndex}] must be non-negative`);
  });
  const stabilityDrift = nullableFinite(
    stability.max_normalized_reward_drift,
    `${location}.stability.max_normalized_reward_drift`,
  );
  if (stabilityDrift !== null && (stabilityDrift < 0 || stabilityDrift > 1))
    throw new Error(`${location}.stability.max_normalized_reward_drift must be in [0, 1]`);
  validateHeldOut(stability.held_out_span, `${location}.stability.held_out_span`);
  const heldOut = stability.held_out_span as JsonObject;

  const expectedStructuralReasons = stability.spans.some((entry) => Number(entry) <= 0)
    ? ['zero_qualification_span']
    : [];
  if (
    canonicalJson(structuralReasons) !== canonicalJson(expectedStructuralReasons) ||
    row.structural_pass !== (expectedStructuralReasons.length === 0)
  )
    throw new Error(`${location} has inconsistent qualification structure`);
  const expectedDiagnosticFlags = [
    ...(heldOut.normalApproxLower95 !== null && Number(heldOut.normalApproxLower95) <= 0
      ? ['normal_approx_span_crosses_zero']
      : []),
    ...(!stability.best_anchor_agreement ? ['best_anchor_unstable'] : []),
    ...(!stability.extrema_set_agreement ? ['extrema_sets_unstable'] : []),
  ];
  if (canonicalJson(diagnosticFlags) !== canonicalJson(expectedDiagnosticFlags))
    throw new Error(`${location} has inconsistent diagnostic flags`);
  if (
    metrics.legalActions !== actions.length ||
    metrics.heldOutSpanValue !== heldOut.value ||
    metrics.heldOutSpanStandardError !== heldOut.standardError ||
    metrics.heldOutSpanNormalApproxLower95 !== heldOut.normalApproxLower95 ||
    metrics.bestAnchorAgreement !== stability.best_anchor_agreement ||
    metrics.extremaSetAgreement !== stability.extrema_set_agreement ||
    metrics.maxNormalizedRewardDrift !== stabilityDrift
  )
    throw new Error(`${location}.eligibility_metrics differ from duplicated score diagnostics`);
}

function validateHeldOut(value: unknown, location: string): [string, string] {
  const heldOut = object(value, location);
  exactKeys(heldOut, HELD_OUT_KEYS, location);
  const selected = string(heldOut.selectedAction, `${location}.selectedAction`);
  const alternative = string(heldOut.alternativeAction, `${location}.alternativeAction`);
  const estimate = finite(heldOut.value, `${location}.value`);
  const standardError = nullableFinite(heldOut.standardError, `${location}.standardError`);
  if (standardError !== null && standardError < 0) throw new Error(`${location}.standardError must be non-negative`);
  const lower = nullableFinite(heldOut.normalApproxLower95, `${location}.normalApproxLower95`);
  const expectedLower = standardError === null ? null : estimate - 1.96 * standardError;
  if (lower !== expectedLower)
    throw new Error(`${location}.normalApproxLower95 is inconsistent with its standard error`);
  return [selected, alternative];
}

interface ValidatedPanelShape {
  actions: string[];
  draws: number;
  opponentPopulation: number;
  opponentSlots: number;
  luckReplications: number;
}

function validateExhaustivePanel(
  value: unknown,
  id: 'stability-a' | 'stability-b' | 'measurement',
  legal: number,
  panelSeed: string,
  opponentLegalActions: readonly string[],
  location: string,
): ValidatedPanelShape {
  const panel = object(value, location);
  exactKeys(panel, PANEL_KEYS, location);
  if (panel.id !== id) throw new Error(`${location}.id must be ${id}`);
  const seedNamespace = string(panel.seedNamespace, `${location}.seedNamespace`);
  if (seedNamespace !== `${panelSeed}:panel:${id}`)
    throw new Error(`${location}.seedNamespace does not match its sealed panel seed`);
  const opponentPopulation = integer(panel.opponentPopulation, `${location}.opponentPopulation`, 1);
  const opponentSlots = integer(panel.opponentSlots, `${location}.opponentSlots`, 1);
  const luckReplications = integer(panel.luckReplications, `${location}.luckReplications`, 1);
  const expectedOpponentPopulation = opponentLegalActions.length || 1;
  if (opponentPopulation !== expectedOpponentPopulation)
    throw new Error(`${location}.opponentPopulation differs from its opponent request`);
  if (opponentSlots > opponentPopulation) throw new Error(`${location}.opponentSlots exceeds its population`);
  string(panel.matrixDigest, `${location}.matrixDigest`);
  if (finite(panel.span, `${location}.span`) < 0) throw new Error(`${location}.span must be non-negative`);

  if (!Array.isArray(panel.draws) || !panel.draws.length) throw new Error(`${location}.draws must be non-empty`);
  const draws = panel.draws;
  if (draws.length !== opponentSlots * luckReplications)
    throw new Error(`${location}.draws do not match opponent slots and luck replications`);
  for (const [drawIndex, raw] of draws.entries()) {
    const draw = object(raw, `${location}.draws[${drawIndex}]`);
    exactKeys(draw, DRAW_KEYS, `${location}.draws[${drawIndex}]`);
    if (integer(draw.index, `${location}.draws[${drawIndex}].index`) !== drawIndex)
      throw new Error(`${location}.draws must use contiguous zero-based indices`);
    if (draw.opponentAction !== null) string(draw.opponentAction, `${location}.draws[${drawIndex}].opponentAction`);
    if (!Array.isArray(draw.battleSeed) || draw.battleSeed.length !== 4)
      throw new Error(`${location}.draws[${drawIndex}].battleSeed must contain four words`);
    draw.battleSeed.forEach((word, wordIndex) => {
      const parsed = integer(word, `${location}.draws[${drawIndex}].battleSeed[${wordIndex}]`, 1);
      if (parsed > 0xffff) throw new Error(`${location}.draws[${drawIndex}].battleSeed[${wordIndex}] is too large`);
    });
    const continuationSeed = string(draw.continuationSeed, `${location}.draws[${drawIndex}].continuationSeed`);
    if (continuationSeed !== `${seedNamespace}:continuation:${drawIndex}`)
      throw new Error(`${location}.draws[${drawIndex}].continuationSeed does not match its panel`);
  }
  const sampledOpponentActions: (string | null)[] = [];
  for (let opponentIndex = 0; opponentIndex < opponentSlots; opponentIndex += 1) {
    const start = opponentIndex * luckReplications;
    const opponentAction = (draws[start] as JsonObject).opponentAction as string | null;
    const block = draws.slice(start, start + luckReplications) as JsonObject[];
    if (block.some((draw) => draw.opponentAction !== opponentAction))
      throw new Error(`${location}.draws opponentAction must be constant within each replication block`);
    sampledOpponentActions.push(opponentAction);
  }
  if (new Set(sampledOpponentActions).size !== sampledOpponentActions.length)
    throw new Error(`${location}.draws sampled opponent actions must be distinct`);
  const opponentLegal = new Set(opponentLegalActions);
  if (opponentLegal.size) {
    if (sampledOpponentActions.some((action) => action === null || !opponentLegal.has(action)))
      throw new Error(`${location}.draws do not match the snapshot-accepted opponent action set`);
  } else if (
    opponentPopulation !== 1 ||
    opponentSlots !== 1 ||
    sampledOpponentActions.length !== 1 ||
    sampledOpponentActions[0] !== null
  ) {
    throw new Error(`${location}.draws must use the unilateral null-opponent census design`);
  }
  const expectedPlan = exhaustivePanelDrawPlan({
    panelSeed,
    id,
    opponentLegalActions,
    opponentSlots,
    luckReplications,
  });
  if (seedNamespace !== expectedPlan.seedNamespace || canonicalJson(draws) !== canonicalJson(expectedPlan.draws))
    throw new Error(`${location}.draws do not match its deterministic panel draw plan`);

  if (!Array.isArray(panel.actions) || panel.actions.length !== legal)
    throw new Error(`${location}.actions must contain ${legal} legal actions`);
  const actions = panel.actions.map((raw, actionIndex) => {
    const action = object(raw, `${location}.actions[${actionIndex}]`);
    exactKeys(action, ACTION_VALUE_KEYS, `${location}.actions[${actionIndex}]`);
    const name = string(action.action, `${location}.actions[${actionIndex}].action`);
    finite(action.value, `${location}.actions[${actionIndex}].value`);
    const standardError = nullableFinite(action.standardError, `${location}.actions[${actionIndex}].standardError`);
    if (standardError !== null && standardError < 0)
      throw new Error(`${location}.actions[${actionIndex}].standardError must be non-negative`);
    if (integer(action.samples, `${location}.actions[${actionIndex}].samples`, 1) !== draws.length)
      throw new Error(`${location}.actions[${actionIndex}].samples must match its draws`);
    const reward = nullableFinite(action.reward, `${location}.actions[${actionIndex}].reward`);
    if (reward !== null && (reward < 0 || reward > 1))
      throw new Error(`${location}.actions[${actionIndex}].reward is outside [0, 1]`);
    return name;
  });

  if (!Array.isArray(panel.matrix) || panel.matrix.length !== draws.length)
    throw new Error(`${location}.matrix rows must match its draws`);
  panel.matrix.forEach((raw, drawIndex) => {
    if (!Array.isArray(raw) || raw.length !== legal)
      throw new Error(`${location}.matrix[${drawIndex}] must contain ${legal} action values`);
    raw.forEach((cell, actionIndex) => {
      finite(cell, `${location}.matrix[${drawIndex}][${actionIndex}]`);
    });
  });
  const matrix = panel.matrix as number[][];
  const derived = actions.map((action, actionIndex) => {
    const blocks = Array.from({ length: opponentSlots }, (_, opponentIndex) =>
      matrix
        .slice(opponentIndex * luckReplications, (opponentIndex + 1) * luckReplications)
        .map((row) => row[actionIndex] as number),
    );
    return { action, ...twoStageClusterEstimate(blocks, opponentPopulation) };
  });
  const values = derived.map((entry) => entry.value);
  const minimum = Math.min(...values);
  const maximum = Math.max(...values);
  const span = maximum - minimum;
  if (panel.span !== span) throw new Error(`${location}.span does not match its matrix`);
  for (const [actionIndex, expected] of derived.entries()) {
    const recorded = panel.actions[actionIndex] as JsonObject;
    const reward = span > 0 ? (expected.value - minimum) / span : null;
    if (
      recorded.value !== expected.value ||
      recorded.standardError !== expected.standardError ||
      recorded.samples !== draws.length ||
      recorded.reward !== reward
    )
      throw new Error(`${location}.actions[${actionIndex}] does not match its matrix estimate`);
  }
  const expectedDigest = exhaustivePanelMatrixDigest({
    id,
    seedNamespace,
    opponentPopulation,
    opponentSlots,
    luckReplications,
    draws: draws as unknown as ExhaustiveDraw[],
    actions,
    matrix,
  });
  if (panel.matrixDigest !== expectedDigest) throw new Error(`${location}.matrixDigest does not match its panel`);
  return { actions, draws: draws.length, opponentPopulation, opponentSlots, luckReplications };
}

function validateExhaustiveTable(
  value: unknown,
  sourcePid: string,
  sourcePlayed: string,
  panelSeed: string,
  opponentLegalActions: readonly string[],
  sourceLegalActions: readonly string[],
  location: string,
): void {
  const table = object(value, location);
  exactKeys(table, TABLE_KEYS, location);
  if (!['p1', 'p2'].includes(String(table.pid))) throw new Error(`${location}.pid is invalid`);
  if (table.pid !== sourcePid) throw new Error(`${location}.pid differs from its source`);
  integer(table.turn, `${location}.turn`);
  const legal = integer(table.legal, `${location}.legal`, 2);
  if (table.horizon !== 'end') integer(table.horizon, `${location}.horizon`);
  finite(table.stateValue, `${location}.stateValue`);
  const selectionBest = string(table.selectionBest, `${location}.selectionBest`);
  const measurementBest = string(table.measurementBest, `${location}.measurementBest`);
  if (typeof table.rankingStable !== 'boolean' || typeof table.anchorAgreement !== 'boolean')
    throw new Error(`${location} agreement fields must be booleans`);
  if (finite(table.valueSpan, `${location}.valueSpan`) < 0)
    throw new Error(`${location}.valueSpan must be non-negative`);
  const heldOutActions = [
    ...validateHeldOut(table.heldOutGap, `${location}.heldOutGap`),
    ...validateHeldOut(table.heldOutSpan, `${location}.heldOutSpan`),
  ];
  const drift = nullableFinite(table.maxNormalizedRewardDrift, `${location}.maxNormalizedRewardDrift`);
  if (drift !== null && (drift < 0 || drift > 1))
    throw new Error(`${location}.maxNormalizedRewardDrift must be in [0, 1]`);
  if (!Array.isArray(table.stability) || table.stability.length !== 2)
    throw new Error(`${location}.stability must contain two panels`);
  const panels = [
    validateExhaustivePanel(
      table.stability[0],
      'stability-a',
      legal,
      panelSeed,
      opponentLegalActions,
      `${location}.stability[0]`,
    ),
    validateExhaustivePanel(
      table.stability[1],
      'stability-b',
      legal,
      panelSeed,
      opponentLegalActions,
      `${location}.stability[1]`,
    ),
    validateExhaustivePanel(
      table.measurement,
      'measurement',
      legal,
      panelSeed,
      opponentLegalActions,
      `${location}.measurement`,
    ),
  ] as const;
  const actions = panels[0].actions;
  if (new Set(actions).size !== legal) throw new Error(`${location} legal actions must be unique`);
  if (canonicalJson(actions) !== canonicalJson(sourceLegalActions)) {
    throw new Error(`${location} actions do not match the snapshot-accepted source action set`);
  }
  if (panels.slice(1).some((panel) => canonicalJson(panel.actions) !== canonicalJson(actions)))
    throw new Error(`${location} panels differ in their legal actions`);
  const samplingDesign = (panel: ValidatedPanelShape) => ({
    draws: panel.draws,
    opponentPopulation: panel.opponentPopulation,
    opponentSlots: panel.opponentSlots,
    luckReplications: panel.luckReplications,
  });
  if (
    panels.slice(1).some((panel) => canonicalJson(samplingDesign(panel)) !== canonicalJson(samplingDesign(panels[0])))
  )
    throw new Error(`${location} panels differ in their matrix dimensions or sampling design`);
  const legalActions = new Set(actions);
  if (!legalActions.has(sourcePlayed)) throw new Error(`${location} source.played is not one of its legal actions`);
  for (const action of [selectionBest, measurementBest, ...heldOutActions]) {
    if (!legalActions.has(action)) throw new Error(`${location} references a non-legal action ${action}`);
  }
  const stabilityA = table.stability[0] as JsonObject;
  const stabilityB = table.stability[1] as JsonObject;
  const measurement = table.measurement as JsonObject;
  const ranked = (panel: JsonObject) =>
    [...(panel.actions as JsonObject[])].sort(
      (a, b) =>
        Number(b.value) - Number(a.value) ||
        Buffer.compare(Buffer.from(String(a.action)), Buffer.from(String(b.action))),
    );
  const selected = String(ranked(stabilityA)[0]?.action);
  const worst = String(ranked(stabilityA).at(-1)?.action);
  const alternative = String(ranked(stabilityB).find((entry) => entry.action !== selected)?.action);
  const measuredBest = String(ranked(measurement)[0]?.action);
  if (selectionBest !== selected || measurementBest !== measuredBest)
    throw new Error(`${location} best-action fields do not match their panels`);
  const stabilityBest = String(ranked(stabilityB)[0]?.action);
  if (table.rankingStable !== (selected === stabilityBest))
    throw new Error(`${location}.rankingStable is inconsistent`);
  const paired = (first: string, second: string) => {
    const firstIndex = actions.indexOf(first);
    const secondIndex = actions.indexOf(second);
    const matrix = stabilityB.matrix as number[][];
    const slots = Number(stabilityB.opponentSlots);
    const replications = Number(stabilityB.luckReplications);
    const differences = matrix.map((row) => (row[firstIndex] as number) - (row[secondIndex] as number));
    const blocks = Array.from({ length: slots }, (_, slot) =>
      differences.slice(slot * replications, (slot + 1) * replications),
    );
    const estimate = twoStageClusterEstimate(blocks, Number(stabilityB.opponentPopulation));
    return {
      selectedAction: first,
      alternativeAction: second,
      value: estimate.value,
      standardError: estimate.standardError,
      normalApproxLower95: estimate.standardError === null ? null : estimate.value - 1.96 * estimate.standardError,
    };
  };
  if (canonicalJson(table.heldOutGap) !== canonicalJson(paired(selected, alternative)))
    throw new Error(`${location}.heldOutGap does not match its paired panel estimate`);
  if (canonicalJson(table.heldOutSpan) !== canonicalJson(paired(selected, worst)))
    throw new Error(`${location}.heldOutSpan does not match its paired panel estimate`);
  const anchors = (panel: JsonObject) => {
    const entries = panel.actions as JsonObject[];
    const values = entries.map((entry) => Number(entry.value));
    const minimum = Math.min(...values);
    const maximum = Math.max(...values);
    return {
      best: entries
        .filter((entry) => entry.value === maximum)
        .map((entry) => entry.action)
        .sort((a, b) => Buffer.compare(Buffer.from(String(a)), Buffer.from(String(b)))),
      worst: entries
        .filter((entry) => entry.value === minimum)
        .map((entry) => entry.action)
        .sort((a, b) => Buffer.compare(Buffer.from(String(a)), Buffer.from(String(b)))),
    };
  };
  if (table.anchorAgreement !== (canonicalJson(anchors(stabilityA)) === canonicalJson(anchors(stabilityB))))
    throw new Error(`${location}.anchorAgreement is inconsistent`);
  const firstRewards = (stabilityA.actions as JsonObject[]).map((entry) => entry.reward);
  const secondRewards = (stabilityB.actions as JsonObject[]).map((entry) => entry.reward);
  const expectedDrift =
    firstRewards.every((value) => typeof value === 'number') &&
    secondRewards.every((value) => typeof value === 'number')
      ? Math.max(...firstRewards.map((value, index) => Math.abs(Number(value) - Number(secondRewards[index]))))
      : null;
  if (table.maxNormalizedRewardDrift !== expectedDrift)
    throw new Error(`${location}.maxNormalizedRewardDrift is inconsistent`);
  if (table.valueSpan !== measurement.span) throw new Error(`${location}.valueSpan differs from measurement`);
}

function validateSealedPositionPanel(row: JsonObject, index = 0, psDir = defaultPsDir()): void {
  const location = `sealed[${index}]`;
  exactKeys(row, SEALED_KEYS, location);
  if (row.schema_version !== POSITION_PANEL_ARTIFACT_SCHEMA_VERSION)
    throw new Error(`${location} has unsupported schema version`);
  for (const key of ['task_id', 'source_id', 'exact_public_fingerprint'] as const)
    string(row[key], `${location}.${key}`);
  const panelSeed = string(row.panel_seed, `${location}.panel_seed`);
  const source = object(row.source, `${location}.source`);
  exactKeys(source, SOURCE_KEYS, `${location}.source`);
  for (const key of ['run_id', 'series_id', 'scaffold', 'played_by', 'played'] as const)
    string(source[key], `${location}.source.${key}`);
  integer(source.game_number, `${location}.source.game_number`, 1);
  integer(source.position_index, `${location}.source.position_index`);
  if (!['p1', 'p2'].includes(String(source.pid))) throw new Error(`${location}.source.pid is invalid`);
  const snapshot = string(row.snapshot, `${location}.snapshot`);
  let parsedSnapshot: JsonObject;
  try {
    parsedSnapshot = object(JSON.parse(snapshot), `${location}.snapshot JSON`);
  } catch {
    throw new Error(`${location}.snapshot must contain a JSON object`);
  }
  const opponentRequest =
    row.opponent_request === null ? null : object(row.opponent_request, `${location}.opponent_request`);
  const controlledPid = String(source.pid) as Pid;
  const opponentPid: Pid = controlledPid === 'p1' ? 'p2' : 'p1';
  let sourceLegalActions: string[];
  let opponentLegalActions: string[] = [];
  try {
    const { Battle } = loadShowdown(psDir);
    const battle = Battle.fromJSON(structuredClone(parsedSnapshot));
    battle.restart(() => {});
    const pending = pendingSides(battle);
    if (!pending.includes(controlledPid)) throw new Error('snapshot does not have the source decision');
    sourceLegalActions = acceptedBattleActionEntries(battle, controlledPid).map((entry) => entry.command);
    const hasOpponentDecision = pending.includes(opponentPid);
    if (hasOpponentDecision !== Boolean(opponentRequest)) {
      throw new Error('opponent_request presence does not match the snapshot decision boundary');
    }
    if (opponentRequest) {
      const authoritativeRequest = battle.getSide(opponentPid).activeRequest as unknown as BattleRequest | null;
      if (!authoritativeRequest || canonicalJson(authoritativeRequest) !== canonicalJson(opponentRequest)) {
        throw new Error('opponent_request does not match the snapshot');
      }
      opponentLegalActions = acceptedBattleActionEntries(battle, opponentPid).map((entry) => entry.command);
    }
  } catch (error) {
    throw new Error(
      `${location} cannot validate its action sets against the snapshot: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  if (sourceLegalActions.length < 2) {
    throw new Error(`${location}.snapshot source has fewer than two Showdown-accepted request-derived actions`);
  }
  if (opponentRequest && !opponentLegalActions.length) {
    throw new Error(`${location}.snapshot opponent has no Showdown-accepted request-derived action`);
  }

  validateExhaustiveTable(
    row.table,
    String(source.pid),
    String(source.played),
    panelSeed,
    opponentLegalActions,
    sourceLegalActions,
    `${location}.table`,
  );
}

export function validatePositionPanelArtifacts(
  tasks: JsonObject[],
  scores: JsonObject[],
  sealed: JsonObject[],
  psDir = defaultPsDir(),
): void {
  if (tasks.length !== scores.length || tasks.length !== sealed.length)
    throw new Error('task, score, and sealed row counts differ');
  const scoreById = new Map<string, JsonObject>();
  const sealedById = new Map<string, JsonObject>();
  const sourceIds = new Set<string>();
  scores.forEach((row, index) => {
    validatePrivatePositionScore(row, index);
    const id = String(row.task_id);
    if (scoreById.has(id)) throw new Error(`duplicate score task_id ${id}`);
    scoreById.set(id, row);
  });
  sealed.forEach((row, index) => {
    validateSealedPositionPanel(row, index, psDir);
    const id = String(row.task_id);
    if (sealedById.has(id)) throw new Error(`duplicate sealed task_id ${id}`);
    const sourceId = String(row.source_id);
    if (sourceIds.has(sourceId)) throw new Error(`duplicate sealed source_id ${sourceId}`);
    sourceIds.add(sourceId);
    sealedById.set(id, row);
  });
  const taskIds = new Set<string>();
  tasks.forEach((row, index) => {
    validatePublicPositionTask(row, index);
    const id = String(row.task_id);
    if (taskIds.has(id)) throw new Error(`duplicate public task_id ${id}`);
    taskIds.add(id);
    const score = scoreById.get(id);
    const sealedRow = sealedById.get(id);
    if (!score || !sealedRow) throw new Error(`task ${id} has no exact private and sealed join`);
    if (sealedRow.exact_public_fingerprint !== exactPublicPositionFingerprint(row))
      throw new Error(`task ${id} does not match its sealed public fingerprint`);
    const table = sealedRow.table as unknown as ExhaustiveActionTable;
    const source = sealedRow.source as JsonObject;
    if (row.turn !== table.turn || source.pid !== table.pid)
      throw new Error(`task ${id} differs from its sealed position`);
    const expectedStructuralReasons = table.stability.some((panel) => panel.span <= 0)
      ? ['zero_qualification_span']
      : [];
    if (
      canonicalJson(score.structural_reasons) !== canonicalJson(expectedStructuralReasons) ||
      score.structural_pass !== (expectedStructuralReasons.length === 0)
    )
      throw new Error(`score ${id} has inconsistent qualification structure`);
    if (score.measurement_ready !== table.measurement.span > 0)
      throw new Error(`score ${id} has inconsistent measurement readiness`);
    const expectedDiagnosticFlags = [
      ...(table.heldOutSpan.normalApproxLower95 !== null && table.heldOutSpan.normalApproxLower95 <= 0
        ? ['normal_approx_span_crosses_zero']
        : []),
      ...(!table.rankingStable ? ['best_anchor_unstable'] : []),
      ...(!table.anchorAgreement ? ['extrema_sets_unstable'] : []),
    ];
    if (canonicalJson(score.diagnostic_flags) !== canonicalJson(expectedDiagnosticFlags))
      throw new Error(`score ${id} has inconsistent diagnostic flags`);
    if (canonicalJson(score.eligibility_metrics) !== canonicalJson(positionEligibilityMetrics(table)))
      throw new Error(`score ${id} eligibility metrics differ from its sealed panels`);
    const measurementActions = table.measurement.actions;
    const values = measurementActions.map((entry) => entry.value);
    const minimum = Math.min(...values);
    const maximum = Math.max(...values);
    if (score.min_value !== minimum || score.max_value !== maximum || score.span !== maximum - minimum)
      throw new Error(`score ${id} measurement extrema differ from its sealed panel`);
    const measurementPanel = score.measurement_panel as JsonObject;
    if (
      measurementPanel.id !== table.measurement.id ||
      measurementPanel.n !== table.measurement.draws.length ||
      measurementPanel.matrix_digest !== table.measurement.matrixDigest
    )
      throw new Error(`score ${id} measurement identity differs from its sealed panel`);
    const measurementByAction = new Map(measurementActions.map((entry) => [entry.action, entry]));
    for (const [actionIndex, action] of (score.actions as JsonObject[]).entries()) {
      const measured = measurementByAction.get(String(action.canonical_action));
      if (
        !measured ||
        action.mean_value !== measured.value ||
        action.standard_error !== measured.standardError ||
        action.n !== measured.samples ||
        action.normalized_reward !== measured.reward
      )
        throw new Error(`score ${id} action ${actionIndex} differs from its sealed measurement`);
    }
    const stability = score.stability as JsonObject;
    if (
      canonicalJson(stability.matrix_digests) !== canonicalJson(table.stability.map((panel) => panel.matrixDigest)) ||
      canonicalJson(stability.spans) !== canonicalJson(table.stability.map((panel) => panel.span)) ||
      stability.best_anchor_agreement !== table.rankingStable ||
      stability.extrema_set_agreement !== table.anchorAgreement ||
      stability.max_normalized_reward_drift !== table.maxNormalizedRewardDrift ||
      canonicalJson(stability.held_out_span) !== canonicalJson(table.heldOutSpan)
    )
      throw new Error(`score ${id} stability diagnostics differ from its sealed panels`);
    validateTaskScoreJoin(
      (row.actions as JsonObject[]).map((action) => ({
        number: Number(action.number),
        canonicalAction: String(action.canonical_action),
        label: String(action.label),
      })),
      (score.actions as JsonObject[]).map((action) => ({
        number: Number(action.number),
        canonicalAction: String(action.canonical_action),
        normalizedReward: action.normalized_reward === null ? null : Number(action.normalized_reward),
      })),
    );
  });
  for (const id of scoreById.keys()) if (!taskIds.has(id)) throw new Error(`private task ${id} has no public join`);
}
