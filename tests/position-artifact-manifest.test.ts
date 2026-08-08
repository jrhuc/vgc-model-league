import assert from 'node:assert/strict';
import test from 'node:test';

import { counterfactualProtocol, EXHAUSTIVE_PANEL_PROTOCOL } from '../src/eval/counterfactual.js';
import { NEAR_DUPLICATE_PROTOCOL } from '../src/eval/duplicates.js';
import { POSITION_ELIGIBILITY_METRICS_VERSION } from '../src/eval/eligibility.js';
import { ACTION_PROTOCOL } from '../src/eval/fork.js';
import { POSITION_SOURCE_GROUP_PROTOCOL } from '../src/eval/panel-artifact.js';
import {
  FROZEN_CALIBRATION_CANDIDATE_SEPARATION,
  FROZEN_POSITION_EXCLUSION_PROTOCOL,
  FROZEN_POSITION_MANIFEST_STATUS,
  FROZEN_POSITION_RELEASE_GATES,
  pilotManifestUpstreamProjectionV2,
  validateFrozenManifestV2,
  validatePilotManifestV2,
} from '../src/eval/position-artifact-manifest.js';
import { CANONICAL_JSON_PROTOCOL, canonicalJsonDigest } from '../src/eval/serialization.js';
import { POSITION_TASK_PROTOCOL } from '../src/eval/task.js';
import type { JsonObject } from '../src/types.js';

const hash = (character: string): string => character.repeat(64);

function pilot(options: { horizon?: number | 'end'; ids?: string[]; sourceSetId?: string } = {}): JsonObject {
  const ids = options.ids ?? ['task-a'];
  const horizon = options.horizon ?? 2;
  return {
    schema_version: 2,
    release_ready: false,
    eligibility_status: 'pilot-thresholds-not-frozen',
    eligibility_metrics_version: POSITION_ELIGIBILITY_METRICS_VERSION,
    split_status: 'pilot-only-source-groups-and-exact-fingerprints-recorded',
    source_set_id: options.sourceSetId ?? 'candidate-source-v1',
    evaluator_digest: hash('1'),
    runtime: { node: 'v24.18.1', platform: 'linux', arch: 'arm64' },
    showdown_commit: '2'.repeat(40),
    action_protocol: ACTION_PROTOCOL,
    task_protocol: POSITION_TASK_PROTOCOL,
    canonical_json: CANONICAL_JSON_PROTOCOL,
    counterfactual: counterfactualProtocol({
      horizon: horizon === 'end' ? Number.POSITIVE_INFINITY : horizon,
      luckSamples: 8,
      opponentSamples: 4,
    }),
    exhaustive_panels: EXHAUSTIVE_PANEL_PROTOCOL,
    source_group_protocol: POSITION_SOURCE_GROUP_PROTOCOL,
    seed_namespace: 'position-panels',
    inputs: { public_set: hash('3'), private_set: hash('4') },
    outputs: {
      tasks: { file: 'tasks.pilot.jsonl', sha256: hash('5'), rows: ids.length },
      scores: { sha256: hash('6'), rows: ids.length },
      sealed_panels: { sha256: hash('7'), rows: ids.length },
    },
    ordered_task_ids: ids,
  };
}

function policy(calibrationManifestSha256: string): JsonObject {
  return {
    schema_version: 2,
    status: 'frozen',
    policy_id: 'position-policy-v1',
    calibration_manifest_sha256: calibrationManifestSha256,
    seed: 'split-seed-v1',
    eval_fraction: 0.5,
    near_duplicate_threshold: 0.9,
    max_eval_fraction_deviation: 0,
    max_stratum_eval_fraction_deviation: 0,
    eligibility: {
      schema_version: 2,
      status: 'frozen',
      min_luck_replications: 2,
      min_sampled_opponent_slots: 2,
      min_held_out_span_value: 0.1,
      max_held_out_span_standard_error: 0.1,
      min_stability_rank_correlation: 0.9,
      max_normalized_reward_drift: 0.1,
      max_qualification_normalized_standard_error: 0.1,
      require_best_anchor_agreement: true,
      require_extrema_set_agreement: true,
    },
  };
}

