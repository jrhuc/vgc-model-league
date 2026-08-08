import type { JsonObject } from '../types.js';
import { COUNTERFACTUAL_PROTOCOL_VERSION, EXHAUSTIVE_PANEL_PROTOCOL, REFERENCE } from './counterfactual.js';
import { NEAR_DUPLICATE_PROTOCOL } from './duplicates.js';
import {
  POSITION_ELIGIBILITY_METRICS_VERSION,
  type PositionEligibilityPolicy,
  validatePositionEligibilityPolicy,
} from './eligibility.js';
import { ACTION_PROTOCOL } from './fork.js';
import { POSITION_SOURCE_GROUP_PROTOCOL } from './panel-artifact.js';
import { CANONICAL_JSON_PROTOCOL, canonicalJson, canonicalJsonDigest } from './serialization.js';
import { POSITION_TASK_PROTOCOL } from './task.js';

export const PILOT_POSITION_MANIFEST_V2_KEYS = [
  'action_protocol',
  'canonical_json',
  'counterfactual',
  'eligibility_metrics_version',
  'eligibility_status',
  'evaluator_digest',
  'exhaustive_panels',
  'inputs',
  'ordered_task_ids',
  'outputs',
  'release_ready',
  'runtime',
  'schema_version',
  'seed_namespace',
  'showdown_commit',
  'source_group_protocol',
  'source_set_id',
  'split_status',
  'task_protocol',
] as const;

export const PILOT_POSITION_ELIGIBILITY_STATUS = 'pilot-thresholds-not-frozen' as const;
export const PILOT_POSITION_SPLIT_STATUS = 'pilot-only-source-groups-and-exact-fingerprints-recorded' as const;

export const FROZEN_POSITION_RELEASE_GATES = [
  'horizon-sensitivity',
  'hidden-information-treatment',
  'criterion-validation',
  'calibration-candidate-semantic-near-duplicate-separation-audit',
  'package-smoke-tests',
] as const;

export const FROZEN_CALIBRATION_CANDIDATE_SEPARATION = {
  exact_checks: [
    'manifest-sha256-non-identical',
    'source-set-id-non-identical',
    'whole-input-digest-tuple-non-identical',
    'ordered-task-id-sets-non-overlapping',
  ],
  semantic_near_duplicate_separation: 'not-auditable-from-pilot-manifests-release-gate-required',
} as const;

export const FROZEN_POSITION_EXCLUSION_PROTOCOL = {
  version: 2,
  rowSchemaVersion: 2,
  keys: ['reasons', 'schema_version', 'task_id'],
  taskId: 'nonempty-trimmed-string',
  reasons: 'nonempty-array-of-nonempty-trimmed-strings-preserve-order',
} as const;

export const FROZEN_POSITION_MANIFEST_V2_KEYS = [
  'calibration_candidate_separation',
  'canonical_json',
  'counts',
  'exclusion_row_protocol',
  'inputs',
  'near_duplicate_protocol',
  'ordered_eval_task_ids',
  'ordered_train_task_ids',
  'outputs',
  'policy',
  'policy_canonical_digest',
  'release_ready',
  'remaining_release_gates',
  'runtime',
  'schema_version',
  'split_balance',
  'split_digest',
  'splitter_digest',
  'status',
  'upstream_calibration_manifest',
  'upstream_pilot_manifest',
] as const;

export const FROZEN_POSITION_MANIFEST_STATUS = 'candidate-splits-frozen-not-release-approved' as const;

export interface PositionManifestRuntimeV2 {
  node: string;
  platform: string;
  arch: string;
}

export interface PositionArtifactBindingV2 {
  sha256: string;
  rows: number;
}

export interface PositionFileArtifactBindingV2 extends PositionArtifactBindingV2 {
  file: string;
}

export interface PilotPositionManifestV2View {
  sourceSetId: string;
  evaluatorDigest: string;
  runtime: PositionManifestRuntimeV2;
  showdownCommit: string;
  seedNamespace: string;
  actionProtocol: JsonObject;
  taskProtocol: JsonObject;
  canonicalJsonProtocol: JsonObject;
  counterfactualProtocol: JsonObject;
  exhaustivePanelsProtocol: JsonObject;
  eligibilityMetricsVersion: typeof POSITION_ELIGIBILITY_METRICS_VERSION;
  sourceGroupProtocol: JsonObject;
  inputDigests: { publicSet: string; privateSet: string };
  outputs: {
    tasks: PositionFileArtifactBindingV2;
    scores: PositionArtifactBindingV2;
    sealedPanels: PositionArtifactBindingV2;
  };
  orderedTaskIds: string[];
}

