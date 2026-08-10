import { z } from 'zod';

import { COUNTERFACTUAL_PROTOCOL_VERSION, EXHAUSTIVE_PANEL_PROTOCOL, REFERENCE } from './counterfactual.js';
import { POSITION_ELIGIBILITY_METRICS_VERSION } from './eligibility.js';
import { ACTION_PROTOCOL } from './fork.js';
import { MIN_HELD_OUT_QUALIFICATION_SPAN } from './positions.js';
import { CANONICAL_JSON_PROTOCOL, canonicalJson } from './serialization.js';
import { POSITION_TASK_PROTOCOL } from './task.js';

export const CANDIDATE_POSITION_MANIFEST_SCHEMA_VERSION = 2 as const;

export const CANDIDATE_POSITION_SELECTION_RULES = {
  version: 3,
  source_rows: 'schema-v3-exhaustive-position-score-rows-from-complete-graded-source-games',
  source_identity: ['run_id', 'series_id', 'game_number', 'position_index', 'pid'],
  duplicate_resolution: 'first-row-in-graded-input',
  qualification_projection: {
    source: 'versioned-grade-time-eligibility-metrics-only',
    measurement_values: 'not-read',
  },
  filters: {
    minimum_held_out_qualification_span: MIN_HELD_OUT_QUALIFICATION_SPAN,
    minimum_legal_actions: 2,
    formats: 'exact-allowlist-membership-or-all-when-null',
  },
  strata: {
    key: 'phase/turn-pace/state-value-standing',
    pace: 'team-preview=preview;turn<=3=early;turn<=8=middle;otherwise=late',
    standing: 'value<=-0.35=far-behind;value<-0.1=behind;value<=0.1=level;value<0.35=ahead;otherwise=far-ahead',
  },
  allocation:
    'seeded-shuffle-of-source-identity-sorted-strata;repeatedly-minimize-(taken+1)/sqrt(available)-then-stratum-key',
  per_game: 'hard-cap-by-run-id-series-id-game-number',
} as const;

const digest = z.string().regex(/^[0-9a-f]{64}$/u);
const showdownCommit = z.string().regex(/^[0-9a-f]{40}$/u);
const boundedText = z
  .string()
  .min(1)
  .max(4_096)
  .refine((value) => value === value.trim(), 'must not have surrounding whitespace');
const runtimeSchema = z.strictObject({ node: boundedText, platform: boundedText, arch: boundedText });
const artifactBindingSchema = z.strictObject({ sha256: digest, rows: z.number().int().nonnegative() });
const fileArtifactBindingSchema = artifactBindingSchema.extend({ file: boundedText });
const selectionSchema = z.strictObject({
  count: z.number().int().positive(),
  seed: boundedText,
  per_game: z.number().int().positive(),
  formats: z.array(boundedText).min(1).nullable(),
  rules: z.unknown(),
});
const counterfactualSchema = z.strictObject({
  version: z.literal(COUNTERFACTUAL_PROTOCOL_VERSION),
  reference: z.unknown(),
  horizon: z.union([z.literal('end'), z.number().int().nonnegative()]),
  luckSamples: z.number().int().positive(),
  opponentSamples: z.number().int().positive(),
  rolloutLimit: z.number().int().positive(),
});
const manifestSchema = z.strictObject({
  schema_version: z.literal(CANDIDATE_POSITION_MANIFEST_SCHEMA_VERSION),
  evaluator_digest: digest,
  runtime: runtimeSchema,
  showdown_commit: showdownCommit,
  seed_namespace: boundedText,
  action_protocol: z.unknown(),
  task_protocol: z.unknown(),
  canonical_json: z.unknown(),
  counterfactual: counterfactualSchema,
  exhaustive_panels: z.unknown(),
  eligibility_metrics_version: z.literal(POSITION_ELIGIBILITY_METRICS_VERSION),
  inputs: z.strictObject({ graded: digest, graded_manifest: digest }),
  selection: selectionSchema,
  outputs: z.strictObject({
    tasks: fileArtifactBindingSchema,
    scores: artifactBindingSchema,
    sealed_panels: artifactBindingSchema,
  }),
  ordered_task_ids: z.array(digest),
});

interface CandidatePositionManifestView {
  evaluatorDigest: string;
  runtime: z.infer<typeof runtimeSchema>;
  showdownCommit: string;
  seedNamespace: string;
  inputDigests: { graded: string; gradedManifest: string };
  selection: z.infer<typeof selectionSchema>;
  outputs: {
    tasks: z.infer<typeof fileArtifactBindingSchema>;
    scores: z.infer<typeof artifactBindingSchema>;
    sealedPanels: z.infer<typeof artifactBindingSchema>;
  };
  orderedTaskIds: string[];
}

function assertProtocol(actual: unknown, expected: unknown, label: string): void {
  if (canonicalJson(actual) !== canonicalJson(expected)) throw new Error(`${label} is not the current protocol`);
}

export function validateCandidateManifest(value: unknown, label = 'candidate manifest'): CandidatePositionManifestView {
  const result = manifestSchema.safeParse(value);
  if (!result.success) throw new Error(`${label} is malformed: ${z.prettifyError(result.error)}`);
  const manifest = result.data;
  assertProtocol(manifest.action_protocol, ACTION_PROTOCOL, `${label}.action_protocol`);
  assertProtocol(manifest.task_protocol, POSITION_TASK_PROTOCOL, `${label}.task_protocol`);
  assertProtocol(manifest.canonical_json, CANONICAL_JSON_PROTOCOL, `${label}.canonical_json`);
  assertProtocol(manifest.counterfactual.reference, REFERENCE, `${label}.counterfactual.reference`);
  assertProtocol(manifest.exhaustive_panels, EXHAUSTIVE_PANEL_PROTOCOL, `${label}.exhaustive_panels`);
  assertProtocol(manifest.selection.rules, CANDIDATE_POSITION_SELECTION_RULES, `${label}.selection.rules`);
  const { tasks, scores, sealed_panels: sealedPanels } = manifest.outputs;
  if (tasks.rows !== scores.rows || tasks.rows !== sealedPanels.rows) {
    throw new Error(`${label} output row counts must agree`);
  }
  if (manifest.selection.count !== tasks.rows) {
    throw new Error(`${label}.selection.count does not match its output row counts`);
  }
  if (new Set(manifest.ordered_task_ids).size !== manifest.ordered_task_ids.length) {
    throw new Error(`${label}.ordered_task_ids contains duplicates`);
  }
  if (manifest.ordered_task_ids.length !== tasks.rows) {
    throw new Error(`${label}.ordered_task_ids does not match its output row counts`);
  }
  return {
    evaluatorDigest: manifest.evaluator_digest,
    runtime: manifest.runtime,
    showdownCommit: manifest.showdown_commit,
    seedNamespace: manifest.seed_namespace,
    inputDigests: { graded: manifest.inputs.graded, gradedManifest: manifest.inputs.graded_manifest },
    selection: manifest.selection,
    outputs: { tasks, scores, sealedPanels },
    orderedTaskIds: [...manifest.ordered_task_ids],
  };
}