function frozen(): JsonObject {
  const candidate = validatePilotManifestV2(pilot({ ids: ['train-a', 'eval-a'] }));
  const calibrationValue = pilot({ ids: ['calibration-a'], sourceSetId: 'calibration-source-v1' });
  (calibrationValue.inputs as JsonObject).public_set = hash('8');
  (calibrationValue.inputs as JsonObject).private_set = hash('9');
  const calibration = validatePilotManifestV2(calibrationValue);
  const candidateSha = hash('a');
  const calibrationSha = hash('b');
  const frozenPolicy = policy(calibrationSha);
  const artifact = (character: string, rows: number) => ({ sha256: hash(character), rows });
  return {
    schema_version: 2,
    release_ready: false,
    status: FROZEN_POSITION_MANIFEST_STATUS,
    remaining_release_gates: FROZEN_POSITION_RELEASE_GATES,
    policy: frozenPolicy,
    splitter_digest: hash('c'),
    runtime: { node: 'v24.18.1', platform: 'linux', arch: 'arm64' },
    upstream_pilot_manifest: pilotManifestUpstreamProjectionV2(candidate, candidateSha),
    upstream_calibration_manifest: pilotManifestUpstreamProjectionV2(calibration, calibrationSha),
    calibration_candidate_separation: FROZEN_CALIBRATION_CANDIDATE_SEPARATION,
    policy_canonical_digest: canonicalJsonDigest(frozenPolicy),
    canonical_json: CANONICAL_JSON_PROTOCOL,
    near_duplicate_protocol: NEAR_DUPLICATE_PROTOCOL,
    exclusion_row_protocol: FROZEN_POSITION_EXCLUSION_PROTOCOL,
    split_digest: hash('d'),
    split_balance: {
      evalFraction: 0.5,
      evalFractionDeviation: 0,
      strata: { level: { total: 2, eval: 1, evalFraction: 0.5, deviation: 0 } },
      maxStratumDeviation: 0,
    },
    inputs: {
      tasks: hash('5'),
      scores: hash('6'),
      sealed: hash('7'),
      pilot_manifest: candidateSha,
      calibration_manifest: calibrationSha,
      policy_file: hash('e'),
    },
    counts: {
      input: 2,
      eligible: 2,
      excluded: 0,
      train: 1,
      eval: 1,
      source_groups: 2,
      duplicate_clusters: 2,
      near_duplicate_pairs: 0,
    },
    outputs: {
      tasks_train: artifact('1', 1),
      tasks_eval: artifact('2', 1),
      scores_train: artifact('3', 1),
      scores_eval: artifact('4', 1),
      sealed_train: artifact('5', 1),
      sealed_eval: artifact('6', 1),
      assignments: artifact('7', 2),
      near_duplicate_pairs: artifact('8', 0),
      exclusions: artifact('9', 0),
    },
    ordered_train_task_ids: ['train-a'],
    ordered_eval_task_ids: ['eval-a'],
  };
}

function remove(value: JsonObject, key: string): JsonObject {
  const copy = structuredClone(value);
  delete copy[key];
  return copy;
}

test('real producer-shaped pilot manifest normalizes current protocols and horizon zero', () => {
  const view = validatePilotManifestV2(pilot({ horizon: 0 }));
  assert.equal(view.counterfactualProtocol.horizon, 0);
  assert.deepEqual(view.sourceGroupProtocol, POSITION_SOURCE_GROUP_PROTOCOL);
  assert.equal(view.outputs.tasks.rows, 1);
});