export type PositionSplitFreezePolicyV2 = JsonObject & {
  schema_version: 2;
  status: 'frozen';
  policy_id: string;
  calibration_manifest_sha256: string;
  seed: string;
  eval_fraction: number;
  near_duplicate_threshold: number;
  max_eval_fraction_deviation: number;
  max_stratum_eval_fraction_deviation: number;
  eligibility: PositionEligibilityPolicy;
};

export interface FrozenPositionUpstreamV2 {
  sha256: string;
  sourceSetId: string;
  evaluatorDigest: string;
  runtime: PositionManifestRuntimeV2;
  showdownCommit: string;
  actionProtocol: JsonObject;
  taskProtocol: JsonObject;
  counterfactualProtocol: JsonObject;
  exhaustivePanelsProtocol: JsonObject;
  sourceGroupProtocol: JsonObject;
  seedNamespace: string;
}

export interface FrozenPositionCountsV2 {
  input: number;
  eligible: number;
  excluded: number;
  train: number;
  eval: number;
  sourceGroups: number;
  duplicateClusters: number;
  nearDuplicatePairs: number;
}

export interface FrozenPositionSplitBalanceV2 {
  evalFraction: number;
  evalFractionDeviation: number;
  strata: Record<string, { total: number; eval: number; evalFraction: number; deviation: number }>;
  maxStratumDeviation: number;
}

export interface FrozenPositionManifestV2View {
  status: typeof FROZEN_POSITION_MANIFEST_STATUS;
  releaseGates: Array<(typeof FROZEN_POSITION_RELEASE_GATES)[number]>;
  runtime: PositionManifestRuntimeV2;
  splitterDigest: string;
  splitDigest: string;
  policyCanonicalDigest: string;
  policy: PositionSplitFreezePolicyV2;
  upstreamPilot: FrozenPositionUpstreamV2;
  upstreamCalibration: FrozenPositionUpstreamV2;
  canonicalJsonProtocol: JsonObject;
  nearDuplicateProtocol: JsonObject;
  exclusionRowProtocol: JsonObject;
  calibrationCandidateSeparation: JsonObject;
  inputs: {
    tasks: string;
    scores: string;
    sealed: string;
    pilotManifest: string;
    calibrationManifest: string;
    policyFile: string;
  };
  counts: FrozenPositionCountsV2;
  splitBalance: FrozenPositionSplitBalanceV2;
  outputs: {
    tasksTrain: PositionArtifactBindingV2;
    tasksEval: PositionArtifactBindingV2;
    scoresTrain: PositionArtifactBindingV2;
    scoresEval: PositionArtifactBindingV2;
    sealedTrain: PositionArtifactBindingV2;
    sealedEval: PositionArtifactBindingV2;
    assignments: PositionArtifactBindingV2;
    nearDuplicatePairs: PositionArtifactBindingV2;
    exclusions: PositionArtifactBindingV2;
  };
  orderedTrainTaskIds: string[];
  orderedEvalTaskIds: string[];
}

function object(value: unknown, label: string): JsonObject {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(`${label} must be an object`);
  return value as JsonObject;
}

function exactKeys(value: JsonObject, expected: readonly string[], label: string): void {
  const actual = Object.keys(value);
  if (actual.length !== expected.length || expected.some((key) => !Object.hasOwn(value, key)))
    throw new Error(`${label} has unexpected or missing keys`);
}

const MAX_SEMANTIC_STRING_CHARACTERS = 4_096;

function trimmedString(value: unknown, label: string): string {
  if (typeof value !== 'string' || !value || value !== value.trim() || value.length > MAX_SEMANTIC_STRING_CHARACTERS)
    throw new Error(`${label} must be a bounded trimmed nonempty string`);
  return value;
}

function sha256(value: unknown, label: string): string {
  if (typeof value !== 'string' || !/^[0-9a-f]{64}$/u.test(value))
    throw new Error(`${label} must be a lowercase SHA-256`);
  return value;
}

