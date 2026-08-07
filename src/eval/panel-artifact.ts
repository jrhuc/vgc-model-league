import type { JsonObject } from '../types.js';
import { POSITION_ELIGIBILITY_METRICS_VERSION } from './eligibility.js';
import { canonicalJson } from './serialization.js';
import { validateTaskScoreJoin } from './task.js';

const TASK_KEYS = [
  'actions',
  'format',
  'phase',
  'prompt',
  'response_schema',
  'schema_version',
  'split',
  'task_id',
  'turn',
];
const SCORE_KEYS = [
  'actions',
  'diagnostic_flags',
  'eligibility_metrics',
  'eligibility_status',
  'max_value',
  'measurement_panel',
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
  'source_group',
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
const PANEL_KEYS = ['actions', 'draws', 'id', 'matrix', 'matrixDigest', 'seedNamespace', 'span'];
const DRAW_KEYS = ['battleSeed', 'continuationSeed', 'index', 'opponentAction'];
const ACTION_VALUE_KEYS = ['action', 'reward', 'samples', 'standardError', 'value'];
const HELD_OUT_KEYS = ['alternativeAction', 'lower95', 'selectedAction', 'standardError', 'value'];

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

export function validatePublicPositionTask(row: JsonObject, index = 0): void {
  const location = `task[${index}]`;
  exactKeys(row, TASK_KEYS, location);
  if (row.schema_version !== 1) throw new Error(`${location} has unsupported schema version`);
  string(row.task_id, `${location}.task_id`);
  string(row.format, `${location}.format`);
  if (!['pilot', 'train', 'eval'].includes(String(row.split))) throw new Error(`${location}.split is invalid`);
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
    string(action.label, `${location}.actions[${actionIndex}].label`);
  }
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

function validateEligibilityMetrics(value: unknown, location: string): void {
  const metrics = object(value, location);
  exactKeys(
    metrics,
    [
      'bestAnchorAgreement',
      'drawsPerPanel',
      'extremaSetAgreement',
      'heldOutSpanLower95',
      'heldOutSpanSignalToNoise',
      'heldOutSpanStandardError',
      'heldOutSpanValue',
      'legalActions',
      'maxMeasurementNormalizedStandardError',
      'maxNormalizedRewardDrift',
      'stabilityRankCorrelation',
      'version',
    ],
    location,
  );
  if (metrics.version !== POSITION_ELIGIBILITY_METRICS_VERSION) throw new Error(`${location}.version is unsupported`);
  integer(metrics.legalActions, `${location}.legalActions`, 1);
  if (!Array.isArray(metrics.drawsPerPanel) || metrics.drawsPerPanel.length !== 3)
    throw new Error(`${location}.drawsPerPanel must contain three panels`);
  metrics.drawsPerPanel.forEach((entry, index) => {
    integer(entry, `${location}.drawsPerPanel[${index}]`, 1);
  });
  finite(metrics.heldOutSpanValue, `${location}.heldOutSpanValue`);
  finite(metrics.heldOutSpanStandardError, `${location}.heldOutSpanStandardError`);
  finite(metrics.heldOutSpanLower95, `${location}.heldOutSpanLower95`);
  nullableFinite(metrics.heldOutSpanSignalToNoise, `${location}.heldOutSpanSignalToNoise`);
  nullableFinite(metrics.stabilityRankCorrelation, `${location}.stabilityRankCorrelation`);
  nullableFinite(metrics.maxNormalizedRewardDrift, `${location}.maxNormalizedRewardDrift`);
  nullableFinite(metrics.maxMeasurementNormalizedStandardError, `${location}.maxMeasurementNormalizedStandardError`);
  if (typeof metrics.bestAnchorAgreement !== 'boolean' || typeof metrics.extremaSetAgreement !== 'boolean')
    throw new Error(`${location} anchor fields must be booleans`);
}

export function validatePrivatePositionScore(row: JsonObject, index = 0): void {
  const location = `score[${index}]`;
  exactKeys(row, SCORE_KEYS, location);
  if (row.schema_version !== 1) throw new Error(`${location} has unsupported schema version`);
  string(row.task_id, `${location}.task_id`);
  if (typeof row.structural_pass !== 'boolean') throw new Error(`${location}.structural_pass must be boolean`);
  strings(row.structural_reasons, `${location}.structural_reasons`);
  strings(row.diagnostic_flags, `${location}.diagnostic_flags`);
  string(row.eligibility_status, `${location}.eligibility_status`);
  validateEligibilityMetrics(row.eligibility_metrics, `${location}.eligibility_metrics`);
  const panel = object(row.measurement_panel, `${location}.measurement_panel`);
  exactKeys(panel, ['id', 'matrix_digest', 'n'], `${location}.measurement_panel`);
  string(panel.id, `${location}.measurement_panel.id`);
  integer(panel.n, `${location}.measurement_panel.n`, 1);
  string(panel.matrix_digest, `${location}.measurement_panel.matrix_digest`);
  finite(row.min_value, `${location}.min_value`);
  finite(row.max_value, `${location}.max_value`);
  finite(row.span, `${location}.span`);
  if (!Array.isArray(row.actions) || !row.actions.length) throw new Error(`${location}.actions must be non-empty`);
  for (const [actionIndex, raw] of row.actions.entries()) {
    const action = object(raw, `${location}.actions[${actionIndex}]`);
    exactKeys(
      action,
      ['canonical_action', 'mean_value', 'n', 'normalized_reward', 'number', 'standard_error'],
      `${location}.actions[${actionIndex}]`,
    );
    integer(action.number, `${location}.actions[${actionIndex}].number`);
    string(action.canonical_action, `${location}.actions[${actionIndex}].canonical_action`);
    finite(action.mean_value, `${location}.actions[${actionIndex}].mean_value`);
    finite(action.standard_error, `${location}.actions[${actionIndex}].standard_error`);
    integer(action.n, `${location}.actions[${actionIndex}].n`, 1);
    const reward = nullableFinite(action.normalized_reward, `${location}.actions[${actionIndex}].normalized_reward`);
    if (reward !== null && (reward < 0 || reward > 1))
      throw new Error(`${location}.actions[${actionIndex}] reward is outside [0, 1]`);
  }
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
    finite(entry, `${location}.stability.spans[${panelIndex}]`);
  });
  nullableFinite(stability.max_normalized_reward_drift, `${location}.stability.max_normalized_reward_drift`);
  const heldOut = object(stability.held_out_span, `${location}.stability.held_out_span`);
  exactKeys(
    heldOut,
    ['alternativeAction', 'lower95', 'selectedAction', 'standardError', 'value'],
    `${location}.stability.held_out_span`,
  );
  string(heldOut.selectedAction, `${location}.stability.held_out_span.selectedAction`);
  string(heldOut.alternativeAction, `${location}.stability.held_out_span.alternativeAction`);
  finite(heldOut.value, `${location}.stability.held_out_span.value`);
  finite(heldOut.standardError, `${location}.stability.held_out_span.standardError`);
  finite(heldOut.lower95, `${location}.stability.held_out_span.lower95`);
}

