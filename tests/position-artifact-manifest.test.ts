import assert from 'node:assert/strict';
import test from 'node:test';

import { counterfactualProtocol, EXHAUSTIVE_PANEL_PROTOCOL } from '../src/eval/counterfactual.js';
import { POSITION_ELIGIBILITY_METRICS_VERSION } from '../src/eval/eligibility.js';
import {
  CANDIDATE_POSITION_MANIFEST_SCHEMA_VERSION,
  CANDIDATE_POSITION_SELECTION_RULES,
  validateCandidateManifest,
} from '../src/eval/position-artifact-manifest.js';
import { POSITION_TASK_PROTOCOL } from '../src/eval/task.js';
import { ACTION_PROTOCOL } from '../src/fork.js';
import { CANONICAL_JSON_PROTOCOL } from '../src/serialization.js';

const DIGEST = 'a'.repeat(64);

function manifest(): Record<string, unknown> {
  return {
    schema_version: CANDIDATE_POSITION_MANIFEST_SCHEMA_VERSION,
    evaluator_digest: DIGEST,
    runtime: { node: 'v24', platform: 'darwin', arch: 'arm64' },
    showdown_commit: 'b'.repeat(40),
    seed_namespace: 'candidate-panels',
    action_protocol: ACTION_PROTOCOL,
    task_protocol: POSITION_TASK_PROTOCOL,
    canonical_json: CANONICAL_JSON_PROTOCOL,
    counterfactual: counterfactualProtocol(),
    exhaustive_panels: EXHAUSTIVE_PANEL_PROTOCOL,
    eligibility_metrics_version: POSITION_ELIGIBILITY_METRICS_VERSION,
    inputs: { graded: DIGEST, graded_manifest: DIGEST },
    selection: {
      count: 1,
      seed: 'position-set',
      per_game: 3,
      formats: ['gen9championsvgc2026regmb'],
      rules: CANDIDATE_POSITION_SELECTION_RULES,
    },
    outputs: {
      tasks: { file: 'tasks.jsonl', sha256: DIGEST, rows: 1 },
      scores: { sha256: DIGEST, rows: 1 },
      sealed_panels: { sha256: DIGEST, rows: 1 },
    },
    ordered_task_ids: [DIGEST],
  };
}

test('candidate manifest binds one exact public, private, and sealed artifact set', () => {
  const view = validateCandidateManifest(manifest());
  assert.equal(view.selection.count, 1);
  assert.deepEqual(view.selection.formats, ['gen9championsvgc2026regmb']);
  assert.equal(view.outputs.tasks.rows, 1);
  assert.deepEqual(view.orderedTaskIds, [DIGEST]);
  assert.equal(CANDIDATE_POSITION_SELECTION_RULES.version, 3);
  assert.deepEqual(Object.keys(CANDIDATE_POSITION_SELECTION_RULES.filters).sort(), [
    'formats',
    'minimum_held_out_qualification_span',
    'minimum_legal_actions',
  ]);
  assert.deepEqual(Object.keys(manifest()).sort(), [
    'action_protocol',
    'canonical_json',
    'counterfactual',
    'eligibility_metrics_version',
    'evaluator_digest',
    'exhaustive_panels',
    'inputs',
    'ordered_task_ids',
    'outputs',
    'runtime',
    'schema_version',
    'seed_namespace',
    'selection',
    'showdown_commit',
    'task_protocol',
  ]);
  assert.deepEqual(Object.keys(manifest().counterfactual as object).sort(), [
    'horizon',
    'luckSamples',
    'opponentSamples',
    'reference',
    'rolloutLimit',
    'version',
  ]);
});

test('candidate manifest rejects old schemas, extra fields, inconsistent selection, and broken output joins', () => {
  assert.throws(
    () =>
      validateCandidateManifest({
        ...manifest(),
        schema_version: CANDIDATE_POSITION_MANIFEST_SCHEMA_VERSION - 1,
      }),
    /malformed/u,
  );
  assert.throws(() => validateCandidateManifest({ ...manifest(), extra: true }), /malformed/u);

  const wrongRules = manifest();
  (wrongRules.selection as { rules: unknown }).rules = { version: 999 };
  assert.throws(() => validateCandidateManifest(wrongRules), /selection\.rules is not the current protocol/u);

  const mismatched = manifest();
  (mismatched.outputs as { scores: { rows: number } }).scores.rows = 2;
  assert.throws(() => validateCandidateManifest(mismatched), /row counts must agree/u);

  const wrongCount = manifest();
  (wrongCount.selection as { count: number }).count = 2;
  assert.throws(() => validateCandidateManifest(wrongCount), /selection\.count does not match/u);

  const duplicate = manifest();
  (
    duplicate.outputs as { tasks: { rows: number }; scores: { rows: number }; sealed_panels: { rows: number } }
  ).tasks.rows = 2;
  (duplicate.outputs as { scores: { rows: number } }).scores.rows = 2;
  (duplicate.outputs as { sealed_panels: { rows: number } }).sealed_panels.rows = 2;
  (duplicate.selection as { count: number }).count = 2;
  duplicate.ordered_task_ids = [DIGEST, DIGEST];
  assert.throws(() => validateCandidateManifest(duplicate), /contains duplicates/u);
});