function showdownCommit(value: unknown, label: string): string {
  if (typeof value !== 'string' || !/^[0-9a-f]{40}$/u.test(value))
    throw new Error(`${label} must be a lowercase full Showdown commit digest`);
  return value;
}

function safeInteger(value: unknown, label: string, minimum = 0): number {
  if (!Number.isSafeInteger(value) || (value as number) < minimum)
    throw new Error(`${label} must be a safe integer >= ${minimum}`);
  return value as number;
}

function fraction(value: unknown, label: string, endpoints = true): number {
  if (
    typeof value !== 'number' ||
    !Number.isFinite(value) ||
    (endpoints ? value < 0 || value > 1 : value <= 0 || value >= 1)
  )
    throw new Error(`${label} must be ${endpoints ? 'in [0, 1]' : 'between zero and one'}`);
  return value;
}

function exactProtocol(value: unknown, expected: unknown, label: string): JsonObject {
  const result = object(value, label);
  if (canonicalJson(result) !== canonicalJson(expected)) throw new Error(`${label} is not the supported protocol`);
  return result;
}

function runtime(value: unknown, label: string): PositionManifestRuntimeV2 {
  const result = object(value, label);
  exactKeys(result, ['arch', 'node', 'platform'], label);
  return {
    node: trimmedString(result.node, `${label}.node`),
    platform: trimmedString(result.platform, `${label}.platform`),
    arch: trimmedString(result.arch, `${label}.arch`),
  };
}

function counterfactualProtocol(value: unknown, label: string): JsonObject {
  const result = object(value, label);
  exactKeys(
    result,
    ['horizon', 'luckSamples', 'opponentSamples', 'reference', 'rolloutLimit', 'screenSamples', 'shortlist', 'version'],
    label,
  );
  if (result.version !== COUNTERFACTUAL_PROTOCOL_VERSION) throw new Error(`${label}.version is unsupported`);
  exactProtocol(result.reference, REFERENCE, `${label}.reference`);
  if (result.horizon !== 'end') safeInteger(result.horizon, `${label}.horizon`);
  for (const key of ['luckSamples', 'opponentSamples', 'rolloutLimit', 'screenSamples', 'shortlist'] as const)
    safeInteger(result[key], `${label}.${key}`, 1);
  return {
    version: result.version,
    reference: REFERENCE,
    horizon: result.horizon,
    luckSamples: result.luckSamples,
    opponentSamples: result.opponentSamples,
    rolloutLimit: result.rolloutLimit,
    screenSamples: result.screenSamples,
    shortlist: result.shortlist,
  };
}

function artifactBinding(value: unknown, label: string): PositionArtifactBindingV2 {
  const result = object(value, label);
  exactKeys(result, ['rows', 'sha256'], label);
  return { sha256: sha256(result.sha256, `${label}.sha256`), rows: safeInteger(result.rows, `${label}.rows`) };
}

function fileArtifactBinding(value: unknown, label: string): PositionFileArtifactBindingV2 {
  const result = object(value, label);
  exactKeys(result, ['file', 'rows', 'sha256'], label);
  return {
    file: trimmedString(result.file, `${label}.file`),
    sha256: sha256(result.sha256, `${label}.sha256`),
    rows: safeInteger(result.rows, `${label}.rows`),
  };
}

function uniqueStrings(value: unknown, label: string): string[] {
  if (!Array.isArray(value)) throw new Error(`${label} must be an array`);
  const result = value.map((entry, index) => trimmedString(entry, `${label}[${index}]`));
  if (new Set(result).size !== result.length) throw new Error(`${label} contains duplicates`);
  return result;
}

