import assert from 'node:assert/strict';
import test from 'node:test';

import { validatePositionPanelArtifacts } from '../src/eval/panel-artifact.js';
import { canonicalJson, canonicalJsonDigest, canonicalJsonl } from '../src/eval/serialization.js';
import type { JsonObject } from '../src/types.js';

function artifacts(): { tasks: JsonObject[]; scores: JsonObject[]; sealed: JsonObject[] } {
  const actions = [
    { number: 0, canonical_action: 'move 1', label: 'Protect' },
    { number: 1, canonical_action: 'move 2', label: 'Tailwind' },
  ];
  const tasks: JsonObject[] = [
    {
      schema_version: 1,
      task_id: 'task-a',
      split: 'pilot',
      format: 'gen9vgc',
      phase: 'turn',
      turn: 1,
      prompt: 'public prompt',
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
      schema_version: 1,
      task_id: 'task-a',
      structural_pass: true,
      structural_reasons: [],
      diagnostic_flags: [],
      eligibility_status: 'pilot-thresholds-not-frozen',
      eligibility_metrics: {
        version: 1,
        legalActions: 2,
        drawsPerPanel: [8, 8, 8],
        heldOutSpanValue: 0.5,
        heldOutSpanStandardError: 0.1,
        heldOutSpanLower95: 0.304,
        heldOutSpanSignalToNoise: 5,
        bestAnchorAgreement: true,
        extremaSetAgreement: true,
        stabilityRankCorrelation: 1,
        maxNormalizedRewardDrift: 0.05,
        maxMeasurementNormalizedStandardError: 0.1,
      },
      measurement_panel: { id: 'measurement', n: 8, matrix_digest: 'abc' },
      min_value: 0,
      max_value: 1,
      span: 1,
      actions: actions.map((action) => ({
        number: action.number,
        canonical_action: action.canonical_action,
        mean_value: action.number,
        standard_error: 0.1,
        n: 8,
        normalized_reward: action.number,
      })),
      stability: {
        matrix_digests: ['a', 'b'],
        spans: [1, 1],
        best_anchor_agreement: true,
        extrema_set_agreement: true,
        max_normalized_reward_drift: 0.05,
        held_out_span: {
          selectedAction: 'move 2',
          alternativeAction: 'move 1',
          value: 0.5,
          standardError: 0.1,
          lower95: 0.304,
        },
      },
    },
  ];
  const sealed: JsonObject[] = [
    {
      schema_version: 1,
      task_id: 'task-a',
      source_id: 'source-a',
      source_group: 'run:series:1',
      exact_public_fingerprint: 'fingerprint',
      source: {},
      snapshot: '{}',
      opponent_request: null,
      panel_seed: 'seed',
      table: {},
    },
  ];
  return { tasks, scores, sealed };
}

test('canonical artifact JSON has recursive key order, finite numbers, and fixed JSONL newlines', () => {
  assert.equal(canonicalJson({ z: 1, a: { y: -0, b: 2 } }), '{"a":{"b":2,"y":0},"z":1}');
  assert.equal(canonicalJsonl([{ b: 1, a: 2 }]), '{"a":2,"b":1}\n');
  assert.equal(canonicalJsonDigest({ b: 1, a: 2 }), canonicalJsonDigest({ a: 2, b: 1 }));
  assert.throws(() => canonicalJson({ value: Number.NaN }), /non-finite/);
  assert.throws(() => canonicalJson({ value: undefined }), /undefined/);
});

test('public, private-score, and sealed panel rows form one exact schema join', () => {
  const artifact = artifacts();
  assert.doesNotThrow(() => validatePositionPanelArtifacts(artifact.tasks, artifact.scores, artifact.sealed));

  const leaked = structuredClone(artifact);
  leaked.tasks[0]!.snapshot = '{}';
  assert.throws(
    () => validatePositionPanelArtifacts(leaked.tasks, leaked.scores, leaked.sealed),
    /task\[0\] keys differ/,
  );

  const privateLeak = structuredClone(artifact);
  privateLeak.scores[0]!.source = {};
  assert.throws(
    () => validatePositionPanelArtifacts(privateLeak.tasks, privateLeak.scores, privateLeak.sealed),
    /score\[0\] keys differ/,
  );

  const brokenJoin = structuredClone(artifact);
  brokenJoin.sealed[0]!.task_id = 'other';
  assert.throws(
    () => validatePositionPanelArtifacts(brokenJoin.tasks, brokenJoin.scores, brokenJoin.sealed),
    /no exact private and sealed join/,
  );
});