function validateHeldOut(value: unknown, location: string): [string, string] {
  const heldOut = object(value, location);
  exactKeys(heldOut, HELD_OUT_KEYS, location);
  const selected = string(heldOut.selectedAction, `${location}.selectedAction`);
  const alternative = string(heldOut.alternativeAction, `${location}.alternativeAction`);
  finite(heldOut.value, `${location}.value`);
  if (finite(heldOut.standardError, `${location}.standardError`) < 0)
    throw new Error(`${location}.standardError must be non-negative`);
  finite(heldOut.lower95, `${location}.lower95`);
  return [selected, alternative];
}

function validateExhaustivePanel(
  value: unknown,
  id: string,
  legal: number,
  location: string,
): { actions: string[]; draws: number } {
  const panel = object(value, location);
  exactKeys(panel, PANEL_KEYS, location);
  if (panel.id !== id) throw new Error(`${location}.id must be ${id}`);
  string(panel.seedNamespace, `${location}.seedNamespace`);
  string(panel.matrixDigest, `${location}.matrixDigest`);
  if (finite(panel.span, `${location}.span`) < 0) throw new Error(`${location}.span must be non-negative`);

  if (!Array.isArray(panel.draws) || !panel.draws.length) throw new Error(`${location}.draws must be non-empty`);
  const draws = panel.draws;
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
    string(draw.continuationSeed, `${location}.draws[${drawIndex}].continuationSeed`);
  }

  if (!Array.isArray(panel.actions) || panel.actions.length !== legal)
    throw new Error(`${location}.actions must contain ${legal} legal actions`);
  const actions = panel.actions.map((raw, actionIndex) => {
    const action = object(raw, `${location}.actions[${actionIndex}]`);
    exactKeys(action, ACTION_VALUE_KEYS, `${location}.actions[${actionIndex}]`);
    const name = string(action.action, `${location}.actions[${actionIndex}].action`);
    finite(action.value, `${location}.actions[${actionIndex}].value`);
    if (finite(action.standardError, `${location}.actions[${actionIndex}].standardError`) < 0)
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
  return { actions, draws: draws.length };
}

function validateExhaustiveTable(value: unknown, sourcePid: string, location: string): void {
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
  if (drift !== null && drift < 0) throw new Error(`${location}.maxNormalizedRewardDrift must be non-negative`);
  if (!Array.isArray(table.stability) || table.stability.length !== 2)
    throw new Error(`${location}.stability must contain two panels`);
  const panels = [
    validateExhaustivePanel(table.stability[0], 'stability-a', legal, `${location}.stability[0]`),
    validateExhaustivePanel(table.stability[1], 'stability-b', legal, `${location}.stability[1]`),
    validateExhaustivePanel(table.measurement, 'measurement', legal, `${location}.measurement`),
  ] as const;
  const actions = panels[0].actions;
  if (new Set(actions).size !== legal) throw new Error(`${location} legal actions must be unique`);
  if (panels.slice(1).some((panel) => canonicalJson(panel.actions) !== canonicalJson(actions)))
    throw new Error(`${location} panels differ in their legal actions`);
  if (panels.slice(1).some((panel) => panel.draws !== panels[0].draws))
    throw new Error(`${location} panels differ in their matrix dimensions`);
  const legalActions = new Set(actions);
  for (const action of [selectionBest, measurementBest, ...heldOutActions]) {
    if (!legalActions.has(action)) throw new Error(`${location} references a non-legal action ${action}`);
  }
}

export function validateSealedPositionPanel(row: JsonObject, index = 0): void {
  const location = `sealed[${index}]`;
  exactKeys(row, SEALED_KEYS, location);
  if (row.schema_version !== 1) throw new Error(`${location} has unsupported schema version`);
  for (const key of ['task_id', 'source_id', 'source_group', 'exact_public_fingerprint'] as const)
    string(row[key], `${location}.${key}`);
  string(row.panel_seed, `${location}.panel_seed`);
  const source = object(row.source, `${location}.source`);
  exactKeys(source, SOURCE_KEYS, `${location}.source`);
  for (const key of ['run_id', 'series_id', 'scaffold', 'played_by', 'played'] as const)
    string(source[key], `${location}.source.${key}`);
  integer(source.game_number, `${location}.source.game_number`, 1);
  integer(source.position_index, `${location}.source.position_index`);
  if (!['p1', 'p2'].includes(String(source.pid))) throw new Error(`${location}.source.pid is invalid`);
  const snapshot = string(row.snapshot, `${location}.snapshot`);
  try {
    object(JSON.parse(snapshot), `${location}.snapshot JSON`);
  } catch {
    throw new Error(`${location}.snapshot must contain a JSON object`);
  }
  if (row.opponent_request !== null) object(row.opponent_request, `${location}.opponent_request`);
  validateExhaustiveTable(row.table, String(source.pid), `${location}.table`);
}

export function validatePositionPanelArtifacts(tasks: JsonObject[], scores: JsonObject[], sealed: JsonObject[]): void {
  if (tasks.length !== scores.length || tasks.length !== sealed.length)
    throw new Error('task, score, and sealed row counts differ');
  const scoreById = new Map<string, JsonObject>();
  const sealedById = new Map<string, JsonObject>();
  scores.forEach((row, index) => {
    validatePrivatePositionScore(row, index);
    const id = String(row.task_id);
    if (scoreById.has(id)) throw new Error(`duplicate score task_id ${id}`);
    scoreById.set(id, row);
  });
  sealed.forEach((row, index) => {
    validateSealedPositionPanel(row, index);
    const id = String(row.task_id);
    if (sealedById.has(id)) throw new Error(`duplicate sealed task_id ${id}`);
    sealedById.set(id, row);
  });
  const taskIds = new Set<string>();
  tasks.forEach((row, index) => {
    validatePublicPositionTask(row, index);
    const id = String(row.task_id);
    if (taskIds.has(id)) throw new Error(`duplicate public task_id ${id}`);
    taskIds.add(id);
    const score = scoreById.get(id);
    if (!score || !sealedById.has(id)) throw new Error(`task ${id} has no exact private and sealed join`);
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