export function validatePilotManifestV2(value: unknown, label = 'pilot manifest'): PilotPositionManifestV2View {
  const manifest = object(value, label);
  exactKeys(manifest, PILOT_POSITION_MANIFEST_V2_KEYS, label);
  if (manifest.schema_version !== 2) throw new Error(`${label} must use schema version 2`);
  if (manifest.release_ready !== false) throw new Error(`${label}.release_ready must be false`);
  if (manifest.eligibility_status !== PILOT_POSITION_ELIGIBILITY_STATUS)
    throw new Error(`${label}.eligibility_status is unsupported`);
  if (manifest.split_status !== PILOT_POSITION_SPLIT_STATUS) throw new Error(`${label}.split_status is unsupported`);
  if (manifest.eligibility_metrics_version !== POSITION_ELIGIBILITY_METRICS_VERSION)
    throw new Error(`${label}.eligibility_metrics_version is unsupported`);

  const inputs = object(manifest.inputs, `${label}.inputs`);
  exactKeys(inputs, ['private_set', 'public_set'], `${label}.inputs`);
  const outputs = object(manifest.outputs, `${label}.outputs`);
  exactKeys(outputs, ['scores', 'sealed_panels', 'tasks'], `${label}.outputs`);
  const tasks = fileArtifactBinding(outputs.tasks, `${label}.outputs.tasks`);
  const scores = artifactBinding(outputs.scores, `${label}.outputs.scores`);
  const sealedPanels = artifactBinding(outputs.sealed_panels, `${label}.outputs.sealed_panels`);
  if (tasks.rows !== scores.rows || tasks.rows !== sealedPanels.rows)
    throw new Error(`${label} output row counts must agree`);
  const orderedTaskIds = uniqueStrings(manifest.ordered_task_ids, `${label}.ordered_task_ids`);
  if (orderedTaskIds.length !== tasks.rows)
    throw new Error(`${label}.ordered_task_ids does not match its output row counts`);

  return {
    sourceSetId: trimmedString(manifest.source_set_id, `${label}.source_set_id`),
    evaluatorDigest: sha256(manifest.evaluator_digest, `${label}.evaluator_digest`),
    runtime: runtime(manifest.runtime, `${label}.runtime`),
    showdownCommit: showdownCommit(manifest.showdown_commit, `${label}.showdown_commit`),
    seedNamespace: trimmedString(manifest.seed_namespace, `${label}.seed_namespace`),
    actionProtocol: exactProtocol(manifest.action_protocol, ACTION_PROTOCOL, `${label}.action_protocol`),
    taskProtocol: exactProtocol(manifest.task_protocol, POSITION_TASK_PROTOCOL, `${label}.task_protocol`),
    canonicalJsonProtocol: exactProtocol(manifest.canonical_json, CANONICAL_JSON_PROTOCOL, `${label}.canonical_json`),
    counterfactualProtocol: counterfactualProtocol(manifest.counterfactual, `${label}.counterfactual`),
    exhaustivePanelsProtocol: exactProtocol(
      manifest.exhaustive_panels,
      EXHAUSTIVE_PANEL_PROTOCOL,
      `${label}.exhaustive_panels`,
    ),
    eligibilityMetricsVersion: POSITION_ELIGIBILITY_METRICS_VERSION,
    sourceGroupProtocol: exactProtocol(
      manifest.source_group_protocol,
      POSITION_SOURCE_GROUP_PROTOCOL,
      `${label}.source_group_protocol`,
    ),
    inputDigests: {
      publicSet: sha256(inputs.public_set, `${label}.inputs.public_set`),
      privateSet: sha256(inputs.private_set, `${label}.inputs.private_set`),
    },
    outputs: { tasks, scores, sealedPanels },
    orderedTaskIds,
  };
}

export function pilotManifestUpstreamProjectionV2(
  manifest: PilotPositionManifestV2View,
  manifestSha256: string,
): JsonObject {
  return {
    sha256: sha256(manifestSha256, 'pilot manifest projection.sha256'),
    source_set_id: manifest.sourceSetId,
    evaluator_digest: manifest.evaluatorDigest,
    runtime: manifest.runtime,
    showdown_commit: manifest.showdownCommit,
    action_protocol: manifest.actionProtocol,
    task_protocol: manifest.taskProtocol,
    counterfactual: manifest.counterfactualProtocol,
    exhaustive_panels: manifest.exhaustivePanelsProtocol,
    source_group_protocol: manifest.sourceGroupProtocol,
    seed_namespace: manifest.seedNamespace,
  };
}