test('canonical zero-row pilot manifest is schema-valid', () => {
  const view = validatePilotManifestV2(pilot({ ids: [] }));
  assert.equal(view.outputs.tasks.rows, 0);
  assert.deepEqual(view.orderedTaskIds, []);
});

test('pilot manifest rejects unsafe horizons and malformed Showdown commits', () => {
  const cases: Array<[string, (value: JsonObject) => void]> = [
    ['negative horizon', (value) => ((value.counterfactual as JsonObject).horizon = -1)],
    ['unsafe horizon', (value) => ((value.counterfactual as JsonObject).horizon = Number.MAX_SAFE_INTEGER + 1)],
    ['short commit', (value) => (value.showdown_commit = 'a'.repeat(39))],
    ['uppercase commit', (value) => (value.showdown_commit = 'A'.repeat(40))],
  ];
  for (const [name, mutate] of cases) {
    const value = structuredClone(pilot());
    mutate(value);
    assert.throws(() => validatePilotManifestV2(value), name);
  }
});

test('pilot manifest rejects missing and extra keys at every declared shape', () => {
  const cases = [
    remove(pilot(), 'inputs'),
    { ...pilot(), surprise: true },
    (() => {
      const value = structuredClone(pilot());
      (value.outputs as JsonObject).surprise = true;
      return value;
    })(),
    (() => {
      const value = structuredClone(pilot());
      delete (value.counterfactual as JsonObject).rolloutLimit;
      return value;
    })(),
    (() => {
      const value = structuredClone(pilot());
      (value.source_group_protocol as JsonObject).surprise = true;
      return value;
    })(),
  ];
  for (const value of cases) assert.throws(() => validatePilotManifestV2(value));
});

test('frozen manifest accepts the exact gates, separation declaration, and exclusion protocol', () => {
  const view = validateFrozenManifestV2(frozen());
  assert.deepEqual(view.releaseGates, FROZEN_POSITION_RELEASE_GATES);
  assert.deepEqual(view.calibrationCandidateSeparation, FROZEN_CALIBRATION_CANDIDATE_SEPARATION);
  assert.deepEqual(view.exclusionRowProtocol, FROZEN_POSITION_EXCLUSION_PROTOCOL);
});

test('frozen manifest rejects changed gates, separation, and exclusion protocol', () => {
  const cases: Array<[string, (value: JsonObject) => void]> = [
    ['gate', (value) => ((value.remaining_release_gates as unknown[])[0] = 'other')],
    [
      'separation',
      (value) => (((value.calibration_candidate_separation as JsonObject).exact_checks as unknown[])[0] = 'other'),
    ],
    ['exclusion', (value) => ((value.exclusion_row_protocol as JsonObject).version = 3)],
  ];
  for (const [name, mutate] of cases) {
    const value = structuredClone(frozen());
    mutate(value);
    assert.throws(() => validateFrozenManifestV2(value), name);
  }
});

test('frozen manifest enforces candidate/calibration scaffold provenance equality', () => {
  for (const key of ['evaluator_digest', 'showdown_commit', 'runtime', 'counterfactual'] as const) {
    const value = structuredClone(frozen());
    const calibration = value.upstream_calibration_manifest as JsonObject;
    if (key === 'evaluator_digest') calibration[key] = hash('f');
    else if (key === 'showdown_commit') calibration[key] = 'f'.repeat(40);
    else if (key === 'runtime') calibration[key] = { node: 'other', platform: 'linux', arch: 'arm64' };
    else calibration[key] = { ...(calibration[key] as JsonObject), horizon: 0 };
    assert.throws(() => validateFrozenManifestV2(value), key);
  }
});

test('frozen manifest rejects missing and extra keys', () => {
  const extra = structuredClone(frozen());
  (extra.outputs as JsonObject).surprise = true;
  assert.throws(() => validateFrozenManifestV2(extra));
  assert.throws(() => validateFrozenManifestV2(remove(frozen(), 'counts')));
});
