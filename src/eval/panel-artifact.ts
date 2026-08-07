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

export function validateSealedPositionPanel(row: JsonObject, index = 0): void {
  const location = `sealed[${index}]`;
  exactKeys(row, SEALED_KEYS, location);
  if (row.schema_version !== 1) throw new Error(`${location} has unsupported schema version`);
  for (const key of ['task_id', 'source_id', 'source_group', 'exact_public_fingerprint'] as const)
    string(row[key], `${location}.${key}`);
  string(row.panel_seed, `${location}.panel_seed`);
  object(row.source, `${location}.source`);
  string(row.snapshot, `${location}.snapshot`);
  if (row.opponent_request !== null) object(row.opponent_request, `${location}.opponent_request`);
  object(row.table, `${location}.table`);
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