export function validatePositionSplitFreezePolicyV2(
  value: unknown,
  label = 'frozen split policy',
): PositionSplitFreezePolicyV2 {
  const result = object(value, label);
  exactKeys(
    result,
    [
      'calibration_manifest_sha256',
      'eligibility',
      'eval_fraction',
      'max_eval_fraction_deviation',
      'max_stratum_eval_fraction_deviation',
      'near_duplicate_threshold',
      'policy_id',
      'schema_version',
      'seed',
      'status',
    ],
    label,
  );
  if (result.schema_version !== 2 || result.status !== 'frozen')
    throw new Error(`${label} must be frozen at schema version 2`);
  trimmedString(result.policy_id, `${label}.policy_id`);
  trimmedString(result.seed, `${label}.seed`);
  sha256(result.calibration_manifest_sha256, `${label}.calibration_manifest_sha256`);
  fraction(result.eval_fraction, `${label}.eval_fraction`, false);
  fraction(result.near_duplicate_threshold, `${label}.near_duplicate_threshold`);
  fraction(result.max_eval_fraction_deviation, `${label}.max_eval_fraction_deviation`);
  fraction(result.max_stratum_eval_fraction_deviation, `${label}.max_stratum_eval_fraction_deviation`);
  const eligibility = object(result.eligibility, `${label}.eligibility`);
  validatePositionEligibilityPolicy(eligibility as unknown as PositionEligibilityPolicy);
  safeInteger(eligibility.min_luck_replications, `${label}.eligibility.min_luck_replications`, 2);
  safeInteger(eligibility.min_sampled_opponent_slots, `${label}.eligibility.min_sampled_opponent_slots`, 2);
  return result as PositionSplitFreezePolicyV2;
}

function upstream(value: unknown, label: string): FrozenPositionUpstreamV2 {
  const result = object(value, label);
  exactKeys(
    result,
    [
      'action_protocol',
      'counterfactual',
      'evaluator_digest',
      'exhaustive_panels',
      'runtime',
      'seed_namespace',
      'sha256',
      'showdown_commit',
      'source_group_protocol',
      'source_set_id',
      'task_protocol',
    ],
    label,
  );
  return {
    sha256: sha256(result.sha256, `${label}.sha256`),
    sourceSetId: trimmedString(result.source_set_id, `${label}.source_set_id`),
    evaluatorDigest: sha256(result.evaluator_digest, `${label}.evaluator_digest`),
    runtime: runtime(result.runtime, `${label}.runtime`),
    showdownCommit: showdownCommit(result.showdown_commit, `${label}.showdown_commit`),
    actionProtocol: exactProtocol(result.action_protocol, ACTION_PROTOCOL, `${label}.action_protocol`),
    taskProtocol: exactProtocol(result.task_protocol, POSITION_TASK_PROTOCOL, `${label}.task_protocol`),
    counterfactualProtocol: counterfactualProtocol(result.counterfactual, `${label}.counterfactual`),
    exhaustivePanelsProtocol: exactProtocol(
      result.exhaustive_panels,
      EXHAUSTIVE_PANEL_PROTOCOL,
      `${label}.exhaustive_panels`,
    ),
    sourceGroupProtocol: exactProtocol(
      result.source_group_protocol,
      POSITION_SOURCE_GROUP_PROTOCOL,
      `${label}.source_group_protocol`,
    ),
    seedNamespace: trimmedString(result.seed_namespace, `${label}.seed_namespace`),
  };
}

export function frozenUpstreamProjectionV2(upstreamManifest: FrozenPositionUpstreamV2): JsonObject {
  return {
    sha256: upstreamManifest.sha256,
    source_set_id: upstreamManifest.sourceSetId,
    evaluator_digest: upstreamManifest.evaluatorDigest,
    runtime: upstreamManifest.runtime,
    showdown_commit: upstreamManifest.showdownCommit,
    action_protocol: upstreamManifest.actionProtocol,
    task_protocol: upstreamManifest.taskProtocol,
    counterfactual: upstreamManifest.counterfactualProtocol,
    exhaustive_panels: upstreamManifest.exhaustivePanelsProtocol,
    source_group_protocol: upstreamManifest.sourceGroupProtocol,
    seed_namespace: upstreamManifest.seedNamespace,
  };
}

function frozenCounts(value: unknown, label: string): FrozenPositionCountsV2 {
  const result = object(value, label);
  exactKeys(
    result,
    ['duplicate_clusters', 'eligible', 'eval', 'excluded', 'input', 'near_duplicate_pairs', 'source_groups', 'train'],
    label,
  );
  const counts = {
    input: safeInteger(result.input, `${label}.input`, 1),
    eligible: safeInteger(result.eligible, `${label}.eligible`, 2),
    excluded: safeInteger(result.excluded, `${label}.excluded`),
    train: safeInteger(result.train, `${label}.train`, 1),
    eval: safeInteger(result.eval, `${label}.eval`, 1),
    sourceGroups: safeInteger(result.source_groups, `${label}.source_groups`, 1),
    duplicateClusters: safeInteger(result.duplicate_clusters, `${label}.duplicate_clusters`, 1),
    nearDuplicatePairs: safeInteger(result.near_duplicate_pairs, `${label}.near_duplicate_pairs`),
  };
  if (!Number.isSafeInteger(counts.train + counts.eval) || counts.eligible !== counts.train + counts.eval)
    throw new Error(`${label}.eligible differs from train plus eval`);
  if (!Number.isSafeInteger(counts.eligible + counts.excluded) || counts.input !== counts.eligible + counts.excluded)
    throw new Error(`${label}.input differs from eligible plus excluded`);
  if (counts.sourceGroups > counts.eligible || counts.duplicateClusters > counts.eligible)
    throw new Error(`${label} component counts exceed the eligible count`);
  return counts;
}

function splitBalance(
  value: unknown,
  counts: FrozenPositionCountsV2,
  target: number,
  label: string,
): FrozenPositionSplitBalanceV2 {
  const result = object(value, label);
  exactKeys(result, ['evalFraction', 'evalFractionDeviation', 'maxStratumDeviation', 'strata'], label);
  const evalFraction = fraction(result.evalFraction, `${label}.evalFraction`);
  const evalFractionDeviation = fraction(result.evalFractionDeviation, `${label}.evalFractionDeviation`);
  const rawStrata = object(result.strata, `${label}.strata`);
  const strata: FrozenPositionSplitBalanceV2['strata'] = Object.create(null);
  let total = 0;
  let evalTotal = 0;
  let maximum = 0;
  for (const [name, raw] of Object.entries(rawStrata)) {
    trimmedString(name, `${label}.strata key`);
    if (name === '__proto__' || name === 'constructor' || name === 'prototype') {
      throw new Error(`${label}.strata contains a reserved key`);
    }
    const entry = object(raw, `${label}.strata.${name}`);
    exactKeys(entry, ['deviation', 'eval', 'evalFraction', 'total'], `${label}.strata.${name}`);
    const entryTotal = safeInteger(entry.total, `${label}.strata.${name}.total`, 1);
    const entryEval = safeInteger(entry.eval, `${label}.strata.${name}.eval`);
    if (entryEval > entryTotal) throw new Error(`${label}.strata.${name}.eval exceeds total`);
    const entryFraction = fraction(entry.evalFraction, `${label}.strata.${name}.evalFraction`);
    const deviation = fraction(entry.deviation, `${label}.strata.${name}.deviation`);
    if (entryFraction !== entryEval / entryTotal || deviation !== Math.abs(entryFraction - target))
      throw new Error(`${label}.strata.${name} is inconsistent`);
    if (!Number.isSafeInteger(total + entryTotal) || !Number.isSafeInteger(evalTotal + entryEval))
      throw new Error(`${label}.strata totals exceed the safe integer range`);
    total += entryTotal;
    evalTotal += entryEval;
    maximum = Math.max(maximum, deviation);
    strata[name] = { total: entryTotal, eval: entryEval, evalFraction: entryFraction, deviation };
  }
  if (
    total !== counts.eligible ||
    evalTotal !== counts.eval ||
    evalFraction !== counts.eval / counts.eligible ||
    evalFractionDeviation !== Math.abs(evalFraction - target)
  )
    throw new Error(`${label} does not match the frozen counts or policy`);
  const maxStratumDeviation = fraction(result.maxStratumDeviation, `${label}.maxStratumDeviation`);
  if (maxStratumDeviation !== maximum) throw new Error(`${label}.maxStratumDeviation is inconsistent`);
  return { evalFraction, evalFractionDeviation, strata, maxStratumDeviation };
}

function sameJson(left: unknown, right: unknown): boolean {
  return canonicalJson(left) === canonicalJson(right);
}

export function validateFrozenManifestV2(value: unknown, label = 'frozen manifest'): FrozenPositionManifestV2View {
  const manifest = object(value, label);
  exactKeys(manifest, FROZEN_POSITION_MANIFEST_V2_KEYS, label);
  if (manifest.schema_version !== 2) throw new Error(`${label} must use schema version 2`);
  if (manifest.release_ready !== false) throw new Error(`${label}.release_ready must be false`);
  if (manifest.status !== FROZEN_POSITION_MANIFEST_STATUS) throw new Error(`${label}.status is unsupported`);

  const releaseGates = uniqueStrings(manifest.remaining_release_gates, `${label}.remaining_release_gates`);
  if (!sameJson(releaseGates, FROZEN_POSITION_RELEASE_GATES))
    throw new Error(`${label}.remaining_release_gates are unsupported`);
  const calibrationCandidateSeparation = exactProtocol(
    manifest.calibration_candidate_separation,
    FROZEN_CALIBRATION_CANDIDATE_SEPARATION,
    `${label}.calibration_candidate_separation`,
  );
  const canonicalJsonProtocol = exactProtocol(
    manifest.canonical_json,
    CANONICAL_JSON_PROTOCOL,
    `${label}.canonical_json`,
  );
  const nearDuplicateProtocol = exactProtocol(
    manifest.near_duplicate_protocol,
    NEAR_DUPLICATE_PROTOCOL,
    `${label}.near_duplicate_protocol`,
  );
  const exclusionRowProtocol = exactProtocol(
    manifest.exclusion_row_protocol,
    FROZEN_POSITION_EXCLUSION_PROTOCOL,
    `${label}.exclusion_row_protocol`,
  );
  const policy = validatePositionSplitFreezePolicyV2(manifest.policy, `${label}.policy`);
  const policyCanonicalDigest = sha256(manifest.policy_canonical_digest, `${label}.policy_canonical_digest`);
  if (policyCanonicalDigest !== canonicalJsonDigest(policy))
    throw new Error(`${label}.policy_canonical_digest is wrong`);

  const upstreamPilot = upstream(manifest.upstream_pilot_manifest, `${label}.upstream_pilot_manifest`);
  const upstreamCalibration = upstream(
    manifest.upstream_calibration_manifest,
    `${label}.upstream_calibration_manifest`,
  );
  if (policy.calibration_manifest_sha256 !== upstreamCalibration.sha256)
    throw new Error(`${label}.policy does not bind the upstream calibration manifest`);
  if (
    upstreamPilot.sha256 === upstreamCalibration.sha256 ||
    upstreamPilot.sourceSetId === upstreamCalibration.sourceSetId
  )
    throw new Error(`${label} candidate and calibration provenance must be distinct`);
  for (const [name, left, right] of [
    ['evaluator_digest', upstreamPilot.evaluatorDigest, upstreamCalibration.evaluatorDigest],
    ['runtime', upstreamPilot.runtime, upstreamCalibration.runtime],
    ['showdown_commit', upstreamPilot.showdownCommit, upstreamCalibration.showdownCommit],
    ['counterfactual', upstreamPilot.counterfactualProtocol, upstreamCalibration.counterfactualProtocol],
  ] as const) {
    if (!sameJson(left, right)) throw new Error(`${label} candidate and calibration ${name} must agree`);
  }

  const inputs = object(manifest.inputs, `${label}.inputs`);
  exactKeys(
    inputs,
    ['calibration_manifest', 'pilot_manifest', 'policy_file', 'scores', 'sealed', 'tasks'],
    `${label}.inputs`,
  );
  const inputView = {
    tasks: sha256(inputs.tasks, `${label}.inputs.tasks`),
    scores: sha256(inputs.scores, `${label}.inputs.scores`),
    sealed: sha256(inputs.sealed, `${label}.inputs.sealed`),
    pilotManifest: sha256(inputs.pilot_manifest, `${label}.inputs.pilot_manifest`),
    calibrationManifest: sha256(inputs.calibration_manifest, `${label}.inputs.calibration_manifest`),
    policyFile: sha256(inputs.policy_file, `${label}.inputs.policy_file`),
  };
  if (inputView.pilotManifest !== upstreamPilot.sha256 || inputView.calibrationManifest !== upstreamCalibration.sha256)
    throw new Error(`${label}.inputs do not bind the upstream manifests`);

  const counts = frozenCounts(manifest.counts, `${label}.counts`);
  const balance = splitBalance(manifest.split_balance, counts, policy.eval_fraction, `${label}.split_balance`);
  if (
    balance.evalFractionDeviation > policy.max_eval_fraction_deviation ||
    balance.maxStratumDeviation > policy.max_stratum_eval_fraction_deviation
  )
    throw new Error(`${label}.split_balance exceeds policy tolerances`);

  const rawOutputs = object(manifest.outputs, `${label}.outputs`);
  exactKeys(
    rawOutputs,
    [
      'assignments',
      'exclusions',
      'near_duplicate_pairs',
      'scores_eval',
      'scores_train',
      'sealed_eval',
      'sealed_train',
      'tasks_eval',
      'tasks_train',
    ],
    `${label}.outputs`,
  );
  const outputs = {
    tasksTrain: artifactBinding(rawOutputs.tasks_train, `${label}.outputs.tasks_train`),
    tasksEval: artifactBinding(rawOutputs.tasks_eval, `${label}.outputs.tasks_eval`),
    scoresTrain: artifactBinding(rawOutputs.scores_train, `${label}.outputs.scores_train`),
    scoresEval: artifactBinding(rawOutputs.scores_eval, `${label}.outputs.scores_eval`),
    sealedTrain: artifactBinding(rawOutputs.sealed_train, `${label}.outputs.sealed_train`),
    sealedEval: artifactBinding(rawOutputs.sealed_eval, `${label}.outputs.sealed_eval`),
    assignments: artifactBinding(rawOutputs.assignments, `${label}.outputs.assignments`),
    nearDuplicatePairs: artifactBinding(rawOutputs.near_duplicate_pairs, `${label}.outputs.near_duplicate_pairs`),
    exclusions: artifactBinding(rawOutputs.exclusions, `${label}.outputs.exclusions`),
  };
  if (
    outputs.tasksTrain.rows !== counts.train ||
    outputs.scoresTrain.rows !== counts.train ||
    outputs.sealedTrain.rows !== counts.train ||
    outputs.tasksEval.rows !== counts.eval ||
    outputs.scoresEval.rows !== counts.eval ||
    outputs.sealedEval.rows !== counts.eval ||
    outputs.assignments.rows !== counts.eligible ||
    outputs.nearDuplicatePairs.rows !== counts.nearDuplicatePairs ||
    outputs.exclusions.rows !== counts.excluded
  )
    throw new Error(`${label}.outputs row counts differ from counts`);

  const orderedTrainTaskIds = uniqueStrings(manifest.ordered_train_task_ids, `${label}.ordered_train_task_ids`);
  const orderedEvalTaskIds = uniqueStrings(manifest.ordered_eval_task_ids, `${label}.ordered_eval_task_ids`);
  if (
    orderedTrainTaskIds.length !== outputs.tasksTrain.rows ||
    orderedEvalTaskIds.length !== outputs.tasksEval.rows ||
    new Set([...orderedTrainTaskIds, ...orderedEvalTaskIds]).size !==
      orderedTrainTaskIds.length + orderedEvalTaskIds.length
  )
    throw new Error(`${label} ordered task IDs are inconsistent with output bindings`);

  return {
    status: FROZEN_POSITION_MANIFEST_STATUS,
    releaseGates: releaseGates as FrozenPositionManifestV2View['releaseGates'],
    runtime: runtime(manifest.runtime, `${label}.runtime`),
    splitterDigest: sha256(manifest.splitter_digest, `${label}.splitter_digest`),
    splitDigest: sha256(manifest.split_digest, `${label}.split_digest`),
    policyCanonicalDigest,
    policy,
    upstreamPilot,
    upstreamCalibration,
    canonicalJsonProtocol,
    nearDuplicateProtocol,
    exclusionRowProtocol,
    calibrationCandidateSeparation,
    inputs: inputView,
    counts,
    splitBalance: balance,
    outputs,
    orderedTrainTaskIds,
    orderedEvalTaskIds,
  };
}
